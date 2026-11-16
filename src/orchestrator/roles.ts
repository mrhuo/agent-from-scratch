import type { AgentRole } from "./types.js";

/**
 * 三个预定义专家角色，构成一条「调研 → 写作 → 审核」的协作流水线。
 *
 * 工具白名单体现「权限最小化」：
 *  - 研究员需要检索与读文件，拿到 searchFiles / readFile / webFetch；
 *  - 写手与审核员是纯推理角色，不拿任何工具——它们只消费前序产出，
 *    从机制上杜绝了「写手擅自改文件」这类越权。
 * 这与第 10 篇的权限沙箱是同一思路，这里先用角色白名单做轻量隔离。
 */

export const RESEARCHER: AgentRole = {
  name: "researcher",
  title: "研究员",
  systemPrompt:
    "你是资料研究员。职责：根据任务，用可用工具检索并收集客观事实、数据、出处。" +
    "只陈述能由工具观察支撑的内容，不臆测、不下最终结论、不做文学创作。" +
    "把收集到的事实整理成条理清晰的清单，作为后续成员的素材。",
  tools: ["searchFiles", "readFile", "webFetch"],
};

export const WRITER: AgentRole = {
  name: "writer",
  title: "写手",
  systemPrompt:
    "你是写手。职责：根据前面成员提供的事实素材，撰写一段通顺、准确的初稿。" +
    "不得编造素材里没有的事实；信息不足处要如实说明。" +
    "你不持有任何工具，只能基于已给出的上下文写作。",
  tools: [],
};

export const REVIEWER: AgentRole = {
  name: "reviewer",
  title: "审核员",
  systemPrompt:
    "你是审核员。职责：检查初稿的事实一致性、逻辑结构与表达，指出问题并给出修订建议。" +
    "你不持有任何工具，只基于已给出的上下文审核；" +
    "最后给出一段「修订后的最终版本」，供协调者直接采用。",
  tools: [],
};

/** 默认协作团队：调研 → 写作 → 审核 */
export const DEFAULT_TEAM: AgentRole[] = [RESEARCHER, WRITER, REVIEWER];
