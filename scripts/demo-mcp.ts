/**
 * 第 9 篇演示：MCP 接入的完整链路。
 *
 * 走一遍真实路径：
 *   1. 拉起 MCP 服务端子进程（stdio 传输）
 *   2. initialize 握手 → notifications/initialized
 *   3. tools/list 发现工具 → 适配成带命名空间的 RawTool
 *   4. 注册进 ToolRegistry，交给真实模型
 *   5. 模型调用 MCP 工具 → 观察结果回喂 → 最终答复
 *   6. 校验副作用真的落在了外部服务上（看板里多了一条任务）
 *
 * 需要网络与 .env 里的 key。
 */
import dotenv from "dotenv";
dotenv.config({ override: true });
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClient } from "../src/llm/index.js";
import { Agent, ToolRegistry } from "../src/agent/index.js";
import { allTools } from "../src/tools/index.js";
import {
  MCPClient,
  StdioTransport,
  toMCPTools,
  localBoardServerOptions,
} from "../src/mcp/index.js";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("缺少 OPENAI_API_KEY");
  process.exit(1);
}

const client = new LLMClient({
  apiKey,
  baseURL: process.env.BASE_URL || undefined,
  model: process.env.MODEL ?? "deepseek-flash",
});

const log: string[] = [];
function record(s: string): void {
  log.push(s);
  console.log(s);
}

async function main(): Promise<void> {
  // 用临时目录做看板数据文件，演示不污染项目 data/
  const boardFile = join(tmpdir(), `agent-demo-board-${Date.now()}.json`);

  record("===== 启动 MCP 服务端子进程 =====");
  const transport = new StdioTransport(localBoardServerOptions(boardFile));
  const mcpClient = new MCPClient(transport, { clientName: "agent-from-scratch" });

  try {
    // 1) 握手
    const info = await mcpClient.connect();
    record(`[握手] 服务端 ${info.name} v${info.version}，协议版本 ${info.protocolVersion}`);
    record(`[握手] 服务端能力：${JSON.stringify(info.capabilities)}`);

    // 2) 工具发现
    const mcpTools = await toMCPTools(mcpClient);
    record(`\n===== 工具发现：${mcpTools.length} 个外部工具 =====`);
    for (const t of mcpTools) {
      record(`  - ${t.name}`);
      record(`    说明：${t.description.slice(0, 48)}...`);
      record(`    参数 schema（服务端原样给出）：${JSON.stringify(t.parameters)}`);
    }

    // 3) 注册进同一个工具箱
    const registry = new ToolRegistry().registerAll([...allTools, ...mcpTools]);
    record(`\n===== 工具箱合计 ${registry.list().length} 个工具 =====`);
    record(`  本地工具：${registry.list().filter((t) => !t.name.startsWith("mcp__")).map((t) => t.name).join(", ")}`);
    record(`  MCP 工具：${registry.list().filter((t) => t.name.startsWith("mcp__")).map((t) => t.name).join(", ")}`);

    // 4) 真实模型跑一轮：让它用 MCP 工具建任务，再读回看板
    const agent = new Agent(client, {
      registry,
      maxSteps: 8,
      systemPrompt:
        "你是一个会使用工具的智能助手。你拥有若干工具，可以用 calculator 做算术，" +
        "用 readFile 读本地资料、用 searchFiles 检索、用 webFetch 抓网页，" +
        "还可以调用以 mcp__ 开头的外部工具（例如任务看板服务）来管理任务。" +
        "需要用到这些能力时优先调用工具，拿到观察结果后再回答。",
    });

    record("\n===== 模型调用 MCP 工具（第一轮：建任务） =====");
    const first = await agent.run(
      "请在任务看板上创建一条任务，标题是「接入 MCP 服务端」，优先级 high。创建后再把看板列出来看看。",
    );
    for (const step of first.steps) {
      record(`  [${label(step.kind)}] ${step.text}`);
    }
    record(`助手：${first.answer}`);

    // 5) 验证副作用：直接读看板文件，确认任务真的写进了外部服务
    record("\n===== 校验外部服务的状态（读看板数据文件） =====");
    try {
      const raw = JSON.parse(readFileSync(boardFile, "utf8")) as {
        tasks: Array<{ id: number; title: string; status: string; priority: string }>;
      };
      for (const t of raw.tasks) {
        record(`  #${t.id} [${t.status}/${t.priority}] ${t.title}`);
      }
      record(`  看板共有 ${raw.tasks.length} 条任务——副作用确实落在了外部服务上`);
    } catch (err) {
      record(`  读取看板失败：${err instanceof Error ? err.message : String(err)}`);
    }

    // 6) 失败路径：MCP 工具执行失败在协议里是「正常响应 + isError」，
    //    不是 JSON-RPC 错误——这两者的区别是本篇最容易踩的坑
    record("\n===== 失败路径：工具执行失败如何回传给 Agent =====");
    const firstComplete = await mcpClient.callToolAsText("complete_task", { id: 1 });
    record(`  第一次完成任务 #1：${firstComplete}`);
    const secondComplete = await mcpClient.callToolAsText("complete_task", { id: 1 });
    record(`  再次完成任务 #1：${secondComplete}`);
    record("  注意第二次的标记：isError=true 被适配层转成 [MCP 工具错误] 前缀，");
    record("  模型看到的是一个明确的失败，而不是一段看似正常的结果。");

    // 7) 换一个进程再连一次，验证外部服务的状态跨连接保留
    record("\n===== 重新连接（模拟新会话）=====");
    mcpClient.close();
    const transport2 = new StdioTransport(localBoardServerOptions(boardFile));
    const mcpClient2 = new MCPClient(transport2, { clientName: "agent-from-scratch" });
    try {
      await mcpClient2.connect();
      const listTools = await mcpClient2.listTools();
      record(`  重新握手成功，发现 ${listTools.length} 个工具`);
      const boardTool = listTools.find((t) => t.name === "list_tasks");
      if (boardTool) {
        const text = await mcpClient2.callToolAsText("list_tasks", {});
        record(`  list_tasks 返回：\n${text.split("\n").map((l) => "    " + l).join("\n")}`);
      }
    } finally {
      mcpClient2.close();
    }
  } finally {
    mcpClient.close();
  }

  writeFileSync(join(tmpdir(), "agent-demo-mcp-trace.txt"), log.join("\n"));
  record("\n[done] trace written");
}

function label(kind: string): string {
  return (
    { thought: "思考", action: "行动", observation: "观察", answer: "回答" }[
      kind
    ] ?? kind
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
