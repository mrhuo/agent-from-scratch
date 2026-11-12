import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { Agent, calculator } from "../src/agent/index.js";
import type { LLMClient } from "../src/llm/index.js";
import type { ChatResult, Message, ToolCall } from "../src/llm/types.js";
import type { Tool } from "../src/agent/tools.js";

const replySig = (_m: unknown, _t: unknown): Promise<ChatResult> => {
  throw new Error("not implemented");
};

/** 拿到某次 chatWithTools 调用时收到的完整上下文（含 tool 观察消息），用于断言 */
function captureMessages(fake: ReturnType<typeof vi.fn>): Message[] {
  const last = fake.mock.calls[fake.mock.calls.length - 1]!;
  return last[0] as Message[];
}

/** 往 Agent 内部注册表塞一个工具（测试用，绕开构造参数） */
function register(agent: Agent, tool: Tool<any>): void {
  (agent as unknown as { registry: { register: (t: Tool<any>) => void } }).registry.register(tool);
}

describe("多工具协作：单轮并行", () => {
  it("一次回复的多个工具调用都被执行，观察按 tool_call_id 对应", async () => {
    const fake = vi.fn(replySig);
    fake
      .mockResolvedValueOnce({
        content: "我来算两笔",
        toolCalls: [
          { id: "a1", type: "function", function: { name: "calculator", arguments: { expression: "23 * 17" } } },
          { id: "a2", type: "function", function: { name: "calculator", arguments: { expression: "100 + 5" } } },
        ],
      })
      .mockResolvedValueOnce({ content: "两笔分别等于 391 和 105。", toolCalls: [] });

    const agent = new Agent({ chatWithTools: fake } as unknown as LLMClient, { tools: [], maxSteps: 6 });
    register(agent, calculator);

    const { answer, steps } = await agent.run("算两笔");

    expect(answer).toBe("两笔分别等于 391 和 105。");
    const obsTexts = steps.filter((s) => s.kind === "observation").map((s) => s.text);
    expect(obsTexts).toEqual(expect.arrayContaining(["391", "105"]));

    // 第二轮发给模型的上下文里应有两个 tool 消息，id 与调用一一对应
    const toolMsgs = captureMessages(fake).filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(expect.arrayContaining(["a1", "a2"]));
    expect(toolMsgs.find((m) => m.tool_call_id === "a1")!.content).toBe("391");
    expect(toolMsgs.find((m) => m.tool_call_id === "a2")!.content).toBe("105");
  });
});

describe("多工具协作：并行确实并发", () => {
  it("两个各自耗时 50ms 的独立工具同轮调用，总耗时远小于 100ms（区间重叠）", async () => {
    const spans: Array<[number, number]> = [];
    const mkSlow = (tag: string): Tool => ({
      name: `slow_${tag}`,
      description: `slow ${tag}`,
      parameters: z.object({}),
      execute: async () => {
        const start = Date.now();
        await new Promise((r) => setTimeout(r, 50));
        spans.push([start, Date.now()]);
        return `${tag} done`;
      },
    });

    const calls: ToolCall[] = [
      { id: "p1", type: "function", function: { name: "slow_a", arguments: {} } },
      { id: "p2", type: "function", function: { name: "slow_b", arguments: {} } },
    ];
    const fake = vi.fn(replySig);
    fake.mockResolvedValueOnce({ content: "并行跑两个", toolCalls: calls });
    fake.mockResolvedValueOnce({ content: "都好了", toolCalls: [] });

    const agent = new Agent({ chatWithTools: fake } as unknown as LLMClient, { tools: [], maxSteps: 6 });
    register(agent, mkSlow("a"));
    register(agent, mkSlow("b"));

    const t0 = Date.now();
    await agent.run("并行");
    const total = Date.now() - t0;

    expect(spans).toHaveLength(2);
    const a = spans[0]!;
    const b = spans[1]!;
    // 两个执行区间应当重叠：a 早于 b 结束开始，b 早于 a 结束开始
    expect(a[0]).toBeLessThan(b[1]);
    expect(b[0]).toBeLessThan(a[1]);
    // 总耗时接近单段（~50ms）而非相加（~100ms），留足调度余量
    expect(total).toBeLessThan(90);
  });
});

describe("多工具协作：依赖工具跨轮次串行", () => {
  it("后一个工具用前一个的观察作参数，因此分两轮，且参数确实来自前一轮观察", async () => {
    // 用 spy 记录 readIt 实际拿到的参数，直接证明它消费了 findFile 的产出
    let readPath: string | null = null;
    const order: string[] = [];

    const findFile: Tool = {
      name: "findFile",
      description: "返回一个文件名",
      parameters: z.object({}),
      execute: async () => {
        order.push("findFile");
        return "docs/plan.md";
      },
    };
    const readIt: Tool = {
      name: "readIt",
      description: "读一个文件",
      parameters: z.object({ path: z.string() }),
      execute: async (args) => {
        order.push("readIt");
        readPath = args.path;
        return `内容来自 ${args.path}`;
      },
    };

    const fake = vi.fn(replySig);
    fake
      .mockResolvedValueOnce({
        content: "先找文件",
        toolCalls: [{ id: "s1", type: "function", function: { name: "findFile", arguments: {} } }],
      })
      .mockResolvedValueOnce({
        content: "再读它",
        toolCalls: [{ id: "s2", type: "function", function: { name: "readIt", arguments: { path: "docs/plan.md" } } }],
      })
      .mockResolvedValueOnce({ content: "读完了", toolCalls: [] });

    const agent = new Agent({ chatWithTools: fake } as unknown as LLMClient, { tools: [], maxSteps: 6 });
    register(agent, findFile);
    register(agent, readIt);

    await agent.run("帮我找并读");

    // findFile 必须先于 readIt 执行，且 readIt 拿到的 path 正是 findFile 的产出
    expect(order).toEqual(["findFile", "readIt"]);
    expect(readPath).toBe("docs/plan.md");
  });
});
