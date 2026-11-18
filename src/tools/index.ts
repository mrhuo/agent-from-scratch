import { calculator } from "../agent/tools.js";
import type { AnyTool } from "../agent/tools.js";
import { readFile } from "./readFile.js";
import { searchFiles } from "./searchFiles.js";
import { webFetch } from "./webFetch.js";
import { createDangerousTools } from "./dangerous.js";

export { readFile } from "./readFile.js";
export { searchFiles } from "./searchFiles.js";
export { webFetch } from "./webFetch.js";
export { DATA_ROOT } from "./root.js";

export {
  createWriteFileTool,
  createDeleteFileTool,
  createRunCommandTool,
  createDangerousTools,
} from "./dangerous.js";
export type { DangerousToolOptions } from "./dangerous.js";

/**
 * 第 4 篇收编进注册表的全部「真工具」。
 * 既包含第 2/3 篇的 calculator，也包含本篇新增的 readFile / searchFiles / webFetch。
 * 演示入口（src/index.ts）只需 `new ToolRegistry().registerAll(allTools)`，
 * Agent 内核一行都不用改。
 */
export const allTools: AnyTool[] = [calculator, readFile, searchFiles, webFetch];

/**
 * 第 10 篇新增：高风险工具（写文件 / 删文件 / 执行命令）。
 *
 * 它们**不**放进 allTools——只有显式声明需要它们的场景才会注册。
 * 默认不给 Agent 装上危险工具，比「装上之后再靠策略挡住」更省心：
 * 工具不在工具箱里，模型连想都不用想。
 */
export const dangerousTools: AnyTool[] = createDangerousTools() as AnyTool[];
