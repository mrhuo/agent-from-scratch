import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import dotenv from "dotenv";
// 与入口一致：本地 .env 优先于外层注入的环境变量
dotenv.config({ override: true });
import { LLMClient } from "../src/llm/index.js";
import { Agent, ToolRegistry } from "../src/agent/index.js";
import { allTools } from "../src/tools/index.js";
import { MemoryStore } from "../src/memory/MemoryStore.js";
import { ContextCompressor, LLMSummarizer } from "../src/memory/ContextCompressor.js";
import { createRememberTool, createRecallTool } from "../src/tools/memory.js";
import { Planner } from "../src/planning/index.js";

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

// 演示用独立记忆文件，避免污染项目 data/memory.json
const store = new MemoryStore(join(tmpdir(), "agent-demo-memory.json"));
const compressor = new ContextCompressor(new LLMSummarizer(client), 6);
const planner = new Planner(client, { jsonMode: true });

const log: string[] = [];
function record(s: string): void {
  log.push(s);
  console.log(s);
}

function newAgent(): Agent {
  const registry = new ToolRegistry().registerAll([
    ...allTools,
    createRememberTool(store),
    createRecallTool(store),
  ]);
  return new Agent(client, { registry, maxSteps: 8, compressor, memoryStore: store, planner });
}

async function main(): Promise<void> {
  const agent = newAgent();
  const task =
    "请分步完成一个小调研任务：" +
    "第一步，用计算器算出 17 的 3 次方；" +
    "第二步，在本地资料目录里搜索包含 'Agent' 关键词的文件并报告命中情况；" +
    "第三步，把前面两步的结果整理成一句话结论。";

  record("===== 规划执行（Plan-and-Execute）=====");
  record(`任务：${task}\n`);

  const result = await agent.runPlan(task);

  record("【规划·Planner.createPlan 产出】");
  record(`  目标：${result.plan.goal}`);
  result.plan.steps.forEach((s, i) => record(`  ${i + 1}. ${s}`));
  record("");

  record("【分步执行·每步各自跑一遍 ReAct 子循环】");
  result.stepResults.forEach((r, i) => {
    record(`  步骤${i + 1}「${r.step}」`);
    record(`    → ${r.result}${r.done ? "" : "（未完成，撞上子循环预算）"}`);
  });
  if (result.revisions > 0) record(`\n【重规划】执行中发生了 ${result.revisions} 次`);

  record("\n【终步合成·LLM 汇总各步结果】");
  record(result.answer);

  writeFileSync(join(tmpdir(), "agent-demo-plan-trace.txt"), log.join("\n"));
  record("\n[done] trace written");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
