import { describe, it, expect, vi, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { MemoryStore } from "../src/memory/MemoryStore.js";
import {
  ContextCompressor,
  NoopSummarizer,
} from "../src/memory/ContextCompressor.js";
import { createRememberTool, createRecallTool } from "../src/tools/memory.js";
import { Agent } from "../src/agent/index.js";
import type { LLMClient } from "../src/llm/index.js";
import type { ChatResult, Message } from "../src/llm/types.js";

let tempFile: string | null = null;
afterEach(async () => {
  if (tempFile) {
    try {
      await unlink(tempFile);
    } catch {
      /* 忽略清理失败 */
    }
    tempFile = null;
  }
});

function newStore(): MemoryStore {
  tempFile = join(tmpdir(), `agent-mem-${Date.now()}-${Math.random()}.json`);
  return new MemoryStore(tempFile);
}

/** 占位：fake 客户端的默认实现，具体返回值由 mockResolvedValue 覆盖 */
function replySig(_m: unknown, _t: unknown): Promise<ChatResult> {
  throw new Error("not implemented");
}

describe("长期记忆 MemoryStore：持久化与检索", () => {
  it("save 后 load 能读回，且跨实例共享同一文件", async () => {
    const store = newStore();
    const e = await store.save("用户的名字", "小明");
    expect(e.id).toBeTruthy();
    expect(e.key).toBe("用户的名字");
    expect(e.content).toBe("小明");

    const reopened = new MemoryStore(tempFile!);
    const all = await reopened.load();
    expect(all).toHaveLength(1);
    expect(all[0]!.content).toBe("小明");
  });

  it("search 按关键词命中打分，相关项排前面", async () => {
    const store = newStore();
    await store.save("用户的名字", "小明");
    await store.save("项目代号", "Agent-From-Scratch");
    await store.save("无关事实", "今天天气晴");

    const hits = await store.search("用户的名字");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.key).toBe("用户的名字");
  });

  it("search 关键词完全不匹配时返回空", async () => {
    const store = newStore();
    await store.save("用户的名字", "小明");
    const hits = await store.search("火箭推进剂配方");
    expect(hits).toHaveLength(0);
  });

  it("remove 能删掉指定条目", async () => {
    const store = newStore();
    const e = await store.save("临时", "会删掉");
    expect(await store.remove(e.id)).toBe(true);
    expect(await store.load()).toHaveLength(0);
    expect(await store.remove(e.id)).toBe(false);
  });
});

