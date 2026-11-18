// 把第 10 篇的沙箱演示轨迹渲染成「终端截图」用的 HTML（配图 10-live.png 的中间产物）。
// 用法：node scripts/gen-sandbox-html.mjs <tracePath> <outHtmlPath> [--raw] [title]
import { readFileSync, writeFileSync } from "node:fs";

const [tracePath, outPath, flag, titleArg] = process.argv.slice(2);
const rawMode = flag === "--raw";
const title = titleArg ?? "sandbox — demo-sandbox.ts (DeepSeek-deepseek-flash)";
const raw = readFileSync(tracePath, "utf8").split("\n");

/**
 * 截图用轨迹要短：模型的完整答复重复一大段、审计条目也有 7 条。
 * 这里做两处压缩：答复只留首句，审计只留前 3 条。
 * --raw 模式跳过全部压缩（验证截图用）。
 */
const lines = [];
let inAnswer = false;
let auditKept = 0;
for (const line of raw) {
  const t = line.trim();
  if (rawMode) {
    lines.push(line);
    continue;
  }
  // 模型的答复块（[回答] 与 助手： 两段长文本）整体压缩成一行
  if (t.startsWith("[回答]") || t.startsWith("助手：")) {
    if (!inAnswer) {
      lines.push(line.split("\n")[0].slice(0, 110) + " …");
    }
    inAnswer = true;
    continue;
  }
  if (inAnswer) {
    if (t.startsWith("=====")) inAnswer = false;
    else continue;
  }
  if (t.startsWith("===== 审计日志")) {
    auditKept = 0;
    lines.push(line);
    continue;
  }
  // 审计条目：保留前 3 条
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) {
    auditKept += 1;
    if (auditKept > 3) continue;
  } else if (auditKept > 3 && (t.startsWith("参数：") || t.startsWith("理由："))) {
    continue;
  }
  lines.push(line);
}

// 连续 4 行以上的正文（模型读到的文件内容）压缩成 3 行
const compacted = [];
let plainRun = 0;
for (const line of lines) {
  const t = line.trim();
  // 缩行（规则表、审计条目）不算正文，不参与压缩
  const isPlain =
    !rawMode &&
    t !== "" &&
    !t.startsWith("[") &&
    !t.startsWith("=") &&
    !/^\s{2,}/.test(line);
  if (isPlain) {
    plainRun += 1;
    if (plainRun === 4) {
      compacted.push("  …（正文略）");
      continue;
    }
    if (plainRun > 4) continue;
  } else {
    plainRun = 0;
  }
  compacted.push(line);
}

lines.length = 0;
lines.push(...compacted);
if (!rawMode) lines.push("  …（审计日志共 7 条，此处节选前 3 条）");

function esc(s) {
  return s
    // 去掉 ANSI 颜色转义（vitest 的输出带颜色码，直接渲染会变成乱码方块）
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 行配色：按前缀与关键字给不同语义上色 */
function colorOf(line) {
  const t = line.trim();
  if (line.startsWith("=====")) return "#7ee787"; // 分节标题
  if (t.startsWith("[决策]")) {
    if (t.includes("自动放行")) return "#7ee787"; // 绿：放行
    if (t.includes("人工批准")) return "#56d4dd"; // 青：人工放行
    if (t.includes("人工驳回")) return "#ff7b72"; // 红：驳回
    return "#ff7b72"; // 红：策略拒绝
  }
  if (t.startsWith("[审批]")) return "#ffa657"; // 橙：人工介入
  if (t.startsWith("[思考]")) return "#8b949e"; // 灰
  if (t.startsWith("[行动]")) return "#d2a8ff"; // 紫
  if (t.startsWith("[观察]")) {
    if (t.includes("[权限拒绝")) return "#ff7b72"; // 红：被拦下
    return "#79c0ff"; // 蓝
  }
  if (t.startsWith("[回答]")) return "#7ee787";
  if (t.startsWith("助手：")) return "#d2a8ff";
  if (/^\s+\d+\.\s+\[/.test(line)) return "#c9d1d9"; // 规则表
  if (t.startsWith("默认兜底")) return "#8b949e";
  if (t.startsWith("只读工具") || t.startsWith("高风险工具")) return "#79c0ff";
  if (t.startsWith("任务：")) return "#e6edf3";
  if (t.startsWith("观察结果")) {
    return t.includes("权限拒绝") ? "#ff7b72" : "#79c0ff";
  }
  if (t.startsWith("data/summary.txt") || t.startsWith("结论：")) return "#7ee787";
  if (t.startsWith("参数：") || t.startsWith("理由：")) return "#8b949e";
  if (t.startsWith("默认权限策略") || t.startsWith("策略拒绝") || t.startsWith("人工驳回")) {
    return "#ff7b72";
  }
  if (t.startsWith("自动放行") || t.startsWith("人工批准")) return "#7ee787";
  if (t.startsWith("2026-")) return "#8b949e";
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
.win { width:1040px; margin:0 auto; background:#0d1117; border-radius:10px;
  box-shadow:0 10px 40px rgba(0,0,0,.5); overflow:hidden; }
.bar { height:30px; background:linear-gradient(#2b2f36,#1f2329); display:flex;
  align-items:center; padding:0 12px; gap:8px; }
.dot { width:12px; height:12px; border-radius:50%; }
.r{background:#ff5f56}.y{background:#ffbd2e}.g{background:#27c93f}
.title { color:#9da7b3; font:13px -apple-system,Segoe UI,sans-serif; margin-left:8px; }
.screen { padding:14px 18px 20px; font:12.5px/1.5 "SF Mono",Consolas,"Courier New",monospace;
  white-space:pre-wrap; word-break:break-word; }
</style></head>
<body><div class="win">
  <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
  <span class="title">${esc(title)}</span></div>
  <div class="screen">${body}</div>
</div></body></html>`;

writeFileSync(outPath, html, "utf8");
console.log("written", outPath);
