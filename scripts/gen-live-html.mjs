// 把 demo 跑出的真实 trace 渲染成一张「终端截图」用的 HTML（配图 06-live.png 的中间产物）。
import { readFileSync, writeFileSync } from "node:fs";

const trace = readFileSync(process.env.TRACE_PATH, "utf8");
const lines = trace.split("\n");

function esc(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function colorLine(line) {
  const e = esc(line);
  if (line.startsWith("=====")) {
    return `<div class="head">${e}</div>`;
  }
  if (line.startsWith("你：")) {
    return `<div><span class="you">你：</span>${esc(line.slice(2))}</div>`;
  }
  if (line.startsWith("助手：")) {
    return `<div><span class="bot">助手：</span>${esc(line.slice(3))}</div>`;
  }
  // 行内标签上色
  const labeled = e
    .replace(/\[(行动)\]/g, '<span class="act">[行动]</span>')
    .replace(/\[(观察)\]/g, '<span class="obs">[观察]</span>')
    .replace(/\[(思考)\]/g, '<span class="thk">[思考]</span>')
    .replace(/\[(回答)\]/g, '<span class="ans">[回答]</span>')
    .replace(/\[(压缩)\]/g, '<span class="cmp">[压缩]</span>');
  return `<div>${labeled}</div>`;
}

const body = lines.map(colorLine).join("\n");

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117;
    font-family: "SF Mono", "Menlo", "Monaco", "Consolas", "Courier New", monospace;
    padding: 0;
  }
  .window {
    background: #0d1117;
    width: 960px;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 10px 40px rgba(0,0,0,.5);
  }
  .titlebar {
    background: #161b22;
    height: 38px;
    display: flex;
    align-items: center;
    padding: 0 14px;
    gap: 8px;
    border-bottom: 1px solid #30363d;
  }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .dot.r { background: #ff5f56; }
  .dot.y { background: #ffbd2e; }
  .dot.g { background: #27c93f; }
  .title {
    color: #8b949e;
    font-size: 13px;
    margin-left: 10px;
  }
  .screen {
    padding: 18px 20px 28px;
    color: #c9d1d9;
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .screen div { white-space: pre-wrap; }
  .head { color: #7ee787; font-weight: bold; margin: 14px 0 6px; }
  .you { color: #58a6ff; font-weight: bold; }
  .bot { color: #d2a8ff; font-weight: bold; }
  .act { color: #ffa657; }
  .obs { color: #79c0ff; }
  .thk { color: #8b949e; }
  .ans { color: #7ee787; }
  .cmp { color: #ff7b72; }
</style>
</head>
<body>
  <div class="window">
    <div class="titlebar">
      <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
      <span class="title">bash — npm run dev (DeepSeek-deepseek-flash)</span>
    </div>
    <div class="screen">${body}</div>
  </div>
</body>
</html>`;

writeFileSync(process.env.OUT_PATH, html, "utf8");
console.log("written", process.env.OUT_PATH);
