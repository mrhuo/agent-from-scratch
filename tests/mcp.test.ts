import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry, validateAgainstJsonSchema, type RawTool } from "../src/agent/index.js";
import { Agent } from "../src/agent/index.js";
import type { LLMClient } from "../src/llm/index.js";
import type { ChatResult } from "../src/llm/types.js";
import {
  MCPClient,
  MCPServer,
  TaskBoard,
  createBoardTools,
  toRawTool,
  toMCPTools,
  mcpToolName,
  sanitizeToolName,
  mcpContentToText,
  localBoardServerOptions,
  type Transport,
} from "../src/mcp/index.js";

// ---------------------------------------------------------------- 假传输

/**
 * 假传输：不启子进程，直接按方法名返回预设结果。
 * 让 MCPClient 的握手 / 分页 / 错误路径都能被确定性地测到。
 */
class FakeTransport implements Transport {
  stderrText = "";
  started = false;
  closed = false;
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private handlers: Array<(msg: unknown) => void> = [];

  constructor(
    private readonly responder: (method: string, params?: Record<string, unknown>) => unknown,
  ) {}

  onMessage(handler: (msg: unknown) => void): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params });
    return this.responder(method, params);
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.sent.push({ method, params });
  }

  close(): void {
    this.closed = true;
  }
}

// ---------------------------------------------------------------- JSON Schema 校验

