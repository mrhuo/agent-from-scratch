/**
 * 第 11 篇：持久化的统一词汇表。
 *
 * 本篇要区分三种「记住」：
 *  1. 长期记忆（第 6 篇）：跨会话的事实，存在 data/memory.json；
 *  2. 会话快照（本篇）：某一次会话在某一刻的完整上下文，存在 snapshot.json；
 *  3. 事件日志（本篇）：从快照之后发生的事，逐条追加到 events.jsonl。
 *
 * 前两者解决「记得住」，事件日志解决「崩了以后能接到哪儿」。把消息快照与
 * 事件日志分开，是因为两者写盘频率不同：快照大、写得少；事件小、写得勤。
 */
import type { Message } from "../llm/types.js";

/** 快照格式版本；不兼容变更时加一，加载时直接拒绝旧版本，避免静默错乱 */
export const SCHEMA_VERSION = 1;

/** 会话生命周期状态 */
export type SessionStatus =
  /** 已建好、空闲，等待下一轮输入 */
  | "active"
  /** 一轮执行中（事件可能只写了一半） */
  | "running"
  /** 上次进程退出时仍在 running —— 恢复时按此状态进入对账流程 */
  | "interrupted"
  /** 正常关闭 */
  | "closed";

/** 会话元信息 */
export interface SessionMeta {
  id: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  model?: string;
}

/**
 * 事件一律带单调递增的 seq，用于「快照之后重放」的切点判断。
 * 每条事件都同步落盘（appendFileSync），进程被强杀后最多丢最后一行未写完的字节。
 */
export type SessionEvent =
  | { seq: number; ts: string; type: "user_input"; text: string }
  | { seq: number; ts: string; type: "assistant_message"; message: Message }
  | {
      seq: number;
      ts: string;
      type: "tool_call";
      /** 与模型返回的 tool_call_id 一致，用作幂等键 */
      id: string;
      /** 同一轮多个工具调用共用一个 group，恢复时合并回一条 assistant 消息 */
      group: string;
      content: string;
      tool: string;
      args: Record<string, unknown>;
      /** 是否允许在结果丢失时重放执行 */
      replayable: boolean;
    }
  | {
      seq: number;
      ts: string;
      type: "tool_result";
      id: string;
      tool: string;
      observation: string;
      /** true = 结果未落盘且不可重放，观察文本是恢复器合成的提示 */
      uncertain?: boolean;
    }
  | { seq: number; ts: string; type: "status"; status: SessionStatus; reason?: string }
  | { seq: number; ts: string; type: "checkpoint"; reason: string; atSeq: number }
  | { seq: number; ts: string; type: "plan_created"; goal: string; steps: string[] }
  | {
      seq: number;
      ts: string;
      type: "plan_step";
      index: number;
      step: string;
      result: string;
      done: boolean;
    }
  | { seq: number; ts: string; type: "plan_done"; answer: string };

/** 事件主体（由 EventLog 补 seq 与 ts）；分布式 Omit，保留各分支的独有字段 */
export type SessionEventInput = SessionEvent extends infer E
  ? E extends SessionEvent
    ? Omit<E, "seq" | "ts">
    : never
  : never;

/** 在途工具调用 */
export interface PendingCall {
  id: string;
  group: string;
  tool: string;
  args: Record<string, unknown>;
  replayable: boolean;
  startedAt: string;
  /** 已落盘的结果；没有结果就是崩溃点 */
  result?: string;
  /** 结果是恢复器合成的警告，不是工具真实输出 */
  uncertain?: boolean;
}

/** 计划进度：runPlan 中断后可以接着已完成的步骤继续 */
export interface PlanProgress {
  goal: string;
  steps: string[];
  /** 下一个待执行步骤下标 */
  index: number;
  results: Array<{ step: string; result: string; done: boolean }>;
}

/** 某一时刻的完整会话状态 */
export interface SessionSnapshot {
  schemaVersion: number;
  meta: SessionMeta;
  /** 这份快照已经包含到哪一条事件 */
  lastSeq: number;
  messages: Message[];
  pending: PendingCall[];
  /** 已完成的工具调用结果表，按 tool_call_id 索引，用于幂等去重 */
  toolResults: Record<string, string>;
  plan?: PlanProgress;
}

/** 恢复结果，给调用方看的对账单 */
export interface RecoveryReport {
  sessionId: string;
  status: SessionStatus;
  /** 恢复出的消息条数 */
  messageCount: number;
  /** 从快照之后重放的事件条数 */
  replayedEvents: number;
  /** 历史调用结果命中、因此没有重复执行的条数 */
  dedupedCalls: string[];
  /** 结果丢失但可以安全重放的调用 */
  replayedCalls: string[];
  /** 结果丢失且不可重放、只能标记不确定的调用 */
  uncertainCalls: string[];
  plan?: PlanProgress;
  warnings: string[];
}
