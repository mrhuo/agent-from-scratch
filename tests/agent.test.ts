import { describe, it, expect, vi } from "vitest";
import { Agent } from "../src/agent/index.js";
import { calculator, evalArithmetic } from "../src/agent/index.js";
import type { LLMClient } from "../src/llm/index.js";
import type { ChatResult } from "../src/llm/types.js";

// 仅作为 vi.fn 的类型签名来源，运行时被 mockImplementation 覆盖
const replySig = (_m: unknown, _t: unknown): Promise<ChatResult> => {
  throw new Error("not implemented");
};

describe("evalArithmetic", () => {
  it("computes basic arithmetic", () => {
    expect(evalArithmetic("23 * 17")).toBe("391");
    expect(evalArithmetic("(1024 - 256) / 8")).toBe("96");
    expect(evalArithmetic("2 + 3 * 4")).toBe("14");
  });

  it("rejects non-arithmetic input (whitelist guard)", () => {
    expect(evalArithmetic("123; process.exit(1)")).toMatch(/错误/);
    expect(evalArithmetic("Math.random()")).toMatch(/错误/);
    expect(evalArithmetic("2 +")).toMatch(/错误/);
  });
});

describe("Agent.run", () => {
  it("returns answer directly when model needs no tool", async () => {
    const fake = vi.fn(replySig);
    fake.mockResolvedValue({ content: "你好", toolCalls: [] });
    const agent = new Agent({ chatWithTools: fake } as unknown as LLMClient, { tools: [calculator] });

    const { answer, steps } = await agent.run("你好");

    expect(answer).toBe("你好");
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe("answer");
    expect(fake.mock.calls.length).toBe(1);
  });

  it("calls tool, observes result, then answers", async () => {
    const fake = vi.fn(replySig);
    fake
      .mockResolvedValueOnce({
        content: "我来算一下",
        toolCalls: [{ id: "c1", type: "function", function: { name: "calculator", arguments: { expression: "23 * 17" } } }],
      })
      .mockResolvedValueOnce({ content: "23 乘以 17 等于 391。", toolCalls: [] });

    const agent = new Agent({ chatWithTools: fake } as unknown as LLMClient, { tools: [calculator], maxSteps: 6 });
    const { answer, steps } = await agent.run("23乘以17是多少");

    expect(answer).toBe("23 乘以 17 等于 391。");
    const kinds = steps.map((s) => s.kind);
    expect(kinds).toEqual(["thought", "action", "observation", "answer"]);
    expect(steps[2]!.text).toBe("391");
    // 模型被调用两次：一次决定调工具，一次给最终答案
    expect(fake.mock.calls.length).toBe(2);
  });

  it("isolates tool errors as observation text", async () => {
    const fake = vi.fn(replySig);
    fake.mockResolvedValueOnce({
      content: null,
      toolCalls: [{ id: "c1", type: "function", function: { name: "calculator", arguments: { expression: "2 +" } } }],
    });
    fake.mockResolvedValueOnce({ content: "看来表达式不完整，无法计算。", toolCalls: [] });

    const agent = new Agent({ chatWithTools: fake } as unknown as LLMClient, { tools: [calculator], maxSteps: 6 });
    const { answer, steps } = await agent.run("2加多少");

    // 工具报错被隔离成观察文本，循环没有崩，仍能给出最终回答
    expect(steps[2]!.text).toMatch(/错误|无法计算/);
    expect(answer).toBe("看来表达式不完整，无法计算。");
  });

  it("stops at maxSteps and returns fallback", async () => {
    const fake = vi.fn(replySig);
    // 每次都要求调工具，永远不给答案 —— 模拟陷入死循环
    fake.mockResolvedValue({
      content: null,
      toolCalls: [{ id: "x", type: "function", function: { name: "calculator", arguments: { expression: "1+1" } } }],
    });

    const agent = new Agent({ chatWithTools: fake } as unknown as LLMClient, { tools: [calculator], maxSteps: 3 });
    const { answer, steps } = await agent.run("一直算");

    expect(answer).toMatch(/最大步数/);
    expect(fake.mock.calls.length).toBe(3);
  });
});
