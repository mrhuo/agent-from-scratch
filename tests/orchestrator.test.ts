import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { Orchestrator, RESEARCHER, WRITER, REVIEWER, type AgentRole } from "../src/orchestrator/index.js";
import { calculator } from "../src/agent/index.js";
import type { LLMClient } from "../src/llm/index.js";
import type { ChatResult, Message } from "../src/llm/types.js";
import type { Tool } from "../src/agent/tools.js";

// 仅作 vi.fn 的类型签名来源，运行时被 mockImplementation 覆盖
const chatSig = (_m: unknown, _o?: unknown): Promise<string> => {
  throw new Error("not implemented");
};
const toolSig = (_m: unknown, _t: unknown, _o?: unknown): Promise<ChatResult> => {
  throw new Error("not implemented");
};

/** 从一次 chatWithTools 调用里取出模型收到的 system 提示 */
function systemPromptOf(call: unknown[]): string {
  const msgs = call[0] as Message[];
  return msgs.find((m) => m.role === "system")?.content ?? "";
}

describe("Orchestrator.createWorker：角色工具白名单", () => {
  it("研究员能拿到白名单里的工具，写手拿不到任何工具", async () => {
    const toolFn = vi.fn(toolSig);
    toolFn.mockResolvedValue({ content: "ok", toolCalls: [] });
    const fakeClient = { chatWithTools: toolFn, chat: vi.fn(chatSig) } as unknown as LLMClient;

    // 研究员白名单含 calculator，写手为空
    const researcherRole: AgentRole = { ...RESEARCHER, tools: ["calculator"] };
    const orch = new Orchestrator(fakeClient, { tools: [calculator] });

    await orch.createWorker(researcherRole).run("算一下");
    await orch.createWorker(WRITER).run("写点东西");

    // 研究员那轮模型收到了 calculator 定义；写手那轮 tools 为空
    const researcherTools = toolFn.mock.calls[0]![1] as unknown[];
    const writerTools = toolFn.mock.calls[1]![1] as unknown[];
    expect((researcherTools as { function: { name: string } }[]).map((t) => t.function.name)).toContain("calculator");
    expect(writerTools).toHaveLength(0);
  });

  it("角色提示被注入到 system 消息", async () => {
    const toolFn = vi.fn(toolSig);
    toolFn.mockResolvedValue({ content: "ok", toolCalls: [] });
    const fakeClient = { chatWithTools: toolFn, chat: vi.fn(chatSig) } as unknown as LLMClient;
    const orch = new Orchestrator(fakeClient, { tools: [] });

    await orch.createWorker(REVIEWER).run("审核");

    expect(systemPromptOf(toolFn.mock.calls[0]!)).toContain("审核员");
  });
});

describe("Orchestrator.runPipeline：串行流水线", () => {
  it("按角色顺序执行，前序产出作为后序上下文，最终答复取末端角色", async () => {
    const toolFn = vi.fn(toolSig);
    const prompts: string[] = [];
    // 按 system 提示里的角色关键词路由，分别返回不同产出
    toolFn.mockImplementation(async (messages: unknown, _tools: unknown) => {
      const sp = systemPromptOf([messages]);
      prompts.push(sp);
      if (sp.includes("研究员")) return { content: "研究员产出：17³=4913，本地命中3个文件", toolCalls: [] };
      if (sp.includes("写手")) return { content: "写手初稿：项目已完成工具系统", toolCalls: [] };
      if (sp.includes("审核员")) return { content: "修订终稿：项目已完成工具系统，正补检索能力", toolCalls: [] };
      return { content: "默认", toolCalls: [] };
    });
    const fakeClient = { chatWithTools: toolFn, chat: vi.fn(chatSig) } as unknown as LLMClient;
    const orch = new Orchestrator(fakeClient, { tools: [] });

    const result = await orch.runPipeline("说明项目进展", [RESEARCHER, WRITER, REVIEWER]);

    expect(result.results.map((r) => r.role)).toEqual(["researcher", "writer", "reviewer"]);
    expect(result.finalAnswer).toBe("修订终稿：项目已完成工具系统，正补检索能力");
    // 第 2 个成员收到的 task（user 消息）应包含第 1 个成员的产出
    const writerCall = toolFn.mock.calls[1]![0] as Message[];
    const writerUser = writerCall.find((m) => m.role === "user")?.content ?? "";
    expect(writerUser).toContain("研究员产出");
    // 第 3 个成员收到的上下文应同时含前两位产出
    const reviewerCall = toolFn.mock.calls[2]![0] as Message[];
    const reviewerUser = reviewerCall.find((m) => m.role === "user")?.content ?? "";
    expect(reviewerUser).toContain("研究员产出");
    expect(reviewerUser).toContain("写手初稿");
  });

  it("空角色列表抛错", async () => {
    const fakeClient = { chatWithTools: vi.fn(toolSig), chat: vi.fn(chatSig) } as unknown as LLMClient;
    const orch = new Orchestrator(fakeClient, { tools: [] });
    await expect(orch.runPipeline("t", [])).rejects.toThrow(/至少需要一个角色/);
  });
});

