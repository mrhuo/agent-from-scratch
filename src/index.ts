import dotenv from "dotenv";
// override: true —— 本地 .env 优先于外层已注入的环境变量（如 CI / 沙箱预设的 OPENAI_API_KEY），
// 避免「明明填了 key，发出去的却是别处的 key」这种静默覆盖坑。
dotenv.config({ override: true });
import { LLMClient } from "./llm/index.js";
import type { Message } from "./llm/types.js";
import * as readline from "node:readline";

/**
 * 第 1 篇配套 demo：交互式对话 REPL。
 * 终端输入一句，模型流式回复一句；多轮上下文累积在 messages 里。
 * 真正的 Agent 循环在篇 3 才出现，这里先验证「多轮对话」这条最短路。
 */
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

  // system 设定人设；之后每轮 user/assistant 交替追加，构成多轮上下文。
  const messages: Message[] = [
    { role: "system", content: "你是一个简洁的中文助手，每轮回答不超过三句话。" },
  ];

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

  console.log("对话开始（输入 exit 或按 Ctrl+C 退出）");
  while (true) {
    // 用户输入统一加「你：」前缀，与助手回复的「助手：」对称，便于阅读多轮对话。
    // TTY 下「你：」打印后由终端回显用户输入；非 TTY（管道/重定向）下输入不回显，
    // 故在拿到文本后补印到同一行，保证两种模式输出一致。
    process.stdout.write("你：");
    const line = await nextLine();
    if (line === null) break; // EOF
    const text = line.trim();
    if (text === "") continue;
    if (text === "exit" || text === "quit") break;

    if (!process.stdin.isTTY) process.stdout.write(`${text}\n`);
    messages.push({ role: "user", content: text });
    process.stdout.write("助手：");
    let full = "";
    for await (const chunk of client.chatStream(messages)) {
      process.stdout.write(chunk);
      full += chunk;
    }
    process.stdout.write("\n");
    messages.push({ role: "assistant", content: full });
  }

  rl.close();
  console.log("对话结束。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