describe("validateAgainstJsonSchema：原生 JSON Schema 校验", () => {
  const schema = {
    type: "object",
    properties: {
      title: { type: "string" },
      priority: { type: "string", enum: ["low", "medium", "high"] },
      count: { type: "number" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["title"],
  };

  it("必填字段缺失 → 报错并指明字段名", () => {
    const check = validateAgainstJsonSchema(schema, { priority: "high" });
    expect(check.ok).toBe(false);
    expect(check.errors.join("; ")).toContain("title");
  });

  it("类型不符 → 报错并说明期望与实际", () => {
    const check = validateAgainstJsonSchema(schema, { title: 123 });
    expect(check.ok).toBe(false);
    expect(check.errors.join("; ")).toContain("类型应为 string");
  });

  it("枚举取值不在范围内 → 报错并列出允许值", () => {
    const check = validateAgainstJsonSchema(schema, { title: "x", priority: "urgent" });
    expect(check.ok).toBe(false);
    expect(check.errors.join("; ")).toContain("取值必须是");
    expect(check.errors.join("; ")).toContain("low");
  });

  it("数组元素类型错 → 指出具体下标", () => {
    const check = validateAgainstJsonSchema(schema, { title: "x", tags: ["ok", 5] });
    expect(check.ok).toBe(false);
    expect(check.errors.join("; ")).toContain("tags[1]");
  });

  it("参数不是对象 → 直接判定失败", () => {
    const check = validateAgainstJsonSchema(schema, "不是对象");
    expect(check.ok).toBe(false);
    expect(check.errors.join("; ")).toContain("必须是 JSON 对象");
  });

  it("合法参数 → 通过", () => {
    const check = validateAgainstJsonSchema(schema, {
      title: "写文档",
      priority: "high",
      count: 3,
      tags: ["a", "b"],
    });
    expect(check.ok).toBe(true);
    expect(check.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- 注册表双路径

describe("ToolRegistry：同时容纳 Zod 工具与原生 JSON Schema 工具", () => {
  const rawTool: RawTool = {
    name: "mcp__taskboard__add_task",
    description: "新增任务",
    parameters: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    execute: (args) => `已创建：${String(args.title)}`,
  };

  it("原生工具的 JSON Schema 直接作为 parameters 喂给模型", () => {
    const registry = new ToolRegistry().register(rawTool);
    const defs = registry.toDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.function.name).toBe("mcp__taskboard__add_task");
    expect(defs[0]!.function.parameters).toBe(rawTool.parameters);
  });

  it("原生工具参数合法 → 正常执行", async () => {
    const registry = new ToolRegistry().register(rawTool);
    const out = await registry.run("mcp__taskboard__add_task", { title: "写文档" });
    expect(out).toBe("已创建：写文档");
  });

  it("原生工具参数缺必填 → 转成 validation 观察文本，不抛异常", async () => {
    const registry = new ToolRegistry().register(rawTool);
    const out = await registry.run("mcp__taskboard__add_task", {});
    expect(out).toContain("[工具错误·validation]");
    expect(out).toContain("title");
  });

  it("原生工具抛异常 → 转成 execution 观察文本", async () => {
    const registry = new ToolRegistry().register({
      ...rawTool,
      execute: () => {
        throw new Error("服务端炸了");
      },
    });
    const out = await registry.run("mcp__taskboard__add_task", { title: "x" });
    expect(out).toContain("[工具错误·execution]");
    expect(out).toContain("服务端炸了");
  });

  it("Zod 工具与原生工具可共存，且各自走各自的校验路径", async () => {
    const zodTool = {
      name: "calculator",
      description: "算数",
      parameters: z.object({ expression: z.string() }),
      execute: (args: { expression: string }) => `算出 ${args.expression}`,
    };
    const registry = new ToolRegistry().registerAll([zodTool, rawTool]);

    expect(registry.toDefinitions()).toHaveLength(2);
    // Zod 路径：缺参数报 zod 风格错误
    const zodOut = await registry.run("calculator", {});
    expect(zodOut).toContain("[工具错误·validation]");
    // 原生路径：缺参数报 JSON Schema 风格错误
    const rawOut = await registry.run("mcp__taskboard__add_task", {});
    expect(rawOut).toContain("[工具错误·validation]");
    expect(rawOut).toContain("缺少必填参数");
  });
});

// ---------------------------------------------------------------- MCP 客户端

describe("MCPClient：握手、发现、调用", () => {
  it("connect 走 initialize 握手，随后发送 initialized 通知", async () => {
    const transport = new FakeTransport((method) => {
      if (method === "initialize") {
        return {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "taskboard", version: "0.1.0" },
        };
      }
      return {};
    });
    const client = new MCPClient(transport, { clientName: "test-client" });

    const info = await client.connect();

    expect(info.name).toBe("taskboard");
    expect(info.protocolVersion).toBe("2024-11-05");
    expect(transport.started).toBe(true);
    // 握手两跳：initialize 请求 + initialized 通知
    expect(transport.sent.map((s) => s.method)).toEqual([
      "initialize",
      "notifications/initialized",
    ]);
    expect(transport.sent[0]!.params?.clientInfo).toMatchObject({ name: "test-client" });
  });

  it("协议版本以服务端回传的为准（协商而非单方面指定）", async () => {
    const transport = new FakeTransport(() => ({
      protocolVersion: "2024-11-05",
      capabilities: {},
      serverInfo: { name: "old-server", version: "0.0.1" },
    }));
    const client = new MCPClient(transport, { protocolVersion: "2025-06-18" });
    const info = await client.connect();
    expect(info.protocolVersion).toBe("2024-11-05");
  });

  it("未连接就调用工具 → 抛错", async () => {
    const transport = new FakeTransport(() => ({}));
    const client = new MCPClient(transport);
    await expect(client.listTools()).rejects.toThrow(/尚未连接/);
  });

  it("listTools 自动翻页，直到没有 nextCursor", async () => {
    let call = 0;
    const transport = new FakeTransport((method) => {
      if (method !== "tools/list") return {};
      call += 1;
      return call === 1
        ? { tools: [{ name: "a" }], nextCursor: "page2" }
        : { tools: [{ name: "b" }] };
    });
    const client = new MCPClient(transport);
    await client.connect();

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(call).toBe(2);
  });

  it("callTool 返回服务端结果；isError 转成带标记的文本", async () => {
    const transport = new FakeTransport((method) => {
      if (method === "initialize") {
        return {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "taskboard", version: "0.1.0" },
        };
      }
      return { content: [{ type: "text", text: "任务 #1 已经完成过了" }], isError: true };
    });
    const client = new MCPClient(transport);
    await client.connect();

    const text = await client.callToolAsText("complete_task", { id: 1 });
    expect(text).toContain("[MCP 工具错误]");
    expect(text).toContain("已经完成过了");
  });

  it("close 会关闭底层传输", async () => {
    const transport = new FakeTransport(() => ({}));
    const client = new MCPClient(transport);
    await client.connect();
    client.close();
    expect(transport.closed).toBe(true);
    expect(client.isConnected).toBe(false);
  });
});

// ---------------------------------------------------------------- 适配层

describe("adapter：MCP 工具接入本项目工具体系", () => {
  it("工具名加命名空间前缀，避免与本地工具撞名", () => {
    expect(mcpToolName("mcp", "taskboard", "add_task")).toBe("mcp__taskboard__add_task");
    expect(sanitizeToolName("weird name/with:chars")).toBe("weird_name_with_chars");
    expect(sanitizeToolName("x".repeat(100))).toHaveLength(64);
  });

  it("转出的 RawTool 沿用服务端 inputSchema，且调用时转发到原工具名", async () => {
    // 记录转发给服务端的原始调用参数
    let forwarded: { name: string; arguments: Record<string, unknown> } | undefined;

    const transport = new FakeTransport((method, params) => {
      if (method === "initialize") {
        return {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "taskboard", version: "0.1.0" },
        };
      }
      if (method === "tools/list") {
        return {
          tools: [
            {
              name: "add_task",
              description: "新增任务",
              inputSchema: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            },
          ],
        };
      }
      forwarded = params as { name: string; arguments: Record<string, unknown> };
      return { content: [{ type: "text", text: "已创建任务 #1" }] };
    });

    const client = new MCPClient(transport);
    await client.connect();
    const tools = await toMCPTools(client);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("mcp__taskboard__add_task");
    // schema 原样保留，不做 Zod 翻译
    expect(tools[0]!.parameters.required).toEqual(["title"]);

    const out = await tools[0]!.execute({ title: "写文档" });
    expect(out).toBe("已创建任务 #1");
    // 转发给服务端时用的是原始工具名（不带命名空间）
    expect(forwarded?.name).toBe("add_task");
    expect(forwarded?.arguments).toEqual({ title: "写文档" });
  });

  it("服务端没给 inputSchema 时补一个空对象 schema", async () => {
    const transport = new FakeTransport((method) => {
      if (method === "initialize") {
        return {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "taskboard", version: "0.1.0" },
        };
      }
      return { tools: [{ name: "ping_tool" }] };
    });
    const client = new MCPClient(transport);
    await client.connect();
    const tools = await toMCPTools(client);
    expect(tools[0]!.parameters).toEqual({ type: "object", properties: {} });
  });

  it("mcpContentToText 拼接文本块，非文本块标注类型", () => {
    expect(
      mcpContentToText({
        content: [
          { type: "text", text: "第一段" },
          { type: "text", text: "第二段" },
        ],
      }),
    ).toBe("第一段\n第二段");
    expect(mcpContentToText({ content: [{ type: "image", data: "..." }] })).toBe(
      "[image 内容块]",
    );
    expect(mcpContentToText({})).toBe("");
  });
});

// ---------------------------------------------------------------- MCP 服务端

describe("MCPServer：最小服务端", () => {
  const server = new MCPServer({
    name: "taskboard",
    version: "0.1.0",
    tools: createBoardTools(new TaskBoard()),
  });

  it("initialize 返回协议版本与服务端信息", async () => {
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "c", version: "1" } },
    });
    const result = resp?.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.serverInfo.name).toBe("taskboard");
  });

  it("notifications/initialized 是通知，返回 null（无需响应）", async () => {
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(resp).toBeNull();
    expect(server.isInitialized).toBe(true);
  });

  it("tools/list 返回工具清单与各自的 inputSchema", async () => {
    const resp = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const result = resp?.result as { tools: Array<{ name: string; inputSchema: unknown }> };
    expect(result.tools.map((t) => t.name)).toEqual([
      "list_tasks",
      "add_task",
      "complete_task",
      "search_tasks",
    ]);
    const addTask = result.tools.find((t) => t.name === "add_task");
    expect((addTask?.inputSchema as { required: string[] }).required).toEqual(["title"]);
  });

  it("tools/call 调用工具并返回文本内容", async () => {
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "add_task", arguments: { title: "写 MCP 篇" } },
    });
    const result = resp?.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain("已创建任务 #1");
  });

  it("未知方法 → 返回 METHOD_NOT_FOUND 错误", async () => {
    const resp = await server.handleMessage({ jsonrpc: "2.0", id: 4, method: "nope" });
    expect(resp?.error?.code).toBe(-32601);
  });

  it("未知工具 → 返回 METHOD_NOT_FOUND 错误", async () => {
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "不存在", arguments: {} },
    });
    expect(resp?.error?.code).toBe(-32601);
  });

  it("工具抛异常 → 返回正常响应 + isError 标记（不是协议错误）", async () => {
    const failing = new MCPServer({
      name: "failing",
      version: "0.1.0",
      tools: [
        {
          name: "boom",
          description: "必定失败",
          inputSchema: { type: "object", properties: {} },
          handler: () => {
            throw new Error("内部炸了");
          },
        },
      ],
    });
    const resp = await failing.handleMessage({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "boom", arguments: {} },
    });
    expect(resp?.error).toBeUndefined();
    expect(resp?.result).toMatchObject({ isError: true });
  });
});

