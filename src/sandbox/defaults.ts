import { PathSandbox } from "./paths.js";
import { DATA_ROOT } from "../tools/root.js";

/**
 * 项目默认的文件沙箱。
 *
 * 放在 sandbox 层而不是 tools 层，是为了让「默认允许碰哪些目录」
 * 成为一条**全局策略**，而不是每个工具各写一份。
 *
 * 默认配置：
 *  - 根目录：data/（第 4 篇起所有本地资料都放在这里）；
 *  - 扩展名：只允许文本类，杜绝「顺手写个 .exe」；
 *  - 大小：单文件 1 MiB 上限，避免一次写入撑爆磁盘；
 *  - 符号链接：解析真实路径，防止软链指向沙箱外。
 */
export function defaultFileSandbox(): PathSandbox {
  return new PathSandbox({
    roots: [DATA_ROOT],
    allowedExtensions: [".txt", ".md", ".markdown", ".json", ".csv", ".log"],
    maxBytes: 1024 * 1024,
  });
}
