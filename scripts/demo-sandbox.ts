/**
 * 第 10 篇演示：让 Agent 可信——权限 / 沙箱 / 人工介入。
 *
 * 走一遍真实路径：
 *   1. 装配一套默认权限策略（参数级规则），把规则表打印出来；
 *   2. 装上高风险工具（writeFile / deleteFile / runCommand）与授权关卡；
 *   3. 真实模型跑一个任务：读资料 → 写文件（人工批准）→ 删文件（人工驳回）；
 *   4. 越权尝试：读 .env（策略直接拒绝）；
 *   5. 命令执行尝试（人工驳回）；
 *   6. 打印审计日志，核对每一次决策都有留痕。
 *
 * 需要网络与 .env 里的 key。
 */
import dotenv from "dotenv";
dotenv.config({ override: true });
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LLMClient } from "../src/llm/index.js";
import { Agent, ToolRegistry } from "../src/agent/index.js";
import { allTools, dangerousTools } from "../src/tools/index.js";
import {
  ToolGuard,
  MemoryAuditLog,
  CallbackApprover,
  defaultSandboxPolicy,
  defaultFileSandbox,
} from "../src/sandbox/index.js";

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

const trace: string[] = [];
function record(s = ""): void {
  trace.push(s);
  console.log(s);
}

async function main(): Promise<void> {
  const dataDir = join(process.cwd(), "data");
  const summaryFile = join(dataDir, "summary.txt");
  if (existsSync(summaryFile)) rmSync(summaryFile);

  // ---------------------------------------------------------- 1. 策略规则表
  const fileSandbox = defaultFileSandbox();
  const policy = defaultSandboxPolicy({ fileSandbox });
  const rules = policy.listRules();

  record("===== 默认权限策略（参数级规则，顺序求值，第一条命中即生效） =====");
  rules.forEach((r, i) => {
    record(`  ${String(i + 1).padStart(2, " ")}. [${r.decision.padEnd(5)}] ${r.id} —— ${r.description}`);
  });
  record(`  默认兜底：无规则命中 → 拒绝`);

  // ---------------------------------------------------------- 2. 装配工具箱与授权关卡
  const audit = new MemoryAuditLog();

  // 模拟人工审批：写文件批准，删文件与执行命令驳回
  const approver = new CallbackApprover((req) => {
    const approved = req.tool === "writeFile";
    record(
      `[审批] 工具 "${req.tool}" 送来审批请求 → ${approved ? "批准" : "驳回"}（理由：${
        approved ? "内容是资料摘要，落在 data/ 内" : "该操作不可逆且无必要"
      }）`,
    );
    return {
      approved,
      reason: approved ? "内容是资料摘要，落在 data/ 内" : "该操作不可逆且无必要",
      approver: "demo-operator",
    };
  }, "demo-approver");

  const guard = new ToolGuard({
    policy,
    approver,
    audit,
    approvalTimeoutMs: 30_000,
    onDecision: ({ tool, outcome, approvalMs }) => {
      const label =
        outcome.status === "allow"
          ? "自动放行"
          : outcome.status === "approved"
            ? "人工批准"
            : outcome.status === "rejected"
              ? "人工驳回"
              : "策略拒绝";
      const ms = approvalMs !== undefined ? `，审批耗时 ${approvalMs}ms` : "";
      record(`[决策] ${tool} → ${label}（${outcome.decision.reason}）${ms}`);
    },
  });

  const registry = new ToolRegistry()
    .registerAll([...allTools, ...dangerousTools])
    .setGuard(guard);

  record(`\n===== 工具箱（${registry.list().length} 个工具，已启用权限检查） =====`);
  record(`  只读工具：calculator, readFile, searchFiles, webFetch`);
  record(`  高风险工具：writeFile, deleteFile, runCommand（需人工审批）`);

  // ---------------------------------------------------------- 3. 真实模型跑任务
  const agent = new Agent(client, {
    registry,
    maxSteps: 8,
    systemPrompt:
      "你是一个会使用工具的智能助手。你可以读本地资料、用 calculator 算数，" +
      "也可以用 writeFile 写文件、用 deleteFile 删文件。" +
      "重要：本地文件路径都相对 data/ 目录，例如 summary.txt、notes.txt、docs/plan.md，" +
      "不要写成 data/summary.txt（那样会变成 data/data/summary.txt）。" +
      "任务里明确要求产出文件时才写文件。" +
      "如果某个工具调用被拒绝（你会看到 [权限拒绝·…] 开头的观察结果），" +
      "不要重试同一个操作，如实说明这一步没能完成即可。",
  });

  record(`\n===== 真实模型执行任务 =====`);
  record(`任务：读出 data/notes.txt 的要点，写进 data/summary.txt，然后把 summary.txt 删掉`);
  const { answer, steps } = await agent.run(
    "请读出 data/notes.txt 的内容，把要点总结成三行写入 data/summary.txt，然后再删除 data/summary.txt。",
  );
  for (const s of steps) {
    const label =
      s.kind === "thought" ? "思考" : s.kind === "action" ? "行动" : s.kind === "observation" ? "观察" : "回答";
    record(`[${label}] ${s.text}`);
  }
  record(`助手：${answer}`);

  // ---------------------------------------------------------- 4. 副作用核对
  const written = existsSync(summaryFile);
  record(`\n===== 副作用核对 =====`);
  record(`  data/summary.txt 是否存在：${written ? "是（写入被批准，已落盘）" : "否"}`);
  record(`  结论：写入生效、删除被驳回后文件仍在——审批结果与磁盘状态一致`);

  // ---------------------------------------------------------- 5. 越权尝试
  record(`\n===== 越权尝试：读 .env =====`);
  const secretOut = await registry.run("readFile", { path: "../.env" });
  record(`  观察结果：${secretOut}`);
  const outsideOut = await registry.run("readFile", { path: "docs/../../package.json" });
  record(`  观察结果（路径穿越）：${outsideOut}`);

  // ---------------------------------------------------------- 6. 命令执行尝试
  record(`\n===== 命令执行尝试 =====`);
  const cmdOut = await registry.run("runCommand", { program: "node", args: ["-e", "console.log(1)"] });
  record(`  观察结果：${cmdOut}`);
  const cmdOut2 = await registry.run("runCommand", { program: "powershell", args: ["-Command", "Get-Item"] });
  record(`  观察结果（程序不在白名单）：${cmdOut2}`);

  // ---------------------------------------------------------- 7. 审计日志
  record(`\n===== 审计日志（${audit.list().length} 条） =====`);
  for (const e of audit.list()) {
    record(
      `  ${e.ts} ${e.tool} → ${e.decision}/${e.outcome} ${e.ruleId ? `规则=${e.ruleId}` : ""}${
        e.approver ? ` 审批人=${e.approver}` : ""
      }`,
    );
    record(`      参数：${e.args}`);
    record(`      理由：${e.reason}`);
  }

  // 清理演示产物
  if (existsSync(summaryFile)) rmSync(summaryFile);

  // 把完整轨迹写到文件，供配图脚本渲染
  const tracePath = join(process.cwd(), "data", "sandbox-trace.txt");
  writeFileSync(tracePath, trace.join("\n"), "utf8");
  record(`\n[done] 轨迹已写入 ${tracePath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
