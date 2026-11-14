// 把真实轨迹 txt 渲染成「macOS 终端」风格的 HTML，供截图。
// 用法：node scripts/gen-plan-html.mjs <tracePath> <outHtmlPath>
import { readFileSync, writeFileSync } from "node:fs";

const [tracePath, outPath] = process.argv.slice(2);
const raw = readFileSync(tracePath, "utf8");
const lines = raw.split("\n");

function esc(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function colorOf(line) {
  if (line.startsWith("=====")) return "#7ee787"; // 标题绿
  if (line.startsWith("【规划")) return "#56d4dd"; // 青
  if (line.startsWith("目标：")) return "#56d4dd";
  if (/^\s*\d+\./.test(line)) return "#56d4dd"; // 计划编号
  if (line.startsWith("【分步执行")) return "#e3b341"; // 黄
  if (line.startsWith("  步骤")) return "#e3b341";
  if (line.startsWith("【重规划")) return "#ff7b72"; // 红
  if (line.startsWith("【终步合成")) return "#d2a8ff"; // 紫
  if (line.startsWith("任务：")) return "#8b949e"; // 灰
  if (line.startsWith("[done]")) return "#8b949e";
  return "#e6edf3"; // 默认浅
}

const body = lines
  .map((l) => {
    const c = colorOf(l);
    return `<div style="color:${c}">${esc(l) || "&nbsp;"}</div>`;
  })
  .join("\n");

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0d1117; }
.win { width:980px; margin:0 auto; background:#0d1117; border-radius:10px;
  box-shadow:0 10px 40px rgba(0,0,0,.5); overflow:hidden; }
.bar { height:30px; background:linear-gradient(#2b2f36,#1f2329); display:flex;
  align-items:center; padding:0 12px; gap:8px; }
.dot { width:12px; height:12px; border-radius:50%; }
.r{background:#ff5f56}.y{background:#ffbd2e}.g{background:#27c93f}
.title { color:#9da7b3; font:13px -apple-system,Segoe UI,sans-serif; margin-left:8px; }
.screen { padding:16px 18px 22px; font:14px/1.55 "SF Mono",Consolas,"Courier New",monospace;
  white-space:pre-wrap; word-break:break-word; }
</style></head>
<body><div class="win">
  <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
  <span class="title">plan-and-execute — demo-plan.ts</span></div>
  <div class="screen">${body}</div>
</div></body></html>`;

writeFileSync(outPath, html, "utf8");
console.log("written", outPath);
