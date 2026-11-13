import type { Message } from "../llm/types.js";

/**
 * 摘要器接口：把一批旧消息压成一段文本。
 * 真实场景用 LLM；测试与兜底用 NoopSummarizer（不调模型）。
 */
export interface Summarizer {
  summarize(messages: Message[]): Promise<string>;
}

/** 测试 / 兜底：不调用模型，直接返回固定占位文本 */
export class NoopSummarizer implements Summarizer {
  constructor(private readonly marker = "（已省略的早期对话摘要）") {}
  async summarize(): Promise<string> {
    return this.marker;
  }
}

/**
 * LLM 摘要器：把旧消息拼成一段对话记录，交给模型压成摘要。
 * 只依赖 LLMClient 的 `chat`（非流式）能力，与 Agent 内核解耦。
 */
export class LLMSummarizer implements Summarizer {
  constructor(private readonly client: { chat: (messages: Message[]) => Promise<string> }) {}

  async summarize(messages: Message[]): Promise<string> {
    const transcript = messages
      .map((m) => `${m.role}: ${m.content ?? ""}`)
      .join("\n");
    return this.client.chat([
      {
        role: "system",
        content:
          "把下面的对话片段压缩成一段简洁摘要。保留：关键事实、数字、结论、未完成的意图与待办；删除寒暄、重复与无关内容。只输出摘要本身，不要加任何前缀或解释。",
      },
      { role: "user", content: transcript },
    ]);
  }
}

export interface CompressResult {
  /** 压缩后用于发给模型的上下文：系统提示 + 一条历史摘要 + 最近若干轮 */
  messages: Message[];
  /** 被摘要掉的旧消息条数（0 表示本轮无需压缩） */
  dropped: number;
  /** 摘要文本；无需压缩时为 null */
  summary: string | null;
}

/**
 * 短期记忆压缩器。
 *
 * 触发条件：非 system 的历史里，用户轮次超过 `keepRecentTurns` 才压缩。
 * 超过的部分（更早的整轮对话）交给 Summarizer 压成一条 system 消息，
 * 最近的若干用户轮保持原样发给模型。
 *
 * 为什么要「按用户轮切分」而不是按消息条数硬切：
 * 一轮工具调用在上下文里是「user → assistant(tool_calls) → tool → tool → ...」
 * 这样一组连续消息。如果按固定条数从中间切断，可能把 assistant 的工具调用
 * 和它的 tool 观察结果拆到摘要两侧，破坏 tool_call_id 的对应关系，模型会困惑。
 * 按「用户轮」对齐切分点，保证被摘要的旧块是若干个**完整轮次**，最近的块
 * 也总是从一条 user 消息开始，绝不切断任何一轮。
 */
export class ContextCompressor {
  constructor(
    private readonly summarizer: Summarizer,
    private readonly keepRecentTurns = 6,
    /** 可选观测钩子：每次真正发生压缩时回调（掉几条、摘要文本），便于调试与演示 */
    private readonly onCompress?: (info: { dropped: number; summary: string }) => void,
  ) {}

  async compress(messages: Message[]): Promise<CompressResult> {
    const system = messages.filter((m) => m.role === "system");
    const rest = messages.filter((m) => m.role !== "system");

    // 收集所有用户轮的下标，决定是否到了需要压缩的临界点
    const userIdx: number[] = [];
    rest.forEach((m, i) => {
      if (m.role === "user") userIdx.push(i);
    });

    if (userIdx.length <= this.keepRecentTurns) {
      // 还没到阈值，整段原样发，不丢任何信息
      return { messages, dropped: 0, summary: null };
    }

    // 第一个被保留的用户轮的下标：它之前的所有轮都属于「旧块」
    const boundary = userIdx[userIdx.length - this.keepRecentTurns]!;
    const older = rest.slice(0, boundary);
    const recent = rest.slice(boundary);

    const summary = await this.summarizer.summarize(older);
    const summaryMsg: Message = {
      role: "system",
      content: `【对话历史摘要】\n${summary}`,
    };

    this.onCompress?.({ dropped: older.length, summary });

    return {
      messages: [...system, summaryMsg, ...recent],
      dropped: older.length,
      summary,
    };
  }
}
