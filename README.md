# agent-from-scratch

从零手搓 AI Agent 的系列博文配套代码。技术栈：**Node.js 22 + TypeScript**，接入层用一套 OpenAI 兼容抽象通吃 OpenAI / DeepSeek / 通义 / OpenRouter。每一篇博文对应一次可运行的代码增量，读者可以 `git checkout` 到任意一篇的起点跟着写。

> 仓库地址：https://github.com/mrhuo/agent-from-scratch

## 这个系列讲什么

不依赖任何 Agent 框架，从最底层自己实现：LLM 接入层 → Agent Loop（think→act→observe）→ Tool 系统 → 记忆 → 规划 → 多 Agent 协作 → MCP → 权限沙箱 → 持久化 → 上线可观测。每篇代码**可跑、可测、可回溯**。

## 章节路线图（每章一个 `post-NN` tag）

| 篇 | 主题 | 状态 |
|---|---|---|
| 01 | 开篇 + 工程地基：什么是 Agent、为什么不直接用框架、Node22 + TS + 统一 LLM 客户端（LLM 接入层） | ✅ 已完成 |
| 02 | 心脏：Agent Loop 与 ReAct | ✅ 已完成 |
| 03 | 长出手脚：Tool 系统设计（Zod 参数 schema + ToolRegistry 注册表 + 错误分类） | ✅ 已完成 |
| 04 | 第一个真工具：搜索 / 计算 / 读文件 | ✅ 已完成 |
| 05 | 多工具协作：串行编排与并行执行 | ✅ 已完成 |
| 06 | 记忆的两种形态（短期 / 长期） | ✅ 已完成 |
| 07 | 会规划：Plan-and-Execute | ✅ 已完成 |
| 08 | 多 Agent 协作（同一内核 + 角色白名单 + 协调者） | ✅ 已完成 |
| 09 | 接外部世界：MCP 实战（手写客户端 + 服务端） | ✅ 已完成 |
| 10 | 让 Agent 可信：权限 / 沙箱 / 人工介入 | ✅ 已完成 |
| 11 | 持久化与恢复：会话、状态、崩溃续跑 | ✅ 已完成 |
| 12 | 上线与可观测：并发、超时、指标与链路追踪 | ✅ 已完成 |
| 13 | 收尾：本系列手搓的 vs 业界 ADK/Mastra | ✅ 已完成 |

> 注：第 1 篇已包含「开篇」与「工程地基」两节；第 2 篇实现「心脏：Agent Loop 与 ReAct」；第 3 篇把工具收编成正式系统（Zod 参数 schema + ToolRegistry 注册表 + 错误分类）；第 4 篇在该系统之上实现第一批真工具（calculator / readFile / searchFiles / webFetch），演示权限沙箱、网络超时与结果截断；第 5 篇让 Agent 在单个任务里自主串联、并行多个工具（依赖型任务串行编排、独立调用 Promise.all 并行）；第 6 篇补齐两种记忆——短期记忆用 ContextCompressor 在历史超阈值时摘要、保真最近轮次，长期记忆用 MemoryStore 落盘 + remember/recall 工具 + 每轮检索注入，二者均通过组合接入、内核循环零改动；第 7 篇在 ReAct 循环之上叠加 Plan-and-Execute——用 Planner 把任务拆成有序步骤（JSON 模式 + 容错解析），runPlan 让每步独立跑一遍 ReAct 子循环（可调用工具），最后由中性提示终步合成，某步撞预算未收敛时有限次 revisePlan 重规划剩余步骤，规划与执行通过组合接入、内核循环零改动；第 8 篇用一层薄薄的 Orchestrator 实现多 Agent 协作——每个 Worker 就是已有的 Agent 实例，换 systemPrompt 与工具白名单即是换角色，runPipeline 用前序产出交接实现串行流水线，runParallel 用 Promise.all 并行推进独立子任务再由中性提示汇总，真实演示中审核员独立发现并纠正了写手的事实性错误，既有能力零改动复用；第 9 篇接上外部世界——不引 MCP SDK，手写 JSON-RPC 2.0 协议层、stdio 子进程传输、客户端握手与工具发现、服务端核心与一个有状态的任务看板服务；工具箱新增「原生工具」一类，参数 schema 由服务端给定、按 JSON Schema 校验，与本地 Zod 工具共用同一套定义与观察格式，Agent 内核零改动；第 10 篇给 Agent 装上边界——参数级权限（决策看参数值而非只看工具名，allow/deny/ask 三态）、工具自带的硬沙箱（根目录 / 扩展名 / 大小 / 符号链接四道边界）、人工介入（超时、审批器异常、没有审批人一律按拒绝处理）与 JSONL 审计日志，授权关卡插在 ToolRegistry 与工具实现之间，Agent 内核依旧零改动；第 11 篇把进程内状态搬到磁盘——会话快照（tmp + rename 原子写、.bak 回滚）加只追加事件日志（单调 seq、撕裂行容错）构成恢复数据源，重放时按 tool_call_id 幂等去重，只读调用可重放、有副作用的调用只标记不确定，计划进度也从事件重建并从下一个未完成步骤续跑；第 12 篇补上上线所需的三类机器可读信号——trace（一次请求的 span 树）、metric（Prometheus 文本）与 probe（存活/就绪），并用 FIFO 信号量限制并发、把排队耗时单独计量、用 AbortSignal 把超时穿透到 fetch。追踪只记行为与数值，不记用户输入与密钥；第 13 篇把 12 项能力与 Google ADK / Mastra 逐项对齐，审计脚本现算证据行数与测试覆盖，缺一项即失败。每篇博文对应一个 `post-NN` tag。

