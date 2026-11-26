import type { ChatClient } from "../llm/index.js";
import type { ChatResult, ChatOptions, Message, ToolCall } from "../llm/types.js";
import { calculator, type AnyTool } from "./tools.js";
import { ToolRegistry } from "./registry.js";
import type { ContextCompressor } from "../memory/ContextCompressor.js";
import type { MemoryStore } from "../memory/MemoryStore.js";
import type { Planner } from "../planning/index.js";
import type { Plan } from "../planning/types.js";
import type { PlanRunResult, StepResult } from "../planning/types.js";
import { randomUUID } from "node:crypto";

/**
 * 可观测钩子（第 11 篇加入）。
 *
 * 只在状态变化的边界上留几个点，不改变循环任何判断：用户输入、模型回复、
 * 一次工具调用的发起与完成、一轮答复、以及规划器的四个节点。
 * 不挂钩子时行为与第 10 篇完全一致。
 */
export interface AgentHooks {
  onUserInput?(text: string): Promise<void> | void;
  onAssistantMessage?(message: Message): Promise<void> | void;
  /** 模型刚给出 tool_calls、工具还没执行——这是写「在途记录」的唯一正确时机 */
  onToolCalls?(content: string | null, calls: ToolCall[], group: string): Promise<void> | void;
  onToolResult?(call: ToolCall, observation: string): Promise<void> | void;
  onFinalAnswer?(answer: string): Promise<void> | void;
  onPlanCreated?(plan: Plan): Promise<void> | void;
  onPlanStep?(index: number, step: string, result: StepResult): Promise<void> | void;
  onPlanDone?(answer: string): Promise<void> | void;
}

export type StepKind = "thought" | "action" | "observation" | "answer";

export interface AgentStep {
  kind: StepKind;
  text: string;
}

export interface AgentRunResult {
  answer: string;
  steps: AgentStep[];
}

const DEFAULT_SYSTEM_PROMPT =
  "你是一个会使用工具的智能助手。你拥有若干工具，可以：用 calculator 做算术、用 readFile 读本地资料、" +
  "用 searchFiles 在资料中检索关键词、用 webFetch 抓取网页。遇到需要这些能力的问题，优先调用对应工具；" +
  "拿到工具返回的观察结果后继续推理。当信息已经足够回答用户时，直接给出最终答案，不要再调用工具。\n" +
  "关于多工具协作：如果多个工具调用彼此独立（例如同时抓取两个网页、同时读两个文件），" +
  "请在同一次回复里一次性发出，我会并行执行它们；如果后一个工具需要前一个的返回结果" +
  "（例如先 searchFiles 找到文件名、再 readFile 读它），就分两轮，先拿到观察再决定下一步。\n" +
  "关于长期记忆：你拥有 remember 与 recall 两个工具。凡是用户告诉你、且未来可能用到的" +
  "事实、偏好或结论（名字、语言偏好、项目代号等），主动调用 remember 记下来；当用户的问题" +
  "可能依赖这些信息时，先调用 recall 回忆再回答。";

/** 计划模式下，单个步骤的子循环系统提示追加语：提醒模型只做当前这一步 */
const STEP_GUIDANCE =
  "\n\n你正在执行一个更大任务中的某一个步骤。只专注完成当前这一步，不要试图一口气做完所有步骤；" +
  "如果当前步骤需要用到工具（计算、读文件、检索、联网），照常调用。完成后用一段话总结这一步的成果。";

/**
 * 最小 Agent：把「思考 → 行动 → 观察」串成一个会自动转的循环。
 *
 * 循环逻辑（runLoop）：
 *   1. 把当前上下文发给模型，问它「下一步做什么」。
 *   2. 若模型返回 tool_calls → 并行执行这些工具（独立调用同时跑），把结果（观察）写回上下文，回到第 1 步。
 *   3. 若模型不再调工具 → 它的文本就是最终答案，结束。
 *
 * maxSteps 是安全阀：防止模型陷入「永远调工具」的死循环，耗尽 token。
 *
 * 第 7 篇在循环之上叠加了「规划」（runPlan）：先用 Planner 把任务拆成有序步骤，
 * 每一步各自跑一遍 runLoop（可调用工具），最后把各步结果合成最终答复；
 * 某步若在子循环预算内没跑通，有限次交给 Planner 重规划剩余步骤。
 * 规划与执行通过组合接入，循环内核本身不变。
 */
