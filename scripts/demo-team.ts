import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import dotenv from "dotenv";
// 与入口一致：本地 .env 优先于外层注入的环境变量
dotenv.config({ override: true });
import { LLMClient } from "../src/llm/index.js";
import { allTools } from "../src/tools/index.js";
import { MemoryStore } from "../src/memory/MemoryStore.js";
import { ContextCompressor, LLMSummarizer } from "../src/memory/ContextCompressor.js";
import { createRememberTool, createRecallTool } from "../src/tools/memory.js";
import {
  Orchestrator,
  RESEARCHER,
  WRITER,
  REVIEWER,
  type AgentRole,
  type CollaborationResult,
} from "../src/orchestrator/index.js";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("缺少 OPENAI_API_KEY");
  process.exit(1);
}

const client = new LLMClient({
  apiKey,
  baseURL: process.env.BASE_URL || undefined,
  model: process.env.MODEL ?? "deepseek-flash",
});

const store = new MemoryStore(join(tmpdir(), "agent-demo-memory.json"));
const compressor = new ContextCompressor(new LLMSummarizer(client), 6);
const orchestrator = new Orchestrator(client, {
  tools: [...allTools, createRememberTool(store), createRecallTool(store)],
  memoryStore: store,
  compressor,
  maxSteps: 8,
});

const log: string[] = [];
function record(s: string): void {
  log.push(s);
  console.log(s);
}

function dump(label: string, result: CollaborationResult): void {
  record(`\n【${label}】`);
  result.results.forEach((r, i) => {
    record(`  ${i + 1}. ${r.title}（${r.role}）`);
    // 每个成员的产出按行缩进，便于阅读
    String(r.answer)
      .split("\n")
      .forEach((line) => record(`     ${line}`));
  });
  if (label.includes("并行")) {
    record("  —— 协调者汇总 ——");
    String(result.finalAnswer)
      .split("\n")
      .forEach((line) => record(`  ${line}`));
  }
}

async function main(): Promise<void> {
  const task =
    "围绕本地资料，简要说明「手搓 Agent」项目的进展：已完成哪些能力、正在补哪些能力。";

  record("===== 多 Agent 协作（Multi-Agent Collaboration）=====");
  record(`任务：${task}\n`);

  // 场景一：串行流水线 调研 → 写作 → 审核
  const roles: AgentRole[] = [RESEARCHER, WRITER, REVIEWER];
  const pipeline = await orchestrator.runPipeline(task, roles);
  record("模式一：串行流水线（前序产出传给后序，末端角色产出即终稿）");
  dump("串行流水线", pipeline);

  // 场景二：并行分派 两个独立子任务同时推进，再汇总
  const parallel = await orchestrator.runParallel([
    { role: RESEARCHER, task: `${task}（侧重：检索本地资料里的客观事实）` },
    { role: REVIEWER, task: `${task}（侧重：从证据充分性角度做独立审查）` },
  ]);
  record("\n模式二：并行分派（Promise.all 同时推进，再交协调者汇总）");
  dump("并行分派", parallel);

  writeFileSync(join(tmpdir(), "agent-demo-team-trace.txt"), log.join("\n"));
  record("\n[done] trace written");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
