/**
 * 能力对照审计：把十二篇手搓实现与 ADK / Mastra 逐项对齐。
 *
 * 对照表不写成飘在文档里的主观结论。每一行都挂着仓库里的证据文件，
 * 行数由脚本现算，测试覆盖也按文件实际存在与否统计。代码改了，
 * 再跑一次审计，表格自动跟着变。
 *
 * 这里只描述能力边界，不给框架打分。取舍写在 posts/13.md。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 一项能力及其在三套实现里的对应位置 */
export interface Capability {
  /** 短标识，用于命令行筛选与输出 */
  id: string;
  /** 中文能力名 */
  name: string;
  /** 首次实现该能力的篇号，如 "02" */
  post: string;
  /** 本系列的源码证据，相对仓库根 */
  evidence: string[];
  /** 覆盖该能力的测试文件，相对仓库根 */
  tests: string[];
  /** Google ADK 的对应机制 */
  adk: string;
  /** Mastra 的对应机制 */
  mastra: string;
  /** 本系列尚未覆盖的部分 */
  gap: string;
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "agent-loop",
    name: "Agent 循环与工具调用",
    post: "02",
    evidence: ["src/agent/Agent.ts", "src/agent/registry.ts"],
    tests: ["tests/agent.test.ts", "tests/tools.test.ts"],
    adk: "LlmAgent + Runner；FunctionTool 由模型自主选择，Runner 负责事件调度",
    mastra: "Agent.generate() / stream()；推理循环封在 Agent 内部",
    gap: "固定步数上限，无流式输出、无结构化中断信号",
  },
  {
    id: "tools",
    name: "工具注册表与参数校验",
    post: "02/09",
    evidence: ["src/agent/tools.ts", "src/agent/registry.ts", "src/agent/schema.ts"],
    tests: ["tests/tools.test.ts", "tests/mcp.test.ts"],
    adk: "BaseTool / FunctionTool；MCPToolset 把外部工具集挂进 agent",
    mastra: "createTool() + Standard JSON Schema，支持 Zod / Valibot / ArkType",
    gap: "只支持 Zod 与原生 JSON Schema，无工具级重试与编排",
  },
  {
    id: "context",
    name: "短期上下文压缩",
    post: "06",
    evidence: ["src/memory/ContextCompressor.ts"],
    tests: ["tests/memory.test.ts"],
    adk: "自动过滤无关事件、摘要较旧轮次、Artifacts 延迟加载",
    mastra: "Observational Memory：后台 agent 压缩旧消息，可开 recall 工具回查原文",
    gap: "按用户轮边界切分后单次摘要，无后台异步压缩与原文回查工具",
  },
  {
    id: "memory",
    name: "跨会话长期记忆",
    post: "06",
    evidence: ["src/memory/MemoryStore.ts", "src/tools/memory.ts"],
    tests: ["tests/memory.test.ts"],
    adk: "MemoryService（InMemory / Firestore）+ LoadMemoryTool 查询",
    mastra: "working memory + semantic recall，按 resource / thread 划分作用域",
    gap: "JSON 文件 + 中文 bigram 检索，无向量检索与多租户作用域",
  },
  {
    id: "planning",
    name: "规划与分步执行",
    post: "07",
    evidence: ["src/planning/Planner.ts", "src/planning/types.ts"],
    tests: ["tests/planning.test.ts"],
    adk: "LlmAgent 内置规划能力；graph workflows 混排确定性节点",
    mastra: "createWorkflow() + .then() / .branch() / .parallel()，typed step",
    gap: "线性计划加一次有限重规划，无图分支、循环与嵌套子流程",
  },
  {
    id: "orchestration",
    name: "多 Agent 协作",
    post: "08",
    evidence: ["src/orchestrator/Orchestrator.ts", "src/orchestrator/roles.ts"],
    tests: ["tests/orchestrator.test.ts"],
    adk: "SequentialAgent / ParallelAgent / LoopAgent 等工作流 agent；A2A 协议",
    mastra: "supervisor 委派与 agent network；子 agent 记忆自动隔离",
    gap: "固定三角色、两条编排路径，无远程 agent 发现与通信协议",
  },
  {
    id: "mcp",
    name: "MCP 协议接入",
    post: "09",
    evidence: ["src/mcp/MCPClient.ts", "src/mcp/transport.ts", "src/mcp/server.ts"],
    tests: ["tests/mcp.test.ts"],
    adk: "MCPToolset，外部工具集直接作为 agent 的工具来源",
    mastra: "可编写 MCPServer，把 agent 与 tool 暴露给任意协议客户端",
    gap: "只实现客户端与最小服务端，无 resources / prompts / sampling",
  },
  {
    id: "sandbox",
    name: "参数级权限与沙箱",
    post: "10",
    evidence: ["src/sandbox/guard.ts", "src/sandbox/rules.ts", "src/sandbox/paths.ts"],
    tests: ["tests/sandbox.test.ts"],
    adk: "before_tool_callback 返回 dict 即跳过真实工具；plugins 集中注入策略",
    mastra: "processors / tripwire 在输入输出两端阻断；平台提供托管沙箱",
    gap: "三态策略与人工审批仅单进程生效，无租户级策略下发与远程审批",
  },
  {
    id: "persistence",
    name: "持久化与崩溃恢复",
    post: "11",
    evidence: ["src/persistence/EventLog.ts", "src/persistence/SessionStore.ts", "src/persistence/restore.ts"],
    tests: ["tests/persistence.test.ts"],
    adk: "SessionService / MemoryService / ArtifactService 三个可插拔服务契约",
    mastra: "storage provider + workflow state + suspend / resume / restart",
    gap: "appendFileSync 未 fsync，只扛进程崩溃；单进程写入，无跨实例租约",
  },
  {
    id: "observability",
    name: "链路追踪与指标",
    post: "12",
    evidence: ["src/observe/tracer.ts", "src/observe/metrics.ts", "src/observe/instrument.ts"],
    tests: ["tests/observability.test.ts"],
    adk: "callbacks / plugins 挂接日志，交由 Cloud Trace 等后端聚合",
    mastra: "原生 OpenTelemetry traces，配套 evals / metrics / datasets",
    gap: "自研 span 与 Prometheus 文本端点，无采样、OTel 导出与评估数据集",
  },
  {
    id: "limits",
    name: "并发限流与超时取消",
    post: "12",
    evidence: ["src/observe/limiter.ts", "src/observe/deadline.ts"],
    tests: ["tests/observability.test.ts"],
    adk: "Runner 调度；并发与弹性由 Vertex AI Agent Engine / GKE 承担",
    mastra: "workflow runners（如 Inngest）与内置 server 承担运行期调度",
    gap: "单进程 FIFO 信号量，跨实例限流要外部组件",
  },
  {
    id: "delivery",
    name: "交付与复现",
    post: "01-12",
    evidence: ["README.md", "scripts/demo-observability.ts", "scripts/demo-persistence.ts"],
    tests: ["tests/agent.test.ts"],
    adk: "adk web / CLI 本地调试，Agent Engine 托管部署",
    mastra: "Studio 可视化工作台，server 配置与 Mastra Cloud 托管",
    gap: "只有 REPL 与演示脚本，无可视化编排界面与托管部署",
  },
];

