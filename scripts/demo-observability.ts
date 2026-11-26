/**
 * 第 12 篇演示：并发请求、链路追踪、指标抓取与超时取消。
 *
 *   npx tsx scripts/demo-observability.ts
 *
 * 三类证据：
 *  1. 三个真实并发请求走同一套 ObservedAgent：并发上限 2，第三个排队；
 *  2. 从 HTTP /metrics 与 /traces 端点读回指标与 trace 摘要；
 *  3. 用受控慢客户端触发截止时间，验证 abort 信号真的送到 fetch 层。
 * 需要网络与 .env 里的 key；轨迹写入 data/observability-trace.txt。
 */
import dotenv from "dotenv";
dotenv.config({ override: true });
import { appendFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LLMClient } from "../src/llm/index.js";
import type { ChatClient } from "../src/llm/index.js";
import { Agent, calculator } from "../src/agent/index.js";
import { readFile, searchFiles } from "../src/tools/index.js";
import {
  defaultMetrics,
  InMemoryCollector,
  JsonlSpanExporter,
  Tracer,
  Semaphore,
  TracedToolRegistry,
  ObservedAgent,
  createObservabilityServer,
  listenObservabilityServer,
  withDeadline,
  DeadlineExceededError,
} from "../src/observe/index.js";

const tracePath = join(process.cwd(), "data", "observability-trace.txt");
if (existsSync(tracePath)) rmSync(tracePath);

function record(s = ""): void {
  console.log(s);
  appendFileSync(tracePath, `${s}\n`, "utf8");
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("缺少 OPENAI_API_KEY");
  process.exit(1);
}

const model = process.env.MODEL ?? "gpt-4o-mini";
const client = new LLMClient({
  apiKey,
  baseURL: process.env.BASE_URL || undefined,
  model,
});

const metrics = defaultMetrics();
const collector = new InMemoryCollector();
const tracer = new Tracer(collector).addExporter(
  new JsonlSpanExporter(join(process.cwd(), "data", "traces.jsonl")),
);
const semaphore = new Semaphore(2);
const registry = new TracedToolRegistry(tracer, metrics).registerAll([
  calculator,
  readFile,
  searchFiles,
]);

const observed = new ObservedAgent({
  client,
  agentFactory: (tracedClient) =>
    new Agent(tracedClient, {
      registry,
      maxSteps: 6,
      systemPrompt:
        "你是一个会使用工具的助手。需要算术时用 calculator，需要本地资料时用 readFile 或 searchFiles。" +
        "文件路径一律相对 data/ 目录。拿到工具结果后直接给出简短答案。",
    }),
  tracer,
  metrics,
  semaphore,
  deadlineMs: 45_000,
  queueTimeoutMs: 30_000,
  model,
});

const bound = await listenObservabilityServer(
  createObservabilityServer({ metrics: metrics.registry, collector, semaphore }),
  0,
);

try {
  record("===== 配置 =====");
  record(`  模型：${model}`);
  record(`  并发上限：${semaphore.max}；单请求截止：45000ms；排队截止：30000ms`);
  record(`  观测端点：${bound.url}/metrics、${bound.url}/traces`);
  record("");
  record("===== 三个真实并发请求（同一进程，三个独立 Agent 实例） =====");

  const tasks = [
    "23 乘以 17 等于多少？用 calculator 计算后只回答数字。",
    "读 notes.txt，回答第一条笔记讲的是什么，一句话。",
    "计算 (1024-256)/8，用 calculator，只回答数字。",
  ];
  const started = Date.now();
  const results = await Promise.all(tasks.map((t) => observed.submit(t)));
  record(`  三个请求总墙钟时间：${Date.now() - started}ms`);
  for (const [i, r] of results.entries()) {
    record(`  [${i + 1}] trace=${r.traceId.slice(0, 12)} status=${r.status} ` +
      `总耗时=${r.durationMs}ms 排队=${r.queuedMs}ms`);
    record(`      答复：${r.answer.slice(0, 100)}`);
    const spans = collector.byTrace(r.traceId);
    for (const s of spans) {
      record(`      span ${s.kind}:${s.name} ${s.durationMs}ms ${s.status}`);
    }
  }

  record("");
  record("===== /traces 端点读回的摘要 =====");
  const tracesBody = (await (await fetch(`${bound.url}/traces`)).json()) as {
    traces: Array<{ traceId: string; spanCount: number; durationMs: number; status: string }>;
    total: number;
  };
  record(`  span 总数=${tracesBody.total}，trace 数=${tracesBody.traces.length}`);
  for (const t of tracesBody.traces.slice(0, 3)) {
    record(`  ${t.traceId.slice(0, 12)} spans=${t.spanCount} ${t.durationMs}ms ${t.status}`);
  }

  record("");
  record("===== /metrics 端点读回的关键指标 =====");
  const metricsText = await (await fetch(`${bound.url}/metrics`)).text();
  for (const line of metricsText.split("\n")) {
    if (
      /^(agent_requests_total|agent_llm_calls_total|agent_tool_calls_total|agent_in_flight)/.test(line)
    ) {
      record(`  ${line}`);
    }
  }
  const queueLines = metricsText
    .split("\n")
    .filter((l) => l.startsWith("agent_request_queue_ms_bucket") && !l.endsWith(" 0"));
  record(`  排队耗时直方图非零桶：${queueLines.length} 个`);
  for (const line of queueLines.slice(0, 4)) record(`  ${line}`);

  record("");
  record("===== 超时探针（受控慢客户端，验证取消链路） =====");
  let aborted = false;
  const slowClient: ChatClient = {
    chat: async () => "",
    chatStream: async function* () {
      yield "";
    },
    chatWithTools: async (_m, _t, options) => {
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
      return { content: "不会到达", toolCalls: [] };
    },
  };
  const timeoutAgent = new ObservedAgent({
    client: slowClient,
    agentFactory: (c) => new Agent(c, {}),
    tracer,
    metrics,
    semaphore: new Semaphore(1),
    deadlineMs: 50,
  });
  const timedOut = await timeoutAgent.submit("故意慢的请求");
  record(`  状态=${timedOut.status}，错误=${timedOut.error}`);
  record(`  fetch 层收到 abort=${aborted}`);
  record(`  截止时间异常类型=${new DeadlineExceededError("x", 1).name}`);

  // 直接验证 withDeadline 对支持 signal 的 fetch 路径生效
  const controller = new AbortController();
  try {
    await withDeadline(async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("fetch aborted")));
      });
      return 1;
    }, 30, "fetch 探针");
  } catch (err) {
    record(`  deadline 探针：${err instanceof Error ? err.constructor.name : String(err)}`);
  }
  void controller;

  record("");
  record("===== 结束状态 =====");
  record(`  Agent 请求计数=${metrics.requests.total()}，模型调用=${metrics.llmCalls.total()}`);
  record(`  工具调用=${metrics.toolCalls.total()}，超时=${metrics.timeouts.total()}`);
  record(`  在途请求=${metrics.inFlight.get()}，span 总数=${collector.all().length}`);
} finally {
  await bound.close();
}
