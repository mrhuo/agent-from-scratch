import type { LLMClient } from "../llm/index.js";
import type { ChatResult, Message, ToolCall } from "../llm/types.js";
import { calculator, type Tool } from "./tools.js";
import { ToolRegistry } from "./registry.js";

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
  "你是一个会使用工具的智能助手。遇到需要计算、查实时数据或执行动作的问题，优先调用提供的工具；" +
  "拿到工具返回的观察结果后，继续推理。当你已经掌握足够信息可以回答用户时，直接给出最终答案，不要再调用工具。";

/**
 * 最小 Agent：把「思考 → 行动 → 观察」串成一个会自动转的循环。
 *
 * 循环逻辑：
 *   1. 把当前上下文发给模型，问它「下一步做什么」。
 *   2. 若模型返回 tool_calls → 逐个执行工具，把结果（观察）写回上下文，回到第 1 步。
 *   3. 若模型不再调工具 → 它的文本就是最终答案，结束。
 *
 * maxSteps 是安全阀：防止模型陷入「永远调工具」的死循环，耗尽 token。
 */
export class Agent {
  private readonly client: LLMClient;
  private readonly registry: ToolRegistry;
  private readonly maxSteps: number;
  private readonly systemPrompt: string;
  /** 有状态：内部持有整段对话上下文，run() 只追加新一句，循环在它之上叠加。
   *  这样 REPL 多轮对话才能保留记忆——第 6 篇会在此基础上加摘要与长期记忆。 */
  private conversation: Message[];

  constructor(
    client: LLMClient,
    options: {
      tools?: Tool<any>[];
      registry?: ToolRegistry;
      maxSteps?: number;
      systemPrompt?: string;
    } = {},
  ) {
    this.client = client;
    // 既可直接传 tools 数组（内部收编进注册表），也可复用外部已建好的注册表
    this.registry = options.registry ?? new ToolRegistry().registerAll(options.tools ?? []);
    this.maxSteps = options.maxSteps ?? 8;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.conversation = [{ role: "system", content: this.systemPrompt }];
  }

  async run(userInput: string): Promise<AgentRunResult> {
    this.conversation.push({ role: "user", content: userInput });
    const steps: AgentStep[] = [];
    const tools = this.registry.toDefinitions();

    for (let step = 0; step < this.maxSteps; step++) {
      const result: ChatResult = await this.client.chatWithTools(this.conversation, tools);

      if (result.toolCalls.length > 0) {
        // 模型这一轮先说了一段思考（可能为空），记录下来
        if (result.content) {
          steps.push({ kind: "thought", text: result.content });
        }
        // 把模型「想调用工具」的原话回写进上下文（线格式：arguments 必须序列化回 JSON 字符串），
        // 模型才能把下一轮的观察结果对应回这次调用。
        this.conversation.push({
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

        for (const call of result.toolCalls) {
          steps.push({
            kind: "action",
            text: `${call.function.name}(${JSON.stringify(call.function.arguments)})`,
          });
          const observation = await this.runTool(call);
          steps.push({ kind: "observation", text: observation });
          this.conversation.push({
            role: "tool",
            content: observation,
            tool_call_id: call.id,
          });
        }
        continue; // 带着观察结果再转一圈
      }

      // 没有工具调用 → 这是最终答案
      const answer = result.content ?? "";
      this.conversation.push({ role: "assistant", content: answer });
      steps.push({ kind: "answer", text: answer });
      return { answer, steps };
    }

    const fallback = "（已达到最大步数限制，任务可能未完成，请简化问题后重试）";
    this.conversation.push({ role: "assistant", content: fallback });
    steps.push({ kind: "answer", text: fallback });
    return { answer: fallback, steps };
  }

  /** 清空对话上下文，回到只有 system 提示语的初始状态 */
  reset(): void {
    this.conversation = [{ role: "system", content: this.systemPrompt }];
  }

  /** 执行单个工具调用：委托给注册表，由其统一做校验与错误分类，
   *  任何失败都变成字符串观察，不会让整个循环崩溃 */
  private async runTool(call: ToolCall): Promise<string> {
    return this.registry.run(call.function.name, call.function.arguments);
  }
}

export { calculator };
