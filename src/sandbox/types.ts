/**
 * 第 10 篇：权限与沙箱的类型定义。
 *
 * 这一层刻意做得很薄——只有类型，没有实现。
 * 目的是让「权限」这件事在整套代码里有唯一的词汇表：
 * 策略（Policy）产出决策、审批器（Approver）消费决策、审计（AuditLog）记录决策、
 * 守卫（ToolGuard）把这三者串起来。
 *
 * 三个核心概念：
 *
 *  1. **参数级权限**：决策不只看工具名，还看这次调用的**参数值**。
 *     「readFile 允许」太粗——允许读 `data/notes.txt`，不等于允许读 `.env`。
 *
 *  2. **三态决策**：allow / deny / ask。
 *     两态（允许/拒绝）在真实系统里不够用：很多操作既不该自动放行，
 *     也不该一票否决——它们需要人来看一眼再定。三态是「ask」存在的理由。
 *
 *  3. **fail-closed**：任何不确定都倒向拒绝。策略匹配器抛异常、审批人超时、
 *     找不到对应的规则——一律拒绝。安全系统的默认答案必须是「不」。
 */

/** 权限决策的三态 */
export type Decision = "allow" | "deny" | "ask";

/** 一次工具调用的授权请求 */
export interface PermissionRequest {
  /** 被调用的工具名（如 readFile、mcp__taskboard__add_task） */
  tool: string;
  /** 已通过参数校验的参数对象 */
  args: Record<string, unknown>;
  /** 调用来源标识（如角色名、Agent 名），用于审计与策略区分 */
  source?: string;
}

/** 策略给出的决策结果 */
export interface PermissionDecision {
  decision: Decision;
  /** 人类可读理由：会写进审计日志，也会出现在被拒绝时的观察文本里 */
  reason: string;
  /** 命中规则的 id，便于回溯是哪条规则起了作用 */
  ruleId?: string;
}

/**
 * 一条权限规则。
 *
 * 规则是「条件 + 决策」的组合，条件由匹配器（matcher）给出。
 * 匹配器只吃请求，不做 I/O、不抛错之外的事，保证求值是纯函数、易测试。
 */
export interface PermissionRule {
  id: string;
  /** 规则说明，写给人看的 */
  description: string;
  /** 命中条件 */
  when: (req: PermissionRequest) => boolean;
  /** 命中后的决策 */
  decision: Decision;
  /** 命中后的理由；不填则用规则描述 */
  reason?: string;
}

/** 策略：把一次请求映射为一个决策 */
export interface Policy {
  readonly name: string;
  evaluate(req: PermissionRequest): PermissionDecision;
}

/** 交给人工裁决的请求 */
export interface ApprovalRequest extends PermissionRequest {
  /** 策略给出的初步判断（恒为 "ask"），供审批人参考 */
  proposed: PermissionDecision;
}

/** 人工裁决结果 */
export interface ApprovalResult {
  approved: boolean;
  reason?: string;
  /** 审批人标识（用户名、通道名等），写进审计 */
  approver?: string;
}

/** 审批器：策略说「ask」时，由它裁决 */
export interface Approver {
  readonly name: string;
  approve(req: ApprovalRequest): Promise<ApprovalResult>;
}

/** 审计事件的终态 */
export type AuditOutcome =
  /** 放行且执行成功 */
  | "executed"
  /** 被策略拒绝 */
  | "denied"
  /** 人工驳回 */
  | "rejected"
  /** 放行但执行抛异常 */
  | "error";

/** 一次授权的完整审计记录 */
export interface AuditEvent {
  /** ISO 时间戳 */
  ts: string;
  tool: string;
  /** 参数摘要（JSON 字符串，截断） */
  args: string;
  /** 最终决策 */
  decision: Decision;
  /** 实际发生的结果 */
  outcome: AuditOutcome;
  reason: string;
  ruleId?: string;
  approver?: string;
  /** 审批耗时（毫秒），仅人工审批路径有值 */
  approvalMs?: number;
}

/** 审计日志：只追加，不可改 */
export interface AuditLog {
  record(event: AuditEvent): void | Promise<void>;
  /** 读取已记录的审计事件（内存实现与文件实现都支持） */
  list(): AuditEvent[];
}
