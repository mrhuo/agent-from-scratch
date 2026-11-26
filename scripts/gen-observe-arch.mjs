// 生成第 12 篇的可观测架构图 HTML（配图 12-arch.png 的中间产物）。
// 用法：node scripts/gen-observe-arch.mjs <outHtmlPath>
import { writeFileSync } from "node:fs";

const outPath = process.argv[2] ?? "data/observe-arch.html";

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0d1117; width:1200px; padding:0 0 24px;
  font-family:"PingFang SC","Microsoft YaHei",-apple-system,"Segoe UI",sans-serif; color:#e6edf3; }
.head { padding:26px 32px 23px; background:linear-gradient(100deg,#1f6feb 0%,#238636 58%,#56d4dd 100%); }
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
.step .t { font-size:13.5px; font-weight:600; }
.step .d { font-size:12.5px; color:#9aa4b2; margin-top:5px; line-height:1.6; }
.arrow { text-align:center; color:#58a6ff; font-size:14px; line-height:1; margin:6px 0; }
code { font-family:"SF Mono",Consolas,"Courier New",monospace; font-size:12px;
  background:#1b2330; color:#79c0ff; padding:1px 5px; border-radius:4px; }
.tag { display:inline-block; font-size:11.5px; padding:1px 7px; border-radius:20px; margin:0 4px 4px 0; }
.t-root{background:rgba(31,111,235,.18);color:#79c0ff;border:1px solid rgba(31,111,235,.55)}
.t-llm{background:rgba(35,134,54,.22);color:#7ee787;border:1px solid rgba(35,134,54,.6)}
.t-tool{background:rgba(137,87,229,.18);color:#d2a8ff;border:1px solid rgba(137,87,229,.55)}
.t-err{background:rgba(218,54,51,.2);color:#ff7b72;border:1px solid rgba(218,54,51,.6)}
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
  <h1>第 12 篇 · 上线与可观测：并发、超时、指标与链路追踪</h1>
  <p>一次请求一条 trace；排队耗时与执行耗时分开；取消信号贯通到 fetch；指标只存数值与有限标签</p>
</div>

<div class="wrap">
  <div class="card">
    <h2>请求路径：三层 span，一个 signal</h2>
    <div class="step n1">
      <span class="no">1</span><span class="t">submit(text) 开根 span</span>
      <div class="d"><code>AsyncLocalStorage</code> 携带 traceId / requestId / signal。<br>并发请求各自一份，不串线</div>
    </div>
    <div class="arrow">↓</div>
    <div class="step n2">
      <span class="no">2</span><span class="t">FIFO 信号量准入</span>
      <div class="d">并发上限 2；等待时间进 <code>queue_ms</code> 直方图。<br>排队也有截止，超时立即失败</div>
    </div>
    <div class="arrow">↓</div>
    <div class="step n3">
      <span class="no">3</span><span class="t">一请求一 Agent 实例</span>
      <div class="d">Agent 自带会话状态，不共享；注册表 / 追踪器 / 指标无状态共享。<br>LLM 与每次工具调用各开子 span</div>
    </div>
  </div>

  <div class="card">
    <h2>四条端点，全部只读 <span class="k">—— node:http，零框架</span></h2>
    <div class="row"><b><code>/healthz</code></b> 存活探针，进程在就返回 200</div>
    <div class="row"><b><code>/readyz</code></b> 就绪探针，外部依赖不可用时返回 503</div>
    <div class="row"><b><code>/metrics</code></b> Prometheus 文本：counter / histogram / gauge</div>
    <div class="row"><b><code>/traces</code></b> trace 摘要；<code>/traces/&lt;id&gt;</code> 看完整 span 树</div>
    <div class="row" style="margin-top:6px">
      <b>可观测的四类事实</b><br>
      <span class="tag t-root">agent.run</span> 总耗时与最终状态<br>
      <span class="tag t-llm">llm.chatWithTools</span> 每轮模型调用<br>
      <span class="tag t-tool">tool.*</span> 工具名、状态、响应长度<br>
      <span class="tag t-err">timeout</span> 取消后 abort 送达 fetch
    </div>
  </div>

  <div class="card full">
    <h2>隐私边界：追踪的是行为，不是内容</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
      <div class="row" style="border:none">
        <b>写进 span</b><br>traceId / spanId / 父节点、耗时、状态、<br>工具名、模型名、响应字符数
      </div>
      <div class="row" style="border:none">
        <b>不写进 span</b><br>用户输入、工具参数、模型答复、<br>API key 与任何鉴权头
      </div>
      <div class="row" style="border:none">
        <b>标签取值封闭</b><br>status ∈ ok/error/timeout；<br>tool ∈ 注册表枚举；model 来自配置
      </div>
    </div>
  </div>
</div>

<div class="foot">
  <b>超时只说明调用方不再等待</b>：<code>AbortController.abort()</code> 能中止 fetch；
  不支持 signal 的第三方同步调用会跑到自然结束，结果被丢弃。这个边界必须写进监控口径，
  否则「超时数上升」会被误读成「服务端已经停止工作」。
</div>
</body></html>`;

writeFileSync(outPath, html, "utf8");
console.log("written", outPath);
