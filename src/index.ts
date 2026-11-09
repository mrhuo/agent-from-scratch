import dotenv from "dotenv";
// override: true —— 本地 .env 优先于外层已注入的环境变量（如 CI / 沙箱预设的 OPENAI_API_KEY），
// 避免「明明填了 key，发出去的却是别处的 key」这种静默覆盖坑。
dotenv.config({ override: true });
import { LLMClient } from "./llm/index.js";
import { Agent } from "./agent/index.js";
import { calculator, ToolRegistry } from "./agent/index.js";
import type { AgentStep } from "./agent/index.js";
import * as readline from "node:readline";

/**
 * 第 3 篇配套 demo：基于 Agent Loop + 工具注册表的交互式 REPL。
 * 终端输入一句，Agent 进入「思考 → 行动 → 观察」循环，可能调用注册表中的工具，
 * 最终给出回答；每轮把循环里的步骤打印出来，让"动手"过程可见。
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

  // 第 3 篇新增：先把工具收编进注册表，再交给 Agent。后续加搜索、读文件等工具，
  // 只要在这里 register 即可，Agent 内核一行都不用改。
  const registry = new ToolRegistry().register(calculator);
  const agent = new Agent(client, { registry, maxSteps: 6 });

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
