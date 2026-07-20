# AgentOS

## Provider Runtime

Agent 配置中的 `provider` 表示用户配置身份，CLI 命令通过 Adapter 的异步 `probe()` 得到实际 `detectedProvider`。两者不一致时会公开 `provider.mismatch` 诊断，选择实际可用的 parser，并把 configured/detected provider 持久化到 Run invocation。Agent 编辑器同时展示 Provider、CLI 命令和最近一次 mismatch。

- Codex：已有 JSONL Adapter；本机 `.codex\\.sandbox-bin\\codex.exe`（`0.144.0-alpha.4`）真实 Gate 已通过。
- Kimi：`0.23.5` 的 `stream-json` Adapter、脱敏 fixture 与 fake CLI Gate 已通过，见 [docs/acceptance/kimi-runtime-final.md](docs/acceptance/kimi-runtime-final.md)。
- OpenCode：已有数据库增量 usage 读取；本机 `E:\\software\\opencode\\node_modules\\opencode-ai\\bin\\opencode.exe`（`1.17.11`）真实 Gate 已通过。

使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-provider-runtime.ps1` 可运行本阶段的自动化验收。

本地多 Agent 调度平台，管理 Codex、KimiCode、OpenCode 等 CLI Agent 协同开发同一项目。

计划 D 的隔离发布验收记录见 [docs/acceptance/agentos-collaboration-workbench-final.md](docs/acceptance/agentos-collaboration-workbench-final.md)。Worktree/recovery/storage 核心测试、三 Provider 真实生命周期和双 Agent 隔离 Worktree gate 均已通过。

## 系统要求

- Node.js >= 22.5
- pnpm（`npm install -g pnpm`）
- 可选：`codex` 和 `opencode` 命令需要在 PATH 中（否则只能使用 Mock 模式）

## 快速启动

### 1. 安装依赖

```bash
cd agentos
pnpm install
```

### 2. 启动（Mock 模式，不需要安装任何 Agent CLI）

```powershell
# Windows PowerShell — 自动释放 3000/3001 端口后启动
./start-dev.ps1 -Mock
```

或手动启动：

```bash
# 终端 1: 后端 (Express API, 默认 http://localhost:3000)
AGENTOS_FORCE_MOCK=true pnpm --filter @agentos/server run dev