// ---------------------------------------------------------------- 看板业务逻辑

describe("TaskBoard：有状态的外部服务", () => {
  it("新增任务后能列出来，且状态流转不可倒退", () => {
    const board = new TaskBoard();
    const created = board.add("写第 9 篇", "high");
    expect(created.status).toBe("todo");

    const listed = board.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.title).toBe("写第 9 篇");

    board.complete(created.id);
    expect(board.list()[0]!.status).toBe("done");
    // 已完成再完成 → 业务约束报错
    expect(() => board.complete(created.id)).toThrow(/已经完成过/);
  });

  it("按状态筛选与关键词搜索", () => {
    const board = new TaskBoard();
    board.add("写 MCP 客户端", "high");
    board.add("写 MCP 服务端");
    const done = board.add("写配图");
    board.complete(done.id);

    expect(board.list("done")).toHaveLength(1);
    expect(board.list("todo")).toHaveLength(2);
    expect(board.search("mcp")).toHaveLength(2);
    expect(board.search("不存在的关键词")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- 本地服务端启动参数

describe("localBoardServerOptions：服务端启动路径", () => {
  it("不传数据文件时落到项目 data/board.json", () => {
    const opts = localBoardServerOptions();
    expect(opts.args[opts.args.length - 1]).toContain("board.json");
    expect(opts.command).toBe(process.execPath);
  });

  it("传绝对路径时不被当成目录再拼一层文件名（回归：曾拼成 xxx.json/board.json）", () => {
    const abs = resolve(tmpdir(), "agent-test-board-123.json");
    const opts = localBoardServerOptions(abs);
    expect(opts.args[opts.args.length - 1]).toBe(abs);
    // 关键：路径的父目录仍是临时目录，而不是把文件名当目录
    expect(dirname(opts.args[opts.args.length - 1]!)).toBe(tmpdir());
  });
});

// ---------------------------------------------------------------- 端到端：Agent 用 MCP 工具

describe("端到端：Agent 通过 MCP 工具完成任务", () => {
  it("模型调用 MCP 工具，观察结果回喂，Agent 内核零改动", async () => {
    const board = new TaskBoard();
    const server = new MCPServer({
      name: "taskboard",
      version: "0.1.0",
      tools: createBoardTools(board),
    });

    // 用一个「假传输」把 MCPClient 直接接到真实服务端上：
    // 请求进 server.handleMessage，响应原路返回。这模拟了 stdio 往返，但不启子进程。
    const transport = new FakeTransport(async (method, params) => {
      const resp = await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      });
      return resp?.result;
    });

    const client = new MCPClient(transport);
    await client.connect();
    const mcpTools = await toMCPTools(client);

    // 伪造模型：第一轮要求调用 add_task，第二轮给出最终答案
    const toolFn = vi.fn();
    toolFn
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "mcp__taskboard__add_task",
              arguments: { title: "接入 MCP 服务端" },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ content: "已在看板上创建任务。", toolCalls: [] });
    const fakeClient = { chatWithTools: toolFn, chat: vi.fn() } as unknown as LLMClient;

    const registry = new ToolRegistry().registerAll(mcpTools);
    const agent = new Agent(fakeClient, { registry, maxSteps: 4 });

    const result = await agent.run("帮我建一个任务");

    // 模型确实看到了 MCP 工具的定义
    const offered = toolFn.mock.calls[0]![1] as Array<{ function: { name: string } }>;
    expect(offered.map((t) => t.function.name)).toContain("mcp__taskboard__add_task");

    // 工具真的执行了，副作用落在外部服务上
    expect(board.list()).toHaveLength(1);
    expect(board.list()[0]!.title).toBe("接入 MCP 服务端");

    // 观察结果回喂给模型
    const obs = result.steps.filter((s) => s.kind === "observation").map((s) => s.text);
    expect(obs[0]).toContain("已创建任务 #1");
    expect(result.answer).toBe("已在看板上创建任务。");
  });
});
