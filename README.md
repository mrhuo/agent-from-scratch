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
| 07 | 会规划：Plan-and-Execute | 规划中 |
| 08 | 多 Agent 协作 | 规划中 |
| 09 | 接外部世界：MCP 实战 | 规划中 |
| 10 | 让 Agent 可信：权限 / 沙箱 / 人工介入 | 规划中 |
| 11 | 持久化与恢复：会话、状态、崩溃续跑 | 规划中 |
| 12 | 上线与可观测 | 规划中 |
| 13 | 收尾：本系列手搓的 vs 业界 ADK/Mastra | 规划中 |

> 注：第 1 篇已包含「开篇」与「工程地基」两节；第 2 篇实现「心脏：Agent Loop 与 ReAct」；第 3 篇把工具收编成正式系统（Zod 参数 schema + ToolRegistry 注册表 + 错误分类）；第 4 篇在该系统之上实现第一批真工具（calculator / readFile / searchFiles / webFetch），演示权限沙箱、网络超时与结果截断；第 5 篇让 Agent 在单个任务里自主串联、并行多个工具（依赖型任务串行编排、独立调用 Promise.all 并行）；第 6 篇补齐两种记忆——短期记忆用 ContextCompressor 在历史超阈值时摘要、保真最近轮次，长期记忆用 MemoryStore 落盘 + remember/recall 工具 + 每轮检索注入，二者均通过组合接入、内核循环零改动。每篇博文对应一个 `post-NN` tag。

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
```

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
```

后续章节发布后会追加 `post-07`、`post-08` …… 以此类推。

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
│  ├─ planner/           # 篇07：任务树
│  ├─ orchestrator/      # 篇08：多 Agent
│  ├─ mcp/               # 篇09：client + server
│  ├─ sandbox/           # 篇10：权限与沙箱
│  └─ persistence/       # 篇11：session 存储
├─ tests/                # Vitest，每篇一个 spec
└─ posts/                # 每篇博文草稿（md）+ assets 配图
```

## 设计要点

- **零运行时第三方依赖接入**：`LLMClient` 只用 Node 22 内置 `fetch` 与 `Response` 流，不引入任何 LLM SDK，一层封装屏蔽各 provider 差异。
- **dotenv 覆盖策略**：入口用 `dotenv.config({ override: true })`，保证本地 `.env` 优先于外层已注入的环境变量，避免"填了 key 却用了别处的 key"这类静默覆盖。
