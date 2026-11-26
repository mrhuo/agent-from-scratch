import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, calculator, ToolRegistry } from "../src/agent/index.js";
import type { ChatClient, ChatResult, Message, ToolDefinition } from "../src/llm/index.js";
import { LLMClient } from "../src/llm/index.js";
import {
  Tracer,
  InMemoryCollector,
  JsonlSpanExporter,
  Counter,
  Histogram,
  Gauge,
  defaultMetrics,
  Semaphore,
  withDeadline,
  DeadlineExceededError,
  delay,
  TracedToolRegistry,
  ObservedAgent,
  createObservabilityServer,
  listenObservabilityServer,
} from "../src/observe/index.js";
import { withObserveContext, newId } from "../src/observe/index.js";

function fakeChatClient(responses: ChatResult[]): ChatClient & { calls: unknown[][] } {
  const state = { calls: [] as unknown[][] };
  let i = 0;
  const chatWithTools = vi.fn(async (messages: Message[], tools: ToolDefinition[]) => {
    state.calls.push([messages, tools]);
    const value = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return value;
  });
  return {
    chat: async () => "ok",
    chatStream: async function* () {
      yield "ok";
    },
    chatWithTools,
    calls: state.calls,
  };
}

function toolCall(name: string, args: Record<string, unknown>, id = "c1") {
  return { id, type: "function" as const, function: { name, arguments: args } };
}

