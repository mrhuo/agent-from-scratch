import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import { zodToJsonSchema, type JsonSchema } from "./schema.js";

/**
 * 一个工具的高层定义。
 *
 * 与第 2 篇的「最小形态」相比，本篇用 Zod 接管了参数：
 *  - `parameters` 是一个 Zod schema，它同时承担两件事：
 *      1) 运行时校验模型给的参数（不合法直接拦下，不进 execute）；
 *      2) 生成喂给模型的 JSON Schema（单一事实来源，不会和校验逻辑漂移）。
 *  - `execute` 收到的 `args` 已经通过 Zod 校验，可以放心使用。
 */
export interface Tool<T extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  /** 给模型看的自然语言描述，决定模型懂不懂、什么时候用这个工具 */
  description: string;
  /** 参数 Zod schema：既是运行时校验器，也是生成 JSON Schema 的来源 */
  parameters: T;
  /** 执行工具，返回字符串形式的观察结果（喂回模型） */
  execute: (args: z.infer<T>) => Promise<string> | string;
}

/**
 * 外部工具：参数 schema 由**外部服务给定**，本项目不重新定义。
 *
 * 第 9 篇接入 MCP 时引入：MCP 服务端给每个工具附一份 JSON Schema（inputSchema），
 * 我们既改不了它，也不该把它翻译成 Zod（翻译层本身就是可能出错的额外代码）。
 * 于是这类工具的校验直接按它自带的 JSON Schema 走——JSON Schema 本来就是干这个的。
 *
 * 对比：
 *  - `Tool`   —— 本项目自己写的工具，参数用 Zod 定义一次（校验与 schema 同源）；
 *  - `RawTool`—— 外部工具，参数用服务端给的 JSON Schema（我们只做消费方）。
 */
export interface RawTool {
  name: string;
  description: string;
  /** 外部给定的 JSON Schema（原生），直接喂给模型 */
  parameters: JsonSchema;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

/** 注册表可容纳的两种工具 */
export type AnyTool = Tool<any> | RawTool;

/** 判断一个工具是「原生 JSON Schema 工具」还是「Zod 工具」 */
export function isRawTool(tool: AnyTool): tool is RawTool {
  return typeof (tool.parameters as { safeParse?: unknown }).safeParse !== "function";
}

/** 工具执行失败的分类：找不到 / 参数不合法 / 执行抛异常 */
export type ToolErrorKind = "not_found" | "validation" | "execution";

/** 携带分类信息的工具错误，便于上层把错误转成结构化的观察文本 */
export class ToolError extends Error {
  readonly kind: ToolErrorKind;
  constructor(kind: ToolErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "ToolError";
  }
}

/**
 * 把高层工具转成发给模型的 ToolDefinition。
 * Zod 工具的 parameters 由 Zod schema 自动生成 JSON Schema；
 * 原生工具的 parameters 直接沿用外部给定的 JSON Schema。
 * 两种工具对模型来说形态完全一致——模型只认 function calling 的标准结构。
 */
export function toDefinition(tool: AnyTool): ToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: isRawTool(tool) ? tool.parameters : zodToJsonSchema(tool.parameters),
    },
  };
}

/** 把 ZodError 压缩成一行可读信息，写进观察结果让模型自行纠正 */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

/**
 * 安全算术求值：白名单只允许数字、四则运算符、括号与空格，
 * 杜绝任何字母（即潜在代码）注入。白名单通过后，才用 Function 构造器计算。
 *
 * 为什么不直接用 eval(expression)？因为 expression 来自模型——而模型可能被
 * 诱导输出 `1+1; process.exit(1)` 之类的东西。白名单是 Agent 使用外部输入时
 * 的通用铁律：先验证形态，再执行。这一层与「Zod 参数校验」是互补的两道防线：
 * Zod 保证 expression 是个字符串，白名单保证这个字符串里没有危险字符。
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

/** 本系列第一个工具：计算器。参数用 Zod 定义，execute 收到的已是合法字符串 */
const calculatorParams = z.object({
  expression: z
    .string()
    .describe('要计算的算术表达式，例如 "23 * 17" 或 "(1024 - 256) / 8"'),
});

export const calculator: Tool<typeof calculatorParams> = {
  name: "calculator",
  description:
    "计算一个算术表达式的值。支持加(+)、减(-)、乘(*)、除(/)和括号()，例如 \"23 * 17\" 或 \"(1024 - 256) / 8\"。凡是需要算数，优先调用它，不要凭记忆口算。",
  parameters: calculatorParams,
  execute: (args) => evalArithmetic(args.expression),
};