export class Agent {
  private readonly client: ChatClient;
  private readonly registry: ToolRegistry;
  private readonly maxSteps: number;
  private readonly systemPrompt: string;
  /** 短期记忆压缩器：历史轮次超阈值时，把旧轮次摘要成一条 system 消息再发 */
  private readonly compressor?: ContextCompressor;
  /** 长期记忆存储：跨会话持久化，并用于把相关事实注入每轮上下文 */
  private readonly memoryStore?: MemoryStore;
  /** 规划器：把复杂任务拆步骤、失败重规划；不传则 runPlan 不可用 */
  private readonly planner?: Planner;
  /** 重规划的最大次数：执行某步失败（超出子循环预算）时，重新规划剩余步骤的次数上限 */
  private readonly maxReplans: number;
  /** 有状态：内部持有整段对话上下文，run() 只追加新一句，循环在它之上叠加。
   *  短期压缩只作用于「发往模型的上下文」，这份本地历史始终保持完整——详见 buildContext。 */
  private conversation: Message[];
  /** 第 11 篇：状态变化钩子，默认空 */
  private hooks: AgentHooks;

  constructor(
    client: ChatClient,
    options: {
      tools?: AnyTool[];
      registry?: ToolRegistry;
      maxSteps?: number;
      systemPrompt?: string;
      compressor?: ContextCompressor;
      memoryStore?: MemoryStore;
      planner?: Planner;
      maxReplans?: number;
      hooks?: AgentHooks;
    } = {},
  ) {
    this.client = client;
    // 既可直接传 tools 数组（内部收编进注册表），也可复用外部已建好的注册表
    this.registry = options.registry ?? new ToolRegistry().registerAll(options.tools ?? []);
    this.maxSteps = options.maxSteps ?? 8;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.compressor = options.compressor;
    this.memoryStore = options.memoryStore;
    this.planner = options.planner;
    this.maxReplans = options.maxReplans ?? 1;
    this.hooks = options.hooks ?? {};
    this.conversation = [{ role: "system", content: this.systemPrompt }];
  }

  /** 运行时替换钩子：恢复流程先建 Agent、再接钩子，顺序更灵活 */
  setHooks(hooks: AgentHooks): void {
    this.hooks = hooks;
  }

  /** 导出完整本地上下文（不经过压缩），供持久化打快照 */
  exportMessages(): Message[] {
    return this.conversation.map((m) => ({ ...m }));
  }

  /** 把恢复出来的上下文灌回 Agent；system 消息缺失时补上当前提示语 */
  loadMessages(messages: Message[]): void {
    const next = messages.map((m) => ({ ...m }));
    if (!next.some((m) => m.role === "system")) {
      next.unshift({ role: "system", content: this.systemPrompt });
    }
    this.conversation = next;
  }