# 终端 2: 前端 (Next.js, 默认 http://localhost:3001)
pnpm --filter @agentos/web run dev
```

然后打开浏览器访问 **http://localhost:3001**

### 3. 启动（真实 Agent 模式）

确保 `codex` 和 `opencode` 在 PATH 中：

```powershell
# Windows PowerShell
./start-dev.ps1 -Stable
```

或通过环境变量指定路径：

```powershell
$env:AGENTOS_CODEX_CLI = "C:\path\to\codex.cmd"
$env:AGENTOS_KIMI_CLI = "C:\path\to\kimi.exe"
$env:AGENTOS_OPENCODE_CLI = "C:\path\to\opencode.exe"
./start-dev.ps1 -Stable
```

> 注意：真实 Agent 模式下如果找不到 CLI 或 Agent 执行失败，任务会标记为 **failed**，不会静默降级到 Mock。Mock 输出只在 `AGENTOS_FORCE_MOCK=true` 时出现。

### 启动模式

| 命令 | 用途 |
|------|------|
| `pnpm --filter @agentos/server run dev` | 人工开发或 Mock Pipeline。该命令使用 `tsx watch`，源码修改时会自动重启 Server。不要用它运行会修改仓库、安装依赖或执行全量构建的真实 Agent。 |
| `pnpm --filter @agentos/server run dev:stable`（或根目录的 `pnpm dev:stable`） | 真实 Codex、KimiCode 等 Agent Pipeline。该命令保留 Server 启动前的 `@agentos/agent-core` 构建步骤，但使用普通 `tsx src/index.ts`，不会因 Agent 修改仓库文件而重启 Server。 |
| `./start-dev.ps1 -Stable` | 同时启动稳定 Server 和 Web 开发服务，适用于从浏览器运行真实 Pipeline。 |

`dev:stable` 的稳定性承诺针对管理任务的 Express Server；Web 前端仍可单独使用 `pnpm --filter @agentos/web run dev` 进行界面开发。

## 运行流程

1. 在首页创建或导入一个 **Workspace**（指向一个本地项目目录）
2. 在工作区中创建 **Task**（输入任务描述）
3. 点击 **Run** 启动 4 阶段流水线：

```
Codex (Manager) → KimiCode (Worker) → OpenCode (Reviewer) → Codex (Final Review)
```

4. 流水线运行中可通过 **Cancel** 按钮中止（会杀掉后端正在执行的 Agent 进程）
5. 每个阶段的输出会持久化保存，刷新页面后仍然可见

## 执行档案与项目知识

v2 会为每条单聊或群聊请求创建一个 `AgentRun`，统一保存公开事件、可观测 CLI 元数据、Git 文件变化、最终结果和记忆用量；历史详情可从执行状态面板打开。项目知识保存在 `agent-memory/records/` 下的 UTF-8 Markdown，SQLite 保存索引和来源，默认只检索 active 记忆并使用固定预算注入。成功 Run 只能生成待审核候选，必须人工接受后才会进入正式记忆。

Codex Runtime 现在支持结构化 JSONL 事件、脱敏工具时间线、可控逐字输出和 `RuntimeArtifact`（文件快照、diff、测试报告、图片、公开日志）。KimiCode 使用 `stream-json` Adapter，OpenCode 使用本地数据库增量读取 Token；三者没有可用 usage 时统一报告 `source: unavailable`，不会用字符数冒充 Token。当前 Provider/Worktree 门禁记录见 [docs/acceptance/agentos-provider-gates.md](docs/acceptance/agentos-provider-gates.md)，三 Provider 真实生命周期和双 Agent Worktree gate 已通过。

- 架构与接口说明：[docs/AGENTOS_V2.md](docs/AGENTOS_V2.md)
- 记忆系统边界：[docs/MEMORY_SYSTEM.md](docs/MEMORY_SYSTEM.md)
- 全链路验收记录：[docs/acceptance/agentos-memory-acceptance.md](docs/acceptance/agentos-memory-acceptance.md)

## 项目结构

```
agentos/
├── apps/
│   ├── web/          # Next.js 前端（端口 3001）
│   └── server/       # Node.js Express 后端（端口 3000）
├── packages/
│   ├── shared/       # 共享类型
│   └── agent-core/   # Agent Runner、Executor、MockCLI
├── agent-memory/     # Agent 共享记忆（PROJECT.md, TASKS.md, LOG.md 等）
├── docs/             # AGENT_RULE.md 等标准文档
├── workspace/        # 工作区数据存储（workspaces.json、tasks.json）
├── .env.example      # 环境变量参考（复制为 .env 使用）
└── start-dev.ps1     # 一键启动脚本（支持 -Mock 参数）
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AGENTOS_FORCE_MOCK` | `false` | `true` 时使用 Mock 输出，不需要安装 Agent CLI |
| `AGENTOS_CODEX_CLI` | `codex` | Codex 命令路径或名称 |
| `AGENTOS_KIMI_CLI` | `kimi` | KimiCode 命令路径或名称 |
| `AGENTOS_OPENCODE_CLI` | `opencode` | OpenCode Reviewer 命令路径或名称；如需使用 Codex 代替 Reviewer，必须显式设置为 `codex` |
| `AGENTOS_KIMI_MODEL` | `kimi-code/kimi-for-coding` | KimiCode 模型 |
| `AGENTOS_OPENCODE_MODEL` | `deepseek/deepseek-v4-flash` | OpenCode 模型 |
| `AGENTOS_SERVER_HOST` | `127.0.0.1` | Server 监听地址；非 loopback 地址还需要 `AGENTOS_ALLOW_REMOTE=true` |
| `AGENTOS_WEB_ORIGINS` | `http://localhost:3001,http://127.0.0.1:3001` | 浏览器 CORS Origin allowlist，不支持 `*` |
| `AGENTOS_ALLOW_REMOTE` | `false` | 是否显式允许 Server 绑定非 loopback 地址；写请求仍要求 allowlist Origin 或 loopback 直连 |
| `AGENTOS_AGENT_TIMEOUT` | `0`（禁用） | 可选无活动超时（毫秒）；`0`、空值或 `null` 表示无限等待，正数仅在 Agent 持续无 stdout/stderr 输出时终止任务。 |
| `PORT` | `3000` | 后端端口 |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3000` | 前端 API 地址 |

Server 默认只监听 `127.0.0.1`。所有 HTTP 写请求（POST/PATCH/PUT/DELETE）在进入 API 路由前统一经过 Origin/loopback guard；浏览器请求必须来自 `AGENTOS_WEB_ORIGINS`，无 Origin 的 CLI 请求只允许直接来自 loopback。只有明确设置 `AGENTOS_ALLOW_REMOTE=true` 才能启动非 loopback 监听，且不自动启用 Express `trust proxy`。

## 收尾验收

执行计划收尾使用独立生产服务端口，不接管用户正在使用的 3000/3001：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-next-optimization-acceptance.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-agentos-e2e.ps1
```

前一个脚本负责 3100/3101 的构建、健康检查、Workspace API 和页面响应；`verify-codex-runtime-e2e.ps1` 验证确定性 Runtime/Artifact 闭环，`verify-real-codex-runtime-e2e.ps1` 验证真实 Codex AgentOS Gate，`verify-agentos-e2e.ps1` 验证三 Provider 生命周期，`verify-real-worktree-gate.mjs` 验证两个真实写入 Agent 的隔离 Worktree/recovery/cleanup 闭环。
# Isolation and local API safety

Parallel isolated execution is opt-in through `AGENTOS_WORKTREE_MODE=isolated` and only starts from a clean Git workspace. Worktree removal requires a verified recovery bundle and explicit confirmation. The server binds to loopback by default; remote binding requires an explicit `AGENTOS_ALLOW_REMOTE=true` configuration.
