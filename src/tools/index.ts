import { calculator } from "../agent/tools.js";
import type { Tool } from "../agent/tools.js";
import { readFile } from "./readFile.js";
import { searchFiles } from "./searchFiles.js";
import { webFetch } from "./webFetch.js";

export { readFile } from "./readFile.js";
export { searchFiles } from "./searchFiles.js";
export { webFetch } from "./webFetch.js";
export { DATA_ROOT } from "./root.js";

/**
 * 第 4 篇收编进注册表的全部「真工具」。
 * 既包含第 2/3 篇的 calculator，也包含本篇新增的 readFile / searchFiles / webFetch。
 * 演示入口（src/index.ts）只需 `new ToolRegistry().registerAll(allTools)`，
 * Agent 内核一行都不用改。
 */
export const allTools: Tool<any>[] = [calculator, readFile, searchFiles, webFetch];
