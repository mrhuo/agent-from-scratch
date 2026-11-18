import { z } from "zod";
import { readFileSync } from "node:fs";
import type { Tool } from "../agent/tools.js";
import { defaultFileSandbox } from "../sandbox/defaults.js";

const MAX_CHARS = 4000;

const readFileParams = z.object({
  path: z
    .string()
    .describe('要读取的文件路径，相对 data/ 目录，例如 "notes.txt" 或 "docs/plan.md"'),
});

/**
 * readFile：读取本地文本文件。
 *
 * 第 4 篇时，路径检查是写在这个工具里的（拼到 DATA_ROOT 下再判前缀）。
 * 第 10 篇把它换成了全局沙箱（PathSandbox），理由有两个：
 *  - **口径统一**：readFile / searchFiles / writeFile / deleteFile 现在用同一套
 *    相对路径语义（都相对 data/ 目录）与同一套边界检查，不会出现
 *    「策略层判的是一个路径、工具实际访问的是另一个路径」这种错位；
 *  - **检查更严**：沙箱额外管住了符号链接、扩展名白名单与文件大小上限。
 *
 * 沙箱检查在真正读盘之前完成，越权路径根本不会走到 open()。
 */
export const readFile: Tool<typeof readFileParams> = {
  name: "readFile",
  description:
    '读取本地资料目录中的文本文件内容（限 data/ 目录内，禁止越权）。用于查看用户提供的笔记、配置或文档，例如 "notes.txt"。',
  parameters: readFileParams,
  execute: (args) => {
    const check = defaultFileSandbox().check(args.path);
    if (!check.ok) {
      throw new Error(`路径越权：${check.reason}`);
    }
    let content: string;
    try {
      content = readFileSync(check.absolute, "utf8");
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