  /**
   * @param options.signal 第 12 篇：取消信号。循环每圈开始时检查，
   *  并透传给 LLMClient 的 fetch；工具执行前也检查，避免取消后继续触发副作用。
   */
  async run(
    userInput: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentRunResult> {
    await this.hooks.onUserInput?.(userInput);
    this.conversation.push({ role: "user", content: userInput });
    const { answer, steps } = await this.runLoop(
      this.conversation,
      this.maxSteps,
      userInput,
      options,
    );
    return { answer, steps };
  }

  /**
   * 规划执行模式（Plan-and-Execute）：
   *   1. Planner 把任务拆成有序步骤；
   *   2. 每一步各自跑一遍 ReAct 子循环（runLoop），可调用工具，产出 StepResult；
   *   3. 若某步在子循环预算内没收敛（撞上 maxSteps），且还有重规划额度，
   *      交给 Planner 基于已完成步骤与失败原因重规划剩余步骤，再继续；
   *   4. 全部步骤完成后，用一次 LLM 调用把各步结果合成面向总体目标的最终答复。
   *
   * 设计要点：每个步骤用**独立**的消息数组跑 ReAct，互不污染；只有最终的
   * 任务与答复被写回 this.conversation，保留 REPL 多轮连续性。
   */
  async runPlan(
    task: string,
    resume?: { goal: string; steps: string[]; index: number; results: StepResult[] },
  ): Promise<PlanRunResult> {
    if (!this.planner) {
      throw new Error("Agent 未配置 planner，无法执行规划模式（请在构造时传入 planner）");
    }
    // 恢复路径跳过 createPlan：失败的步骤已经耗过一次模型调用，重做计划会引入随机漂移。
    const plan: Plan = resume
      ? { goal: resume.goal, steps: resume.steps }
      : await this.planner.createPlan(task);
    if (!resume) await this.hooks.onPlanCreated?.(plan);
    const stepResults: StepResult[] = resume ? [...resume.results] : [];
    let steps = [...plan.steps];
    let revisions = 0;
    let i = resume?.index ?? 0;

    while (i < steps.length) {
      const step = steps[i]!;
      const priorContext = stepResults
        .map((r, idx) => `步骤${idx + 1}「${r.step}」→ ${r.result}`)
        .join("\n");
      const stepMessages: Message[] = [
        { role: "system", content: this.systemPrompt + STEP_GUIDANCE },
        {
          role: "user",
          content:
            `总体目标：${plan.goal}\n\n` +
            `当前执行第 ${i + 1} / ${steps.length} 步：${step}\n\n` +
            (priorContext ? `已完成步骤的产出：\n${priorContext}\n\n` : "") +
            `请专注完成这一步，最后用一段话总结这一步的成果。`,
        },
      ];

      const { answer, converged } = await this.runLoop(stepMessages, this.maxSteps, step);

      if (!converged && revisions < this.maxReplans) {
        // 这一步没跑通：先交给规划器基于「已完成步骤」重规划剩余步骤，
        // 再把失败步（done:false）记进结果里便于追溯，回到 i 重跑新计划。
        const revised = await this.planner.revisePlan(plan.goal, stepResults, step, answer);
        const failed: StepResult = { step, result: answer, done: false };
        stepResults.push(failed);
        await this.hooks.onPlanStep?.(i, step, failed);
        steps = [...steps.slice(0, i), ...revised.steps];
        revisions++;
        continue;
      }

      // 成功或已无重试额度：记录这一步结果，前进
      const done: StepResult = { step, result: answer, done: converged };
      stepResults.push(done);
      await this.hooks.onPlanStep?.(i, step, done);
      i++;
    }

    // 终步合成：把各步结果汇总成面向总体目标的最终答复。
    // 用中性系统提示，避免把「工具有哪些」带进来诱导模型在汇总时误发工具调用。
    const finalMessages: Message[] = [
      {
        role: "system",
        content:
          "你是一个结果汇总助手。下面给出总体目标与各步骤的执行结果，" +
          "请把它们整合成一段面向总体目标的最终答复。只输出最终答复本身，" +
          "不要调用工具，不要复述步骤编号，不要加额外解释。",
      },
      {
        role: "user",
        content:
          `总体目标：${plan.goal}\n\n` +
          `以下是各步骤的执行结果，请综合这些信息，给出面向总体目标的最终答复：\n\n` +
          stepResults
            .map((r, idx) => `步骤${idx + 1}「${r.step}」：${r.result}`)
            .join("\n\n"),
      },
    ];
    const finalAnswer = await this.client.chat(finalMessages);

    // 写回会话历史（REPL 连续性）：任务作为 user 消息，最终答复作为 assistant 消息
    this.conversation.push({ role: "user", content: task });
    this.conversation.push({ role: "assistant", content: finalAnswer });
    await this.hooks.onPlanDone?.(finalAnswer);

    return { plan, stepResults, revisions, answer: finalAnswer };
  }

  /** 清空对话上下文，回到只有 system 提示语的初始状态 */
  reset(): void {
    this.conversation = [{ role: "system", content: this.systemPrompt }];
  }

  /**
   * 「思考 → 行动 → 观察」ReAct 子循环。
   *
   * @param messages   参与本循环的消息数组（run 传 this.conversation；runPlan 传每步的独立数组）
   * @param budget     本循环最多转几圈（安全阀）
   * @param currentUserInput 本轮用于长期记忆检索的「当前用户输入」（通常是原始问题或步骤文本）
   * @returns answer（最终文本）、steps（可视化步骤）、converged（是否在预算内收敛；false=撞上预算）
   */
  private async runLoop(
    messages: Message[],
    budget: number,
    currentUserInput: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ answer: string; steps: AgentStep[]; converged: boolean }> {
    const steps: AgentStep[] = [];
    const signal = options.signal;
    const tools = this.registry.toDefinitions();
    /** 一次 runLoop 内的多个工具调用属于同一组，恢复时合并回一条 assistant 消息 */
    const group = randomUUID();

    for (let step = 0; step < budget; step++) {
      // 取消后不再发新请求，也不再执行工具；signal 同时传给 fetch 做真实中止
      if (signal?.aborted) throw options.signal?.reason ?? new Error("Agent 循环已取消");
      // 组装本轮发给模型的上下文：基础 system + 长期记忆简报 + 历史（必要时压缩）
      const sendMessages = await this.buildContext(messages, currentUserInput);
      const chatOptions: ChatOptions = signal ? { signal } : {};
      const result: ChatResult = await this.client.chatWithTools(sendMessages, tools, chatOptions);

      if (result.toolCalls.length > 0) {
        // 模型这一轮先说了一段思考（可能为空），记录下来
        if (result.content) {
          steps.push({ kind: "thought", text: result.content });
        }
        // 把模型「想调用工具」的原话回写进上下文（线格式：arguments 必须序列化回 JSON 字符串），
        // 模型才能把下一轮的观察结果对应回这次调用。
        messages.push({
          role: "assistant",
          content: result.content,
          tool_calls: result.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.function.name,
              arguments: JSON.stringify(tc.function.arguments),
            },
          })),
        });

