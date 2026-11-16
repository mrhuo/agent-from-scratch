import type { AgentStep } from "../agent/index.js";

/**
 * 角色定义：一个 Worker 的「身份」。
 *
 * 多 Agent 协作的关键不是再造一个 Agent 内核，而是给同一个内核配不同的：
 *  - systemPrompt：职责边界（我是谁、只做什么、不做什么）；
 *  - tools：工具白名单（这个角色被允许用哪些工具，权限最小化）。
 * 换角色 = 换这两项配置，内核循环一行不用改。
 */
export interface AgentRole {
  /** 角色标识，如 researcher / writer / reviewer */
  name: string;
  /** 中文显示名，用于日志与结果标注 */
  title: string;
  /** 注入到该角色 system 消息里的职责提示 */
  systemPrompt: string;
  /** 允许使用的工具名白名单；空数组表示纯推理角色（无工具） */
  tools: string[];
}

/** 并行分派时，一个成员领到的独立子任务 */
export interface Assignment {
  role: AgentRole;
  task: string;
}

/** 单个 Worker 的执行结果 */
export interface WorkerResult {
  role: string;
  title: string;
  task: string;
  answer: string;
  steps: AgentStep[];
}

/** 一次协作的完整产出：各成员结果 + 汇总后的最终答复 */
export interface CollaborationResult {
  results: WorkerResult[];
  finalAnswer: string;
}
