import type { LLMClient } from "../llm/index.js";
import type { Message } from "../llm/types.js";
import { Agent, ToolRegistry } from "../agent/index.js";
import type { AnyTool } from "../agent/tools.js";
import type { ContextCompressor } from "../memory/ContextCompressor.js";
import type { MemoryStore } from "../memory/MemoryStore.js";
import type {
  AgentRole,
  Assignment,
  CollaborationResult,
  WorkerResult,
} from "./types.js";

/**
 * 协调者（Orchestrator）：把任务分派给多个专家 Worker，并汇总结果。
 *
 * 设计原则：**复用**，不重造。每个 Worker 就是第 2-7 篇的 Agent 实例，
 * 只是注入了不同的 systemPrompt 与工具白名单。协调者只做三件事：
 *   1. createWorker —— 按角色装配一个 Agent（工具白名单 + 角色提示）；
 *   2. runPipeline  —— 串行流水线，前序产出传给后序（有依赖的任务）；
 *   3. runParallel  —— 并行分派独立子任务，再汇总（无依赖的任务）。
 *
 * 两种模式对应多 Agent 协作的两种基本形态：链式交接（handoff）与并行分治（fan-out/fan-in）。
 */
export class Orchestrator {
  constructor(
    private readonly client: LLMClient,
    private readonly options: {
      /** 全部可用工具，createWorker 时按角色白名单取子集 */
      tools?: AnyTool[];
      /** 记忆与压缩能力按角色透传给每个 Worker（可选） */
      memoryStore?: MemoryStore;
      compressor?: ContextCompressor;
      maxSteps?: number;
    } = {},
  ) {}

  /**
   * 按角色装配一个 Worker。
   * 工具白名单在这里落地：只把 role.tools 里点名的工具注册进该 Worker 的注册表，
   * 其余工具对它「不可见」——从能力层面限制越权，而非仅靠提示词约束。
   */
  createWorker(role: AgentRole): Agent {
    const registry = new ToolRegistry();
    for (const tool of this.options.tools ?? []) {
      if (role.tools.includes(tool.name)) {
        registry.register(tool);
      }
    }
    return new Agent(this.client, {
      registry,
      systemPrompt: role.systemPrompt,
      maxSteps: this.options.maxSteps ?? 8,
      memoryStore: this.options.memoryStore,
      compressor: this.options.compressor,
    });
  }

  /**
   * 串行流水线：任务依次流过每个角色，前一角色的产出作为后一角色的上下文。
   * 适合有依赖的任务（先调研、再写作、后审核）。
   * 最终答复取流水线末端角色的产出（审核员给出的是「修订后的最终版本」）。
   */
  async runPipeline(task: string, roles: AgentRole[]): Promise<CollaborationResult> {
    if (roles.length === 0) {
      throw new Error("runPipeline: 至少需要一个角色");
    }
    const results: WorkerResult[] = [];
    let prior = "";

    for (const role of roles) {
      const worker = this.createWorker(role);
      const assignment = prior
        ? `团队任务：${task}\n\n前序成员产出：\n${prior}\n\n当前职责：${role.title}——基于以上信息完成你的部分，并把结果写清楚。`
        : `团队任务：${task}\n\n当前职责：${role.title}——完成你的部分，并把结果写清楚。`;
      const { answer, steps } = await worker.run(assignment);
      results.push({ role: role.name, title: role.title, task: assignment, answer, steps });
      prior = `${prior}\n\n【${role.title}】${answer}`.trim();
    }

    return { results, finalAnswer: results[results.length - 1]!.answer };
  }

  /**
   * 并行分派：每个成员拿到一个独立子任务，同时执行（Promise.all），
   * 再由一次 LLM 调用把各成员产出汇总成最终答复。
   * 适合彼此无依赖、可同时推进的任务（fan-out / fan-in）。
   */
  async runParallel(assignments: Assignment[]): Promise<CollaborationResult> {
    if (assignments.length === 0) {
      throw new Error("runParallel: 至少需要一个任务");
    }
    const results = await Promise.all(
      assignments.map(async ({ role, task }) => {
        const worker = this.createWorker(role);
        const assignment = `任务上下文：${task}\n\n当前职责：${role.title}——独立完成你的部分。`;
        const { answer, steps } = await worker.run(assignment);
        return { role: role.name, title: role.title, task: assignment, answer, steps };
      }),
    );
    const finalAnswer = await this.synthesize(assignments.map((a) => a.task).join("；"), results);
    return { results, finalAnswer };
  }

  /** 汇总：用中性系统提示把各成员产出合成为一段连贯答复 */
  private async synthesize(task: string, results: WorkerResult[]): Promise<string> {
    const digest = results.map((r) => `【${r.title}】${r.answer}`).join("\n\n");
    const messages: Message[] = [
      {
        role: "system",
        content:
          "你是团队协调者。汇总各成员的产出，写成一段连贯、无重复的最终答复。" +
          "只输出最终答复本身，不要复述成员姓名或步骤编号，不要调用工具。",
      },
      {
        role: "user",
        content: `团队总任务：${task}\n\n各成员产出：\n\n${digest}\n\n请综合成最终答复。`,
      },
    ];
    return this.client.chat(messages);
  }
}
