import dotenv from "dotenv";
// override: true —— 本地 .env 优先于外层已注入的环境变量（如 CI / 沙箱预设的 OPENAI_API_KEY），
// 避免「明明填了 key，发出去的却是别处的 key」这种静默覆盖坑。
dotenv.config({ override: true });
import { LLMClient } from "./llm/index.js";
import { Agent, ToolRegistry } from "./agent/index.js";
import type { AgentStep } from "./agent/index.js";
import { allTools, dangerousTools } from "./tools/index.js";
import { MemoryStore } from "./memory/MemoryStore.js";
import { ContextCompressor, LLMSummarizer } from "./memory/ContextCompressor.js";
import { createRememberTool, createRecallTool } from "./tools/memory.js";
import { Planner } from "./planning/index.js";
import {
  Orchestrator,
  RESEARCHER,
  WRITER,
  REVIEWER,
  type AgentRole,
  type CollaborationResult,
} from "./orchestrator/index.js";
import { MCPClient, StdioTransport, toMCPTools, localBoardServerOptions } from "./mcp/index.js";
import {
  ToolGuard,
  FileAuditLog,
  ConsoleApprover,
  defaultSandboxPolicy,
  defaultFileSandbox,
} from "./sandbox/index.js";
import { join } from "node:path";
import * as readline from "node:readline";

/**
 * 演示入口（累计到第 10 篇）：
 *  - 直接输入：走 Agent Loop（含第 6 篇的短期压缩 + 长期记忆注入）。
 *  - /plan：第 7 篇的规划执行模式（Planner 拆步骤 → 分步执行 → 汇总）。
 *  - /team：第 8 篇的多 Agent 协作（串行流水线 / 并行分派 + 汇总）。
 *  - /mcp：第 9 篇的 MCP 接入（拉起本地 MCP 服务端 → 发现工具 → 交给 Agent 调用）。
 *  - /safe：第 10 篇的受限模式（参数级权限 + 路径沙箱 + 人工审批 + 审计日志）。
 */
