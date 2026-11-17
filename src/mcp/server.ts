import {
  JSONRPC_ERROR,
  JSONRPC_VERSION,
  MCP_METHOD,
  MCP_PROTOCOL_VERSION,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from "./protocol.js";

/**
 * 一个 MCP 工具在服务端的定义。
 *
 * 与客户端侧相反：服务端是自己写工具的一方，所以它可以用任意方式定义参数
 * （这里直接给 JSON Schema，因为对外暴露的就是 JSON Schema）。
 */
export interface MCPServerTool {
  name: string;
  description: string;
  /** 工具参数 JSON Schema（对外暴露的那份） */
  inputSchema: Record<string, unknown>;
  /** 执行逻辑，返回文本结果；抛异常则视为工具执行失败 */
  handler: (args: Record<string, unknown>) => Promise<string> | string;
}

/** 服务端可选项 */
export interface MCPServerOptions {
  name: string;
  version: string;
  tools: MCPServerTool[];
}

/**
 * 最小 MCP 服务端：把「收到一条 JSON-RPC 消息 → 该回什么」这件事单独抽出来，
 * 不掺杂任何 IO。这样既能作为独立进程跑（stdio 传输），
 * 也能在单元测试里直接喂消息、断言响应。
 *
 * 支持的方法：
 *  - initialize            → 握手，回协议版本与服务端信息
 *  - notifications/initialized → 通知，无响应
 *  - tools/list            → 工具清单
 *  - tools/call            → 调用工具
 *  - ping                  → 心跳
 */
export class MCPServer {
  private readonly tools = new Map<string, MCPServerTool>();
  private initialized = false;

  constructor(private readonly options: MCPServerOptions) {
    for (const t of options.tools) this.tools.set(t.name, t);
  }

  /**
   * 处理一条 JSON-RPC 消息。
   * 返回响应对象；若是通知（无 id），返回 null 表示「不用回」。
   */
  async handleMessage(msg: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    // 通知：没有 id，不需要响应
    if (!("id" in msg)) {
      if (msg.method === MCP_METHOD.INITIALIZED) this.initialized = true;
      return null;
    }

    const id = msg.id;
    const method = (msg as { method?: string }).method;
    if (!method) {
      return this.error(id, JSONRPC_ERROR.INVALID_REQUEST, "缺少 method 字段");
    }

    switch (method) {
      case MCP_METHOD.INITIALIZE: {
        const params = (msg as { params?: Record<string, unknown> }).params ?? {};
        // 记录客户端请求的协议版本，但以自己支持的版本回应——
        // 真实 MCP 服务端在这里做能力协商与降级
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return this.ok(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: this.options.name,
            version: this.options.version,
          },
          ...(requested ? {} : {}),
        });
      }

      case MCP_METHOD.PING:
        return this.ok(id, {});

      case MCP_METHOD.TOOLS_LIST:
        return this.ok(id, {
          tools: [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case MCP_METHOD.TOOLS_CALL: {
        const params = (msg as { params?: Record<string, unknown> }).params ?? {};
        const name = params.name;
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (typeof name !== "string" || name.length === 0) {
          return this.error(id, JSONRPC_ERROR.INVALID_PARAMS, "tools/call 缺少工具名");
        }
        const tool = this.tools.get(name);
        if (!tool) {
          return this.error(id, JSONRPC_ERROR.METHOD_NOT_FOUND, `未知工具：${name}`);
        }
        try {
          const text = await tool.handler(args);
          return this.ok(id, { content: [{ type: "text", text }] });
        } catch (err) {
          // 工具执行失败不是协议错误，而是一次「正常响应 + isError 标记」。
          // 客户端据此把失败如实告诉模型，而不是伪装成成功。
          const message = err instanceof Error ? err.message : String(err);
          return this.ok(id, {
            content: [{ type: "text", text: `工具执行失败：${message}` }],
            isError: true,
          });
        }
      }

      default:
        return this.error(id, JSONRPC_ERROR.METHOD_NOT_FOUND, `不支持的方法：${method}`);
    }
  }

  /** 是否已完成握手（收到过 notifications/initialized） */
  get isInitialized(): boolean {
    return this.initialized;
  }

  private ok(id: number | string, result: unknown): JsonRpcResponse {
    return { jsonrpc: JSONRPC_VERSION, id, result };
  }

  private error(id: number | string, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
  }
}
