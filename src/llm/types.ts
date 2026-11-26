export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  /**
   * 文本内容。助手消息在携带 tool_calls 时 content 可为 null；
   * 工具消息 content 为观察结果文本。
   */
  content: string | null;
  /** tool 角色的消息需携带 tool_call_id，表明回应的是哪一次工具调用 */
  tool_call_id?: string;
  /** 助手消息可能携带待执行的工具调用（线格式：arguments 为 JSON 字符串）；工具执行后原样回传 */
  tool_calls?: WireToolCall[];
  /** 兼容旧协议用 name 标注工具名；本系列走 tool_call_id，此字段保留备用 */
  name?: string;
}

/**
 * 内部使用的工具调用：参数是已解开的对象，方便 Agent 逻辑直接读取。
 * 注意它与线格式（WireToolCall）的差异——线格式里 arguments 必须是 JSON 字符串。
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** 已解开为对象的参数，Agent 逻辑直接使用 */
    arguments: Record<string, unknown>;
  };
}

/** 线格式工具调用（与 OpenAI / DeepSeek 对齐）：arguments 是 JSON 字符串 */
export interface WireToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** 传给模型的工具定义，遵循 OpenAI function calling 的 JSON Schema 形态 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** chatWithTools 的返回：模型的文本（可能为空） + 它想调用的工具列表 */
export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
}

/**
 * 最小聊天客户端接口。
 *
 * Agent 只依赖这三个能力，不依赖 LLMClient 的具体实现。
 * 第 12 篇据此插入 TracedLLMClient 做链路追踪与超时透传，
 * Agent 的循环判断一行不改。
 */
export interface ChatClient {
  chat(messages: Message[], options?: ChatOptions): Promise<string>;
  chatStream(messages: Message[], options?: ChatOptions): AsyncGenerator<string>;
  chatWithTools(messages: Message[], tools: ToolDefinition[], options?: ChatOptions): Promise<ChatResult>;
}

export interface ChatOptions {
  /** 默认 0.7 */
  temperature?: number;
  /** 默认由模型决定 */
  maxTokens?: number;
  /** 是否流式返回，默认 false */
  stream?: boolean;
  /** 是否要求模型只输出 JSON（OpenAI/DeepSeek 兼容的 json_object 模式）；
   *  供规划器等需要结构化输出的场景使用；解析侧另有容错兜底 */
  jsonMode?: boolean;
  /** 第 12 篇：取消信号，直接传给 fetch。超时后 HTTP 请求会被真正中止 */
  signal?: AbortSignal;
}

export interface ChatConfig {
  apiKey: string;
  /** OpenAI-compatible 基址，默认 https://api.openai.com/v1 */
  baseURL?: string;
  model: string;
  /** 注入自定义 fetch（测试用），默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
}
