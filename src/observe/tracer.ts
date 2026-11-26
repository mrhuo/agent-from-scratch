import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  currentContext,
  ensureContext,
  newId,
  withObserveContext,
  type ObserveContext,
} from "./context.js";

export type SpanKind = "agent" | "llm" | "tool" | "queue";
export type SpanStatus = "ok" | "error";

export interface SpanEvent {
  name: string;
  ts: string;
  attributes: Record<string, string | number | boolean>;
}

/** 一条最小 span：字段对齐 OpenTelemetry 的核心语义，但不引入其 SDK */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: SpanStatus;
  statusMessage?: string;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

export interface SpanExporter {
  export(span: Span): void;
}

/** 只追加 JSONL：与第 11 篇事件日志同样的写盘策略，最后一条也不能丢 */
export class JsonlSpanExporter implements SpanExporter {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  export(span: Span): void {
    appendFileSync(this.file, `${JSON.stringify(span)}\n`, "utf8");
  }

  readAll(): Span[] {
    if (!existsSync(this.file)) return [];
    const out: Span[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const span = JSON.parse(line) as Span;
        if (span && typeof span.traceId === "string" && typeof span.spanId === "string") {
          out.push(span);
        }
      } catch {
        // 撕裂行跳过，与 EventLog 一致
      }
    }
    return out;
  }
}

/** 内存收集器：HTTP 端点与演示脚本查询用，容量有上限防无限增长 */
export class InMemoryCollector {
  private readonly spans: Span[] = [];

  constructor(private readonly capacity = 1000) {}

  add(span: Span): void {
    this.spans.push(span);
    if (this.spans.length > this.capacity) this.spans.splice(0, this.spans.length - this.capacity);
  }

  all(): Span[] {
    return [...this.spans];
  }

  byTrace(traceId: string): Span[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }

  /** 每个 trace 一行摘要，供 dashboard 展示；不返回任何用户输入文本 */
  traces(): Array<{ traceId: string; spanCount: number; durationMs: number; status: SpanStatus }> {
    const grouped = new Map<string, Span[]>();
    for (const s of this.spans) {
      const list = grouped.get(s.traceId) ?? [];
      list.push(s);
      grouped.set(s.traceId, list);
    }
    return [...grouped.entries()]
      .map(([traceId, list]) => {
        const root = list.find((s) => s.kind === "agent");
        return {
          traceId,
          spanCount: list.length,
          durationMs: Math.round(root?.durationMs ?? Math.max(...list.map((s) => s.durationMs ?? 0))),
          status: list.some((s) => s.status === "error") ? ("error" as const) : ("ok" as const),
        };
      })
      .reverse();
  }

  clear(): void {
    this.spans.length = 0;
  }
}

/** span 句柄：业务代码只碰 addEvent / setStatus，时间戳与导出由 Tracer 负责 */
export class SpanHandle {
  readonly span: Span;
  private closed = false;

  constructor(
    span: Span,
    private readonly onClose: (span: Span) => void,
  ) {
    this.span = span;
  }

  addEvent(name: string, attributes: Record<string, string | number | boolean> = {}): void {
    this.span.events.push({ name, ts: new Date().toISOString(), attributes });
  }

  setStatus(status: SpanStatus, message?: string): void {
    this.span.status = status;
    if (message) this.span.statusMessage = message;
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.span.attributes[key] = value;
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.span.endTime = Date.now();
    this.span.durationMs = this.span.endTime - this.span.startTime;
    this.onClose(this.span);
  }
}

/**
 * 极简 Tracer。
 *
 * 刻意不做采样：本篇的目标是把「一次请求里发生了什么」完整讲清楚，
 * 采样会在演示里制造不可解释的空洞。生产环境可在 exporter 层加采样，
 * 不影响上层代码。
 */
export class Tracer {
  constructor(
    readonly collector: InMemoryCollector = new InMemoryCollector(),
    private readonly exporters: SpanExporter[] = [],
  ) {}

  addExporter(exporter: SpanExporter): this {
    this.exporters.push(exporter);
    return this;
  }

  /**
   * 开一个根 span，并在其上下文里执行整段请求逻辑。
   * traceId / signal 由此传下去，后续 LLM 与工具 span 自动成为它的子节点。
   */
  async withRoot<T>(
    traceId: string,
    requestId: string,
    name: string,
    kind: SpanKind,
    fn: (span: SpanHandle) => Promise<T>,
    attributes: Record<string, string | number | boolean> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const span = this.newSpan(name, kind, attributes, { traceId, requestId, spanId: undefined });
    return this.runInSpan(span, fn, signal);
  }

  /**
   * 手动 span：用于异步生成器等无法放进 withSpan 回调的场景。
   * 调用方必须自己调用 end()，通常用 try/catch/finally 包裹。
   */
  startSpan(
    name: string,
    kind: SpanKind,
    attributes: Record<string, string | number | boolean> = {},
  ): SpanHandle {
    return this.newSpan(name, kind, attributes, ensureContext());
  }

  /** 自动从 ALS 取父 span；无上下文时自成一条 trace */
  async withSpan<T>(
    name: string,
    kind: SpanKind,
    fn: (span: SpanHandle) => Promise<T>,
    attributes: Record<string, string | number | boolean> = {},
  ): Promise<T> {
    const span = this.newSpan(name, kind, attributes, ensureContext());
    return this.runInSpan(span, fn);
  }

  private async runInSpan<T>(
    span: SpanHandle,
    fn: (span: SpanHandle) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const parent = currentContext();
    const ctx: ObserveContext = {
      traceId: span.span.traceId,
      requestId: String(span.span.attributes.request_id ?? parent?.requestId ?? newId()),
      spanId: span.span.spanId,
      signal: signal ?? parent?.signal,
    };
    try {
      const value = await withObserveContext(ctx, () => fn(span));
      if (span.span.status === "ok") span.setStatus("ok");
      return value;
    } catch (err) {
      span.setStatus("error", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      span.end();
    }
  }

  private newSpan(
    name: string,
    kind: SpanKind,
    attributes: Record<string, string | number | boolean>,
    ctx: { traceId: string; requestId: string; spanId?: string },
  ): SpanHandle {
    const parentId = ctx.spanId ?? currentContext()?.spanId;
    const span: Span = {
      traceId: ctx.traceId,
      spanId: newId(),
      ...(parentId ? { parentSpanId: parentId } : {}),
      name,
      kind,
      startTime: Date.now(),
      status: "ok",
      attributes: { ...attributes, request_id: ctx.requestId },
      events: [],
    };
    return new SpanHandle(span, (done) => {
      this.collector.add(done);
      for (const exporter of this.exporters) exporter.export(done);
    });
  }
}
