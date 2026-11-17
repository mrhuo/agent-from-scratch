/**
 * MCP（Model Context Protocol）协议的基础类型与常量。
 *
 * MCP 是一套「让 Agent 用统一协议接外部工具」的规范，底座就是 JSON-RPC 2.0。
 * 本文件不引入任何 MCP SDK，把协议里我们需要的那部分类型手写出来——
 * 这样既看清了协议到底有多薄，也避免了把整个生态的依赖拖进这个小项目。
 *
 * 协议要素（stdio 传输下的完整交互）：
 *   1. 客户端 → 服务端  initialize（含 protocolVersion / capabilities / clientInfo）
 *   2. 服务端 → 客户端  initialize 的响应（含协商后的 protocolVersion / serverInfo）
 *   3. 客户端 → 服务端  notifications/initialized（通知，无 id，无响应）
 *   4. 客户端 → 服务端  tools/list → 拿到工具清单与各自的 inputSchema
 *   5. 客户端 → 服务端  tools/call → 调用工具并拿回 content
 */

/** JSON-RPC 版本号 */
export const JSONRPC_VERSION = "2.0" as const;

/**
 * 本客户端声明的 MCP 协议版本。
 * 2024-11-05 是工具能力最完整、兼容性最广的一版：initialize / tools/list / tools/call。
 */
export const MCP_PROTOCOL_VERSION = "2024-11-05" as const;

/** JSON-RPC 2.0 标准错误码 */
export const JSONRPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** 本实现用到的 MCP 方法名 */
export const MCP_METHOD = {
  /** 握手：客户端发起，服务端返回协议版本与能力 */
  INITIALIZE: "initialize",
  /** 握手完成通知（无 id，服务端不回复） */
  INITIALIZED: "notifications/initialized",
  /** 列出服务端提供的工具 */
  TOOLS_LIST: "tools/list",
  /** 调用某个工具 */
  TOOLS_CALL: "tools/call",
  /** 心跳 */
  PING: "ping",
} as const;

/** 一条 JSON-RPC 请求（带 id，必须有响应） */
export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** 一条 JSON-RPC 通知（无 id，不要求响应） */
export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 错误对象 */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** 一条 JSON-RPC 响应（带 id，或 result 或 error） */
export interface JsonRpcResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** 判断一条消息是否为「响应」——只有响应才有 id 且没有 method */
export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && !("method" in msg);
}

/** 判断一条消息是否为「请求」（有 id 且有 method） */
export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "id" in msg && "method" in msg;
}

/** 服务端在 initialize 响应里自报的信息 */
export interface MCPServerInfo {
  name: string;
  version: string;
  /** 协商后的协议版本 */
  protocolVersion: string;
  /** 服务端声明的能力，本实现目前只用 tools */
  capabilities: Record<string, unknown>;
}

/** tools/list 返回的单个工具描述 */
export interface MCPToolDescriptor {
  name: string;
  description?: string;
  /** 工具参数的 JSON Schema——外部给定的，本项目直接消费，不翻译成 Zod */
  inputSchema?: Record<string, unknown>;
}

/** tools/call 返回的内容块 */
export interface MCPContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** tools/call 的结果 */
export interface MCPToolCallResult {
  content?: MCPContentBlock[];
  /** 服务端标记工具执行失败（注意：这是「正常响应」，不是 JSON-RPC 错误） */
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * 把 tools/call 的 content 拼成一段纯文本观察。
 * MCP 的内容块可能是 text，也可能是别的类型；这里只取能读的文字，
 * 读不出来的块统一标注类型，避免把 [object Object] 喂给模型。
 */
export function mcpContentToText(result: MCPToolCallResult): string {
  const blocks = result.content ?? [];
  if (blocks.length === 0) return "";
  return blocks
    .map((b) => (typeof b.text === "string" ? b.text : `[${b.type} 内容块]`))
    .join("\n")
    .trim();
}
