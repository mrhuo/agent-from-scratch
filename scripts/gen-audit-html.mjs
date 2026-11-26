// 把能力审计的真实终端输出渲染成紧凑版配图 HTML（13-live.png 的中间产物）。
// 排版更密，内容一行不改：76 行输出需要塞进一张可读的图里。
// 用法：node scripts/gen-audit-html.mjs <auditOutPath> <outHtmlPath>
import { readFileSync, writeFileSync } from "node:fs";

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  process.stderr.write("用法: node scripts/gen-audit-html.mjs <auditOutPath> <outHtmlPath>\n");
  process.exit(1);
}

const lines = readFileSync(inPath, "utf8").split(/\r?\n/);

function esc(s) {
  return s
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function colorOf(line) {
  const t = line.trim();
  if (line.startsWith("=")) return "#30363d";
  if (t.startsWith("能力对照审计") || t.startsWith("合计")) return "#7ee787";
  if (t.startsWith("[post-")) return "#e6edf3";
  if (t.startsWith("证据 ✓")) return "#7ee787";
  if (t.startsWith("证据 ✗")) return "#ff7b72";
  if (t.startsWith("ADK")) return "#d2a8ff";
  if (t.startsWith("Mastra")) return "#7ee787";
  if (t.startsWith("差距")) return "#e3b341";
  return "#8b949e";
}

const body = lines
  .map((l, i) => {
    const color = colorOf(l);
    const bold = /^\[post-|^能力对照审计|^合计/.test(l.trim()) ? "font-weight:700;" : "";
    return `<div style="color:${color};${bold}">${esc(l) || "&nbsp;"}</div>`;
  })
  .join("\n");

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0d1117; }
.win { width:1120px; margin:0 auto; background:#0d1117; border-radius:10px;
  box-shadow:0 10px 40px rgba(0,0,0,.5); overflow:hidden; }
.bar { height:28px; background:linear-gradient(#2b2f36,#1f2329); display:flex;
  align-items:center; padding:0 12px; gap:8px; }
.dot { width:11px; height:11px; border-radius:50%; }
.r{background:#ff5f56}.y{background:#ffbd2e}.g{background:#27c93f}
.title { color:#9da7b3; font:12px -apple-system,Segoe UI,sans-serif; margin-left:8px; }
.screen { padding:12px 18px 16px; font:10.8px/1.28 "SF Mono",Consolas,"Courier New",monospace;
  white-space:pre-wrap; word-break:break-word; }
</style></head>
<body><div class="win">
  <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
  <span class="title">audit — npx tsx scripts/capability-audit.ts（真实输出）</span></div>
  <div class="screen">${body}</div>
</div></body></html>`;

writeFileSync(outPath, html, "utf8");
console.log("written", outPath, "lines", lines.length);
