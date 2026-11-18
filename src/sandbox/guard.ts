import type {
  ApprovalResult,
  AuditEvent,
  AuditLog,
  AuditOutcome,
  PermissionDecision,
  PermissionRequest,
  Policy,
  Approver,
} from "./types.js";

/**
 * ToolGuard：把策略、审批、审计三件事串成一条授权流水线。
 *
 * 这是第 10 篇的核心组件。位置在「工具箱」与「工具实现」之间——
 * 模型看不见它，但每一个工具调用都要从它这里过。
 *
 * ```
 * 模型发起调用
 *    │
 *    ▼
 * ┌──────────┐  allow ──────────────► 放行
 * │ 策略判定 │  deny  ──────────────► 拒绝（观察文本回喂模型）
 * │ Policy   │  ask   ─► 人工审批 ──┬─ 批准 ─► 放行
 * └──────────┘                      └─ 驳回/超时 ─► 拒绝
 *    │
 *    ▼
 * 写入审计日志（决策 + 最终结果）
 * ```
 *
 * 三条不可让步的规则：
 *  - 审批超时 = 拒绝；
 *  - 审批器抛异常 = 拒绝；
 *  - 找不到审批器 = 拒绝。
 * 也就是「拿不到明确同意，一律视为没同意」。
 */

/** 权限被拒时抛出的异常：与「工具执行失败」区分开 */
export class PermissionDeniedError extends Error {
  /** "policy" = 策略直接拒绝；"approval" = 人工驳回或超时 */
  readonly kind: "policy" | "approval";
  readonly decision: PermissionDecision;

  constructor(kind: "policy" | "approval", decision: PermissionDecision) {
    super(decision.reason);
    this.name = "PermissionDeniedError";
    this.kind = kind;
    this.decision = decision;
  }
}

export type GuardOutcome =
  /** 策略直接放行 */
  | { status: "allow"; decision: PermissionDecision }
  /** 策略直接拒绝 */
  | { status: "deny"; decision: PermissionDecision }
  /** 人工审批通过 */
  | {
      status: "approved";
      decision: PermissionDecision;
      approval: ApprovalResult;
      approvalMs: number;
    }
  /** 人工驳回或审批超时 */
  | {
      status: "rejected";
      decision: PermissionDecision;
      approval: ApprovalResult;
      approvalMs: number;
    };

export interface ToolGuardOptions {
  /** 策略：产出决策 */
  policy: Policy;
  /** 审批器：策略说 ask 时由它裁决；不配则一律按拒绝处理 */
  approver?: Approver;
  /** 审计日志 */
  audit?: AuditLog;
  /** 审批超时毫秒，默认 60s */
  approvalTimeoutMs?: number;
  /** 调用来源标识，写进审计 */
  source?: string;
  /** 每次决策后的回调（演示脚本用来打印轨迹） */
  onDecision?: (info: {
    tool: string;
    args: Record<string, unknown>;
    outcome: GuardOutcome;
    approvalMs?: number;
  }) => void;
}

export class ToolGuard {
  private readonly policy: Policy;
  private readonly approver?: Approver;
  private readonly audit?: AuditLog;
  private readonly approvalTimeoutMs: number;
  private readonly source?: string;
  private readonly onDecision?: ToolGuardOptions["onDecision"];

  constructor(options: ToolGuardOptions) {
    this.policy = options.policy;
    this.approver = options.approver;
    this.audit = options.audit;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 60_000;
    this.source = options.source;
    this.onDecision = options.onDecision;
  }

