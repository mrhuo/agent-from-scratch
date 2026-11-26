import type {
  ChatClient,
  ChatOptions,
  ChatResult,
  Message,
  ToolDefinition,
} from "../llm/index.js";
import { Agent, ToolRegistry } from "../agent/index.js";
import { currentContext, newId } from "./context.js";
import { withDeadline, isDeadlineExceeded } from "./deadline.js";
import type { Semaphore } from "./limiter.js";
import type { defaultMetrics } from "./metrics.js";
import { Tracer, type SpanHandle } from "./tracer.js";

type Metrics = ReturnType<typeof defaultMetrics>;
type RunStatus = "ok" | "error" | "timeout";

function withContextSignal(options: ChatOptions): ChatOptions {
  const signal = currentContext()?.signal;
  return signal ? { ...options, signal } : options;
}

/**
 * 装饰 LLM 客户端：每次调用开一个 llm span。
 *
 * 只记模型名、状态与耗时，不记 messages 内容——请求正文里可能有 API key、
 * 用户隐私和公司内部资料，进追踪系统就是一次数据外泄。
 */
export class TracedLLMClient implements ChatClient {
  constructor(
    private readonly inner: ChatClient,
    private readonly tracer: Tracer,
    private readonly metrics: Metrics,
    private readonly model = "unknown",
  ) {}

  async chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
    return this.wrap("llm.chat", () => this.inner.chat(messages, withContextSignal(options)));
  }

  async *chatStream(
    messages: Message[],
    options: ChatOptions = {},
  ): AsyncGenerator<string> {
    const span = this.tracer.startSpan("llm.chatStream", "llm", {
      model: this.model,
      streaming: true,
    });
    try {
      yield* this.inner.chatStream(messages, withContextSignal(options));
      this.metrics.llmCalls.inc({ status: "ok" });
    } catch (err) {
      span.setStatus("error", err instanceof Error ? err.message : String(err));
      this.metrics.llmCalls.inc({ status: "error" });
      throw err;
    } finally {
      span.end();
    }
  }

  async chatWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    options: ChatOptions = {},
  ): Promise<ChatResult> {
    return this.wrap("llm.chatWithTools", () =>
      this.inner.chatWithTools(messages, tools, withContextSignal(options)),
    );
  }

  private async wrap<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.tracer.withSpan(
      name,
      "llm",
      async (span: SpanHandle) => {
        try {
          const result = await fn();
          this.metrics.llmCalls.inc({ status: "ok" });
          return result;
        } catch (err) {
          span.setStatus("error", err instanceof Error ? err.message : String(err));
          this.metrics.llmCalls.inc({ status: "error" });
          throw err;
        }
      },
      { model: this.model },
    );
  }
}

/**
 * 装饰工具注册表：每次工具调用开一个 tool span。
 *
 * 工具返回的错误文本本身不进 span；只把「成功/失败」与响应长度记为数值。
 * 注册表原有的参数校验、权限关卡与错误分类完全不动。
 */
export class TracedToolRegistry extends ToolRegistry {
  constructor(
    private readonly tracer: Tracer,
    private readonly metrics: Metrics,
  ) {
    super();
  }

  override async run(name: string, rawArgs: unknown): Promise<string> {
    return this.tracer.withSpan(
      `tool.${name}`,
      "tool",
      async (span) => {
        const observation = await super.run(name, rawArgs);
        const failed =
          observation.startsWith("[工具错误") ||
          observation.startsWith("[权限拒绝") ||
          observation.startsWith("错误：");
        const status = failed ? "error" : "ok";
        span.setStatus(status);
        span.setAttribute("tool", name);
        span.addEvent("observation", { chars: observation.length });
        this.metrics.toolCalls.inc({ tool: name, status });
        return observation;
      },
      { tool: name },
    );
  }
}

export interface ObservedRunResult {
  traceId: string;
  answer: string;
  status: RunStatus;
  durationMs: number;
  queuedMs: number;
  error?: string;
}

export interface ObservedAgentOptions {
  client: ChatClient;
  /** 一请求一 Agent：Agent 自带会话状态，绝不能在并发请求间共享 */
  agentFactory: (client: ChatClient) => Agent;
  tracer: Tracer;
  metrics: Metrics;
  semaphore: Semaphore;
  deadlineMs?: number;
  queueTimeoutMs?: number;
  model?: string;
}

/**
 * 观测与生命周期编排层。
 *
 * 一个 submit = 一条 trace：
 *   agent.run（根 span）
 *     ├─ llm.chatWithTools（子 span，每轮一个）
 *     └─ tool.*（子 span，每次工具调用一个）
 *
 * 排队时间单独计量：请求卡在信号量队列里与卡在模型 I/O 上，
 * 是两种完全不同的故障，混在一个总耗时里无法定位。
 */
export class ObservedAgent {
  private sequence = 0;

  constructor(private readonly options: ObservedAgentOptions) {}

  async submit(text: string): Promise<ObservedRunResult> {
    const { tracer, metrics, semaphore, client, agentFactory } = this.options;
    const traceId = newId();
    const requestId = `req-${++this.sequence}`;
    const startedAt = Date.now();
    let status: RunStatus = "ok";
    let errorMessage: string | undefined;

    metrics.inFlight.inc();

    const result = await tracer.withRoot(
      traceId,
      requestId,
      "agent.run",
      "agent",
      async (root) => {
        root.addEvent("accepted", { queue_max: semaphore.max });
        let queuedMs = 0;
        let release: (() => void) | undefined;
        try {
          const acquired = await semaphore.acquire(this.options.queueTimeoutMs);
          release = acquired.release;
          queuedMs = acquired.waitedMs;
          metrics.queueDuration.observe(queuedMs);
          root.addEvent("admitted", { waited_ms: queuedMs });

          const tracedClient = new TracedLLMClient(
            client,
            tracer,
            metrics,
            this.options.model ?? "unknown",
          );
          const agent = agentFactory(tracedClient);
          agent.setHooks({
            onToolCalls: (_content, calls) => root.addEvent("tool_calls", { count: calls.length }),
            onToolResult: (call) => root.addEvent("tool_result", { tool: call.function.name }),
            onFinalAnswer: () => root.addEvent("final_answer", {}),
          });

          const run = await withDeadline(
            (signal) => agent.run(text, { signal }),
            this.options.deadlineMs ?? 30000,
            "Agent 请求",
          );
          return { queuedMs, answer: run.answer };
        } catch (err) {
          status = isDeadlineExceeded(err) ? "timeout" : "error";
          errorMessage = err instanceof Error ? err.message : String(err);
          if (status === "timeout") metrics.timeouts.inc({ phase: "request" });
          root.setStatus("error", errorMessage);
          root.addEvent("failed", { status, phase: "request" });
          return { queuedMs, answer: "" };
        } finally {
          release?.();
        }
      },
      { request_id: requestId },
    );

    const durationMs = Date.now() - startedAt;
    metrics.inFlight.dec();
    metrics.requests.inc({ status });
    metrics.requestDuration.observe(durationMs, { status });

    return {
      traceId,
      answer: result.answer,
      status,
      durationMs,
      queuedMs: result.queuedMs,
      ...(errorMessage ? { error: errorMessage } : {}),
    };
  }
}
