import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  ToolRegistry,
  calculator,
  evalArithmetic,
  toDefinition,
  formatZodError,
  zodToJsonSchema,
  type Tool,
} from "../src/agent/index.js";

// 仅作为 vi.fn 的类型签名来源，运行时被 mockImplementation 覆盖
const replySig = (_m: unknown, _t: unknown): Promise<{ content: string | null; toolCalls: never[] }> => {
  throw new Error("not implemented");
};

describe("ToolRegistry", () => {
  it("registers and looks up tools by name", () => {
    const reg = new ToolRegistry().register(calculator);
    expect(reg.has("calculator")).toBe(true);
    expect(reg.get("calculator")).toBeDefined();
    expect(reg.list()).toHaveLength(1);
    expect(reg.toDefinitions()).toHaveLength(1);
  });

  it("rejects duplicate registration", () => {
    const reg = new ToolRegistry();
    expect(() => reg.register(calculator).register(calculator)).toThrow(/已存在/);
  });

  it("registers many at once via registerAll", () => {
    const reg = new ToolRegistry().registerAll([calculator]);
    expect(reg.list()).toHaveLength(1);
  });
});

describe("toDefinition / zodToJsonSchema", () => {
  it("generates JSON Schema from a rich Zod schema", () => {
    const richParams = z.object({
      name: z.string().describe("名字"),
      age: z.number().describe("年龄"),
      tags: z.array(z.string()).describe("标签列表"),
      role: z.enum(["admin", "user"]).describe("角色"),
      nick: z.string().optional().describe("昵称"),
    });
    const tool: Tool<typeof richParams> = {
      name: "demo",
      description: "示例工具",
      parameters: richParams,
      execute: () => "ok",
    };
    const def = toDefinition(tool);
    expect(def.type).toBe("function");
    expect(def.function.name).toBe("demo");

    const params = def.function.parameters as Record<string, any>;
    expect(params.type).toBe("object");
    expect(params.properties.name).toEqual({ type: "string", description: "名字" });
    expect(params.properties.age).toEqual({ type: "number", description: "年龄" });
    expect(params.properties.tags).toEqual({
      type: "array",
      items: { type: "string" },
      description: "标签列表",
    });
    expect(params.properties.role).toEqual({
      type: "string",
      enum: ["admin", "user"],
      description: "角色",
    });
    expect(params.properties.nick).toEqual({ type: "string", description: "昵称" });
    // 可选字段 nick 不在 required 里
    expect(params.required).toEqual(["name", "age", "tags", "role"]);
  });

  it("zodToJsonSchema handles number / boolean / union", () => {
    const s = z.object({
      n: z.number(),
      b: z.boolean(),
      u: z.union([z.literal("a"), z.literal("b")]),
    });
    const out = zodToJsonSchema(s) as Record<string, any>;
    expect(out.properties.n.type).toBe("number");
    expect(out.properties.b.type).toBe("boolean");
    expect(out.properties.u.anyOf).toHaveLength(2);
  });
});

describe("ToolError classification via registry.run", () => {
  it("not_found → observation tagged not_found", async () => {
    const reg = new ToolRegistry().register(calculator);
    const obs = await reg.run("does_not_exist", {});
    expect(obs).toContain("not_found");
  });

  it("validation → Zod rejects bad args before execute", async () => {
    const reg = new ToolRegistry().register(calculator);
    // 缺 expression 字段，Zod required 校验失败，execute 根本不会被调用
    const obs = await reg.run("calculator", {});
    expect(obs).toContain("validation");
  });

  it("validation → wrong arg type is rejected by Zod", async () => {
    const reg = new ToolRegistry().register(calculator);
    const obs = await reg.run("calculator", { expression: 123 });
    expect(obs).toContain("validation");
  });

  it("execution → tool throwing is isolated, tagged execution", async () => {
    const boom: Tool = {
      name: "boom",
      description: "总会抛错",
      parameters: z.object({}),
      execute: () => {
        throw new Error("kaboom");
      },
    };
    const reg = new ToolRegistry().register(boom);
    const obs = await reg.run("boom", {});
    expect(obs).toContain("execution");
    expect(obs).toContain("kaboom");
  });

  it("happy path → execute result returned as observation", async () => {
    const reg = new ToolRegistry().register(calculator);
    const obs = await reg.run("calculator", { expression: "23 * 17" });
    expect(obs).toBe("391");
  });
});

describe("formatZodError", () => {
  it("compresses issues into a readable line", () => {
    const parsed = z.object({ a: z.string() }).safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = formatZodError(parsed.error);
      expect(msg).toContain("a");
      expect(msg).toContain("Required");
    }
  });
});

describe("Agent still answers when a tool call fails validation", () => {
  it("treats validation failure as observation and continues", async () => {
    const { Agent } = await import("../src/agent/index.js");
    const fake = (..._args: unknown[]) => {
      let calls = 0;
      return async () => {
        calls++;
        if (calls === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: "c1",
                type: "function",
                function: { name: "calculator", arguments: { expression: 123 } },
              },
            ],
          };
        }
        return { content: "看起来参数不对，我换个方式。", toolCalls: [] };
      };
    };
    // 用最小桩客户端满足 Agent 构造
    const client = {
      chatWithTools: fake(),
    } as unknown as import("../src/llm/index.js").LLMClient;

    const reg = new ToolRegistry().register(calculator);
    const agent = new Agent(client, { registry: reg, maxSteps: 6 });
    const { answer, steps } = await agent.run("帮我算一下");

    // 第一轮工具调用因参数校验失败产生 observation，循环未崩，最终仍给出回答
    const observationStep = steps.find((s) => s.kind === "observation");
    expect(observationStep?.text).toContain("validation");
    expect(answer).toBe("看起来参数不对，我换个方式。");
  });
});

// 复用既有 calculator 的算术断言，确保白名单逻辑未被破坏
describe("evalArithmetic (unchanged behavior)", () => {
  it("computes and guards", () => {
    expect(evalArithmetic("23 * 17")).toBe("391");
    expect(evalArithmetic("Math.random()")).toMatch(/错误/);
  });
});
