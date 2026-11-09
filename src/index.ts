import dotenv from "dotenv";
// override: true —— 本地 .env 优先于外层已注入的环境变量（如 CI / 沙箱预设的 OPENAI_API_KEY），
// 避免「明明填了 key，发出去的却是别处的 key」这种静默覆盖坑。
dotenv.config({ override: true });
import { LLMClient } from "./llm/index.js";
import type { Message } from "./llm/types.js";

/**
 * 第 1 篇配套 demo：跑通一次流式对话。
 * 真正的 Agent 循环在篇 3 才出现，这里先验证「模型能对话」这条最短路。
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

  const messages: Message[] = [
    { role: "system", content: "你是一个简洁的中文助手，回答不超过两句话。" },
    { role: "user", content: "用一句话解释什么是 AI Agent。" },
  ];

  process.stdout.write("助手：");
  for await (const chunk of client.chatStream(messages)) {
    process.stdout.write(chunk);
  }
  process.stdout.write("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
