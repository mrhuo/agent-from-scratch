import type { LLMClient } from "../llm/index.js";
import type { Message } from "../llm/types.js";
import { PlanSchema, type Plan, type StepResult } from "./types.js";

const PLAN_SYSTEM =
  "你是一个任务规划器。给定一个任务，把它拆解成若干**有序、可独立执行**的步骤。" +
  "每一步应该是一个明确的动作（例如「用计算器算 17 的平方」「在本地资料里搜索关键词 Agent」「读取某文件」），" +
  "而不是一顶子目标的大帽子。步骤数量通常 2 到 5 步，过多则合并，过少则不必拆。" +
  "只输出 JSON，格式：{\"goal\":\"...\",\"steps\":[\"...\",\"...\"]}。不要输出任何解释或多余文字。";

const REVISE_SYSTEM =
  "你是一个任务规划器，负责在**执行偏离或某步失败**时重新规划剩余工作。" +
  "已知哪些步骤已完成、哪一步失败及其原因，请规划出**尚未完成**的步骤（不要重复已完成步骤）。" +
  "只输出 JSON，格式：{\"goal\":\"...\",\"steps\":[\"...\",\"...\"]}。不要输出任何解释或多余文字。";

/**
 * 规划器：把「自然语言任务」变成「有序步骤清单」。
 *
 * 与 Agent 内核解耦——它只依赖 LLMClient 的 `chat`（非流式文本），
 * 不关心工具、不关心循环。两种能力：
 *  - createPlan：首次规划整份任务；
 *  - revisePlan：执行某步失败后，基于已完成步骤与失败原因，重规划剩余步骤。
 *
 * 结构化输出靠「提示词要求只输出 JSON」+ 可选的 json_mode 双保险，
 * parsePlan 再做一层容错（抠出文本里第一个 {...} 块），避免模型多嘴导致解析失败。
 */
export class Planner {
  constructor(
    private readonly client: LLMClient,
    private readonly options: { jsonMode?: boolean } = {},
  ) {}

  async createPlan(task: string): Promise<Plan> {
    const messages: Message[] = [
      { role: "system", content: PLAN_SYSTEM },
      { role: "user", content: `任务：${task}\n\n请把它拆解成若干有序步骤。` },
    ];
    const raw = await this.client.chat(messages, {
      jsonMode: this.options.jsonMode,
      temperature: 0.3,
    });
    return parsePlan(raw, "createPlan");
  }

  async revisePlan(
    goal: string,
    doneSteps: StepResult[],
    failedStep: string,
    reason: string,
  ): Promise<Plan> {
    const doneText = doneSteps.length
      ? doneSteps
          .map((s, i) => `步骤${i + 1}「${s.step}」→ ${s.result}`)
          .join("；")
      : "（无）";
    const messages: Message[] = [
      { role: "system", content: REVISE_SYSTEM },
      {
        role: "user",
        content:
          `总体目标：${goal}\n\n` +
          `已完成：${doneText}\n\n` +
          `第 ${doneSteps.length + 1} 步「${failedStep}」执行失败，原因：${reason}\n\n` +
          `请重新规划**剩余**要做的事（不要重复已完成步骤），给出新的有序步骤列表。`,
      },
    ];
    const raw = await this.client.chat(messages, {
      jsonMode: this.options.jsonMode,
      temperature: 0.3,
    });
    return parsePlan(raw, "revisePlan");
  }
}

/** 把模型返回的（可能夹带废话的）文本解析成受 Zod 校验的计划 */
function parsePlan(raw: string, who: string): Plan {
  const text = raw.trim();
  let jsonStr = text;
  // 兜底：模型可能在 JSON 前后多嘴，抠出第一个 {...} 块
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    jsonStr = text.slice(start, end + 1);
  }
  let data: unknown;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Planner.${who}: 返回的并非合法 JSON —— ${text.slice(0, 200)}`);
  }
  const parsed = PlanSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Planner.${who}: 计划结构不符合预期 ${parsed.error.message}`);
  }
  if (parsed.data.steps.length === 0) {
    throw new Error(`Planner.${who}: 计划不能为空（至少要有一步）`);
  }
  return parsed.data;
}
