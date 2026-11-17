// 把 MCP 演示跑出的真实轨迹渲染成「终端截图」用的 HTML（配图 09-live.png 的中间产物）。
// 用法：node scripts/gen-mcp-html.mjs <tracePath> <outHtmlPath>
import { readFileSync, writeFileSync } from "node:fs";

const [tracePath, outPath] = process.argv.slice(2);
const lines = readFileSync(tracePath, "utf8").split("\n");

function esc(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 行配色：按前缀与关键字给不同语义上色 */
function colorOf(line) {
  const t = line.trim();
  if (line.startsWith("=====")) return "#7ee787"; // 分节标题
  if (t.startsWith("[握手]")) return "#56d4dd"; // 青
  if (t.startsWith("[思考]")) return "#8b949e"; // 灰
  if (t.startsWith("[行动]")) return "#ffa657"; // 橙
  if (t.startsWith("[观察]")) return "#79c0ff"; // 蓝
  if (t.startsWith("[回答]")) return "#7ee787"; // 绿
  if (t.startsWith("助手：")) return "#d2a8ff"; // 紫
  if (line.startsWith("  - mcp__")) return "#56d4dd"; // 工具名
  if (t.startsWith("说明：")) return "#8b949e";
  if (t.startsWith("参数 schema")) return "#8b949e";
  if (t.startsWith("本地工具：")) return "#79c0ff";
  if (t.startsWith("MCP 工具：")) return "#56d4dd";
  if (line.includes("[MCP 工具错误]")) return "#ff7b72"; // 红：失败路径
  if (t.startsWith("看板共有") || t.startsWith("注意")) return "#7ee787";
  if (t.startsWith("重新握手") || t.startsWith("list_tasks 返回")) return "#56d4dd";
  if (t.startsWith("[done]")) return "#8b949e";
  return "#e6edf3";
}

const body = lines
  .map((l) => `<div style="color:${colorOf(l)}">${esc(l) || "&nbsp;"}</div>`)
  .join("\n");

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0d1117; }
.win { width:1000px; margin:0 auto; background:#0d1117; border-radius:10px;
  box-shadow:0 10px 40px rgba(0,0,0,.5); overflow:hidden; }
.bar { height:30px; background:linear-gradient(#2b2f36,#1f2329); display:flex;
  align-items:center; padding:0 12px; gap:8px; }
.dot { width:12px; height:12px; border-radius:50%; }
.r{background:#ff5f56}.y{background:#ffbd2e}.g{background:#27c93f}
.title { color:#9da7b3; font:13px -apple-system,Segoe UI,sans-serif; margin-left:8px; }
.screen { padding:16px 18px 22px; font:13.5px/1.5 "SF Mono",Consolas,"Courier New",monospace;
  white-space:pre-wrap; word-break:break-word; }
</style></head>
<body><div class="win">
  <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
  <span class="title">mcp — demo-mcp.ts (DeepSeek-deepseek-flash)</span></div>
  <div class="screen">${body}</div>
</div></body></html>`;

writeFileSync(outPath, html, "utf8");
console.log("written", outPath);
