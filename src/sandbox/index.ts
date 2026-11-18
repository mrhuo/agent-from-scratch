/**
 * 第 10 篇：权限与沙箱。
 *
 * 目录结构：
 *   types.ts   —— 权限词汇表：决策三态、规则、策略、审批器、审计事件
 *   rules.ts   —— 参数级规则 DSL：按参数路径取值 + 匹配器 + 组合子
 *   policy.ts  —— 策略引擎：顺序求值、默认拒绝、多策略合并
 *   paths.ts   —— 路径沙箱：根目录 / 扩展名 / 大小 / 符号链接四道边界
 *   approver.ts—— 人工审批器：终端交互、超时、异常，全部按拒绝兜底
 *   audit.ts   —— 审计日志：内存与 JSONL 文件两种实现
 *   guard.ts   —— ToolGuard：策略 → 审批 → 执行 → 审计，一条流水线
 */
export type {
  Decision,
  PermissionRequest,
  PermissionDecision,
  PermissionRule,
  Policy,
  ApprovalRequest,
  ApprovalResult,
  Approver,
  AuditEvent,
  AuditOutcome,
  AuditLog,
} from "./types.js";

export {
  getArg,
  toolIs,
  toolStartsWith,
  argExists,
  argEquals,
  argIn,
  argMatches,
  argStartsWith,
  argUrlHostIn,
  argPathWithin,
  allOf,
  anyOf,
  not,
  rule,
  allowRule,
  denyRule,
  askRule,
} from "./rules.js";
export type { RuleOptions } from "./rules.js";

export { PolicyEngine, strictestOf, denyAllPolicy } from "./policy.js";
export type { PolicyEngineOptions } from "./policy.js";

export { PathSandbox } from "./paths.js";
export type { PathSandboxOptions, PathCheck } from "./paths.js";

export {
  StaticApprover,
  DenyAllApprover,
  CallbackApprover,
  SequenceApprover,
  ConsoleApprover,
} from "./approver.js";
export type { ConsoleApproverOptions } from "./approver.js";

export { MemoryAuditLog, FileAuditLog } from "./audit.js";
export type { FileAuditLogOptions } from "./audit.js";

export { ToolGuard, PermissionDeniedError } from "./guard.js";
export type { ToolGuardOptions, GuardOutcome } from "./guard.js";

export { defaultFileSandbox } from "./defaults.js";
export { defaultSandboxPolicy, defaultSandboxRules } from "./presets.js";
export type { SandboxPresetOptions } from "./presets.js";
