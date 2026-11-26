/**
 * 能力对照审计 CLI。
 *
 *   npx tsx scripts/capability-audit.ts            # 终端表格
 *   npx tsx scripts/capability-audit.ts --md       # Markdown 表格
 *   npx tsx scripts/capability-audit.ts --json     # 结构化输出
 *   npx tsx scripts/capability-audit.ts --only=sandbox
 *
 * 任一证据文件缺失时以退出码 1 结束：对照表必须能回溯到真实代码。
 */
import { resolve } from "node:path";
import {
  CAPABILITIES,
  auditCapabilities,
  renderMarkdown,
  renderTerminal,
} from "../src/audit/capabilities.js";

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const list = only ? CAPABILITIES.filter((c) => c.id === only) : CAPABILITIES;

if (list.length === 0) {
  process.stderr.write(`未知能力标识: ${only}\n可用标识: ${CAPABILITIES.map((c) => c.id).join(", ")}\n`);
  process.exit(1);
}

const rows = auditCapabilities(resolve(process.cwd()), list);

if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
} else if (args.includes("--md")) {
  process.stdout.write(`${renderMarkdown(rows)}\n`);
} else {
  process.stdout.write(`${renderTerminal(rows)}\n`);
}

if (rows.some((r) => !r.present)) process.exitCode = 1;