describe("Orchestrator.runParallel：并行分派", () => {
  it("多个成员并发执行，区间重叠；再由 chat 汇总", async () => {
    const spans: Array<[number, number]> = [];
    const toolFn = vi.fn(toolSig);
    toolFn.mockImplementation(async () => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 50));
      spans.push([start, Date.now()]);
      return { content: "成员产出", toolCalls: [] };
    });
    const chatFn = vi.fn(chatSig);
    chatFn.mockResolvedValue("汇总答复");
    const fakeClient = { chatWithTools: toolFn, chat: chatFn } as unknown as LLMClient;
    const orch = new Orchestrator(fakeClient, { tools: [] });

    const result = await orch.runParallel([
      { role: RESEARCHER, task: "子任务A" },
      { role: WRITER, task: "子任务B" },
    ]);

    expect(result.results).toHaveLength(2);
    expect(result.finalAnswer).toBe("汇总答复");
    expect(spans).toHaveLength(2);
    // 两段执行区间重叠 → 确实并发，而非串行相加
    expect(spans[0]![0]).toBeLessThan(spans[1]![1]);
    expect(spans[1]![0]).toBeLessThan(spans[0]![1]);
    // chat 只调用一次用于汇总
    expect(chatFn.mock.calls.length).toBe(1);
  });

  it("空任务列表抛错", async () => {
    const fakeClient = { chatWithTools: vi.fn(toolSig), chat: vi.fn(chatSig) } as unknown as LLMClient;
    const orch = new Orchestrator(fakeClient, { tools: [] });
    await expect(orch.runParallel([])).rejects.toThrow(/至少需要一个任务/);
  });
});

describe("Orchestrator：真实工具参与协作", () => {
  it("研究员角色用 calculator 得到观察，结果进入成员产出", async () => {
    const toolFn = vi.fn(toolSig);
    toolFn
      .mockResolvedValueOnce({
        content: "算一下",
        toolCalls: [{ id: "c1", type: "function", function: { name: "calculator", arguments: { expression: "17*17*17" } } }],
      })
      .mockResolvedValueOnce({ content: "17³=4913，已记录", toolCalls: [] });
    const fakeClient = { chatWithTools: toolFn, chat: vi.fn(chatSig) } as unknown as LLMClient;
    const researcherRole: AgentRole = { ...RESEARCHER, tools: ["calculator"] };
    const orch = new Orchestrator(fakeClient, { tools: [calculator] });

    const result = await orch.runPipeline("算17的三次方", [researcherRole]);

    expect(result.finalAnswer).toContain("4913");
    const obs = result.results[0]!.steps.filter((s) => s.kind === "observation").map((s) => s.text);
    expect(obs).toContain("4913");
  });
});
