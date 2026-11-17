import {
  MCP_METHOD,
  MCP_PROTOCOL_VERSION,
  mcpContentToText,
  type MCPServerInfo,
  type MCPToolCallResult,
  type MCPToolDescriptor,
} from "./protocol.js";
import type { Transport } from "./transport.js";

/**
 * MCP 客户端：把「一个 MCP 服务端」包装成「一组可以调用的工具」。
 *
 * 生命周期严格按协议来：
 *   connect()  → initialize 握手 → 发 notifications/initialized → 记下服务端信息
 *   listTools()→ 拉工具清单（服务端可能分页，靠 nextCursor 续拉）
 *   callTool() → 调用具体工具
 *   close()    → 关连接
 *
 * 注意一个容易踩的坑：**协议版本是要协商的**，不是客户端单方面定死。
 * 服务端可能回一个比自己旧的版本，这时应该以服务端回传的为准（降级运行），
 * 而不是直接报错——本客户端把最终协商结果记在 serverInfo.protocolVersion 里。
 */
export class MCPClient {
  private serverInfo: MCPServerInfo | null = null;
  private connected = false;

  constructor(
    private readonly transport: Transport,
    private readonly options: {
      /** 客户端名，握手时告知服务端 */
      clientName?: string;
      /** 客户端版本 */
      clientVersion?: string;
      /** 请求的协议版本，默认最新支持版 */
      protocolVersion?: string;
    } = {},
  ) {}

  /** 握手成功后拿到的服务端信息；未连接时为 null */
  get info(): MCPServerInfo | null {
    return this.serverInfo;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** 建立连接：启动传输 → initialize 握手 → 发送 initialized 通知 */
  async connect(): Promise<MCPServerInfo> {
    await this.transport.start();

    const result = (await this.transport.request(MCP_METHOD.INITIALIZE, {
      protocolVersion: this.options.protocolVersion ?? MCP_PROTOCOL_VERSION,
      capabilities: {
        // 声明客户端支持工具能力；服务端据此决定是否返回 tools
        tools: {},
      },
      clientInfo: {
        name: this.options.clientName ?? "agent-from-scratch",
        version: this.options.clientVersion ?? "0.1.0",
      },
    })) as
      | {
          protocolVersion?: string;
          capabilities?: Record<string, unknown>;
          serverInfo?: { name?: string; version?: string };
        }
      | undefined;

    // 通知服务端握手完成（通知没有 id，也不会有响应）
    this.transport.notify(MCP_METHOD.INITIALIZED);

    // 注意 initialize 响应的形状：协议版本与能力在顶层，服务端名称与版本在 serverInfo 里
    const serverInfo = result?.serverInfo;
    this.serverInfo = {
      name: serverInfo?.name ?? "unknown-server",
      version: serverInfo?.version ?? "0.0.0",
      // 以服务端回传的版本为准——这就是「协商」
      protocolVersion: result?.protocolVersion ?? MCP_PROTOCOL_VERSION,
      capabilities: result?.capabilities ?? {},
    };
    this.connected = true;
    return this.serverInfo;
  }

  /** 列出服务端提供的全部工具（自动翻页） */
  async listTools(): Promise<MCPToolDescriptor[]> {
    this.assertConnected();
    const tools: MCPToolDescriptor[] = [];
    let cursor: string | undefined;

    do {
      const result = (await this.transport.request(
        MCP_METHOD.TOOLS_LIST,
        cursor ? { cursor } : undefined,
      )) as { tools?: MCPToolDescriptor[]; nextCursor?: string } | undefined;

      tools.push(...(result?.tools ?? []));
      cursor = result?.nextCursor;
    } while (cursor);

    return tools;
  }

  /** 调用服务端上的某个工具 */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<MCPToolCallResult> {
    this.assertConnected();
    const result = await this.transport.request(MCP_METHOD.TOOLS_CALL, {
      name,
      arguments: args,
    });
    return (result ?? {}) as MCPToolCallResult;
  }

  /**
   * 调用工具并把结果转成一段纯文本观察。
   * MCP 里「工具执行失败」不是 JSON-RPC 错误，而是正常响应里带 isError=true——
   * 这个区别很关键：把它当成异常会误伤，把它当成成功会骗模型。
   * 这里统一转成带标记的文本，让模型能看见「这次调用失败了」。
   */
  async callToolAsText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await this.callTool(name, args);
    const text = mcpContentToText(result);
    if (result.isError) {
      return `[MCP 工具错误] ${text || "工具执行失败，服务端未返回错误详情"}`;
    }
    return text;
  }

  /** 关闭连接 */
  close(): void {
    this.connected = false;
    this.transport.close();
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error("MCP 客户端尚未连接，请先调用 connect() 完成 initialize 握手");
    }
  }
}
