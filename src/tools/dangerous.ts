import { z } from "zod";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Tool } from "../agent/tools.js";
import { PathSandbox } from "../sandbox/paths.js";
import { defaultFileSandbox } from "../sandbox/defaults.js";

/**
 * 高风险工具：写文件、删文件、执行外部命令。
 *
 * 这三个工具存在的意义不是「方便」，而是给权限系统一个**可被拦截的对象**。
 * 只读工具（readFile / searchFiles / webFetch）永远不会造成不可逆损害，
 * 拿它们演示权限系统说服力不足——真正要防的是「写」「删」「执行」这三类。
 *
 * 两个层次的防护，两者的职责不同：
 *
 *  1. **工具自带的沙箱（硬边界）**：写在工具内部，写死它最多能碰哪些路径、
 *     能执行哪些程序。这层不随策略配置而放松——策略层再怎么写，
 *     也放宽不了工具内部的常量。相当于围栏。
 *
 *  2. **策略层的权限（软策略）**：决定某一次具体调用放不放行、
 *     要不要问人。相当于门禁：可以给某些人开后门，但翻不出围栏。
 *
 * 只做第 2 层是不够的——策略配置本身可能有 bug；
 * 只做第 1 层也不够——它粒度太粗，没法区分「写 .md」和「写 .ts」。
 */

export interface DangerousToolOptions {
  /** 文件类工具的路径沙箱，默认限制在 data/ 目录内 */
  sandbox?: PathSandbox;
  /** runCommand 允许执行的程序名（不含路径），默认只给几个只读命令 */
  allowedPrograms?: string[];
}

const writeFileParams = z.object({
  path: z.string().describe('要写入的文件路径，相对沙箱根目录，例如 "summary.txt"'),
  content: z.string().describe("要写入的文本内容"),
  append: z.boolean().optional().describe("是否追加到文件末尾，默认 false（覆盖写入）"),
});

/**
 * writeFile：往沙箱目录里写文本文件。
 *
 * 沙箱检查在真正落盘之前完成：路径越界、扩展名不在白名单、文件超限，
 * 都会在这里被拒绝——不依赖策略层是否配对。
 */
export function createWriteFileTool(options: DangerousToolOptions = {}): Tool<typeof writeFileParams> {
  const sandbox = options.sandbox ?? defaultFileSandbox();
  return {
    name: "writeFile",
    description:
      "把一段文本写入沙箱目录内的文件（默认只允许 data/ 目录下的文本文件）。" +
      "这是会产生副作用的操作，仅在明确需要产出文件时使用。",
    parameters: writeFileParams,
    execute: (args) => {
      const check = sandbox.check(args.path);
      if (!check.ok) {
        throw new Error(`写入被沙箱拒绝：${check.reason}`);
      }
      if (args.append && existsSync(check.absolute)) {
        appendFileSync(check.absolute, args.content, "utf8");
      } else {
        writeFileSync(check.absolute, args.content, "utf8");
      }
      const size = statSync(check.absolute).size;
      return `已写入 ${check.relativeToRoot}（${size} 字节）`;
    },
  };
}

const deleteFileParams = z.object({
  path: z.string().describe('要删除的文件路径，相对沙箱根目录，例如 "old.txt"'),
});

/**
 * deleteFile：删除沙箱目录内的文件。
 *
 * 刻意不支持目录删除：递归删目录的破坏力与一次手滑的距离太近，
 * 真有清理需求也应该逐文件删。
 */