        // 写「在途记录」必须在工具执行之前：崩溃后据此判断是否可能已产生副作用。
        await this.hooks.onToolCalls?.(result.content, result.toolCalls, group);

        // 一次回复可能要求调用多个工具。彼此独立的调用（如并行抓取两个网页）
        // 用 Promise.all 同时跑，省时间；彼此依赖的调用模型会自动拆成两轮，
        // 依赖关系的编排由上面的 for 循环自然完成。registry.run 永不抛异常
        // （失败转成观察文本），所以 Promise.all 不会因单个工具失败而短路。
        const executed = await Promise.all(
          result.toolCalls.map(async (call) => {
            if (signal?.aborted) throw options.signal?.reason ?? new Error("工具执行前已取消");
            const actionText = `${call.function.name}(${JSON.stringify(call.function.arguments)})`;
            const observation = await this.runTool(call);
            await this.hooks.onToolResult?.(call, observation);
            return { id: call.id, actionText, observation };
          }),
        );
        for (const { id, actionText, observation } of executed) {
          steps.push({ kind: "action", text: actionText });
          steps.push({ kind: "observation", text: observation });
          messages.push({
            role: "tool",
            content: observation,
            tool_call_id: id,
          });
        }
        continue; // 带着观察结果再转一圈
      }

      // 没有工具调用 → 这是最终答案
      const answer = result.content ?? "";
      const finalMessage: Message = { role: "assistant", content: answer };
      messages.push(finalMessage);
      await this.hooks.onAssistantMessage?.(finalMessage);
      await this.hooks.onFinalAnswer?.(answer);
      steps.push({ kind: "answer", text: answer });
      return { answer, steps, converged: true };
    }

    const fallback = "（已达到最大步数限制，该步骤可能未完成，请简化问题后重试）";
    const fallbackMessage: Message = { role: "assistant", content: fallback };
    messages.push(fallbackMessage);
    await this.hooks.onAssistantMessage?.(fallbackMessage);
    steps.push({ kind: "answer", text: fallback });
    return { answer: fallback, steps, converged: false };
  }

  /**
   * 组装「发往模型」的上下文，是两种记忆真正落地的入口：
   *
   *  1. 从传入的 messages 拷贝一份（不动原件，保证本地不丢信息）。
   *  2. 若挂了长期记忆，用本轮用户输入去检索相关事实，注入到 system 提示里
   *     （这是长期记忆的「被动」形态：模型不必主动调 recall，相关事实已摆在眼前）。
   *  3. 若挂了压缩器，把旧轮次摘要成一条 system 消息，防止上下文溢出窗口。
   *
   * 关键设计：压缩只发生在「发给模型」这一步，传入的 messages 永远保留全量历史。
   */
  private async buildContext(messages: Message[], currentUserInput: string): Promise<Message[]> {
    const base = messages.map((m) => ({ ...m }));

    if (this.memoryStore) {
      const hits = await this.memoryStore.search(currentUserInput, 5);
      if (hits.length > 0) {
        const brief = hits.map((h) => `- [${h.key}] ${h.content}`).join("\n");
        const idx = base.findIndex((m) => m.role === "system");
        const basePrompt = idx >= 0 ? (base[idx]!.content ?? "") : "";
        const augmented = `${basePrompt}\n\n【长期记忆·相关事实】\n${brief}`;
        if (idx >= 0) base[idx]!.content = augmented;
        else base.unshift({ role: "system", content: augmented });
      }
    }

    if (this.compressor) {
      return (await this.compressor.compress(base)).messages;
    }
    return base;
  }

  /** 执行单个工具调用：委托给注册表，由其统一做校验与错误分类，
   *  任何失败都变成字符串观察，不会让整个循环崩溃 */
  private async runTool(call: ToolCall): Promise<string> {
    return this.registry.run(call.function.name, call.function.arguments);
  }
}

export { calculator };
