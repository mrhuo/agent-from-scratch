import type { ToolDefinition } from "../llm/types.js";

/**
 * 一个工具的高层定义：名字、给模型看的描述、参数 JSON Schema，以及执行函数。
 * 注意：本系列在篇 4 才会把它升级成「带 Zod 校验的注册表」，这里先用最小形态，
 * 足以让 Agent Loop 跑起来。
 */
export interface Tool {
  name: string;
  /** 给模型看的自然语言描述，决定模型会不会、什么时候调用它 */
  description: string;
  /** 参数的 JSON Schema 形态，直接喂给模型 */
  parameters: Record<string, unknown>;
  /** 执行工具，返回字符串形式的观察结果（喂回模型） */
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

/**
 * 安全算术求值：白名单只允许数字、四则运算符、括号与空格，
 * 杜绝任何字母（即潜在代码）注入。白名单通过后，才用 Function 构造器计算。
 *
 * 为什么不直接用 eval(expression)？因为 expression 来自模型——而模型可能被
 * 诱导输出 `1+1; process.exit(1)` 之类的东西。白名单是 Agent 使用外部输入时
 * 的通用铁律：先验证形态，再执行。
 */
const ARITH_WHITELIST = /^[\d+\-*/().\s]+$/;

export function evalArithmetic(expression: string): string {
  const cleaned = expression.trim();
  if (cleaned === "" || !ARITH_WHITELIST.test(cleaned)) {
    return "错误：表达式只能包含数字、运算符 + - * /、括号和空格";
  }
  try {
    // 经白名单校验后才执行；Function 在严格模式下运行，不访问外部作用域
    const value = Function(`"use strict"; return (${cleaned});`)() as unknown;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "错误：计算结果不是有限数值";
    }
    return String(value);
  } catch {
    return "错误：表达式无法计算，请检查括号与运算符是否匹配";
  }
}

/** 篇 2 内置的唯一工具：计算器。它的存在是为了让 Agent Loop 第一次"动手" */
export const calculator: Tool = {
  name: "calculator",
  description:
    "计算一个算术表达式的值。支持加(+)、减(-)、乘(*)、除(/)和括号()，例如 \"23 * 17\" 或 \"(1024 - 256) / 8\"。凡是需要算数，优先调用它，不要凭记忆口算。",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "要计算的算术表达式，例如 \"23 * 17\"",
      },
    },
    required: ["expression"],
  },
  execute: (args) => evalArithmetic(String(args.expression ?? "")),
};

/** 把高层 Tool 转成发给模型的 ToolDefinition（去掉 execute，模型不需要知道怎么执行） */
export function toDefinition(tool: Tool): ToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
