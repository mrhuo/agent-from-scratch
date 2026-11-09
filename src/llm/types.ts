export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  /** tool 角色的消息需要 name 指明工具名 */
  name?: string;
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
