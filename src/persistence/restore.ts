import type { Message, WireToolCall } from "../llm/types.js";
import type {
  PendingCall,
  PlanProgress,
  RecoveryReport,
  SessionEvent,
  SessionSnapshot,
  SessionStatus,
} from "./types.js";

/** 恢复：快照打底，事件增量重放，产出可交给 Agent 的完整状态 */
export interface RestoredState {
  messages: Message[];
  pending: PendingCall[];
  toolResults: Record<string, string>;
  plan?: PlanProgress;
  report: RecoveryReport;
}

/**
 * 从快照与事件重建会话。
 *
 * 关键正确性要求：
 *  - 同一 tool_call_id 的结果只写一次（幂等键），重放时不会把旧观察重复塞进上下文；
 *  - 同一轮的多个 tool_call 合并成一条 assistant 消息，模型看到的结构与运行时一致；
 *  - 有结果记录的调用放进 toolResults，恢复器据此跳过可能重复执行的副作用操作；
 *  - 没有结果的调用留在 pending，由上层决定重放还是标记不确定。
 */
export function restoreSession(
  snapshot: SessionSnapshot | undefined,
  events: SessionEvent[],
  sessionId: string,
): RestoredState {
  const messages: Message[] = (snapshot?.messages ?? []).map((m) => ({ ...m }));
  const toolResults: Record<string, string> = { ...(snapshot?.toolResults ?? {}) };
  const pending: PendingCall[] = (snapshot?.pending ?? []).map((p) => ({ ...p }));
  let plan: PlanProgress | undefined = snapshot?.plan ? { ...snapshot.plan } : undefined;
  const warnings: string[] = [];
  const dedupedCalls: string[] = [];
  const replayedCalls: string[] = [];
  const uncertainCalls: string[] = [];

  /** 把连续的同 group 工具调用合并回一条 assistant 消息 */
  let openGroup: { group: string; index: number; toolCalls: WireToolCall[] } | undefined;

  function flushGroup(): void {
    if (!openGroup || openGroup.toolCalls.length === 0) return;
    openGroup = undefined;
  }

  function findPending(id: string): PendingCall | undefined {
    return pending.find((p) => p.id === id);
  }

  for (const event of events) {
    switch (event.type) {
      case "status":
        break; // 状态由 SessionStore.status() 单独给出
      case "checkpoint":
        break; // 快照已包含 checkpoint 之前的所有事件
      case "user_input": {
        // 避免与快照末尾同一条用户输入重复（快照保存点可能落在输入之后）
        const last = messages[messages.length - 1];
        if (!(last?.role === "user" && last.content === event.text)) {
          messages.push({ role: "user", content: event.text });
        }
        break;
      }
      case "assistant_message":
        messages.push({ ...event.message });
        break;
      case "tool_call": {
        if (toolResults[event.id]) {
          dedupedCalls.push(event.id);
        }
        if (!findPending(event.id) && !toolResults[event.id]) {
          pending.push({
            id: event.id,
            group: event.group,
            tool: event.tool,
            args: event.args,
            replayable: event.replayable,
            startedAt: event.ts,
          });
        }
        // 同 group 的调用合并；插入位置是第一次出现的位置
        if (openGroup?.group !== event.group) {
          flushGroup();
          const call: WireToolCall = {
            id: event.id,
            type: "function",
            function: { name: event.tool, arguments: JSON.stringify(event.args) },
          };
          messages.push({
            role: "assistant",
            content: event.content,
            tool_calls: [call],
          });
          openGroup = { group: event.group, index: messages.length - 1, toolCalls: [call] };
        } else {
          const call: WireToolCall = {
            id: event.id,
            type: "function",
            function: { name: event.tool, arguments: JSON.stringify(event.args) },
          };
          const msg = messages[openGroup.index];
          if (msg) {
            msg.tool_calls = [...(msg.tool_calls ?? []), call];
          }
          openGroup.toolCalls.push(call);
        }
        break;
      }
      case "tool_result": {
        if (toolResults[event.id]) break; // 幂等：同 id 的观察只保留第一份
        toolResults[event.id] = event.observation;
        const p = findPending(event.id);
        if (p) {
          p.result = event.observation;
          p.uncertain = event.uncertain;
        }
        // 有些崩溃发生在 assistant 消息写盘之前，这里兜底补一条工具观察
        if (!messages.some((m) => m.role === "tool" && m.tool_call_id === event.id)) {
          messages.push({
            role: "tool",
            content: event.observation,
            tool_call_id: event.id,
          });
        }
        break;
      }
      case "plan_created":
        plan = { goal: event.goal, steps: event.steps, index: 0, results: [] };
        break;
      case "plan_step":
        if (plan) {
          plan.results.push({ step: event.step, result: event.result, done: event.done });
          plan.index = Math.max(plan.index, event.index + 1);
          if (!event.done) warnings.push(`步骤 ${event.index + 1}「${event.step}」未完成`);
        }
        break;
      case "plan_done":
        if (plan) {
          messages.push({ role: "user", content: plan.goal });
          messages.push({ role: "assistant", content: event.answer });
        }
        break;
    }
  }
  flushGroup();

  const status: SessionStatus = events.length > 0 ? "interrupted" : "active";
  const unresolved = pending.filter((p) => !p.result);
  return {
    messages,
    pending,
    toolResults,
    plan,
    report: {
      sessionId,
      status,
      messageCount: messages.length,
      replayedEvents: events.length,
      dedupedCalls,
      replayedCalls,
      uncertainCalls,
      plan,
      warnings: [...warnings, ...unresolved.map((p) => `工具调用 ${p.id}（${p.tool}）结果未落盘`)],
    },
  };
}

/** 有副作用的工具一律不重放；外部 MCP 工具默认也按有副作用处理 */
export function isReplayable(tool: string): boolean {
  const SIDE_EFFECTS = new Set(["writeFile", "deleteFile", "runCommand"]);
  return !SIDE_EFFECTS.has(tool) && !tool.startsWith("mcp__");
}
