import type { Agent, AgentRunResult } from "../agent/index.js";
import type { PlanRunResult } from "../planning/types.js";
import type { ToolRegistry } from "../agent/registry.js";
import { SessionStore } from "./SessionStore.js";
import { isReplayable, restoreSession } from "./restore.js";
import { SCHEMA_VERSION, type RecoveryReport, type SessionSnapshot } from "./types.js";

/**
 * 把「写事件 → 崩溃 → 重放」串成一条可调用的流程。
 *
 * 运行时：Agent 的钩子把每个关键状态同步写进事件日志；每轮结束打一份快照。
 * 恢复时：先读快照，再重放后续事件；对没有结果的在途工具调用做分类——
 * 只读工具重放执行，有副作用的工具绝不重跑，只写一条「结果未落盘」的观察。
 */
export class ResumableAgent {
  private readonly agent: Agent;
  private readonly registry: ToolRegistry;
  readonly store: SessionStore;
  private readonly errorStream: NodeJS.WritableStream;
  private recovered = false;
  private lastReport?: RecoveryReport;

  constructor(options: {
    agent: Agent;
    registry: ToolRegistry;
    store: SessionStore;
    errorStream?: NodeJS.WritableStream;
  }) {
    this.agent = options.agent;
    this.registry = options.registry;
    this.store = options.store;
    this.errorStream = options.errorStream ?? process.stderr;
    this.agent.setHooks({
      onUserInput: (text) => {
        this.store.mark("running", "开始新一轮执行");
        this.store.append({ type: "user_input", text });
      },
      onToolCalls: (content, calls, group) => {
        for (const call of calls) {
          this.store.append({
            type: "tool_call",
            id: call.id,
            group,
            content: content ?? "",
            tool: call.function.name,
            args: call.function.arguments,
            replayable: isReplayable(call.function.name),
          });
        }
      },
      onToolResult: (call, observation) => {
        this.store.append({
          type: "tool_result",
          id: call.id,
          tool: call.function.name,
          observation,
        });
      },
      onAssistantMessage: (message) => {
        this.store.append({ type: "assistant_message", message });
      },
      onPlanCreated: (plan) => {
        this.store.append({ type: "plan_created", goal: plan.goal, steps: plan.steps });
      },
      onPlanStep: (index, step, result) => {
        this.store.append({
          type: "plan_step",
          index,
          step,
          result: result.result,
          done: result.done,
        });
      },
      onPlanDone: (answer) => {
        this.store.append({ type: "plan_done", answer });
      },
    });
  }

  /** 最近一次恢复账单 */
  get report(): RecoveryReport | undefined {
    return this.lastReport;
  }

  status(): string {
    return this.store.status();
  }

  async run(text: string): Promise<AgentRunResult> {
    if (!this.recovered) await this.resume();
    const result = await this.agent.run(text);
    this.checkpoint("turn-complete");
    return result;
  }

  /** 规划模式：如果上次崩在步骤中间，从下一个未完成步骤继续 */
  async runPlan(task: string): Promise<PlanRunResult> {
    if (!this.recovered) await this.resume();
    const plan = this.currentPlan();
    const result = plan
      ? await this.agent.runPlan(task, {
          goal: plan.goal,
          steps: plan.steps,
          index: plan.index,
          results: plan.results,
        })
      : await this.agent.runPlan(task);
    this.checkpoint("plan-complete");
    return result;
  }

  /**
   * 从磁盘恢复到最后一个一致点。
   *
   * 「未落盘结果」的处理是本篇的核心：只读工具可以安全地再跑一次；
   * 写文件、删文件、外部 MCP 调用可能已经产生副作用，重跑会造成重复，
   * 因此只合成一条明确的观察文本，把这个不确定性摊在模型面前。
   */
  async resume(): Promise<RecoveryReport> {
    const before = this.store.status();
    if (before === "running") {
      this.store.mark("interrupted", "进程重启，上一轮执行未完成");
    }

    let state = restoreSession(
      this.store.loadSnapshot(),
      this.store.log.since(this.store.loadSnapshot()?.lastSeq ?? 0),
      this.store.sessionId,
    );
    this.agent.loadMessages(state.messages);
    const report: RecoveryReport = { ...state.report, status: before };

    for (const call of state.pending) {
      if (call.result) continue;
      if (call.replayable) {
        // 只读工具：重新执行并把结果补进日志，模型不必知道发生过崩溃
        const observation = await this.registry.run(call.tool, call.args);
        this.store.append({
          type: "tool_result",
          id: call.id,
          tool: call.tool,
          observation,
        });
        report.replayedCalls.push(call.id);
      } else {
        const observation =
          `[恢复提示·结果未落盘] 工具 "${call.tool}" 在上次进程退出前没有写下结果。` +
          `该工具可能已产生副作用，为避免重复执行已跳过重放；请如实告知用户这一步状态未知。`;
        this.store.append({
          type: "tool_result",
          id: call.id,
          tool: call.tool,
          observation,
          uncertain: true,
        });
        report.uncertainCalls.push(call.id);
      }
    }

    // 补齐结果后再重放一遍，确保工具观察消息按正确顺序回到上下文
    state = restoreSession(
      this.store.loadSnapshot(),
      this.store.log.since(this.store.loadSnapshot()?.lastSeq ?? 0),
      this.store.sessionId,
    );
    this.agent.loadMessages(state.messages);
    report.messageCount = state.messages.length;
    report.plan = state.plan;
    // 已重放成功的调用不再算未决告警：告警只描述恢复结束时仍悬而未决的事
    report.warnings = report.warnings.filter(
      (w) => !report.replayedCalls.some((id) => w.includes(id)),
    );

    this.checkpoint("resume");
    this.recovered = true;
    this.lastReport = report;
    if (report.uncertainCalls.length > 0) {
      this.errorStream.write(
        `[恢复] ${report.uncertainCalls.length} 个有副作用的工具调用结果未落盘，已标记不确定：${report.uncertainCalls.join(", ")}\n`,
      );
    }
    return report;
  }

  /** 手动打快照；调用方可以在长任务的中途插入 */
  checkpoint(reason: string): SessionSnapshot {
    const derived = restoreSession(undefined, this.store.log.readAll(), this.store.sessionId);
    const previous = this.store.loadSnapshot()?.meta;
    const now = new Date().toISOString();
    const snapshot: SessionSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      meta: {
        id: this.store.sessionId,
        schemaVersion: SCHEMA_VERSION,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        status: "active",
        model: previous?.model,
      },
      lastSeq: this.store.log.currentSeq,
      messages: this.agent.exportMessages(),
      pending: [],
      toolResults: derived.toolResults,
      plan: derived.plan,
    };
    this.store.mark("active", reason);
    this.store.saveSnapshot(snapshot);
    this.store.append({ type: "checkpoint", reason, atSeq: snapshot.lastSeq });
    return snapshot;
  }

  private currentPlan() {
    const derived = restoreSession(undefined, this.store.log.readAll(), this.store.sessionId);
    const p = derived.plan;
    if (!p || p.index >= p.steps.length) return undefined;
    return p;
  }
}
