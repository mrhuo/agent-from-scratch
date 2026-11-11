import { resolve } from "node:path";

/**
 * 真工具的「安全根目录」。
 *
 * readFile / searchFiles 默认都只在项目下的 `data/` 目录内活动。
 * 任何试图用 `../` 越权访问系统文件（如 `/etc/passwd`、项目根的 `.env`）的请求，
 * 都会在各自工具的路径检查里被拒绝。这样即便模型被诱导去读敏感文件，也被沙箱挡在外层。
 */
export const DATA_ROOT = resolve(process.cwd(), "data");