const STEP_LABEL: Record<AgentStep["kind"], string> = {
  thought: "思考",
  action: "行动",
  observation: "观察",
  answer: "回答",
};

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("缺少 OPENAI_API_KEY，请复制 .env.example 为 .env 并填入");
    process.exit(1);
  }

  const client = new LLMClient({
    apiKey,
    baseURL: process.env.BASE_URL || undefined,
    model: process.env.MODEL ?? "gpt-4o-mini",
  });

  // 长期记忆：落盘到项目目录下的 data/memory.json（已加入 .gitignore，不会进提交）。
  const memoryStore = new MemoryStore(join(process.cwd(), "data", "memory.json"));

  // 短期记忆：用 LLM 把旧轮次压成摘要；保留最近 6 个用户轮原样。
  const compressor = new ContextCompressor(new LLMSummarizer(client), 6);

  // 第 7 篇：规划器（jsonMode 让 DeepSeek/OpenAI 稳定返回结构化计划）。
  const planner = new Planner(client, { jsonMode: true });

  // 第 4 篇的四大真工具 + 第 6 篇的两个记忆工具，全部收编进注册表。
  // 新增工具只需在对应 index 里加一项，Agent 内核一行都不用改。
  const registry = new ToolRegistry().registerAll([
    ...allTools,
    createRememberTool(memoryStore),
    createRecallTool(memoryStore),
  ]);
  const agent = new Agent(client, { registry, maxSteps: 8, compressor, memoryStore, planner });

  // 第 10 篇：受限模式的一套组件。
  //  - 策略：参数级规则，默认拒绝兜底；
  //  - 沙箱：文件类工具只能碰 data/ 目录下的文本文件；
  //  - 审批：高风险操作问人（终端交互，超时按拒绝）；
  //  - 审计：每次决策都写 data/audit.jsonl。
  const auditLog = new FileAuditLog({ file: join(process.cwd(), "data", "audit.jsonl") });
  const sandboxGuard = new ToolGuard({
    policy: defaultSandboxPolicy({ fileSandbox: defaultFileSandbox() }),
    approver: new ConsoleApprover({ timeoutMs: 60_000 }),
    audit: auditLog,
    source: "safe-mode",
  });
  const safeRegistry = new ToolRegistry()
    .registerAll([...allTools, ...dangerousTools])
    .setGuard(sandboxGuard);
  const safeAgent = new Agent(client, {
    registry: safeRegistry,
    maxSteps: 8,
    compressor,
    memoryStore,
    planner,
    systemPrompt:
      "你是一个在受限沙箱里运行的助手。你可以读本地资料、算数、写文件、删文件、执行少量本地命令。" +
      "写文件、删文件、执行命令会触发人工审批，若收到 [权限拒绝·…] 开头的观察结果，" +
      "不要重试同一个操作，如实说明这一步没有完成。",
  });

  // 第 8 篇：协调者。把全部工具交给它，由它按角色白名单分发给每个 Worker。
  const orchestrator = new Orchestrator(client, {
    tools: [...allTools, createRememberTool(memoryStore), createRecallTool(memoryStore)],
    memoryStore,
    compressor,
    maxSteps: 8,
  });

  /** 打印一次协作结果：各成员产出 + 最终答复 */
  function printCollaboration(result: CollaborationResult): void {
    console.log("\n【团队协作·各成员产出】");
    result.results.forEach((r, idx) => {
      console.log(`  ${idx + 1}. ${r.title}（${r.role}）`);
      console.log(`     ${r.answer}`);
    });
    console.log(`【协调者汇总】${result.finalAnswer}\n`);
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  // 用 line 事件 + 队列，避免 question 在异步 await 期间因管道 EOF 关闭而抛 ERR_USE_AFTER_CLOSE。
  const queue: string[] = [];
  let resolveNext: ((value: string | null) => void) | null = null;
  let eof = false;
  rl.on("line", (line) => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(line);
    } else {
      queue.push(line);
    }
  });
  rl.on("close", () => {
    eof = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(null);
    }
  });

  const nextLine = (): Promise<string | null> =>
    new Promise((resolve) => {
      if (queue.length > 0) {
        resolve(queue.shift() ?? "");
        return;
      }
      if (eof) {
        resolve(null);
        return;
      }
      resolveNext = resolve;
    });

  console.log("Agent 对话开始（输入 exit 退出）");
  // 当前是否处于第 10 篇的受限模式（/safe 切换）
  let useSafe = false;
  while (true) {
    // 用户输入统一加「你：」前缀，与助手回复的「助手：」对称，便于阅读多轮对话。
    process.stdout.write("你：");
    const line = await nextLine();
    if (line === null) break; // EOF
    const text = line.trim();
    if (text === "") continue;
    if (text === "exit" || text === "quit") break;

    // 第 7 篇新增：/plan 进入「规划执行」模式——先把任务拆步骤，再分步执行后汇总
    if (text === "/plan") {
      process.stdout.write("请输入要规划执行的任务：");
      const taskLine = await nextLine();
      if (taskLine === null) break;
      const task = taskLine.trim();
      if (!task) continue;

      const result = await agent.runPlan(task);
      console.log("\n【规划】");
      console.log(`  目标：${result.plan.goal}`);
      result.plan.steps.forEach((s, idx) => console.log(`  ${idx + 1}. ${s}`));
      console.log("【分步执行】");
      result.stepResults.forEach((r, idx) =>
        console.log(`  步骤${idx + 1}「${r.step}」→ ${r.result}${r.done ? "" : "（未完成）"}`),
      );
      if (result.revisions > 0) console.log(`【重规划】发生了 ${result.revisions} 次`);
      console.log(`【最终答复】${result.answer}\n`);
      continue;
    }

    // 第 8 篇新增：/team 进入「多 Agent 协作」模式
    if (text === "/team") {
      process.stdout.write("请输入交给团队的任务：");
      const taskLine = await nextLine();
      if (taskLine === null) break;
      const task = taskLine.trim();
      if (!task) continue;
      console.log("选择协作模式：1=串行流水线（调研→写作→审核）  2=并行分派（默认 1）");
      const modeLine = await nextLine();
      const mode = modeLine?.trim() ?? "1";

      if (mode === "2") {
        // 并行：两个独立子任务同时推进——调研本地资料 + 检索关键词，再汇总
        const result = await orchestrator.runParallel([
          { role: RESEARCHER, task: `${task}（侧重：梳理本地资料里的相关事实）` },
          { role: REVIEWER, task: `${task}（侧重：从证据充分性角度做独立审查）` },
        ]);
        printCollaboration(result);
      } else {
        // 串行：调研 → 写作 → 审核，前序产出传给后序
        const roles: AgentRole[] = [RESEARCHER, WRITER, REVIEWER];
        const result = await orchestrator.runPipeline(task, roles);
        printCollaboration(result);
      }
      continue;
    }

    // 第 9 篇新增：/mcp 进入「MCP 接入」模式
    // 四步走：拉起服务端子进程 → initialize 握手 → tools/list 发现工具 → 注册进 Agent
    if (text === "/mcp") {
      process.stdout.write("请输入要交给 Agent 的任务：");
      const taskLine = await nextLine();
      if (taskLine === null) break;
      const task = taskLine.trim();
      if (!task) continue;

      const transport = new StdioTransport(localBoardServerOptions());
      const mcpClient = new MCPClient(transport, { clientName: "agent-from-scratch" });
      try {
        const info = await mcpClient.connect();
        console.log(`\n【MCP 握手】已连接服务端 ${info.name} v${info.version}（协议 ${info.protocolVersion}）`);

        const mcpTools = await toMCPTools(mcpClient);
        console.log(`【工具发现】发现 ${mcpTools.length} 个外部工具：`);
        mcpTools.forEach((t) => console.log(`  - ${t.name}`));

        // MCP 工具与本地工具进同一个注册表——Agent 内核一行都不用改。
        // systemPrompt 补充一句说明，模型才知道这些带 mcp__ 前缀的工具是外部来的。
        const mcpRegistry = new ToolRegistry().registerAll([...allTools, ...mcpTools]);
        const mcpAgent = new Agent(client, {
          registry: mcpRegistry,
          maxSteps: 8,
          compressor,
          memoryStore,
          planner,
          systemPrompt:
            "你是一个会使用工具的智能助手。你拥有若干工具，可以用 calculator 做算术，" +
            "用 readFile 读本地资料、用 searchFiles 检索、用 webFetch 抓网页，" +
            "还可以调用以 mcp__ 开头的外部工具（例如任务看板服务）来管理任务。" +
            "需要用到这些能力时优先调用工具，拿到观察结果后再回答。",
        });

        const { answer, steps } = await mcpAgent.run(task);
        for (const step of steps) {
          console.log(`  [${STEP_LABEL[step.kind]}] ${step.text}`);
        }
        console.log(`助手：${answer}`);
      } finally {
        // 无论成功失败都要收掉子进程，否则 Node 会挂住不退出
        mcpClient.close();
      }
      console.log();
      continue;
    }

    // 第 10 篇新增：/safe 切换到受限模式（参数级权限 + 沙箱 + 人工审批 + 审计）
    if (text === "/safe") {
      useSafe = true;
      console.log(
        "\n已进入受限模式：读写文件、删文件、执行命令都要过权限策略与人工审批；" +
          "审计写入 data/audit.jsonl。\n（输入 /unsafe 可切回普通模式）\n",
      );
      continue;
    }
    if (text === "/unsafe") {
      useSafe = false;
      console.log("\n已切回普通模式\n");
      continue;
    }

    if (!process.stdin.isTTY) process.stdout.write(`${text}\n`);
    const activeAgent = useSafe ? safeAgent : agent;
    const { answer, steps } = await activeAgent.run(text);
    for (const step of steps) {
      console.log(`  [${STEP_LABEL[step.kind]}] ${step.text}`);
    }
    console.log(`助手：${answer}`);
  }

  rl.close();
  console.log("对话结束。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
