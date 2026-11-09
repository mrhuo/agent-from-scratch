import type { ChatConfig, ChatOptions, Message } from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * OpenAI-compatible 大模型的统一客户端。
 *
 * 设计目标：用一套接口通吃所有 OpenAI-compatible 端点
 * （OpenAI / DeepSeek / 通义千问 / OpenRouter ...），
 * 后续篇章的 Agent 内核只依赖这个客户端，不关心背后是哪家模型。
 */
export class LLMClient {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ChatConfig) {
    if (!config.apiKey) {
      throw new Error("LLMClient: apiKey is required");
    }
    this.apiKey = config.apiKey;
    this.baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = config.model;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error("LLMClient: no fetch implementation available");
    }
  }

  /** 非流式：一次拿到完整回复文本 */
  async chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
    const res = await this.rawCompletions(messages, { ...options, stream: false });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LLMClient.chat failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content ?? "";
  }

  /** 流式：逐 token 产出，适合 CLI 实时打字效果 */
  async *chatStream(
    messages: Message[],
    options: ChatOptions = {},
  ): AsyncGenerator<string> {
    const res = await this.rawCompletions(messages, { ...options, stream: true });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LLMClient.chatStream failed: ${res.status} ${body}`);
    }
    const body = res.body;
    if (!body) {
      throw new Error("LLMClient: response body is null");
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      // 最后一行可能不完整，留到下次拼接
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const json = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // 跳过不完整 / 心跳行
        }
      }
    }
  }

  private rawCompletions(messages: Message[], options: ChatOptions) {
    const body = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
      stream: options.stream ?? false,
    };
    return this.fetchImpl(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  }
}