每篇博文在 `posts/NN.md`，配套代码增量在 `src/` 对应目录。

## 环境要求

- **Node.js >= 22**（依赖原生 `fetch` 与 `ReadableStream` 解析 SSE 流）
- 任意一个 OpenAI 兼容端点的 API Key（推荐 DeepSeek，国内直连）

## 如何运行

```bash
# 1. 克隆
git clone https://github.com/mrhuo/agent-from-scratch.git
cd agent-from-scratch

# 2. 安装依赖
npm install

# 3. 配置密钥（复制模板后填入申请的 API Key）
cp .env.example .env
#   编辑 .env：
#     OPENAI_API_KEY=sk-xxxxxxxx
#     BASE_URL=https://api.deepseek.com   # DeepSeek 兼容地址【不带 /v1】
#     MODEL=deepseek-flash

# 4. 启动交互式对话（输入一句、模型流式回复一句，exit 退出）
npm run dev

# 5. 跑单元测试（mock，无需 key / 外网）
npm test

# 6. 类型检查
npm run typecheck

# 7. 持久化两阶段演示（需联网与 key；第一阶段以 exit(9) 结束属预期）
npx tsx scripts/demo-persistence.ts run
npx tsx scripts/demo-persistence.ts resume

# 8. 可观测演示（需联网与 key）：并发请求 + 指标抓取 + 超时探针
npx tsx scripts/demo-observability.ts

# 9. 单独启动观测端点（不需要 key）
npm run observe

# 10. 能力对照审计（不需要 key / 外网）：12 项能力，证据现算
npx tsx scripts/capability-audit.ts
npx tsx scripts/capability-audit.ts --md
npx tsx scripts/capability-audit.ts --only=sandbox
```

交互式入口支持 `/persist` 进入持久化模式、`/resume [会话ID]` 在新进程恢复、`/obs` 进入可观测模式（端点 `http://127.0.0.1:9464/metrics`）。

> 注意：DeepSeek 的 OpenAI 兼容地址是 `https://api.deepseek.com`（**不带 `/v1`**），与 OpenAI 官方的 `https://api.openai.com/v1` 不同。切换其他 provider 只需改 `.env` 的 `BASE_URL` 和 `MODEL`，Agent 内核无需改动。
> 本地 `.env` 已被 `.gitignore` 忽略，不会进入提交。

## 按章节回溯

每篇博文对应一个 tag，读者可精确回到任意一篇的代码起点：

```bash
git clone https://github.com/mrhuo/agent-from-scratch.git
git checkout post-01   # 回到第 1 篇完成时的代码
git checkout post-02   # 回到第 2 篇（Agent Loop）完成时的代码
git checkout post-03   # 回到第 3 篇（Tool 系统：Zod + 注册表）完成时的代码
git checkout post-04   # 回到第 4 篇（真工具：readFile / searchFiles / webFetch）完成时的代码
git checkout post-05   # 回到第 5 篇（多工具协作：并行执行 + 串行编排）完成时的代码
git checkout post-06   # 回到第 6 篇（记忆的两种形态：短期压缩 + 长期持久化）完成时的代码
git checkout post-07   # 回到第 7 篇（会规划：Plan-and-Execute）完成时的代码
git checkout post-08   # 回到第 8 篇（多 Agent 协作：角色白名单 + 串行流水线 / 并行分派）完成时的代码
git checkout post-09   # 回到第 9 篇（接外部世界：MCP 客户端 + 服务端）完成时的代码
git checkout post-10   # 回到第 10 篇（让 Agent 可信：权限 / 沙箱 / 人工介入）完成时的代码
git checkout post-11   # 回到第 11 篇（持久化与恢复：快照 / 事件日志 / 崩溃续跑）完成时的代码
git checkout post-12   # 回到第 12 篇（上线与可观测：并发 / 超时 / 指标 / 链路追踪）完成时的代码
git checkout post-13   # 回到第 13 篇（收尾对照：ADK / Mastra 逐项比对）完成时的代码
```

