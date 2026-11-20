import { describe, it, expect, vi } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { EventLog } from "../src/persistence/EventLog.js";
import { SessionStore } from "../src/persistence/SessionStore.js";
import { restoreSession, isReplayable } from "../src/persistence/restore.js";
import { ResumableAgent } from "../src/persistence/ResumableAgent.js";
import { Agent, ToolRegistry, calculator } from "../src/agent/index.js";
import { Planner } from "../src/planning/index.js";
import type { LLMClient } from "../src/llm/index.js";
import type { ChatResult } from "../src/llm/types.js";
import { SCHEMA_VERSION, type SessionEvent, type SessionSnapshot } from "../src/persistence/types.js";

const replySig = (_m: unknown, _t: unknown): Promise<ChatResult> => {
  throw new Error("not implemented");
};

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "persist-"));
}

function baseSnapshot(id: string): SessionSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      id,
      schemaVersion: SCHEMA_VERSION,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
    },
    lastSeq: 0,
    messages: [{ role: "system", content: "sys" }],
    pending: [],
    toolResults: {},
  };
}

describe("EventLog：只追加、自带序号、读时容错", () => {
  it("顺序分配 seq 与 ISO 时间戳", () => {
    const log = new EventLog(join(freshDir(), "events.jsonl"));
    const a = log.append({ type: "status", status: "running" });
    const b = log.append({ type: "user_input", text: "你好" });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(log.currentSeq).toBe(2);
  });

  it("重建实例后 seq 从最后一条继续", () => {
    const file = join(freshDir(), "events.jsonl");
    const first = new EventLog(file);
    first.append({ type: "status", status: "running" });
    first.append({ type: "user_input", text: "x" });
    const second = new EventLog(file);
    expect(second.append({ type: "status", status: "active" }).seq).toBe(3);
  });

  it("跳过撕裂的尾行（JSON 只写了一半）", () => {
    const file = join(freshDir(), "events.jsonl");
    const log = new EventLog(file);
    log.append({ type: "status", status: "running" });
    appendFileSync(file, '{"seq":2,"ts":"2026","type":"user_inp', "utf8");
    expect(log.readAll()).toHaveLength(1);
  });

  it("跳过 seq 断裂之后的事件", () => {
    const file = join(freshDir(), "events.jsonl");
    const log = new EventLog(file);
    log.append({ type: "status", status: "running" });
    appendFileSync(file, `${JSON.stringify({ seq: 5, ts: "x", type: "user_input", text: "skip" })}\n`);
    expect(log.readAll()).toHaveLength(1);
  });

  it("since 只返回指定序号之后的事件", () => {
    const log = new EventLog(join(freshDir(), "events.jsonl"));
    log.append({ type: "status", status: "running" });
    log.append({ type: "user_input", text: "a" });
    log.append({ type: "user_input", text: "b" });
    expect(log.since(1).map((e) => (e.type === "user_input" ? e.text : ""))).toEqual(["a", "b"]);
    expect(log.since(2)).toHaveLength(1);
  });
});

