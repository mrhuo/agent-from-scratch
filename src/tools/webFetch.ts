import { z } from "zod";
import type { Tool } from "../agent/tools.js";

const TIMEOUT_MS = 10_000;
const MAX_CHARS = 3000;

const webFetchParams = z.object({
  url: z.string().url().describe("要抓取的网页地址，必须是 http/https"),
  maxChars: z
    .number()
    .optional()
    .describe("返回正文最多多少字符，默认 3000"),
});

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * webFetch：抓取网页并返回去标签后的正文。
 *
 * 这是第一个「碰网络」的工具，也是第一个会「超时」的工具：
 *  - 用 AbortController 设 10s 上限，超时主动 abort，避免 Agent 卡死在等待里；
 *  - 抓回来的 HTML 去掉 script/style 与标签，只留可读文本；
 *  - 超长正文截断到 maxChars，防止把整页塞爆上下文。
 * 任何失败（超时、非 2xx、DNS 失败）都抛 Error，由注册表归类为 execution 观察。
 */
export const webFetch: Tool<typeof webFetchParams> = {
  name: "webFetch",
  description:
    "抓取一个网页并返回其正文文本（去除 HTML 标签），用于获取实时信息或网页内容。传入完整 http/https 地址。",
  parameters: webFetchParams,
  execute: async (args) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(args.url, {
        signal: controller.signal,
        headers: { "user-agent": "agent-from-scratch/0.1" },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const html = await res.text();
      const plain = stripHtml(html);
      const max = args.maxChars ?? MAX_CHARS;
      if (plain.length > max) {
        return (
          plain.slice(0, max) + ` ...（已截断，全文 ${plain.length} 字）`
        );
      }
      return plain.length ? plain : "（页面没有可读文本内容）";
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(`请求超时（>${TIMEOUT_MS / 1000}s）：${args.url}`);
      }
      throw new Error(`抓取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  },
};
