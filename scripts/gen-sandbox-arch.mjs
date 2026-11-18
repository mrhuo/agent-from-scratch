// 生成第 10 篇的架构图 HTML（配图 10-arch.png 的中间产物）。
// 用法：node scripts/gen-sandbox-arch.mjs <outHtmlPath>
import { writeFileSync } from "node:fs";

const outPath = process.argv[2] ?? "data/sandbox-arch.html";

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0d1117; width:1200px; padding:0 0 28px;
  font-family:"PingFang SC","Microsoft YaHei",-apple-system,"Segoe UI",sans-serif; color:#e6edf3; }
.head { margin:0; padding:26px 32px 24px;
  background:linear-gradient(100deg,#1f6feb 0%,#6f42c1 62%,#a371f7 100%); }
.head h1 { font-size:26px; font-weight:700; letter-spacing:.5px; }
.head p { margin-top:9px; font-size:13.5px; color:#dfe7f5; opacity:.94; }
.wrap { padding:22px 32px 0; display:grid; grid-template-columns:1fr 1fr; gap:18px; }
.card { background:#161b22; border:1px solid #30363d; border-radius:10px; padding:16px 18px 18px; }
.card h2 { font-size:15px; font-weight:700; margin-bottom:13px; }
.card h2 .k { color:#8b949e; font-weight:400; font-size:12.5px; }
.step { background:#21262d; border:1px solid #30363d; border-radius:8px; padding:11px 13px; }
.step .no { display:inline-flex; width:21px; height:21px; border-radius:50%; font-size:12px;
  align-items:center; justify-content:center; margin-right:8px; font-weight:700; color:#fff; }
.n1 .no{background:#1f6feb}.n2 .no{background:#238636}.n3 .no{background:#9e6a03}
.n4 .no{background:#8957e5}.n5 .no{background:#da3633}
.step .t { font-size:13.5px; font-weight:600; }
.step .d { font-size:12.5px; color:#9aa4b2; margin-top:5px; line-height:1.65; }
.arrow { text-align:center; color:#58a6ff; font-size:15px; line-height:1; margin:7px 0; }
code { font-family:"SF Mono",Consolas,"Courier New",monospace; font-size:12px;
  background:#1b2330; color:#79c0ff; padding:1px 5px; border-radius:4px; }
.tag { display:inline-block; font-size:11.5px; padding:1px 7px; border-radius:20px; margin:0 4px 4px 0; }
.t-allow{background:rgba(35,134,54,.22);color:#7ee787;border:1px solid rgba(35,134,54,.6)}
.t-deny{background:rgba(218,54,51,.2);color:#ff7b72;border:1px solid rgba(218,54,51,.6)}
.t-ask{background:rgba(158,106,3,.22);color:#e3b341;border:1px solid rgba(158,106,3,.6)}
.t-hard{background:rgba(31,111,235,.18);color:#79c0ff;border:1px solid rgba(31,111,235,.55)}
.t-soft{background:rgba(137,87,229,.18);color:#d2a8ff;border:1px solid rgba(137,87,229,.55)}
.row { border-bottom:1px dashed #30363d; padding:8px 0; font-size:12.5px; line-height:1.7; }
.row:last-child { border-bottom:none; }
.row b { color:#e6edf3; }
.g { color:#7ee787; } .r { color:#ff7b72; } .y { color:#e3b341; } .c { color:#56d4dd; }
.muted { color:#8b949e; }
.full { grid-column:1 / -1; }
.foot { padding:16px 32px 0; font-size:12.5px; color:#8b949e; line-height:1.8; }
</style></head>
<body>
<div class="head">
  <h1>第 10 篇 · 让 Agent 可信：权限 / 沙箱 / 人工介入</h1>
  <p>Agent 内核零改动 —— 授权关卡插在「工具箱」与「工具实现」之间，每一次调用都要从它这里过</p>
</div>

<div class="wrap">
  <div class="card">
    <h2>主链路：一次工具调用要过几道关</h2>

    <div class="step n1">
      <span class="no">1</span><span class="t">Agent Loop</span>
      <div class="d">模型吐出 <code>tool_calls</code>（工具名 + 参数）——参数此刻还是<b>不可信输入</b></div>
    </div>
    <div class="arrow">↓</div>

    <div class="step n2">
      <span class="no">2</span><span class="t">ToolRegistry · 参数校验</span>
      <div class="d">Zod 工具走 Zod，外部工具走其自带 JSON Schema。<br>
      校验<b>在前</b>：参数不合法时不该去打扰人审批</div>
    </div>
    <div class="arrow">↓</div>

    <div class="step n3">
      <span class="no">3</span><span class="t">ToolGuard · 授权关卡</span>
      <div class="d">
        <span class="tag t-allow">allow</span><span class="tag t-ask">ask</span><span class="tag t-deny">deny</span>
        <span class="tag t-soft">软策略</span><br>
        策略产出决策 → <code>ask</code> 转人工 → 全部决策写审计
      </div>
    </div>
    <div class="arrow">↓</div>

    <div class="step n4">
      <span class="no">4</span><span class="t">工具实现 · 内置硬边界</span>
      <div class="d">
        <span class="tag t-hard">围栏</span><br>
        路径沙箱（根目录 / 扩展名 / 大小 / 符号链接）、程序白名单、命令不走 shell
      </div>
    </div>
    <div class="arrow">↓</div>

    <div class="step n5">
      <span class="no">5</span><span class="t">真实副作用</span>
      <div class="d">磁盘文件 · 网络请求 · 外部子进程</div>
    </div>
  </div>

  <div class="card">
    <h2>决策三态与人工介入 <span class="k">—— 为什么不是「允许 / 拒绝」两态</span></h2>

    <div class="row">
      <span class="tag t-allow">allow</span>
      规则命中且无风险，直接执行（只读本地资料、算数、白名单域名抓取）
    </div>
    <div class="row">
      <span class="tag t-ask">ask</span>
      有风险但不该一票否决 —— <b>交给人裁决</b>（写文件、删文件、执行命令）
    </div>
    <div class="row">
      <span class="tag t-deny">deny</span>
      命中红线或无规则覆盖 —— <b>直接拒绝</b>（疑似凭据文件、越出沙箱、未知工具）
    </div>

    <div class="row" style="margin-top:6px">
      <b>fail-closed 三条铁律</b><br>
      <span class="r">审批超时 → 拒绝</span> ·
      <span class="r">审批器异常 → 拒绝</span> ·
      <span class="r">没有审批人 → 拒绝</span><br>
      <span class="muted">拿不到明确同意，一律视为没同意</span>
    </div>

    <div class="row">
      <b>审批器可替换</b>：终端交互（y/n + 超时）／ 回调 ／ 预设序列 ／ 一律拒绝<br>
      <span class="muted">终端版还有个现实约束：非 TTY 环境（CI、管道）直接拒绝，不傻等</span>
    </div>

    <div class="row">
      <b>审计日志</b>：JSONL 追加，记录决策、命中规则、审批人、<b>最终结果</b><br>
      <span class="muted">「批准了但执行失败」与「批准了且执行成功」必须可区分</span>
    </div>

    <div class="row">
      <b>策略只看参数，不看工具输出</b><br>
      <span class="muted">工具返回的网页正文、文件内容都是不可信输入（可能夹带提示注入），
      一律不参与权限判定——否则一句「忽略前面的规则」就能改写授权结果</span>
    </div>
  </div>

  <div class="card full">
    <h2>三层防线的分工：围栏、门禁、摄像头</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
      <div class="row" style="border:none">
        <b>沙箱（硬边界）</b><br>
        写在工具内部，规定这个工具<b>物理上</b>够不到哪些目录、哪些程序。<br>
        <span class="c">策略层再怎么配置，都放宽不了它。</span>
      </div>
      <div class="row" style="border:none">
        <b>策略（软策略）</b><br>
        在沙箱允许的范围内，决定某一次具体调用放不放行、要不要问人。<br>
        <span class="c">粒度到参数值，可以给某些人开后门。</span>
      </div>
      <div class="row" style="border:none">
        <b>审计（事后追溯）</b><br>
        每次决策与结果都留痕，出事后能回答「谁、什么时候、批了什么」。<br>
        <span class="c">只追加，不修改、不删除。</span>
      </div>
    </div>
  </div>
</div>

<div class="foot">
  <b>一个容易踩的坑</b>：策略层判定的路径，必须和工具实际访问的路径是同一个。
  第 4 篇各工具各写一份路径检查（相对 cwd 还是相对 data/ 都不统一），
  就会出现「策略说在沙箱内、工具却读到了沙箱外」这种错位。
  本篇把路径语义统一成「一律相对沙箱根目录」，并把检查收进 PathSandbox 一处。
</div>
</body></html>`;

writeFileSync(outPath, html, "utf8");
console.log("written", outPath);
