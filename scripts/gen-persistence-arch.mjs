// 生成第 11 篇的持久化架构图 HTML（配图 11-arch.png 的中间产物）。
// 用法：node scripts/gen-persistence-arch.mjs <outHtmlPath>
import { writeFileSync } from "node:fs";

const outPath = process.argv[2] ?? "data/persistence-arch.html";

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0d1117; width:1200px; padding:0 0 26px;
  font-family:"PingFang SC","Microsoft YaHei",-apple-system,"Segoe UI",sans-serif; color:#e6edf3; }
.head { padding:26px 32px 24px; background:linear-gradient(100deg,#1f6feb 0%,#8957e5 62%,#a371f7 100%); }
.head h1 { font-size:26px; font-weight:700; letter-spacing:.5px; }
.head p { margin-top:9px; font-size:13.5px; color:#dfe7f5; opacity:.94; }
.wrap { padding:22px 32px 0; display:grid; grid-template-columns:1fr 1fr; gap:18px; }
.card { background:#161b22; border:1px solid #30363d; border-radius:10px; padding:16px 18px 18px; }
.card h2 { font-size:15px; font-weight:700; margin-bottom:13px; }
.card h2 .k { color:#8b949e; font-weight:400; font-size:12.5px; }
.step { background:#21262d; border:1px solid #30363d; border-radius:8px; padding:10px 13px; }
.step .no { display:inline-flex; width:21px; height:21px; border-radius:50%; font-size:12px;
  align-items:center; justify-content:center; margin-right:8px; font-weight:700; color:#fff; }
.n1 .no{background:#1f6feb}.n2 .no{background:#238636}.n3 .no{background:#9e6a03}
.n4 .no{background:#8957e5}.n5 .no{background:#da3633}
.step .t { font-size:13.5px; font-weight:600; }
.step .d { font-size:12.5px; color:#9aa4b2; margin-top:5px; line-height:1.6; }
.arrow { text-align:center; color:#58a6ff; font-size:14px; line-height:1; margin:6px 0; }
code { font-family:"SF Mono",Consolas,"Courier New",monospace; font-size:12px;
  background:#1b2330; color:#79c0ff; padding:1px 5px; border-radius:4px; }
.tag { display:inline-block; font-size:11.5px; padding:1px 7px; border-radius:20px; margin:0 4px 4px 0; }
.t-safe{background:rgba(35,134,54,.22);color:#7ee787;border:1px solid rgba(35,134,54,.6)}
.t-danger{background:rgba(218,54,51,.2);color:#ff7b72;border:1px solid rgba(218,54,51,.6)}
.t-snap{background:rgba(31,111,235,.18);color:#79c0ff;border:1px solid rgba(31,111,235,.55)}
.t-log{background:rgba(137,87,229,.18);color:#d2a8ff;border:1px solid rgba(137,87,229,.55)}
.row { border-bottom:1px dashed #30363d; padding:7px 0; font-size:12.5px; line-height:1.65; }
.row:last-child { border-bottom:none; }
.row b { color:#e6edf3; }
.g { color:#7ee787; } .r { color:#ff7b72; } .y { color:#e3b341; } .c { color:#56d4dd; }
.muted { color:#8b949e; }
.full { grid-column:1 / -1; }
.foot { padding:15px 32px 0; font-size:12.5px; color:#8b949e; line-height:1.75; }
</style></head>
<body>
<div class="head">
  <h1>第 11 篇 · 持久化与恢复：会话、状态、崩溃续跑</h1>
  <p>快照是定期存档点，事件日志是存档之后的增量；恢复时按幂等键对账，有副作用的调用绝不重跑</p>
</div>

<div class="wrap">
  <div class="card">
    <h2>写入路径：每一个状态变化都同步落盘</h2>
    <div class="step n1">
      <span class="no">1</span><span class="t">用户输入</span>
      <div class="d">先写 <code>status:running</code>，再写 <code>user_input</code>。<br>顺序不能反：崩溃时先看到「正在跑」才安全</div>
    </div>
    <div class="arrow">↓</div>
    <div class="step n2">
      <span class="no">2</span><span class="t">模型给出 tool_calls</span>
      <div class="d"><b>执行之前</b>写 <code>tool_call</code>（id + group + 参数 + 可否重放）。<br>这是判断「是否可能已产生副作用」的唯一依据</div>
    </div>
    <div class="arrow">↓</div>
    <div class="step n3">
      <span class="no">3</span><span class="t">工具执行完成</span>
      <div class="d">写 <code>tool_result</code>，键与 tool_call_id 一致。<br><code>appendFileSync</code> 同步追加，进程被杀最多丢半行</div>
    </div>
    <div class="arrow">↓</div>
    <div class="step n4">
      <span class="no">4</span><span class="t">一轮结束</span>
      <div class="d"><span class="tag t-snap">snapshot</span> 写 tmp → rename 原子替换，<br>旧快照挪到 .bak；事件日志继续保留</div>
    </div>
  </div>

  <div class="card">
    <h2>恢复路径：快照打底，增量重放 <span class="k">—— 对账而非盲目重跑</span></h2>
    <div class="row"><b>1. 读取</b>：<code>snapshot.json</code> 坏了退 <code>.bak</code>，两份都坏则事件全量重放</div>
    <div class="row"><b>2. 切点</b>：只重放 <code>seq &gt; snapshot.lastSeq</code> 的事件；撕裂行与断号跳过</div>
    <div class="row"><b>3. 重建</b>：同一 <code>group</code> 的 tool_call 合并回一条 assistant 消息，<br>tool_result 按 id 去重——旧观察不会重复塞回上下文</div>
    <div class="row" style="margin-top:6px">
      <b>4. 在途调用分类</b><br>
      <span class="tag t-safe">可重放</span> calculator / readFile / searchFiles → 重新执行，结果补盘<br>
      <span class="tag t-danger">不可重放</span> writeFile / deleteFile / runCommand / mcp__ → 不重跑
    </div>
    <div class="row">
      <b>5. 不确定也要留痕</b>：不可重放的调用写入 <code>uncertain:true</code> 的观察文本，<br>模型据此如实告知用户「这一步状态未知」
    </div>
    <div class="row">
      <b>6. 幂等收尾</b>：恢复后再打一次快照，重复恢复得到空账单</div>
  </div>

  <div class="card full">
    <h2>三种「记住」不要混为一谈</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
      <div class="row" style="border:none">
        <b>长期记忆</b>（第 6 篇）<br>
        跨会话的事实：名字、偏好、结论。<br>
        <span class="c">存 data/memory.json，关键词检索后注入 system</span>
      </div>
      <div class="row" style="border:none">
        <b>会话快照</b>（本篇）<br>
        某次会话某一刻的完整上下文。<br>
        <span class="c">存 snapshot.json，原子替换，恢复起点</span>
      </div>
      <div class="row" style="border:none">
        <b>事件日志</b>（本篇）<br>
        快照之后发生了什么，逐条追加。<br>
        <span class="c">存 events.jsonl，带 seq，崩溃对账依据</span>
      </div>
    </div>
  </div>
</div>

<div class="foot">
  <b>计划进度也走同一套事件</b>：<code>plan_created</code> / <code>plan_step</code> / <code>plan_done</code>。
  崩在第 N 步时，恢复出的 PlanProgress 指向第 N+1 步，续跑跳过 createPlan——重新规划一次会引入随机漂移，
  已经做过的事不该因为重启而改写。
</div>
</body></html>`;

writeFileSync(outPath, html, "utf8");
console.log("written", outPath);
