import { resolve } from "node:path";
import type { StdioTransportOptions } from "./transport.js";

/** 启动参数：命令与参数必定存在，这里给出更精确的类型 */
export type LocalServerOptions = StdioTransportOptions &
  Required<Pick<StdioTransportOptions, "command" | "args">>;

/**
 * 本地 MCP 服务端的启动参数。
 *
 * 为什么用 `node node_modules/tsx/dist/cli.mjs` 而不是 `npx tsx`：
 *  - npx 会先查本地再考虑联网，在离线或受限网络里可能卡住；
 *  - 直接用 node 跑 tsx 的 CLI 入口，不经过 shell、不依赖 .cmd 包装，跨平台一致；
 *  - 子进程的类型是 node.exe，stdio 管道行为可预期。
 */
export function localBoardServerOptions(dataFile?: string): LocalServerOptions {
  const tsxCli = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const serverEntry = resolve(process.cwd(), "scripts", "mcp-server.ts");
  // 传入的 dataFile 可能是绝对路径（演示脚本会用临时目录），
  // 必须单独 resolve，否则会被当成目录再拼一层文件名，路径就废了。
  const board = dataFile
    ? resolve(dataFile)
    : resolve(process.cwd(), "data", "board.json");
  return {
    command: process.execPath,
    args: [tsxCli, serverEntry, board],
    cwd: process.cwd(),
    timeoutMs: 30_000,
  };
}