describe("短期记忆 ContextCompressor：按用户轮压缩", () => {
  it("未超阈值时整段原样返回，不丢信息", async () => {
    const comp = new ContextCompressor(new NoopSummarizer(), 6);
    const msgs: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ];
    const r = await comp.compress(msgs);
    expect(r.dropped).toBe(0);
    expect(r.summary).toBeNull();
    expect(r.messages).toBe(msgs); // 直接复用，无拷贝开销
  });

  it("超阈值时把旧轮次摘要成一条 system 消息，并保留最近 N 个用户轮", async () => {
    const comp = new ContextCompressor(new NoopSummarizer("SUM"), 6);
    // 8 个用户轮（超过 6），触发压缩；旧 2 个用户轮被摘要
    const msgs: Message[] = [{ role: "system", content: "sys" }];
    for (let i = 1; i <= 8; i++) {
      msgs.push({ role: "user", content: `u${i}` });
      msgs.push({ role: "assistant", content: `a${i}` });
    }
    const r = await comp.compress(msgs);
    expect(r.summary).toBe("SUM");
    expect(r.dropped).toBeGreaterThan(0);

    // 第一个是原始 system，第二条是摘要 system，其后应以最近的用户轮开头
    expect(r.messages[0]!.role).toBe("system");
    expect(r.messages[1]!.content).toContain("SUM");
    const recentUser = r.messages.filter((m) => m.role === "user");
    expect(recentUser.map((m) => m.content)).toEqual([
      "u3", "u4", "u5", "u6", "u7", "u8",
    ]);
  });

  it("按用户轮切分，绝不把 assistant 的工具调用与它的 tool 观察结果拆开", async () => {
    const comp = new ContextCompressor(new NoopSummarizer("SUM"), 6);
    // 构造一轮工具调用：userB → assistant(tool_calls) → tool，紧跟在边界附近
    const msgs: Message[] = [{ role: "system", content: "sys" }];
    const users = ["A", "B", "C", "D", "E", "F", "G", "H"];
    for (const u of users) {
      msgs.push({ role: "user", content: `u${u}` });
      if (u === "B") {
        msgs.push({
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "searchFiles", arguments: "{}" } },
          ],
        });
        msgs.push({ role: "tool", content: "命中 plan.md", tool_call_id: "call_1" });
      } else {
        msgs.push({ role: "assistant", content: `a${u}` });
      }
    }

    const r = await comp.compress(msgs);
    const summaryIdx = r.messages.findIndex((m) => m.content?.startsWith("SUM") || m.content?.includes("【对话历史摘要】"));
    const recent = r.messages.slice(summaryIdx + 1);

    // 保留块必须以一条 user 消息开头（轮次对齐的硬保证）
    expect(recent[0]!.role).toBe("user");
    // 保留块内：每个 tool 消息都能找到对应 assistant；每个 assistant tool_call 都有对应 tool
    const callIds = new Set<string>();
    const toolIds = new Set<string>();
    for (const m of recent) {
      if (m.role === "assistant" && m.tool_calls) {
        for (const tc of m.tool_calls) callIds.add(tc.id);
      }
      if (m.role === "tool" && m.tool_call_id) toolIds.add(m.tool_call_id);
    }
    for (const id of toolIds) expect(callIds.has(id)).toBe(true);
    for (const id of callIds) expect(toolIds.has(id)).toBe(true);
  });
});

describe("记忆工具 remember / recall", () => {
  it("remember 写入后，recall 能按关键词检索出来", async () => {
    const store = newStore();
    const remember = createRememberTool(store);
    const recall = createRecallTool(store);

    const saved = await remember.execute({ key: "用户的名字", content: "小明" });
    expect(saved).toContain("已记住");

    const recalled = await recall.execute({ query: "用户的名字" });
    expect(recalled).toContain("小明");
  });
});

describe("Agent 记忆集成：长期记忆注入 + 短期压缩", () => {
  it("配置了 memoryStore 时，相关事实会被注入 system 提示", async () => {
    const store = newStore();
    await store.save("用户的名字", "小明");

    const fake = vi.fn(replySig);
    fake.mockResolvedValueOnce({ content: "你是小明。", toolCalls: [] });

    const agent = new Agent(
      { chatWithTools: fake } as unknown as LLMClient,
      { tools: [], maxSteps: 4, memoryStore: store },
    );
    await agent.run("小明喜欢什么语言");

    const sent = fake.mock.calls[0]![0] as Message[];
    const sys = sent.find((m) => m.role === "system")!;
    expect(sys.content).toContain("【长期记忆·相关事实】");
    expect(sys.content).toContain("小明");
  });

  it("历史超阈值时，发给模型的上下文会包含历史摘要（压缩生效）", async () => {
    const store = newStore();
    const fake = vi.fn(replySig);
    // 一次性把多轮对话铺开：模型每轮都直接回答，不调工具
    fake.mockResolvedValue({ content: "好的。", toolCalls: [] });

    const agent = new Agent(
      { chatWithTools: fake } as unknown as LLMClient,
      { tools: [], maxSteps: 30, memoryStore: store, compressor: new ContextCompressor(new NoopSummarizer("SUM"), 3) },
    );

    // 灌入 6 个用户轮（超过 keepRecentTurns=3），最后一轮才会触发压缩
    for (let i = 1; i <= 6; i++) {
      await agent.run(`第${i}句`);
    }

    // 看最后一次调用发出的上下文：应出现历史摘要
    const last = fake.mock.calls[fake.mock.calls.length - 1]![0] as Message[];
    const hasSummary = last.some(
      (m) => m.role === "system" && (m.content?.includes("SUM") || m.content?.includes("【对话历史摘要】")),
    );
    expect(hasSummary).toBe(true);
  });
});
