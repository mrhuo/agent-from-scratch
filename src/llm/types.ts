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

export interface ChatOptions {
  /** 默认 0.7 */
  temperature?: number;
  /** 默认由模型决定 */
  maxTokens?: number;
  /** 是否流式返回，默认 false */
  stream?: boolean;
}

export interface ChatConfig {
  apiKey: string;
  /** OpenAI-compatible 基址，默认 https://api.openai.com/v1 */
  baseURL?: string;
  model: string;
  /** 注入自定义 fetch（测试用），默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
}
