import { z } from "zod";
import type { Tool } from "../agent/tools.js";
import type { MemoryStore } from "../memory/MemoryStore.js";

/**
 * 长期记忆的「主动」形态：把记忆暴露成两个工具，让模型**自己决定**
 * 什么时候记、记什么、什么时候想起来查。
 *
 * 这是 Agent 记忆与「固定提示词」最不同的地方：记忆不是写死在系统提示里，
 * 而是模型在推理过程中按需存取的状态。两个工具闭包绑定同一个 MemoryStore，
 * 因此无论 Agent 在哪一轮调用，落地的文件都是同一份。
 */

/** 记住一条事实：写入长期记忆（落盘到 MemoryStore 对应的文件） */
export function createRememberTool(store: MemoryStore): Tool<z.ZodObject<{
  key: z.ZodString;
  content: z.ZodString;
}>> {
  const params = z.object({
    key: z.string().describe('简短主题，例如「用户的名字」「项目代号」「常用语言」'),
    content: z.string().describe("要长期记住的具体内容，尽量完整、自包含"),
  });
  return {
    name: "remember",
    description:
      "把一条对用户有价值、需要在未来会话里还能回忆起来的事实、偏好或结论长期记住。" +
      "例如用户告诉你他叫什么、偏好哪种语言、项目代号是什么。参数 key 是简短主题，content 是具体内容。",
    parameters: params,
    execute: async (args) => {
      const entry = await store.save(args.key, args.content);
      return `已记住（id=${entry.id}）：[${args.key}] ${args.content}`;
    },
  };
}

/** 回忆：从长期记忆里按关键词检索相关事实 */
export function createRecallTool(store: MemoryStore): Tool<z.ZodObject<{
  query: z.ZodString;
}>> {
  const params = z.object({
    query: z.string().describe("要回忆的主题或关键词，例如「用户的名字」「项目代号」"),
  });
  return {
    name: "recall",
    description:
      "从长期记忆里检索与某个主题相关的事实。当用户的问题可能涉及之前记住的信息时调用，" +
      "例如「我叫什么」「项目代号是什么」。参数 query 是关键词或问题，返回匹配的记忆条目。",
    parameters: params,
    execute: async (args) => {
      const hits = await store.search(args.query, 5);
      if (hits.length === 0) return "长期记忆里没有相关内容。";
      return hits.map((h) => `[${h.key}] ${h.content}`).join("\n");
    },
  };
}