describe("SessionStore：快照原子写与备份回滚", () => {
  it("初始化即创建目录与空快照", () => {
    const store = new SessionStore({ dir: freshDir(), sessionId: "s1" });
    expect(existsSync(store.snapshotPath)).toBe(true);
    expect(store.loadSnapshot()?.meta.id).toBe("s1");
    expect(store.status()).toBe("active");
  });

  it("覆盖快照时保留上一份备份", () => {
    const store = new SessionStore({ dir: freshDir(), sessionId: "s2" });
    const first = baseSnapshot("s2");
    store.saveSnapshot({ ...first, messages: [{ role: "user", content: "old" }] });
    store.saveSnapshot({ ...first, messages: [{ role: "user", content: "new" }] });
    expect(store.loadSnapshot()?.messages[0]?.content).toBe("new");
    expect(existsSync(store.backupPath)).toBe(true);
  });

  it("主快照损坏时退回备份", () => {
    const store = new SessionStore({ dir: freshDir(), sessionId: "s3" });
    store.saveSnapshot({ ...baseSnapshot("s3"), messages: [{ role: "user", content: "keep" }] });
    // 备份里放同一份内容，模拟「正式文件写坏、备份仍可用」
    writeFileSync(store.backupPath, JSON.stringify({ ...baseSnapshot("s3"), messages: [{ role: "user", content: "keep" }] }), "utf8");
    writeFileSync(store.snapshotPath, "{broken", "utf8");
    expect(store.loadSnapshot()?.messages[0]?.content).toBe("keep");
  });

  it("两份快照都损坏时返回 undefined（可全量重放）", () => {
    const store = new SessionStore({ dir: freshDir(), sessionId: "s4" });
    writeFileSync(store.snapshotPath, "nope", "utf8");
    writeFileSync(store.backupPath, "nope", "utf8");
    expect(store.loadSnapshot()).toBeUndefined();
  });

  it("拒绝版本号不匹配的快照", () => {
    const store = new SessionStore({ dir: freshDir(), sessionId: "s5" });
    rmSync(store.backupPath, { force: true });
    writeFileSync(store.snapshotPath, "{broken", "utf8");
    store.saveSnapshot({ ...baseSnapshot("s5"), schemaVersion: 999 });
    expect(store.loadSnapshot()).toBeUndefined();
  });

  it("状态由最后一条 status 事件决定", () => {
    const store = new SessionStore({ dir: freshDir(), sessionId: "s6" });
    store.mark("running");
    expect(store.status()).toBe("running");
    store.mark("interrupted", "crash");
    expect(store.status()).toBe("interrupted");
    store.mark("active");
    expect(store.status()).toBe("active");
  });

  it("load 只返回快照之后的新事件", () => {
    const store = new SessionStore({ dir: freshDir(), sessionId: "s7" });
    store.append({ type: "user_input", text: "before" });
    const snap = baseSnapshot("s7");
    snap.lastSeq = store.log.currentSeq;
    store.saveSnapshot(snap);
    store.append({ type: "user_input", text: "after" });
    const { events } = store.load();
    expect(events).toHaveLength(1);
    expect(events[0]!.type === "user_input" && events[0]!.text).toBe("after");
  });

  it("list 能枚举会话并按更新时间排序", () => {
    const dir = freshDir();
    const a = new SessionStore({ dir, sessionId: "a" });
    const b = new SessionStore({ dir, sessionId: "b" });
    b.saveSnapshot({
      ...baseSnapshot("b"),
      meta: { ...baseSnapshot("b").meta, updatedAt: "2030-01-01T00:00:00.000Z" },
    });
    expect(SessionStore.list(dir).map((s) => s.id)).toEqual(["b", "a"]);
    expect(a.sessionId).toBe("a");
  });

  it("drop 只删本会话目录", () => {
    const dir = freshDir();
    const a = new SessionStore({ dir, sessionId: "a" });
    new SessionStore({ dir, sessionId: "b" });
    a.drop();
    expect(existsSync(a.dir)).toBe(false);
    expect(SessionStore.list(dir).map((s) => s.id)).toEqual(["b"]);
  });
});