export function createDeleteFileTool(options: DangerousToolOptions = {}): Tool<typeof deleteFileParams> {
  const sandbox = options.sandbox ?? defaultFileSandbox();
  return {
    name: "deleteFile",
    description:
      "删除沙箱目录内的一个文件（仅限单个文件，不支持目录）。这是不可逆操作，使用前请确认路径正确。",
    parameters: deleteFileParams,
    execute: (args) => {
      const check = sandbox.check(args.path);
      if (!check.ok) {
        throw new Error(`删除被沙箱拒绝：${check.reason}`);
      }
      if (!existsSync(check.absolute)) {
        throw new Error(`文件不存在：${args.path}`);
      }
      if (statSync(check.absolute).isDirectory()) {
        throw new Error(`拒绝删除目录：${check.relativeToRoot}`);
      }
      rmSync(check.absolute);
      return `已删除 ${check.relativeToRoot}`;
    },
  };
}

const runCommandParams = z.object({
  program: z
    .string()
    .describe("要执行的程序名，必须在允许清单里，例如 \"git\""),
  args: z
    .array(z.string())
    .optional()
    .describe("传给程序的参数列表，例如 [\"status\", \"--short\"]"),
});

/** 默认允许执行的程序：都是只读或低风险的 */
const DEFAULT_PROGRAMS = ["git", "node", "ls", "pwd", "echo"];

const CMD_TIMEOUT_MS = 10_000;
const CMD_MAX_CHARS = 2000;

/**
 * runCommand：执行一个外部程序。
 *
 * 两个刻意的限制：
 *  - **不经过 shell**：直接 spawn 可执行文件，参数以数组传入。
 *    走 shell 的话，`; rm -rf ...` 这类注入只需要一个字符串参数就能生效。
 *  - **程序名白名单**：只允许清单里的程序，且不解析 PATH 之外的路径，
 *    避免用绝对路径绕开白名单。
 */
export function createRunCommandTool(options: DangerousToolOptions = {}): Tool<typeof runCommandParams> {
  const allowed = options.allowedPrograms ?? DEFAULT_PROGRAMS;
  return {
    name: "runCommand",
    description:
      "执行一个本地命令（程序名必须在允许清单内，参数以数组传入，不经过 shell）。" +
      "这是本系统中风险最高的工具，执行外部命令前通常需要人工确认。",
    parameters: runCommandParams,
    execute: (args) =>
      new Promise<string>((resolvePromise, rejectPromise) => {
        const program = args.program;
        if (!allowed.includes(program)) {
          rejectPromise(
            new Error(
              `程序 "${program}" 不在允许清单里（允许：${allowed.join(", ")}）`,
            ),
          );
          return;
        }
        // 拒绝绝对路径与路径分隔符，防止用路径绕过白名单
        if (program.includes("/") || program.includes("\\") || program.includes("..")) {
          rejectPromise(new Error(`程序名必须是不带路径的可执行文件名，收到 "${program}"`));
          return;
        }

        const child = spawn(program, args.args ?? [], {
          cwd: process.cwd(),
          shell: false, // 关键：不走 shell，杜绝命令注入
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill();
          rejectPromise(new Error(`命令执行超时（>${CMD_TIMEOUT_MS}ms）`));
        }, CMD_TIMEOUT_MS);

        child.stdout?.on("data", (c: Buffer) => {
          stdout += c.toString();
        });
        child.stderr?.on("data", (c: Buffer) => {
          stderr += c.toString();
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          rejectPromise(new Error(`命令启动失败：${err.message}`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          const out = truncate(stdout, CMD_MAX_CHARS);
          const errText = truncate(stderr, CMD_MAX_CHARS);
          const header = `命令：${program} ${(args.args ?? []).join(" ")}（退出码 ${code ?? "null"}）`;
          const body = [out && `stdout:\n${out}`, errText && `stderr:\n${errText}`]
            .filter(Boolean)
            .join("\n");
          resolvePromise(body ? `${header}\n${body}` : header);
        });
      }),
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…（已截断）` : s;
}

/** 三个高风险工具的集合 */
export function createDangerousTools(options: DangerousToolOptions = {}): Tool<any>[] {
  return [
    createWriteFileTool(options),
    createDeleteFileTool(options),
    createRunCommandTool(options),
  ] as Tool<any>[];
}
