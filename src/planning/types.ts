import { z } from "zod";

/**
 * 计划 = 一份有序、可独立执行的步骤清单。
 * 这是 Plan-and-Execute 的核心产出：先「想清楚要分几步」，再「一步一步做」。
 */
export const PlanSchema = z.object({
  goal: z.string().describe("总体目标，用一句话概括任务要达成什么"),
  steps: z
    .array(z.string())
    .describe("有序的、可独立执行的步骤列表，每步一句话、一个明确动作"),
});

export type Plan = z.infer<typeof PlanSchema>;

/** 单个步骤的执行结果 */
export interface StepResult {
  step: string;
  result: string;
  /** 该步是否在子循环预算内收敛完成（false 表示撞上 maxSteps 上限，未跑通） */
  done: boolean;
}

/** runPlan 的返回：原始计划 + 各步结果 + 重规划次数 + 最终答复 */
export interface PlanRunResult {
  plan: Plan;
  stepResults: StepResult[];
  /** 执行过程中发生「某步失败并重规划」的次数 */
  revisions: number;
  answer: string;
}