describe("restoreSession：事件重放的正确性", () => {
  const snap = baseSnapshot("r1");

  it("无事件时原样返回快照消息", () => {
    const r = restoreSession(snap, [], "r1");
    expect(r.messages).toEqual(snap.messages);
    expect(r.report.messageCount).toBe(1);
  });

  it("用户输入不重复追加", () => {
    const s = { ...snap, messages: [...snap.messages, { role: "user" as const, content: "hi" }] };
    const events: SessionEvent[] = [{ seq: 1, ts: "t", type: "user_input", text: "hi" }];
    expect(restoreSession(s, events, "r1").messages).toHaveLength(2);
  });

  it("同组多个 tool_call 合并为一条 assistant 消息", () => {
    const events: SessionEvent[] = [
      { seq: 1, ts: "t", type: "tool_call", id: "a", group: "g1", content: "思考", tool: "calculator", args: { expression: "1+1" }, replayable: true },
      { seq: 2, ts: "t", type: "tool_call", id: "b", group: "g1", content: "思考", tool: "calculator", args: { expression: "2+2" }, replayable: true },
    ];
    const r = restoreSession(snap, events, "r1");
    const assistant = r.messages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.tool_calls).toHaveLength(2);
    expect(r.pending).toHaveLength(2);
  });

  it("tool_result 按 id 幂等，重复事件只保留第一份", () => {
    const events: SessionEvent[] = [
      { seq: 1, ts: "t", type: "tool_call", id: "a", group: "g", content: "", tool: "calculator", args: {}, replayable: true },
      { seq: 2, ts: "t", type: "tool_result", id: "a", tool: "calculator", observation: "2" },
      { seq: 3, ts: "t", type: "tool_result", id: "a", tool: "calculator", observation: "222" },
    ];
    const r = restoreSession(snap, events, "r1");
    expect(r.messages.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(r.toolResults["a"]).toBe("2");
    expect(r.pending[0]!.result).toBe("2");
  });

  it("已有结果的调用不会重复进入 pending，也不算未决", () => {
    const s = {
      ...snap,
      pending: [{ id: "x", group: "g", tool: "calculator", args: {}, replayable: true, startedAt: "t", result: "ok" }],
      toolResults: { x: "ok" },
    };
    const events: SessionEvent[] = [
      { seq: 1, ts: "t", type: "tool_call", id: "x", group: "g", content: "", tool: "calculator", args: {}, replayable: true },
    ];
    const r = restoreSession(s, events, "r1");
    expect(r.pending).toHaveLength(1);
    expect(r.report.dedupedCalls).toEqual(["x"]);
    expect(r.report.warnings.some((w) => w.includes("未落盘"))).toBe(false);
  });

  it("assistant_message 与 plan 事件按序重建", () => {
    const events: SessionEvent[] = [
      { seq: 1, ts: "t", type: "plan_created", goal: "g", steps: ["a", "b"] },
      { seq: 2, ts: "t", type: "plan_step", index: 0, step: "a", result: "done", done: true },
      { seq: 3, ts: "t", type: "assistant_message", message: { role: "assistant", content: "hi" } },
    ];
    const r = restoreSession(snap, events, "r1");
    expect(r.plan?.index).toBe(1);
    expect(r.plan?.results).toEqual([{ step: "a", result: "done", done: true }]);
    expect(r.messages.at(-1)?.content).toBe("hi");
  });

  it("plan_done 把任务与答复写回上下文", () => {
    const events: SessionEvent[] = [
      { seq: 1, ts: "t", type: "plan_created", goal: "target", steps: ["a"] },
      { seq: 2, ts: "t", type: "plan_step", index: 0, step: "a", result: "r", done: true },
      { seq: 3, ts: "t", type: "plan_done", answer: "final" },
    ];
    const r = restoreSession(snap, events, "r1");
    expect(r.messages.slice(-2).map((m) => m.content)).toEqual(["target", "final"]);
  });

  it("有事件即报告 interrupted", () => {
    const r = restoreSession(snap, [{ seq: 1, ts: "t", type: "status", status: "active" }], "r1");
    expect(r.report.status).toBe("interrupted");
  });

  it("有副作用与外部工具不可重放，只读工具可重放", () => {
    expect(isReplayable("calculator")).toBe(true);
    expect(isReplayable("readFile")).toBe(true);
    expect(isReplayable("writeFile")).toBe(false);
    expect(isReplayable("deleteFile")).toBe(false);
    expect(isReplayable("runCommand")).toBe(false);
    expect(isReplayable("mcp__taskboard__add_task")).toBe(false);
  });
});