export interface AuditRow extends Capability {
  /** 全部证据文件是否都在 */
  present: boolean;
  /** 证据文件源码总行数 */
  sourceLines: number;
  /** 实际存在的测试文件数 */
  testFiles: number;
  /** 缺失的证据文件 */
  missing: string[];
}

/** 统计一个文本文件的行数，末尾换行不算多出一行 */
function countLines(path: string): number {
  const content = readFileSync(path, "utf8");
  if (content === "") return 0;
  const parts = content.split(/\r?\n/);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

/** 从仓库根目录扫描全部能力的证据文件 */
export function auditCapabilities(
  rootDir: string,
  list: readonly Capability[] = CAPABILITIES,
): AuditRow[] {
  return list.map((cap) => {
    const missing: string[] = [];
    let sourceLines = 0;
    for (const file of cap.evidence) {
      const full = join(rootDir, file);
      if (!existsSync(full)) {
        missing.push(file);
        continue;
      }
      sourceLines += countLines(full);
    }
    const testFiles = cap.tests.filter((file) => existsSync(join(rootDir, file))).length;
    return { ...cap, present: missing.length === 0, sourceLines, testFiles, missing };
  });
}

/** 终端输出：按篇号排序后逐项列出证据、行数、测试与三套实现的对应 */
export function renderTerminal(rows: readonly AuditRow[]): string {
  const lines: string[] = [];
  lines.push(`能力对照审计 —— ${rows.length} 项`);
  lines.push("=".repeat(64));
  for (const row of rows) {
    lines.push(`[post-${row.post}] ${row.id}  ${row.name}`);
    lines.push(
      `  证据 ${row.present ? "✓" : "✗"}  ${row.sourceLines} 行 / ${row.testFiles} 个测试文件` +
        (row.missing.length ? `  缺失: ${row.missing.join(", ")}` : ""),
    );
    lines.push(`  ADK    ${row.adk}`);
    lines.push(`  Mastra ${row.mastra}`);
    lines.push(`  差距   ${row.gap}`);
    lines.push("");
  }
  const present = rows.filter((r) => r.present).length;
  lines.push(`合计 ${present}/${rows.length} 项证据齐全`);
  return lines.join("\n");
}

/** Markdown 表格，可直接贴进文档 */
export function renderMarkdown(rows: readonly AuditRow[]): string {
  const lines = [
    "| 能力 | 篇 | 本系列证据 | ADK 对应 | Mastra 对应 | 未覆盖 |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const evidence = `${row.evidence.length} 文件 / ${row.sourceLines} 行`;
    lines.push(
      `| ${row.name} | ${row.post} | ${evidence} | ${row.adk} | ${row.mastra} | ${row.gap} |`,
    );
  }
  return lines.join("\n");
}
