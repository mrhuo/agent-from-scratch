import * as readline from "node:readline";
import type { ApprovalRequest, ApprovalResult, Approver } from "./types.js";

/**
 * 人工介入（human-in-the-loop）的审批器实现。
 *
 * 这一层的设计目标只有一个：**让「需要人点头」的操作真的能等人点头，
 * 同时保证「等不到人」时不会变成放行**。
 *
 * 三个必须处理的现实问题：
 *
 *  1. **超时**：人可能不在线。超时必须按拒绝处理（fail-closed）。
 *  2. **非交互环境**：CI、管道、后台任务里没有 TTY，
 *     此时 `readline.question` 会永远挂着（或者读到 EOF 立刻返回空）。
 *     所以非 TTY 环境下直接拒绝，而不是傻等。
 *  3. **审批记录**：谁批的、批的理由是什么，必须能落到审计日志里。
 */

/** 固定结果的审批器：测试与演示用 */
export class StaticApprover implements Approver {
  readonly name: string;
  private readonly result: ApprovalResult;

  constructor(result: ApprovalResult, name = "static") {
    this.result = result;
    this.name = name;
  }

  async approve(_req: ApprovalRequest): Promise<ApprovalResult> {
    return this.result;
  }
}

/** 一律拒绝的审批器：等效于「没有审批人」 */
export class DenyAllApprover implements Approver {
  readonly name = "deny-all";

  async approve(req: ApprovalRequest): Promise<ApprovalResult> {    return {
      approved: false,
      reason: `没有可用审批人，按拒绝处理（工具 ${req.tool}）`,
      approver: this.name,
    };
  }
}

/** 包装一个回调 */
export class CallbackApprover implements Approver {
  readonly name: string;
  private readonly fn: (req: ApprovalRequest) => Promise<ApprovalResult> | ApprovalResult;

  constructor(
    fn: (req: ApprovalRequest) => Promise<ApprovalResult> | ApprovalResult,
    name = "callback",
  ) {
    this.fn = fn;
    this.name = name;
  }

  async approve(req: ApprovalRequest): Promise<ApprovalResult> {
    return this.fn(req);
  }
}

/**
 * 依次按预设结果返回的审批器。
 *
 * 用途：演示与测试里，需要精确控制「第 1 次批准、第 2 次驳回」这类
 * 人工介入序列，又不想真的坐在终端前敲 y/n。
 */
export class SequenceApprover implements Approver {
  readonly name: string;
  private readonly results: ApprovalResult[];
  private index = 0;
  /** 已经发出的审批请求（演示脚本用来打印轨迹） */
  readonly requests: ApprovalRequest[] = [];

  constructor(results: ApprovalResult[], name = "sequence") {
    this.results = results;
    this.name = name;
  }

  async approve(req: ApprovalRequest): Promise<ApprovalResult> {
    this.requests.push(req);
    const result = this.results[Math.min(this.index, this.results.length - 1)];
    this.index += 1;
    return (
      result ?? {
        approved: false,
        reason: "预设审批序列已用尽，按拒绝处理",
        approver: this.name,
      }
    );
  }
}

export interface ConsoleApproverOptions {
  /** 超时毫秒数，默认 60s */
  timeoutMs?: number;
  /** 审批人标识，写进审计 */
  approver?: string;
  /** 输出流，默认 stderr（避免污染 stdout 的业务日志） */
  output?: NodeJS.WritableStream;
  /** 输入流，默认 stdin */
  input?: NodeJS.ReadableStream;
}

/**
 * 终端交互式审批器：问一句「允许吗」，等一个 y/n。
 *
 * 之所以问在 stderr 上：Agent 的正常输出走 stdout，审批提示混进去会让
 * 「程序输出」和「人在说话」糊在一起，日志没法看。
 */
export class ConsoleApprover implements Approver {
  readonly name: string;
  private readonly timeoutMs: number;
  private readonly approverName: string;
  private readonly output: NodeJS.WritableStream;
  private readonly input: NodeJS.ReadableStream;

  constructor(options: ConsoleApproverOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.approverName = options.approver ?? "console-user";
    this.output = options.output ?? process.stderr;
    this.input = options.input ?? process.stdin;
    this.name = "console";
  }

  async approve(req: ApprovalRequest): Promise<ApprovalResult> {
    // 非交互环境：没人能回答，直接拒绝，绝不阻塞等待
    if (!(this.input as NodeJS.ReadStream).isTTY) {
      return {
        approved: false,
        reason: "当前不是交互式终端，无法进行人工审批，按拒绝处理",
        approver: this.approverName,
      };
    }

    const rl = readline.createInterface({
      input: this.input as NodeJS.ReadableStream,
      output: this.output,
    });

    const question =
      `\n[人工审批] 工具 "${req.tool}" 需要你的确认\n` +
      `  参数：${safeJson(req.args)}\n` +
      `  理由：${req.proposed.reason}\n` +
      `  允许执行吗？(y/N) `;

    try {
      const answer = await this.ask(rl, question);
      const ok = /^\s*y(es)?\s*$/i.test(answer);
      return {
        approved: ok,
        reason: ok ? "人工批准" : "人工驳回",
        approver: this.approverName,
      };
    } finally {
      rl.close();
    }
  }

  /** 带超时的提问：超时后返回空串（= 驳回） */
  private ask(rl: readline.Interface, question: string): Promise<string> {
    return new Promise<string>((resolvePromise) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.output.write(`\n[人工审批] 等待超时（${this.timeoutMs}ms），按拒绝处理\n`);
        resolvePromise("");
      }, this.timeoutMs);

      rl.question(question, (answer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(answer);
      });
    });
  }
}

/** 参数摘要：截断到 200 字符，避免审批提示刷屏 */
function safeJson(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return "(参数无法序列化)";
  }
}