describe("Tracer：trace 与 span 层级", () => {
  it("子 span 继承 traceId 并挂到父 span 下", async () => {
    const collector = new InMemoryCollector();
    const tracer = new Tracer(collector);
    const traceId = newId();
    await tracer.withRoot(traceId, "req-1", "agent.run", "agent", async (root) => {
      await tracer.withSpan("llm.chatWithTools", "llm", async () => "ok");
      expect(root.span.status).toBe("ok");
    });
    const spans = collector.byTrace(traceId);
    expect(spans).toHaveLength(2);
    const root = spans.find((s) => s.kind === "agent")!;
    const child = spans.find((s) => s.kind === "llm")!;
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentSpanId).toBe(root.spanId);
    expect(child.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("并发请求互不串线", async () => {
    const collector = new InMemoryCollector();
    const tracer = new Tracer(collector);
    const a = newId();
    const b = newId();
    await Promise.all([
      tracer.withRoot(a, "req-a", "agent.run", "agent", async () => {
        await delay(10);
        await tracer.withSpan("tool.calculator", "tool", async () => 1);
      }),
      tracer.withRoot(b, "req-b", "agent.run", "agent", async () => {
        await tracer.withSpan("tool.calculator", "tool", async () => 2);
      }),
    ]);
    expect(collector.byTrace(a)).toHaveLength(2);
    expect(collector.byTrace(b)).toHaveLength(2);
    expect(collector.byTrace(a).every((s) => s.traceId === a)).toBe(true);
    expect(collector.byTrace(b).every((s) => s.traceId === b)).toBe(true);
  });

  it("异常自动标记 error 且 span 仍然结束", async () => {
    const collector = new InMemoryCollector();
    const tracer = new Tracer(collector);
    await expect(
      tracer.withSpan("tool.bad", "tool", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const span = collector.all()[0]!;
    expect(span.status).toBe("error");
    expect(span.statusMessage).toContain("boom");
    expect(span.endTime).toBeDefined();
  });

  it("ALS 之外的调用仍能产生独立 trace", async () => {
    const collector = new InMemoryCollector();
    const tracer = new Tracer(collector);
    await tracer.withSpan("orphan", "tool", async () => 1);
    expect(collector.all()[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("withObserveContext 手动传递上下文", async () => {
    const collector = new InMemoryCollector();
    const tracer = new Tracer(collector);
    const traceId = newId();
    await withObserveContext({ traceId, requestId: "manual" }, async () => {
      await tracer.withSpan("manual.span", "tool", async () => 1);
    });
    expect(collector.byTrace(traceId)).toHaveLength(1);
  });
});

describe("span 导出", () => {
  it("JSONL 导出可读，撕裂行被跳过", async () => {
    const dir = mkdtempSync(join(tmpdir(), "observe-"));
    const file = join(dir, "traces.jsonl");
    const exporter = new JsonlSpanExporter(file);
    const tracer = new Tracer(new InMemoryCollector(), [exporter]);
    await tracer.withSpan("one", "tool", async () => 1);
    writeFileSync(file, `${readFileSync(file, "utf8")}{"traceId":"broken"\n`, "utf8");
    await tracer.withSpan("two", "tool", async () => 2);
    expect(exporter.readAll()).toHaveLength(2);
  });
});

describe("Prometheus 指标", () => {
  it("counter 按标签累计，total 给出无标签合计", () => {
    const c = new Counter("requests_total", "请求数");
    c.inc({ status: "ok" }, 2);
    c.inc({ status: "error" });
    expect(c.total()).toBe(3);
    expect(c.render()).toContain('requests_total{status="ok"} 2');
  });

  it("histogram 桶计数单调且含 +Inf", () => {
    const h = new Histogram("duration_ms", "耗时", [10, 100]);
    h.observe(5);
    h.observe(50);
    h.observe(200);
    expect(h.snapshot().count).toBe(3);
    expect(h.render()).toContain('duration_ms_bucket{le="+Inf"} 3');
    expect(h.render()).toContain('duration_ms_bucket{le="10"} 1');
  });

  it("gauge 支持增减", () => {
    const g = new Gauge("in_flight", "在途");
    g.inc();
    g.inc();
    g.dec();
    expect(g.get()).toBe(1);
  });

  it("标签值中的引号被转义", () => {
    const c = new Counter("x_total", "x");
    c.inc({ model: 'a"b' });
    expect(c.render()).toContain('model="a\\"b"');
  });
});

describe("截止时间与取消", () => {
  it("超时抛出 DeadlineExceededError 并 abort signal", async () => {
    let seen: AbortSignal | undefined;
    await expect(
      withDeadline(async (signal) => {
        seen = signal;
        await delay(200, signal);
        return 1;
      }, 20, "测试操作"),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(seen?.aborted).toBe(true);
  });

  it("正常完成时不 abort", async () => {
    let seen: AbortSignal | undefined;
    const value = await withDeadline(async (signal) => {
      seen = signal;
      return 42;
    }, 1000, "快速操作");
    expect(value).toBe(42);
    expect(seen?.aborted).toBe(false);
  });

  it("非正数截止时间直接拒绝", async () => {
    await expect(withDeadline(async () => 1, 0, "零截止")).rejects.toBeInstanceOf(
      DeadlineExceededError,
    );
  });

  it("LLMClient 把 signal 透传给 fetch", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "hi" } }] }),
      } as Response;
    };
    const client = new LLMClient({
      apiKey: "test-key",
      model: "test-model",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const controller = new AbortController();
    await client.chat([{ role: "user", content: "hello" }], { signal: controller.signal });
    expect(captured?.signal).toBe(controller.signal);
  });

  it("Agent 在 signal 已取消时不再调用工具", async () => {
    const fake = fakeChatClient([
      { content: null, toolCalls: [toolCall("calculator", { expression: "1+1" })] },
    ]);
    const agent = new Agent(fake, { tools: [calculator] });
    const controller = new AbortController();
    controller.abort();
    await expect(agent.run("算一下", { signal: controller.signal })).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});

describe("FIFO 并发信号量", () => {
  it("限制并发上限，且按先进先出放行", async () => {
    const sem = new Semaphore(2);
    const order: number[] = [];
    const first = await sem.acquire();
    const second = await sem.acquire();
    const third = sem.acquire().then(async ({ release }) => {
      order.push(3);
      release();
    });
    const fourth = sem.acquire().then(async ({ release }) => {
      order.push(4);
      release();
    });
    await delay(10);
    expect(sem.stats).toMatchObject({ active: 2, queued: 2 });
    first.release();
    await delay(5);
    second.release();
    await Promise.all([third, fourth]);
    expect(order).toEqual([3, 4]);
    expect(sem.stats.active).toBe(0);
  });

  it("排队超时后移除等待者，不泄漏名额", async () => {
    const sem = new Semaphore(1);
    const hold = await sem.acquire();
    await expect(sem.acquire(20)).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(sem.stats.queued).toBe(0);
    hold.release();
    const next = await sem.acquire();
    expect(next.waitedMs).toBeGreaterThanOrEqual(0);
    next.release();
  });

  it("run 在异常路径也释放名额", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(sem.stats.active).toBe(0);
  });
});

describe("TracedToolRegistry", () => {
  it("成功与失败的工具调用分别记为 ok / error span", async () => {
    const metrics = defaultMetrics();
    const collector = new InMemoryCollector();
    const registry = new TracedToolRegistry(new Tracer(collector), metrics).registerAll([
      calculator,
    ]);
    const ok = await registry.run("calculator", { expression: "3*7" });
    expect(ok).toBe("21");
    const bad = await registry.run("calculator", { expression: "3+" });
    expect(bad).toContain("错误");
    const spans = collector.all();
    expect(spans.map((s) => s.status)).toEqual(["ok", "error"]);
    expect(spans[0]!.attributes.tool).toBe("calculator");
    expect(metrics.toolCalls.total()).toBe(2);
  });

  it("span 不记录工具参数与观察正文", async () => {
    const collector = new InMemoryCollector();
    const registry = new TracedToolRegistry(new Tracer(collector), defaultMetrics()).registerAll([
      calculator,
    ]);
    await registry.run("calculator", { expression: "SECRET_VALUE" });
    const span = collector.all()[0]!;
    expect(JSON.stringify(span)).not.toContain("SECRET_VALUE");
  });
});

describe("ObservedAgent：一请求一 trace", () => {
  it("端到端产出 root / llm / tool 三层 span 与指标", async () => {
    const metrics = defaultMetrics();
    const collector = new InMemoryCollector();
    const tracer = new Tracer(collector);
    const fake = fakeChatClient([
      { content: "计算中", toolCalls: [toolCall("calculator", { expression: "23*17" })] },
      { content: "结果是 391", toolCalls: [] },
    ]);
    const registry = new TracedToolRegistry(tracer, metrics).registerAll([calculator]);
    const observed = new ObservedAgent({
      client: fake,
      agentFactory: (client) => new Agent(client, { registry, maxSteps: 6 }),
      tracer,
      metrics,
      semaphore: new Semaphore(2),
    });
    const result = await observed.submit("23乘以17");
    expect(result.status).toBe("ok");
    expect(result.answer).toBe("结果是 391");
    const spans = collector.byTrace(result.traceId);
    expect(spans.map((s) => s.kind).sort()).toEqual(["agent", "llm", "llm", "tool"]);
    const toolSpan = spans.find((s) => s.kind === "tool")!;
    const root = spans.find((s) => s.kind === "agent")!;
    expect(toolSpan.parentSpanId).toBe(root.spanId);
    expect(metrics.requests.total()).toBe(1);
    expect(metrics.inFlight.get()).toBe(0);
  });

  it("超时返回 timeout 状态而不是异常逃逸", async () => {
    const metrics = defaultMetrics();
    const collector = new InMemoryCollector();
    const fake: ChatClient = {
      chat: async () => "",
      chatStream: async function* () {
        yield "";
      },
      chatWithTools: async () => {
        await delay(200);
        return { content: "迟到的答复", toolCalls: [] };
      },
    };
    const observed = new ObservedAgent({
      client: fake,
      agentFactory: (client) => new Agent(client, {}),
      tracer: new Tracer(collector),
      metrics,
      semaphore: new Semaphore(1),
      deadlineMs: 20,
    });
    const result = await observed.submit("慢请求");
    expect(result.status).toBe("timeout");
    expect(result.error).toContain("超过");
    expect(metrics.timeouts.total()).toBe(1);
    expect(collector.byTrace(result.traceId).find((s) => s.kind === "agent")!.status).toBe("error");
  });

  it("排队耗时单独计量", async () => {
    const metrics = defaultMetrics();
    const collector = new InMemoryCollector();
    const fake = fakeChatClient([{ content: "ok", toolCalls: [] }]);
    const sem = new Semaphore(1);
    const hold = await sem.acquire();
    const observed = new ObservedAgent({
      client: fake,
      agentFactory: (client) => new Agent(client, {}),
      tracer: new Tracer(collector),
      metrics,
      semaphore: sem,
    });
    const pending = observed.submit("排队请求");
    await delay(25);
    hold.release();
    const result = await pending;
    expect(result.queuedMs).toBeGreaterThanOrEqual(20);
    expect(metrics.queueDuration.snapshot().count).toBe(1);
  });
});

describe("HTTP 观测端点", () => {
  it("healthz / readyz / metrics / traces 均可访问", async () => {
    const metrics = defaultMetrics();
    const collector = new InMemoryCollector();
    metrics.requests.inc({ status: "ok" });
    const server = createObservabilityServer({ metrics: metrics.registry, collector });
    const bound = await listenObservabilityServer(server, 0);
    try {
      const health = await fetch(`${bound.url}/healthz`);
      expect(await health.text()).toBe("ok\n");
      const ready = await fetch(`${bound.url}/readyz`);
      expect(ready.status).toBe(200);
      const metricText = await (await fetch(`${bound.url}/metrics`)).text();
      expect(metricText).toContain("agent_requests_total");
      const traces = await (await fetch(`${bound.url}/traces`)).json();
      expect(traces).toMatchObject({ traces: [], total: 0 });
      const dashboard = await (await fetch(`${bound.url}/`)).text();
      expect(dashboard).toContain("Agent Observability");
      const missing = await fetch(`${bound.url}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await bound.close();
    }
  });

  it("readyz 在未就绪时返回 503", async () => {
    const metrics = defaultMetrics();
    const server = createObservabilityServer({
      metrics: metrics.registry,
      collector: new InMemoryCollector(),
      isReady: () => false,
    });
    const bound = await listenObservabilityServer(server, 0);
    try {
      const res = await fetch(`${bound.url}/readyz`);
      expect(res.status).toBe(503);
    } finally {
      await bound.close();
    }
  });
});
