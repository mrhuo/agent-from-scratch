import { z } from "zod";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Dirent } from "node:fs";
import type { Tool } from "../agent/tools.js";
import { PathSandbox } from "../sandbox/paths.js";
import { DATA_ROOT } from "./root.js";

const TEXT_EXT =
  /\.(txt|md|markdown|json|csv|log|js|ts|tsx|jsx|py|xml|yaml|yml)$/i;
const MAX_HITS = 20;
const LINE_MAX = 140;

/**
 * 检索用的沙箱：只管「能进哪个目录」，不管扩展名。
 *
 * 与读写沙箱分开是有意的——检索是在目录里挑文件，扩展名由工具自己的
 * TEXT_EXT 过滤决定；而读写是逐个文件落地，必须卡死扩展名与大小。
 * 两类操作的风险模型不同，用两个沙箱比用一个「什么都能放行」的沙箱更清楚。
 */
function searchSandbox(): PathSandbox {
  return new PathSandbox({ roots: [DATA_ROOT] });
}

const searchParams = z.object({
  query: z.string().describe("要搜索的关键词（大小写不敏感）"),
  root: z
    .string()
    .optional()
    .describe("搜索根目录，相对 data/ 目录；默认就是 data/ 本身"),
  maxResults: z.number().optional().describe("最多返回多少个命中，默认 20"),
});

function walk(dir: string, visit: (file: string) => void): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 无权限或不存在的目录直接跳过，不阻断整体搜索
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, visit);
    } else if (entry.isFile()) {
      visit(full);
    }
  }
}

/**
 * searchFiles：在本地资料目录递归搜索关键词。
 *
 * 为什么第 4 篇先做「本地搜索」而不是直连搜索引擎？
 *  - 完全离线可复现，不依赖任何外部 API 或 key；
 *  - 覆盖「找一下我之前记过的某某」这类最高频的真实需求；
 *  - 网络搜索放到第 9 篇（MCP）再接，那里才需要纠结搜索 API 与配额。
 *
 * 第 10 篇起，检索根目录也走统一的路径沙箱：相对路径以 data/ 为基准解析，
 * 越出沙箱的根目录在遍历之前就被拒绝。
 */
export const searchFiles: Tool<typeof searchParams> = {
  name: "searchFiles",
  description:
    '在本地资料目录中按关键词搜索文件内容，返回命中的「文件路径:行号:该行内容」。用于「之前记过的某某在哪」这类需求。',
  parameters: searchParams,
  execute: (args) => {
    const check = searchSandbox().check(args.root ?? ".");
    if (!check.ok) {
      throw new Error(`路径越权：${check.reason}`);
    }
    const root = check.absolute;
    const q = args.query.toLowerCase();
    const max = Math.min(args.maxResults ?? MAX_HITS, MAX_HITS);
    const hits: string[] = [];

    walk(root, (file) => {
      if (hits.length >= max) return;
      if (!TEXT_EXT.test(file)) return; // 只扫文本类文件，跳过二进制
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        return; // 读不了的跳过
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        if (line.toLowerCase().includes(q)) {
          hits.push(
            `${relative(root, file)}:${i + 1}: ${line.trim().slice(0, LINE_MAX)}`,
          );
          if (hits.length >= max) break;
        }
      }
    });

    if (hits.length === 0) {
      return `在 ${root} 中没有找到包含 "${args.query}" 的内容`;
    }
    return `命中 ${hits.length} 处：\n` + hits.join("\n");
  },
};