post-01 至 post-13 均已发布。

## 目录结构

```
agent-from-scratch/
├─ package.json          # Node>=22，type:module；scripts: dev / test / typecheck
├─ tsconfig.json         # strict 模式
├─ .env.example          # OPENAI_API_KEY / BASE_URL / MODEL 模板
├─ src/
│  ├─ llm/               # 篇01：LLMClient（OpenAI 兼容，非流式 + 流式 SSE）
│  ├─ agent/             # 篇02-03：Agent Loop + Tool 系统（ToolRegistry / Zod schema / ToolError）
│  ├─ tools/             # 篇04 起：搜索 / 计算 / 读文件等真工具
│  ├─ memory/            # 篇06：短/长期记忆
│  ├─ planning/          # 篇07：Planner 任务拆解与重规划
│  ├─ orchestrator/      # 篇08：多 Agent
│  ├─ mcp/               # 篇09：MCP 客户端 + 服务端（JSON-RPC 2.0 / stdio）
│  ├─ sandbox/           # 篇10：参数级权限 / 路径沙箱 / 人工审批 / 审计
│  ├─ persistence/       # 篇11：session 存储
│  ├─ observe/           # 篇12：trace / 指标 / 并发限流 / 超时取消 / HTTP 端点
│  └─ audit/             # 篇13：12 项能力对照与证据扫描
├─ tests/                # Vitest，每篇一个 spec
├─ scripts/              # 各篇演示脚本 + 配图生成脚本
└─ posts/                # 每篇博文草稿（md）+ assets 配图
```

## 设计要点

- **零运行时第三方依赖接入**：`LLMClient` 只用 Node 22 内置 `fetch` 与 `Response` 流，不引入任何 LLM SDK，一层封装屏蔽各 provider 差异。
- **dotenv 覆盖策略**：入口用 `dotenv.config({ override: true })`，保证本地 `.env` 优先于外层已注入的环境变量，避免"填了 key 却用了别处的 key"这类静默覆盖。
- **一切能力通过组合接入**：记忆、规划、多 Agent、权限都是挂到同一个 `Agent` 上的可选项，内核循环从第 2 篇起几乎没变过——每篇的新增都可以单独关掉。
- **权限默认拒绝**：策略无规则命中、规则求值异常、审批超时、审批器故障、没有审批人，五种情况一律按拒绝处理；被拒绝的调用返回结构化观察文本，模型能据此改道。
- **沙箱与策略分工明确**：沙箱写在工具内部，是物理围栏；策略写在配置里，是可调的软门禁。门禁可以开后门，翻不出围栏。
- **路径语义全局统一**：所有文件类工具的相对路径一律以沙箱根目录为基准，策略层判定的路径与工具实际访问的路径永远是同一个。
- **快照 + 事件日志分工**：快照是定期存档点（原子替换、可回滚），事件日志是存档后的增量（同步追加、带序号、容错撕裂行）；恢复只读 `seq > lastSeq` 的事件。
- **恢复只做对账，不做盲目重跑**：只读工具可安全重放；写文件、删文件、执行命令与外部 MCP 工具结果未落盘时一律不重跑，只写明确的「状态未知」观察。
- **在途记录必须先于执行**：工具调用写盘失败就中止本轮，不能带着没有记录的状态继续执行。
- **一请求一 Agent 实例**：Agent 持有会话状态，并发请求不可共享；注册表、追踪器、指标无状态，可以共享。
- **排队耗时与执行耗时分开**：FIFO 信号量限制并发，排队超时直接失败；总耗时里混进排队时间会让容量问题被误判成模型变慢。
- **超时贯通到 I/O**：`AbortSignal` 从截止时间传到 `fetch`；不支持 signal 的同步调用无法被强停，只丢弃结果，这个边界写进监控口径。
- **追踪只记行为不记内容**：span 存标识、耗时、状态、工具名与响应长度；用户输入、工具参数、模型答复与密钥一律不进追踪。
- **对照表必须有证据**：每项能力绑定真实源码与测试文件，行数由脚本现算；文件缺失则审计以退出码 1 结束。
