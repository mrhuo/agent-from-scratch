import type { RawTool } from "../agent/tools.js";
import type { MCPClient } from "./MCPClient.js";
import type { MCPToolDescriptor } from "./protocol.js";

/**
 * 把 MCP 服务端的工具，接进本项目的 ToolRegistry。
 *
 * 这里是「外部世界」与「Agent 内核」之间唯一需要动脑的地方——
 * 协议层面 MCP 工具和本地工具长得完全不一样：
 *  - 本地工具：参数用 Zod 定义，校验由 Zod 做；
 *  - MCP 工具：参数是服务端给的 JSON Schema，校验按它自己的 schema 做。
 *
 * 所以适配层做三件事：
 *  1. **命名空间化**：给每个 MCP 工具名加 `mcp__<server>__` 前缀。
 *     不加前缀会撞名——服务端一个叫 `readFile` 的工具和本地 `readFile` 同名，
 *     注册表会直接抛「工具名已存在」。前缀同时让模型在工具列表里一眼看出
 *     「这是外部来的」，有助于它理解能力边界。
 *  2. **形状对齐**：包成 RawTool，parameters 直接沿用服务端的 inputSchema，
 *     不翻译成 Zod——翻译层是多余的中间环节，且翻译出错很难查。
 *  3. **结果归一**：调用结果（含 isError）统一转成纯文本观察喂回模型。
 */
export interface MCPAdapterOptions {
  /** 命名空间前缀，默认 "mcp" */
  namespace?: string;
  /**
   * 服务端名。默认取握手时服务端自报的 name。
   * 同一台机器上接多个同名服务端时，显式传参区分。
   */
  serverName?: string;
}

/** 工具名清洗：OpenAI function name 只允许字母、数字、下划线与连字符，且长度上限 64 */
export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length <= 64 ? cleaned : cleaned.slice(0, 64);
}

/** 拼出带命名空间的工具名，例如 mcp__notes__search */
export function mcpToolName(namespace: string, serverName: string, toolName: string): string {
  return sanitizeToolName(`${namespace}__${serverName}__${toolName}`);
}

/** 把单个 MCP 工具描述转成本项目的 RawTool */
export function toRawTool(
  descriptor: MCPToolDescriptor,
  client: MCPClient,
  options: MCPAdapterOptions = {},
): RawTool {
  const namespace = options.namespace ?? "mcp";
  const serverName = options.serverName ?? client.info?.name ?? "server";
  const name = mcpToolName(namespace, serverName, descriptor.name);

  // 没有 inputSchema 的工具等价于「无参」，补一个空对象 schema，
  // 否则模型侧看到的 parameters 是 undefined，部分 provider 会报错
  const inputSchema =
    descriptor.inputSchema && typeof descriptor.inputSchema === "object"
      ? descriptor.inputSchema
      : { type: "object", properties: {} };

  return {
    name,
    description:
      descriptor.description ??
      `MCP 服务端 ${serverName} 提供的工具 ${descriptor.name}`,
    parameters: inputSchema,
    execute: async (args: Record<string, unknown>) =>
      client.callToolAsText(descriptor.name, args),
  };
}

/**
 * 把一个 MCP 客户端上的全部工具，转换成可直接注册进 ToolRegistry 的 RawTool 列表。
 * 转换前会先 listTools 拉一次清单——这是「工具发现」的关键一步。
 */
export async function toMCPTools(
  client: MCPClient,
  options: MCPAdapterOptions = {},
): Promise<RawTool[]> {
  const descriptors = await client.listTools();
  return descriptors.map((d) => toRawTool(d, client, options));
}
