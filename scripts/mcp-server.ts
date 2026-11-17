/**
 * 以独立进程方式运行 MCP 服务端（stdio 传输）。
 *
 * 用法（由 MCPClient 通过 StdioTransport 拉起）：
 *   npx tsx scripts/mcp-server.ts [数据文件路径]
 *
 * 协议形态：stdin 收「一行一个 JSON」的 JSON-RPC 请求，stdout 回同样格式的响应。
 * **stdout 只能输出协议内容**，任何日志都必须写 stderr，否则会污染 JSON 流。
 */
import { MCPServer } from "../src/mcp/server.js";
import { TaskBoard, createBoardTools } from "../src/mcp/taskBoard.js";
import type { JsonRpcMessage } from "../src/mcp/protocol.js";

async function main(): Promise<void> {
  const dataFile = process.argv[2] ?? "data/board.json";
  const board = new TaskBoard(dataFile);
  const server = new MCPServer({
    name: "taskboard",
    version: "0.1.0",
    tools: createBoardTools(board),
  });

  // 日志一律走 stderr，stdout 留给协议
  process.stderr.write(`[mcp-server] taskboard 已启动，数据文件：${dataFile}\n`);

  let buffer = "";
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) void handleLine(line);
      index = buffer.indexOf("\n");
    }
  });

  process.stdin.on("end", () => {
    process.stderr.write("[mcp-server] stdin 已关闭，服务端退出\n");
    process.exit(0);
  });

  async function handleLine(line: string): Promise<void> {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // 解析失败：按 JSON-RPC 规范回 parse error（id 未知时用 null）
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "JSON 解析失败" },
      });
      return;
    }

    const response = await server.handleMessage(msg);
    if (response) write(response);
  }

  function write(payload: unknown): void {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`[mcp-server] 致命错误：${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