  /**
   * 只做授权判定，不执行工具。
   *
   * 单独暴露这个方法是为了让「判断」和「执行」可以分开：
   * 前端可以先问一遍要不要执行，再决定是否真的调用。
   */
  async authorize(tool: string, args: Record<string, unknown>): Promise<GuardOutcome> {
    const req: PermissionRequest = {
      tool,
      args,
      ...(this.source !== undefined ? { source: this.source } : {}),
    };

    const decision = this.policy.evaluate(req);

    if (decision.decision === "allow") {
      const outcome: GuardOutcome = { status: "allow", decision };
      this.onDecision?.({ tool, args, outcome });
      return outcome;
    }

    if (decision.decision === "deny") {
      const outcome: GuardOutcome = { status: "deny", decision };
      this.onDecision?.({ tool, args, outcome });
      return outcome;
    }

    // decision === "ask"：交给人
    const started = Date.now();
    const { result, timedOut } = await this.requestApproval(req, decision);
    const approvalMs = Date.now() - started;

    let outcome: GuardOutcome;
    if (timedOut) {
      outcome = {
        status: "rejected",
        decision: {
          decision: "deny",
          reason: `人工审批超时（${this.approvalTimeoutMs}ms），按拒绝处理`,
          ruleId: decision.ruleId,
        },
        approval: { approved: false, reason: "审批超时", approver: this.approver?.name },
        approvalMs,
      };
    } else if (result.approved) {
      outcome = { status: "approved", decision, approval: result, approvalMs };
    } else {
      outcome = {
        status: "rejected",
        decision: {
          decision: "deny",
          reason: result.reason
            ? `人工审批未通过：${result.reason}`
            : "人工审批未通过",
          ruleId: decision.ruleId,
        },
        approval: result,
        approvalMs,
      };
    }
    this.onDecision?.({ tool, args, outcome, approvalMs });
    return outcome;
  }

  /**
   * 授权 + 执行 + 审计，一条龙。
   *
   * 审计记录的是**最终结果**（executed / denied / rejected / error），
   * 而不只是决策——「批准了但执行失败」和「批准了且执行成功」在审计上必须可区分。
   */
  async execute<T>(
    tool: string,
    args: Record<string, unknown>,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const outcome = await this.authorize(tool, args);

    if (outcome.status === "deny") {
      await this.writeAudit(tool, args, outcome, "denied");
      throw new PermissionDeniedError("policy", outcome.decision);
    }
    if (outcome.status === "rejected") {
      await this.writeAudit(tool, args, outcome, "rejected");
      throw new PermissionDeniedError("approval", outcome.decision);
    }

    try {
      const result = await fn();
      await this.writeAudit(tool, args, outcome, "executed");
      return result;
    } catch (err) {
      await this.writeAudit(tool, args, outcome, "error");
      throw err;
    }
  }

  /** 请求人工审批：带超时，审批器异常一律按拒绝处理 */
  private async requestApproval(
    req: PermissionRequest,
    proposed: PermissionDecision,
  ): Promise<{ result: ApprovalResult; timedOut: boolean }> {
    if (!this.approver) {
      return {
        result: {
          approved: false,
          reason: "策略要求人工审批，但当前没有可用的审批人，按拒绝处理",
          approver: "none",
        },
        timedOut: false,
      };
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.approver.approve({ ...req, proposed }),
        new Promise<ApprovalResult>((resolvePromise) => {
          timer = setTimeout(
            () =>
              resolvePromise({
                approved: false,
                reason: "审批超时",
                approver: this.approver?.name,
              }),
            this.approvalTimeoutMs,
          );
        }),
      ]);
      const timedOut = result.reason === "审批超时";
      return { result, timedOut };
    } catch (err) {
      // 审批器自己坏了 → 当作没有批准
      return {
        result: {
          approved: false,
          reason: `审批器异常：${err instanceof Error ? err.message : String(err)}`,
          approver: this.approver.name,
        },
        timedOut: false,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 写审计：失败不阻断主流程（由 AuditLog 实现内部兜底） */
  private async writeAudit(
    tool: string,
    args: Record<string, unknown>,
    outcome: GuardOutcome,
    result: AuditOutcome,
  ): Promise<void> {
    if (!this.audit) return;
    const event: AuditEvent = {
      ts: new Date().toISOString(),
      tool,
      args: summarizeArgs(args),
      decision:
        outcome.status === "allow" || outcome.status === "approved" ? "allow" : "deny",
      outcome: result,
      reason: outcome.decision.reason,
      ...(outcome.decision.ruleId ? { ruleId: outcome.decision.ruleId } : {}),
      ...(outcome.status === "approved" || outcome.status === "rejected"
        ? { approver: outcome.approval.approver ?? this.approver?.name }
        : {}),
      ...(outcome.status === "approved" || outcome.status === "rejected"
        ? { approvalMs: outcome.approvalMs }
        : {}),
    };
    await this.audit.record(event);
  }
}

/** 参数摘要：截断，避免审计文件被大参数撑爆 */
function summarizeArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 400 ? `${s.slice(0, 400)}…` : s;
  } catch {
    return "(参数无法序列化)";
  }
}
