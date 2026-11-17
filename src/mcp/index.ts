/**
 * 第 9 篇：MCP（Model Context Protocol）接入层。
 *
 * 目录结构：
 *   protocol.ts —— JSON-RPC 2.0 与 MCP 的类型、常量、方法名
 *   transport.ts —— stdio 传输（子进程 + 换行分隔 JSON），含请求配对与超时
 *   MCPClient.ts —— 客户端：握手、工具发现、工具调用、结果归一
 *   adapter.ts   —— 把 MCP 工具转成本项目的 RawTool（命名空间化）
 *   server.ts    —— 最小 MCP 服务端核心（与 IO 解耦，便于单测）
 *   taskBoard.ts —— 一个真实的有状态外部服务：任务看板
 */
export {
  JSONRPC_VERSION,
  MCP_PROTOCOL_VERSION,
  JSONRPC_ERROR,
  MCP_METHOD,
  isRequest,
  isResponse,
  mcpContentToText,
} from "./protocol.js";
export type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcErrorObject,
  MCPServerInfo,
  MCPToolDescriptor,
  MCPToolCallResult,
  MCPContentBlock,
} from "./protocol.js";

export { StdioTransport } from "./transport.js";
export type { Transport, StdioTransportOptions } from "./transport.js";

export { MCPClient } from "./MCPClient.js";

export { toRawTool, toMCPTools, mcpToolName, sanitizeToolName } from "./adapter.js";
export type { MCPAdapterOptions } from "./adapter.js";

export { MCPServer } from "./server.js";
export type { MCPServerTool, MCPServerOptions } from "./server.js";

export { TaskBoard, createBoardTools } from "./taskBoard.js";
export type { BoardTask, TaskStatus, TaskPriority } from "./taskBoard.js";

export { localBoardServerOptions } from "./localServer.js";
