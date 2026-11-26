// 生成第 13 篇的三方能力对照图 HTML（配图 13-arch.png 的中间产物）。
// 用法：node scripts/gen-audit-arch.mjs <outHtmlPath>
import { writeFileSync } from "node:fs";

const outPath = process.argv[2] ?? "data/audit-arch.html";

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0d1117; width:1200px; padding:0 0 24px;
  font-family:"PingFang SC","Microsoft YaHei",-apple-system,"Segoe UI",sans-serif; color:#e6edf3; }
.head { padding:26px 32px 22px; background:linear-gradient(100deg,#1f6feb 0%,#7d3cb5 52%,#238636 100%); }
.head h1 { font-size:25px; font-weight:700; letter-spacing:.4px; }
.head p { margin-top:9px; font-size:13.5px; color:#e2e9f7; opacity:.95; }
.wrap { padding:22px 32px 0; display:grid; grid-template-columns:1fr 1fr 1fr; gap:16px; }
.card { background:#161b22; border:1px solid #30363d; border-radius:10px; padding:15px 16px 16px; }
.card h2 { font-size:14.5px; font-weight:700; margin-bottom:12px; }
.card h2 .k { color:#8b949e; font-weight:400; font-size:12px; }
.hs { border-left:3px solid #1f6feb; } .adk { border-left:3px solid #a371f7; } .ms { border-left:3px solid #238636; }
.line { border-bottom:1px dashed #30363d; padding:6.5px 0; font-size:12.2px; line-height:1.55; color:#aeb8c4; }
.line:last-child { border-bottom:none; }
.line b { color:#e6edf3; font-weight:600; }
.line .p { color:#6e7681; font-family:Consolas,monospace; font-size:11px; margin-right:5px; }
code { font-family:"SF Mono",Consolas,monospace; font-size:11.5px; color:#79c0ff; }
.full { grid-column:1 / -1; margin-top:16px; }
.grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.box { background:#21262d; border:1px solid #30363d; border-radius:8px; padding:11px 13px; font-size:12.2px; line-height:1.65; color:#aeb8c4; }
.box b { display:block; color:#e6edf3; font-size:13px; margin-bottom:5px; }
.box .y { color:#e3b341; } .box .g { color:#7ee787; } .box .c { color:#56d4dd; }
.foot { padding:16px 32px 0; font-size:12.5px; color:#8b949e; line-height:1.75; }
</style></head>
<body>
<div class="head">
  <h1>第 13 篇 · 十二篇手搓与两套框架的逐项对照</h1>
  <p>12 项能力全部指向仓库里的真实文件；ADK 与 Mastra 只对照公开文档里的对应机制，不排名</p>
</div>

<div class="wrap">
  <div class="card hs">
    <h2>本系列 <span class="k">—— 从零手搓</span></h2>
    <div class="line"><span class="p">02</span><b>Agent 循环</b> / 工具注册表 / JSON Schema 校验</div>
    <div class="line"><span class="p">06</span><b>轮次压缩</b> / 长期记忆与中文 bigram 检索</div>
    <div class="line"><span class="p">07</span><b>线性计划</b> / 一次有限重规划</div>
    <div class="line"><span class="p">08</span><b>三角色</b> 串行流水线 / 并行分派</div>
    <div class="line"><span class="p">09</span><b>MCP 客户端</b> + 最小有状态服务端</div>
    <div class="line"><span class="p">10</span><b>参数级三态</b> / 路径沙箱 / 审批 / 审计</div>
    <div class="line"><span class="p">11</span><b>快照 + 事件日志</b> / 幂等对账 / 崩溃续跑</div>
    <div class="line"><span class="p">12</span><b>ALS 追踪</b> / 限流 / 超时 / 指标端点</div>
    <div class="line" style="color:#79c0ff"><b>审计脚本</b> 现算证据行数，缺一项即失败</div>
  </div>

  <div class="card adk">
    <h2>Google ADK <span class="k">—— 服务契约</span></h2>
    <div class="line"><span class="p">01</span><b>LlmAgent + Runner</b> / FunctionTool</div>
    <div class="line"><span class="p">02</span><b>自动过滤事件</b> / 摘要旧轮次 / Artifacts 延迟加载</div>
    <div class="line"><span class="p">03</span><b>MemoryService</b> + LoadMemoryTool</div>
    <div class="line"><span class="p">04</span><b>Graph workflows</b> / 顺序、并行、循环 agent</div>
    <div class="line"><span class="p">05</span><b>MCPToolset</b> 直接挂外部工具集</div>
    <div class="line"><span class="p">06</span><b>before_tool_callback</b> 返回 dict 即跳过工具</div>
    <div class="line"><span class="p">07</span><b>Session / Memory / Artifact</b> 三个服务契约</div>
    <div class="line"><span class="p">08</span><b>callbacks / plugins</b> 挂日志，后端聚合</div>
    <div class="line" style="color:#d2a8ff"><b>Runner</b> 调度 / Agent Engine 托管 / A2A</div>
  </div>

  <div class="card ms">
    <h2>Mastra <span class="k">—— TypeScript 原生</span></h2>
    <div class="line"><span class="p">01</span><b>Agent.generate()</b> / stream()</div>
    <div class="line"><span class="p">02</span><b>Observational Memory</b> 后台压缩 + recall</div>
    <div class="line"><span class="p">03</span><b>working memory</b> / semantic recall / scopes</div>
    <div class="line"><span class="p">04</span><b>createWorkflow</b> + then / branch / parallel</div>
    <div class="line"><span class="p">05</span><b>MCPServer</b> 把 agent 暴露给任意客户端</div>
    <div class="line"><span class="p">06</span><b>processors / tripwire</b> 阻断输入输出</div>
    <div class="line"><span class="p">07</span><b>storage provider</b> + suspend / resume</div>
    <div class="line"><span class="p">08</span><b>原生 OTel traces</b> / evals / datasets</div>
    <div class="line" style="color:#7ee787"><b>workflow runners</b> / server / Studio</div>
  </div>

  <div class="card full">
    <h2>同一件事的三种做法 <span class="k">—— 概念同构，边界不同</span></h2>
    <div class="grid3">
      <div class="box"><b>上下文压缩</b>
        <span class="y">本系列</span>：按用户轮切分，LLM 摘要旧轮<br>
        <span class="c">ADK</span>：自动过滤事件，摘要旧轮次<br>
        <span class="g">Mastra</span>：后台 agent 写观察日志，可选 recall 回原文
      </div>
      <div class="box"><b>工具拦截</b>
        <span class="y">本系列</span>：参数级规则 + 审批，拒绝返回文本<br>
        <span class="c">ADK</span>：<code>before_tool_callback</code> 返回 dict 跳过执行<br>
        <span class="g">Mastra</span>：processor 触发 tripwire，状态写进运行结果
      </div>
      <div class="box"><b>状态恢复</b>
        <span class="y">本系列</span>：事件日志重放，副作用调用不重跑<br>
        <span class="c">ADK</span>：SessionService 契约，后端可替换<br>
        <span class="g">Mastra</span>：workflow state 持久化 + restart
      </div>
    </div>
  </div>

  <div class="card full">
    <h2>取舍边界 <span class="k">—— 没有通用答案</span></h2>
    <div class="grid2">
      <div class="box"><b>继续手搓</b>
        策略要写成带类型的代码；每个边界都要能被追问到实现；依赖数量要压到最低；
        场景不在框架的默认路径上（参数级审批、副作用对账）。
      </div>
      <div class="box"><b>换框架</b>
        需要多租户隔离、可视化编排、托管部署、RAG / 评估 / A2A 等现成能力；
        团队要共享一套约定，代码只是配置层。
      </div>
    </div>
  </div>
</div>

<div class="foot">
  <b>边界比功能更值得对照</b>：本系列把「写盘失败就不继续执行」「被拒的工具不重试」「超时不等于服务端已停止」
  这类约束写成了代码。框架提供的是约定和后端，约束仍需自己确认落到哪一层。
</div>
</body></html>`;

writeFileSync(outPath, html, "utf8");
console.log("written", outPath);
