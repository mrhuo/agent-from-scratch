import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve, normalize, relative, isAbsolute } from "node:path";
import type { Tool } from "../agent/tools.js";
import { DATA_ROOT } from "./root.js";

const MAX_CHARS = 4000;

const readFileParams = z.object({
  path: z
    .string()
    .describe('要读取的文件路径，相对 data/ 目录，例如 "notes.txt" 或 "docs/plan.md"'),
});

/**
 * readFile：读取本地文本文件。
 *
 * 两个安全点：
 *  1) 把请求路径拼到 DATA_ROOT 下、算出相对路径后，若结果以 `..` 开头或仍是绝对路径，
 *     说明在试图越权（比如 `../.env`），直接抛错 —— 这一步在真正读盘之前就拦下。
 *  2) 读取结果超过 MAX_CHARS 时截断，避免把一整本大书塞进对话上下文。
 */
export const readFile: Tool<typeof readFileParams> = {
  name: "readFile",
  description:
    '读取本地资料目录中的文本文件内容（限 data/ 目录内，禁止越权）。用于查看用户提供的笔记、配置或文档，例如 "notes.txt"。',
  parameters: readFileParams,
  execute: (args) => {
    const target = resolve(DATA_ROOT, normalize("./" + args.path));
    const rel = relative(DATA_ROOT, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `路径越权：只允许读取 data/ 目录内的文件，收到 "${args.path}"`,
      );
    }
    let content: string;
    try {
      content = readFileSync(target, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") throw new Error(`文件不存在：${args.path}`);
      throw new Error(`读取失败：${e instanceof Error ? e.message : String(e)}`);
    }
    if (content.length > MAX_CHARS) {
      return (
        content.slice(0, MAX_CHARS) +
        `\n...（已截断，全文 ${content.length} 字）`
      );
    }
    return content;
  },
};
