import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { MetricsRegistry } from "./metrics.js";
import type { InMemoryCollector } from "./tracer.js";
import type { Semaphore } from "./limiter.js";

export interface ObservabilityServerOptions {
  metrics: MetricsRegistry;
  collector: InMemoryCollector;
  semaphore?: Semaphore;
  /** 就绪探针：外部依赖（如模型端点）不可用时可置 false */
  isReady?: () => boolean;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function text(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 极简 dashboard：只展示标识、耗时与状态，不展示任何请求正文 */
function dashboard(collector: InMemoryCollector, semaphore?: Semaphore): string {
  const rows = collector
    .traces()
    .slice(0, 12)
    .map(
      (t) =>
        `<tr><td>${esc(t.traceId.slice(0, 12))}</td><td>${t.spanCount}</td>` +
        `<td>${t.durationMs}ms</td><td>${esc(t.status)}</td></tr>`,
    )
    .join("\n");
  const queue = semaphore ? JSON.stringify(semaphore.stats) : "n/a";
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Agent Observability</title>
<style>body{font:14px/1.6 ui-monospace,Consolas,monospace;background:#f7f7f5;color:#222;margin:40px auto;max-width:900px}
h1{font-size:20px;font-weight:600}table{border-collapse:collapse;width:100%;margin-top:20px}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left}th{color:#666;font-weight:500}
a{color:#2a5a8a}code{background:#eee;padding:2px 5px}</style></head><body>
<h1>Agent Observability</h1>
<p><a href="/metrics">/metrics</a> · <a href="/traces">/traces</a> · <a href="/healthz">/healthz</a> · <a href="/readyz">/readyz</a></p>
<p>limiter: <code>${esc(queue)}</code></p>
<table><thead><tr><th>trace</th><th>spans</th><th>duration</th><th>status</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4">暂无请求</td></tr>'}</tbody></table></body></html>`;
}

/**
 * 观测端点。刻意不引入任何 Web 框架：
 * 四个只读端点用 node:http 不到 100 行就能写完，依赖越少越容易上线排障。
 */
export function createObservabilityServer(options: ObservabilityServerOptions) {
  const { metrics, collector, semaphore, isReady } = options;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET") {
      json(res, 405, { error: "只支持 GET" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") {
      text(res, 200, "ok\n", "text/plain; charset=utf-8");
      return;
    }
    if (path === "/readyz") {
      const ready = isReady?.() ?? true;
      text(res, ready ? 200 : 503, ready ? "ready\n" : "not ready\n", "text/plain; charset=utf-8");
      return;
    }
    if (path === "/metrics") {
      text(res, 200, metrics.render(), "text/plain; version=0.0.4; charset=utf-8");
      return;
    }
    if (path === "/traces") {
      json(res, 200, { traces: collector.traces(), total: collector.all().length });
      return;
    }
    if (path.startsWith("/traces/")) {
      const traceId = path.slice("/traces/".length);
      const spans = collector.byTrace(traceId);
      json(res, spans.length > 0 ? 200 : 404, spans.length > 0 ? { spans } : { error: "trace 不存在" });
      return;
    }
    if (path === "/") {
      text(res, 200, dashboard(collector, semaphore), "text/html; charset=utf-8");
      return;
    }
    json(res, 404, { error: "not found" });
  });
}

/** 绑定端口并返回实际地址；port=0 由系统分配，测试用 */
export function listenObservabilityServer(
  server: ReturnType<typeof createObservabilityServer>,
  port = 9464,
  host = "127.0.0.1",
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://${host}:${actualPort}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
