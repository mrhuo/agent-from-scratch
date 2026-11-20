/**
 * 第 11 篇演示：会话持久化与崩溃续跑。
 *
 * 两个阶段，中间用真实的进程退出隔开：
 *   node scripts/demo-persistence.ts run
 *     → 真实模型跑一轮，落快照；随后注入两条在途工具调用并以 exit(9) 退出。
 *   node scripts/demo-persistence.ts resume
 *     → 新进程从磁盘恢复：只读调用重放、有副作用调用标记不确定，
 *       再用恢复后的上下文向真实模型追问一次。
 *
 * 故障点是显式注入的（直接写事件日志），但恢复路径全部走产品代码。
 * 需要网络与 .env 里的 key。
 */
import dotenv from "dotenv";
dotenv.config({ override: true });
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LLMClient } from "../src/llm/index.js";
import { Agent, ToolRegistry } from "../src/agent/index.js";
import { allTools, createWriteFileTool } from "../src/tools/index.js";
import { SessionStore, ResumableAgent } from "../src/persistence/index.js";

const phase = process.argv[2] ?? "run";
const tracePath = join(process.cwd(), "data", "persistence-trace.txt");
const sessionDir = join(process.cwd(), "data", "sessions");
const sessionId = "demo-11";
if (existsSync(tracePath) && phase === "run") rmSync(tracePath);

function record(s = ""): void {
  console.log(s);
  appendFileSync(tracePath, `${s}\n`, "utf8");
}

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

function build() {
  const registry = new ToolRegistry().registerAll([...allTools, createWriteFileTool()]);
  const agent = new Agent(client, {
    registry,
    maxSteps: 8,
    systemPrompt:
      "你是一个会使用工具的智能助手。你可以用 calculator 算数、用 readFile 读本地资料、" +
      "用 searchFiles 检索、用 writeFile 写文件。本地文件路径相对 data/ 目录。" +
      "拿到工具结果后给出简短答复。",
  });
  const store = new SessionStore({ dir: sessionDir, sessionId, model: process.env.MODEL });
  return { registry, agent, store, resumable: new ResumableAgent({ agent, registry, store }) };
}

async function runPhase(): Promise<void> {
  const firstDir = join(sessionDir, sessionId);
  if (existsSync(firstDir)) rmSync(firstDir, { recursive: true, force: true });
  const fresh = build();
  record(`===== 阶段一：正常运行（进程 ${process.pid}） =====`);
  record(`会话目录：${fresh.store.dir}`);
  const { answer, steps } = await fresh.resumable.run("读一下 data/notes.txt，再用 calculator 算 17*23，最后给出简短答复");
  for (const s of steps) {
    const label = s.kind === "thought" ? "思考" : s.kind === "action" ? "行动" : s.kind === "observation" ? "观察" : "回答";
    record(`  [${label}] ${s.text.slice(0, 140)}`);
  }
  record(`  [答复] ${answer.slice(0, 160)}`);
  const snap = fresh.store.loadSnapshot();
  record(`\n  事件条数：${fresh.store.log.readAll().length}，快照 lastSeq=${snap?.lastSeq}，状态=${fresh.store.status()}`);
  record(`  快照消息数：${snap?.messages.length}`);

  // 故障注入：写入两条「工具即将执行」的在途记录，然后真的退出进程。
  record(`\n  [故障注入] 写入两条在途工具调用，进程以 exit(9) 退出`);
  fresh.store.mark("running", "注入崩溃：工具执行前");
  fresh.store.append({
    type: "tool_call",
    id: "crash-calc",
    group: "injected-crash",
    content: "先算一下",
    tool: "calculator",
    args: { expression: "40+2" },
    replayable: true,
  });
  fresh.store.append({
    type: "tool_call",
    id: "crash-write",
    group: "injected-crash",
    content: "再把结果写盘",
    tool: "writeFile",
    args: { path: "persistence-demo.txt", content: "42" },
    replayable: false,
  });
  record(`  崩溃时事件条数：${fresh.store.log.readAll().length}，状态=${fresh.store.status()}`);
  writeFileSync(join(process.cwd(), "data", "persistence-phase.txt"), "crashed", "utf8");
  process.exit(9);
}

async function resumePhase(): Promise<void> {
  const { store, resumable } = build();
  record(`\n===== 阶段二：新进程恢复（进程 ${process.pid}） =====`);
  record(`崩溃时状态=${store.status()}，事件条数=${store.log.readAll().length}`);
  const report = await resumable.resume();
  record(`  [恢复] 重放事件 ${report.replayedEvents} 条，恢复消息 ${report.messageCount} 条`);
  record(`  [恢复] 只读重放：${report.replayedCalls.join(", ") || "（无）"}`);
  record(`  [恢复] 跳过重放：${report.uncertainCalls.join(", ") || "（无）"}`);
  for (const w of report.warnings) record(`  [警告] ${w}`);
  const snap = store.loadSnapshot();
  record(`  恢复后 lastSeq=${snap?.lastSeq}，状态=${store.status()}，消息数=${snap?.messages.length}`);

  // 重复恢复必须幂等
  const second = await resumable.resume();
  record(`  二次恢复：重放调用 ${second.replayedCalls.length} 条、不确定调用 ${second.uncertainCalls.length} 条（均应为 0）`);

  record(`\n  [追问] 上一轮算出的结果是多少？`);
  const { answer, steps } = await resumable.run("刚才计算器算出的结果是多少？只回答数字");
  for (const s of steps) {
    if (s.kind === "observation") record(`  [观察] ${s.text.slice(0, 120)}`);
  }
  record(`  [答复] ${answer.slice(0, 160)}`);
  record(`\n  最终状态=${store.status()}，事件总数=${store.log.readAll().length}`);
}

if (phase === "run") {
  await runPhase();
} else if (phase === "resume") {
  await resumePhase();
} else {
  console.error("用法：node scripts/demo-persistence.ts run | resume");
  process.exit(1);
}
