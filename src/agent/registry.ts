import type { ToolDefinition } from "../llm/types.js";
import { formatZodError, toDefinition, type Tool } from "./tools.js";

/**
 * 工具注册表：Agent 持有的「工具箱」。
 *
 * 第 2 篇的工具散落在 Agent 构造函数里（一个 Map），没有统一入口、没有重复注册保护、
 * 也没有集中的参数校验。本篇把工具收编成正式系统：
 *  - 所有工具先 `register` 进注册表，按名字查找；
 *  - `toDefinitions()` 一次性生成喂给模型的所有工具定义；
 *  - `run()` 统一负责「找工具 → Zod 校验参数 → 执行」，并把任何失败分类成
 *    结构化的观察文本，绝不让异常逃逸到循环外。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool<any>>();

  /** 注册一个工具；同名重复注册直接报错，避免悄悄覆盖 */
  register(tool: Tool<any>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: 工具名 "${tool.name}" 已存在，不能重复注册`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  /** 批量注册 */
  registerAll(tools: Tool<any>[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  get(name: string): Tool<any> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 当前注册的所有工具 */
  list(): Tool<any>[] {
    return [...this.tools.values()];
  }

  /** 生成喂给模型的所有工具定义（parameters 来自各自 Zod schema） */
  toDefinitions(): ToolDefinition[] {
    return this.list().map(toDefinition);
  }

  /**
   * 按名字执行一个工具调用，返回观察文本。
   * 任何失败都被分类并转成文本，绝不让异常逃逸：
   *  - 找不到工具 → [工具错误·not_found]
   *  - 参数校验失败 → [工具错误·validation]（带具体字段错误，模型可据此纠正）
   *  - 执行抛异常 → [工具错误·execution]
   * 这样 Agent 循环即使工具不可靠也能继续，模型下一圈能看到失败原因。
   */
  async run(name: string, rawArgs: unknown): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `[工具错误·not_found] 找不到名为 "${name}" 的工具，请检查工具名是否拼写正确`;
    }

    const parsed = tool.parameters.safeParse(rawArgs);
    if (!parsed.success) {
      return `[工具错误·validation] 参数校验失败：${formatZodError(parsed.error)}`;
    }

    try {
      return String(await tool.execute(parsed.data));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `[工具错误·execution] 工具 "${name}" 执行异常：${message}`;
    }
  }
}
