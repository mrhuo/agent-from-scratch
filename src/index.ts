import dotenv from "dotenv";
// override: true —— 本地 .env 优先于外层已注入的环境变量（如 CI / 沙箱预设的 OPENAI_API_KEY），
// 避免「明明填了 key，发出去的却是别处的 key」这种静默覆盖坑。
dotenv.config({ override: true });
import { LLMClient } from "./llm/index.js";
import { Agent, ToolRegistry } from "./agent/index.js";
import type { AgentStep } from "./agent/index.js";
import { allTools } from "./tools/index.js";
import { MemoryStore } from "./memory/MemoryStore.js";
import { ContextCompressor, LLMSummarizer } from "./memory/ContextCompressor.js";
import { createRememberTool, createRecallTool } from "./tools/memory.js";
import { join } from "node:path";
import * as readline from "node:readline";

/**
 * 第 6 篇配套 demo：在「思考 → 行动 → 观察」循环之上，加上两种记忆。
 *  - 短期记忆：历史轮次超阈值时自动摘要，防止上下文溢出窗口。
 *  - 长期记忆：remember / recall 两个工具把事实落盘到 data/memory.json，
 *    并自动把与本轮问题相关的事实注入 system 提示，跨会话都记得住。
 */
const STEP_LABEL: Record<AgentStep["kind"], string> = {
  thought: "思考",
  action: "行动",
  observation: "观察",
  answer: "回答",
};

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("缺少 OPENAI_API_KEY，请复制 .env.example 为 .env 并填入");
    process.exit(1);
  }

  const client = new LLMClient({
    apiKey,
    baseURL: process.env.BASE_URL || undefined,
    model: process.env.MODEL ?? "gpt-4o-mini",
  });

  // 长期记忆：落盘到项目目录下的 data/memory.json（已加入 .gitignore，不会进提交）。
  const memoryStore = new MemoryStore(join(process.cwd(), "data", "memory.json"));

  // 短期记忆：用 LLM 把旧轮次压成摘要；保留最近 6 个用户轮原样。
  const compressor = new ContextCompressor(new LLMSummarizer(client), 6);

  // 第 4 篇的四大真工具 + 第 6 篇的两个记忆工具，全部收编进注册表。
  // 新增工具只需在对应 index 里加一项，Agent 内核一行都不用改。
  const registry = new ToolRegistry().registerAll([
    ...allTools,
    createRememberTool(memoryStore),
    createRecallTool(memoryStore),
  ]);
  const agent = new Agent(client, { registry, maxSteps: 8, compressor, memoryStore });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  // 用 line 事件 + 队列，避免 question 在异步 await 期间因管道 EOF 关闭而抛 ERR_USE_AFTER_CLOSE。
  const queue: string[] = [];
  let resolveNext: ((value: string | null) => void) | null = null;
  let eof = false;
  rl.on("line", (line) => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(line);
    } else {
      queue.push(line);
    }
  });
  rl.on("close", () => {
    eof = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(null);
    }
  });

  const nextLine = (): Promise<string | null> =>
    new Promise((resolve) => {
      if (queue.length > 0) {
        resolve(queue.shift() ?? "");
        return;
      }
      if (eof) {
        resolve(null);
        return;
      }
      resolveNext = resolve;
    });

  console.log("Agent 对话开始（输入 exit 退出）");
  while (true) {
    // 用户输入统一加「你：」前缀，与助手回复的「助手：」对称，便于阅读多轮对话。
    process.stdout.write("你：");
    const line = await nextLine();
    if (line === null) break; // EOF
    const text = line.trim();
    if (text === "") continue;
    if (text === "exit" || text === "quit") break;

    if (!process.stdin.isTTY) process.stdout.write(`${text}\n`);

    const { answer, steps } = await agent.run(text);
    for (const step of steps) {
      console.log(`  [${STEP_LABEL[step.kind]}] ${step.text}`);
    }
    console.log(`助手：${answer}`);
  }

  rl.close();
  console.log("对话结束。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
