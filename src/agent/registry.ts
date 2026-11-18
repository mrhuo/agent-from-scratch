import type { ToolDefinition } from "../llm/types.js";
import { formatZodError, isRawTool, toDefinition, type AnyTool } from "./tools.js";
import { validateAgainstJsonSchema } from "./schema.js";
import { PermissionDeniedError, type ToolGuard } from "../sandbox/index.js";

/**
 * 工具注册表：Agent 持有的「工具箱」。
 *
 * 第 2 篇的工具散落在 Agent 构造函数里（一个 Map），没有统一入口、没有重复注册保护、
 * 也没有集中的参数校验。本篇把工具收编成正式系统：
 *  - 所有工具先 `register` 进注册表，按名字查找；
 *  - `toDefinitions()` 一次性生成喂给模型的所有工具定义；
 *  - `run()` 统一负责「找工具 → 参数校验 → 执行」，并把任何失败分类成
 *    结构化的观察文本，绝不让异常逃逸到循环外。
 *
 * 第 9 篇起，注册表同时容纳两类工具：
 *  - Zod 工具（本项目自己写的）：参数用 Zod 校验，失败信息来自 ZodError；
 *  - 原生工具（外部给的，如 MCP）：参数按其自带的 JSON Schema 校验。
 * 两条校验路径共用同一个观察文本格式，模型看到的东西完全一致。
 *
 * 第 10 篇起，注册表多了一道**授权关卡**（guard）：
 * 参数校验通过之后、真正执行之前，每一次调用都要先过权限策略。
 * 校验在前、授权在后是有意为之——参数不合法时不该去打扰人审批，
 * 人只该为「格式正确但有风险」的调用买单。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();
  /** 授权关卡；不配置则不做任何权限检查（保持第 3 篇的默认行为） */
  private guard?: ToolGuard;

  /** 注册一个工具；同名重复注册直接报错，避免悄悄覆盖 */
  register(tool: AnyTool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: 工具名 "${tool.name}" 已存在，不能重复注册`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  /** 批量注册 */
  registerAll(tools: AnyTool[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  /** 装上授权关卡 */
  setGuard(guard: ToolGuard): this {
    this.guard = guard;
    return this;
  }

  /** 当前是否已启用权限检查 */
  hasGuard(): boolean {
    return this.guard !== undefined;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 当前注册的所有工具 */
  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  /** 生成喂给模型的所有工具定义（Zod 工具由 Zod 生成 schema，原生工具沿用自带 schema） */
  toDefinitions(): ToolDefinition[] {
    return this.list().map(toDefinition);
  }

  /**
   * 按名字执行一个工具调用，返回观察文本。
   * 任何失败都被分类并转成文本，绝不让异常逃逸：
   *  - 找不到工具 → [工具错误·not_found]
   *  - 参数校验失败 → [工具错误·validation]（带具体字段错误，模型可据此纠正）
   *  - 权限拒绝 → [权限拒绝·策略] / [权限拒绝·人工驳回]
   *  - 执行抛异常 → [工具错误·execution]
   * 这样 Agent 循环即使工具不可靠也能继续，模型下一圈能看到失败原因。
   */
  async run(name: string, rawArgs: unknown): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `[工具错误·not_found] 找不到名为 "${name}" 的工具，请检查工具名是否拼写正确`;
    }

    // 校验：Zod 工具走 Zod，原生工具走其自带的 JSON Schema
    let args: unknown;
    if (isRawTool(tool)) {
      const check = validateAgainstJsonSchema(tool.parameters, rawArgs);
      if (!check.ok) {
        return `[工具错误·validation] 参数校验失败：${check.errors.join("; ")}`;
      }
      args = rawArgs;
    } else {
      const parsed = tool.parameters.safeParse(rawArgs);
      if (!parsed.success) {
        return `[工具错误·validation] 参数校验失败：${formatZodError(parsed.error)}`;
      }
      args = parsed.data;
    }

    try {
      // 有授权关卡时，调用必须先过策略；被拒会抛 PermissionDeniedError，
      // 下面单独归类成「权限拒绝」，与「工具执行失败」区分开。
      const result = this.guard
        ? await this.guard.execute(name, args as Record<string, unknown>, () =>
            tool.execute(args as never),
          )
        : await tool.execute(args as never);
      return String(result);
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        const tag = err.kind === "approval" ? "人工驳回" : "策略拒绝";
        return `[权限拒绝·${tag}] ${err.message}`;
      }
      const message = err instanceof Error ? err.message : String(err);
      return `[工具错误·execution] 工具 "${name}" 执行异常：${message}`;
    }
  }
}
