import dotenv from "dotenv";
dotenv.config({ override: true });
import { LLMClient } from "../src/llm/index.js";
import { Agent, ToolRegistry } from "../src/agent/index.js";
import { allTools } from "../src/tools/index.js";
import { MemoryStore } from "../src/memory/MemoryStore.js";
import { ContextCompressor, LLMSummarizer } from "../src/memory/ContextCompressor.js";
import { createRememberTool, createRecallTool } from "../src/tools/memory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

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

// 演示用独立记忆文件，避免污染项目 data/memory.json。
// 预先建好空库，绕过环境对「首次新建文件」的偶发拦截。
const MEM_PATH = join(tmpdir(), "agent-demo-memory.json");
writeFileSync(MEM_PATH, "[]");
const store = new MemoryStore(MEM_PATH);

// 会话一/二：保留最近 6 个用户轮（演示里轮次不多，主要看长期记忆）。
// 会话三：把窗口缩到 3，连续多轮后旧轮次必然被摘要，演示短期记忆压缩。
function makeCompressor(keep: number): ContextCompressor {
  return new ContextCompressor(new LLMSummarizer(client), keep, (info) => {
    record(`  [压缩] 短期记忆触发：旧 ${info.dropped} 条对话已摘要为一条 system 消息`);
  });
}

const log: string[] = [];
function record(s: string): void {
  log.push(s);
  console.log(s);
}

function newAgent(compressor: ContextCompressor): Agent {
  const registry = new ToolRegistry().registerAll([
    ...allTools,
    createRememberTool(store),
    createRecallTool(store),
  ]);
  return new Agent(client, { registry, maxSteps: 8, compressor, memoryStore: store });
}

async function chat(agent: Agent, text: string): Promise<void> {
  record(`你：${text}`);
  const { answer, steps } = await agent.run(text);
  for (const step of steps) {
    const label =
      step.kind === "thought" ? "思考" : step.kind === "action" ? "行动" : step.kind === "observation" ? "观察" : "回答";
    record(`  [${label}] ${step.text}`);
  }
  record(`助手：${answer}`);
}

async function main(): Promise<void> {
  record("===== 会话一（首次启动，长期记忆为空） =====");
  const a1 = newAgent(makeCompressor(6));
  await chat(a1, "我叫小明，是一名前端工程师，平时主要用 TypeScript 写代码。");
  await chat(a1, "我们这个项目代号叫手搓 Agent，目标是零框架实现一个通用助手。");

  record("\n===== 会话二（模拟进程重启：对话历史清空，长期记忆从磁盘恢复） =====");
  const a2 = newAgent(makeCompressor(6));
  await chat(a2, "你还记得我是谁吗？我叫什么、做什么、项目代号是什么？");

  record("\n===== 会话三（压测短期记忆：窗口缩到 3，连续多轮后旧轮次被摘要） =====");
  const a3 = newAgent(makeCompressor(3));
  const topics = [
    "先帮我算 128 乘以 7 等于多少。",
    "再算 1024 减去 256 等于多少。",
    "把这两个结果加起来。",
    "现在问一个和前面都无关的问题：北京是中国的首都吗？",
    "继续：上海是不是中国首都？",
    "回到刚才，前面算的几个数里最大的那个是多少？",
    "再问：北京和上海，哪个是首都？",
  ];
  for (const t of topics) await chat(a3, t);

  writeFileSync(join(tmpdir(), "agent-demo-trace.txt"), log.join("\n"));
  record("\n[done] trace written");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
