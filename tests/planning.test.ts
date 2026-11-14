import { describe, it, expect, vi } from "vitest";
import { Agent, calculator } from "../src/agent/index.js";
import { Planner } from "../src/planning/index.js";
import type { LLMClient } from "../src/llm/index.js";
import type { ChatResult, Message } from "../src/llm/types.js";

// 仅作 vi.fn 的类型签名来源，运行时被 mockImplementation 覆盖
const chatSig = (_m: unknown, _o?: unknown): Promise<string> => {
  throw new Error("not implemented");
};
const toolSig = (_m: unknown, _t: unknown, _o?: unknown): Promise<ChatResult> => {
  throw new Error("not implemented");
};

/** 取一段消息里最后一条 user 文本，用于按意图路由假模型返回 */
function lastUserText(messages: unknown): string {
  const msgs = messages as Message[];
  const u = [...msgs].reverse().find((m) => m.role === "user");
  return u?.content ?? "";
}

describe("Planner.createPlan", () => {
  it("解析模型返回的 JSON 计划", async () => {
    const chatFn = vi.fn(chatSig);
    chatFn.mockResolvedValue(JSON.stringify({ goal: "目标", steps: ["a", "b", "c"] }));
    const planner = new Planner({ chat: chatFn } as unknown as LLMClient, {});

    const plan = await planner.createPlan("做个任务");

    expect(plan.goal).toBe("目标");
    expect(plan.steps).toEqual(["a", "b", "c"]);
  });

  it("容错：模型在 JSON 前后多嘴时，抠出第一个 {...} 块", async () => {
    const chatFn = vi.fn(chatSig);
    chatFn.mockResolvedValue('说明一下：\n{"goal":"G","steps":["x"]}\n以上');
    const planner = new Planner({ chat: chatFn } as unknown as LLMClient, {});

    const plan = await planner.createPlan("t");
    expect(plan.steps).toEqual(["x"]);
  });

  it("计划为空步骤时抛错", async () => {
    const chatFn = vi.fn(chatSig);
    chatFn.mockResolvedValue(JSON.stringify({ goal: "G", steps: [] }));
    const planner = new Planner({ chat: chatFn } as unknown as LLMClient, {});

    await expect(planner.createPlan("t")).rejects.toThrow(/不能为空/);
  });

  it("返回内容不是合法 JSON 时抛错", async () => {
    const chatFn = vi.fn(chatSig);
    chatFn.mockResolvedValue("我来想想…… 其实没法拆");
    const planner = new Planner({ chat: chatFn } as unknown as LLMClient, {});

    await expect(planner.createPlan("t")).rejects.toThrow(/并非合法 JSON/);
  });
});

describe("Planner.revisePlan", () => {
  it("基于已完成步骤与失败原因，返回剩余步骤", async () => {
    const chatFn = vi.fn(chatSig);
    chatFn.mockResolvedValue(JSON.stringify({ goal: "G", steps: ["剩下的1", "剩下的2"] }));
    const planner = new Planner({ chat: chatFn } as unknown as LLMClient, {});

    const plan = await planner.revisePlan(
      "G",
      [{ step: "done1", result: "r1", done: true }],
      "bad",
      "原因",
    );
    expect(plan.steps).toEqual(["剩下的1", "剩下的2"]);
  });
});

describe("Agent.runPlan：规划执行主流程", () => {
  it("先规划、分步执行各步、终步合成，不触发重规划", async () => {
    const chatFn = vi.fn(chatSig);
    const toolFn = vi.fn(toolSig);
    chatFn.mockImplementation(async (messages: unknown) => {
      const txt = lastUserText(messages);
      if (txt.includes("拆解")) return JSON.stringify({ goal: "G", steps: ["s1", "s2"] });
      if (txt.includes("重新规划")) return JSON.stringify({ goal: "G", steps: ["s2b"] });
      if (txt.includes("综合")) return "最终答复";
      return "默认";
    });
    toolFn.mockImplementation(async () => ({ content: "step result", toolCalls: [] }));

    const fakeClient = { chat: chatFn, chatWithTools: toolFn } as unknown as LLMClient;
    const planner = new Planner(fakeClient, {});
    const agent = new Agent(fakeClient, {
      tools: [calculator],
      planner,
      maxSteps: 8,
      maxReplans: 1,
    });

    const res = await agent.runPlan("task");

    expect(res.plan.steps).toEqual(["s1", "s2"]);
    expect(res.stepResults).toHaveLength(2);
    expect(res.stepResults.every((r) => r.done)).toBe(true);
    expect(res.answer).toBe("最终答复");
    expect(res.revisions).toBe(0);
    // 两步各跑一次子循环 + 计划/合成两次 chat = 各 2 次
    expect(toolFn.mock.calls.length).toBe(2);
    expect(chatFn.mock.calls.length).toBe(2);
  });

  it("某步在子循环预算内没跑通，触发一次重规划后继续完成", async () => {
    const chatFn = vi.fn(chatSig);
    const toolFn = vi.fn(toolSig);
    let n = 0;
    chatFn.mockImplementation(async (messages: unknown) => {
      const txt = lastUserText(messages);
      if (txt.includes("拆解")) return JSON.stringify({ goal: "G", steps: ["s1"] });
      if (txt.includes("重新规划")) return JSON.stringify({ goal: "G", steps: ["s2b"] });
      if (txt.includes("综合")) return "最终答复";
      return "默认";
    });
    toolFn.mockImplementation(async () => {
      n++;
      // 前两次（s1 的子循环两轮）返回工具调用，把预算耗尽 → s1 失败
      if (n <= 2) {
        return {
          content: null,
          toolCalls: [
            { id: "x", type: "function", function: { name: "calculator", arguments: { expression: "1+1" } } },
          ],
        };
      }
      // 重规划后的 s2b 直接收敛
      return { content: "完成了 s2b", toolCalls: [] };
    });

    const fakeClient = { chat: chatFn, chatWithTools: toolFn } as unknown as LLMClient;
    const planner = new Planner(fakeClient, {});
    const agent = new Agent(fakeClient, {
      tools: [calculator],
      planner,
      maxSteps: 2,
      maxReplans: 1,
    });

    const res = await agent.runPlan("task");

    expect(res.revisions).toBe(1);
    expect(res.stepResults).toHaveLength(2);
    expect(res.stepResults[0]!.step).toBe("s1");
    expect(res.stepResults[0]!.done).toBe(false); // s1 没跑通
    expect(res.stepResults[1]!.step).toBe("s2b");
    expect(res.stepResults[1]!.done).toBe(true);
    expect(res.answer).toBe("最终答复");
  });

  it("未配置 planner 时 runPlan 抛错", async () => {
    const toolFn = vi.fn(toolSig);
    const fakeClient = { chatWithTools: toolFn } as unknown as LLMClient;
    const agent = new Agent(fakeClient, { tools: [calculator] });
    await expect(agent.runPlan("task")).rejects.toThrow(/未配置 planner/);
  });
});