describe("ResumableAgent：写入、检查点、崩溃恢复", () => {
  function setup() {
    const dir = freshDir();
    const fake = vi.fn(replySig);
    const client = { chatWithTools: fake } as unknown as LLMClient;
    let writes = 0;
    const writeTool = {
      name: "writeFile",
      description: "写文件",
      parameters: z.object({ path: z.string() }),
      execute: () => {
        writes += 1;
        return `written ${writes}`;
      },
    };
    const registry = new ToolRegistry().registerAll([calculator, writeTool]);
    const agent = new Agent(client, { registry, maxSteps: 6 });
    const store = new SessionStore({ dir, sessionId: "live" });
    const resumable = new ResumableAgent({ agent, registry, store });
    return { fake, resumable, store, registry, writes: () => writes };
  }

  it("正常一轮结束会落事件并打快照，状态回到 active", async () => {
    const { fake, resumable, store } = setup();
    fake.mockResolvedValueOnce({ content: "直接回答", toolCalls: [] });
    await resumable.run("你好");
    const types = store.log.readAll().map((e) => e.type);
    expect(types).toContain("user_input");
    expect(types).toContain("assistant_message");
    expect(types).toContain("checkpoint");
    expect(store.status()).toBe("active");
    expect(store.loadSnapshot()?.messages.length).toBeGreaterThan(1);
  });

  it("工具调用在结果之前写入在途记录", async () => {
    const { fake, resumable, store } = setup();
    fake
      .mockResolvedValueOnce({
        content: "算一下",
        toolCalls: [{ id: "c1", type: "function", function: { name: "calculator", arguments: { expression: "2+3" } } }],
      })
      .mockResolvedValueOnce({ content: "答案是 5", toolCalls: [] });
    await resumable.run("2加3");
    const types = store.log.readAll().map((e) => e.type);
    expect(types.indexOf("tool_call")).toBeLessThan(types.indexOf("tool_result"));
  });

  it("崩溃后只读调用重放一次，副作用调用不重放", async () => {
    const { fake, resumable, store, registry, writes } = setup();
    fake.mockResolvedValue({ content: "恢复后回答", toolCalls: [] });
    store.mark("running");
    store.append({ type: "user_input", text: "老任务" });
    store.append({ type: "tool_call", id: "safe", group: "g", content: "", tool: "calculator", args: { expression: "6*7" }, replayable: true });
    store.append({ type: "tool_call", id: "danger", group: "g", content: "", tool: "writeFile", args: { path: "a.txt" }, replayable: false });

    const report = await resumable.resume();

    expect(report.replayedCalls).toEqual(["safe"]);
    expect(report.uncertainCalls).toEqual(["danger"]);
    expect(writes()).toBe(0); // 有副作用的工具一次都没执行
    expect(registry.get("calculator")).toBeDefined();
    const results = store.log.readAll().filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);
    const uncertain = results.find((e) => e.type === "tool_result" && e.id === "danger");
    expect(uncertain?.type === "tool_result" && uncertain.uncertain).toBe(true);
    expect(store.status()).toBe("active");
  });

  it("重复恢复不会重复执行已记录的调用", async () => {
    const { resumable, store } = setup();
    store.mark("running");
    store.append({ type: "tool_call", id: "safe", group: "g", content: "", tool: "calculator", args: { expression: "1+1" }, replayable: true });
    const first = await resumable.resume();
    expect(first.replayedCalls).toEqual(["safe"]);
    const second = await resumable.resume();
    expect(second.replayedCalls).toEqual([]);
    expect(store.log.readAll().filter((e) => e.type === "tool_result" && e.id === "safe")).toHaveLength(1);
  });

  it("恢复后带着历史上下文继续对话", async () => {
    const { fake, resumable, store } = setup();
    store.mark("running");
    store.append({ type: "user_input", text: "记住代号 A7" });
    await resumable.resume();
    fake.mockResolvedValueOnce({ content: "收到", toolCalls: [] });
    await resumable.run("代号是什么");
    const sent = fake.mock.calls[0]?.[0] as Array<{ role: string; content: string | null }>;
    expect(sent.some((m) => m.role === "user" && m.content === "记住代号 A7")).toBe(true);
  });

  it("恢复时为缺失的 system 消息兜底", async () => {
    const { resumable, store } = setup();
    store.saveSnapshot({ ...baseSnapshot("live"), messages: [{ role: "user", content: "only" }] });
    await resumable.resume();
    const messages = store.loadSnapshot()?.messages ?? [];
    expect(messages[0]?.role).toBe("system");
  });

  it("快照损坏时从事件日志全量恢复", async () => {
    const { fake, resumable, store } = setup();
    fake.mockResolvedValue({ content: "答", toolCalls: [] });
    store.mark("running");
    store.append({ type: "user_input", text: "从头来" });
    writeFileSync(store.snapshotPath, "{" , "utf8");
    writeFileSync(store.backupPath, "{" , "utf8");
    const report = await resumable.resume();
    expect(report.messageCount).toBeGreaterThanOrEqual(1);
    expect(readFileSync(store.snapshotPath, "utf8")).toContain("schemaVersion");
  });

  it("计划崩在中间时从下一个步骤续跑，不重新生成计划", async () => {
    const dir = freshDir();
    const chat = vi.fn(async () => '{"goal":"两件事","steps":["第一步","第二步"]}');
    const chatWithTools = vi.fn(async () => ({ content: "步骤完成", toolCalls: [] }));
    const client = { chat, chatWithTools } as unknown as LLMClient;
    const planner = new Planner(client);
    const registry = new ToolRegistry().registerAll([calculator]);
    const agent = new Agent(client, { registry, planner });
    const store = new SessionStore({ dir, sessionId: "plan" });
    store.mark("running");
    store.append({ type: "plan_created", goal: "两件事", steps: ["第一步", "第二步"] });
    store.append({ type: "plan_step", index: 0, step: "第一步", result: "已完成", done: true });
    const resumable = new ResumableAgent({ agent, registry, store });

    const result = await resumable.runPlan("两件事");

    // chat 只被终步合成调用一次；createPlan 没有重跑
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.stepResults).toEqual([{ step: "第一步", result: "已完成", done: true }, { step: "第二步", result: "步骤完成", done: true }]);
    expect(store.status()).toBe("active");
  });
});
