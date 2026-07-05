# AgentOS

本地多 Agent 调度平台，管理 Codex、KimiCode、OpenCode 等 CLI Agent 协同开发同一项目。

## 系统要求

- Node.js >= 18
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
./start-dev.ps1
```

或通过环境变量指定路径：

```powershell
$env:AGENTOS_CODEX_CLI = "C:\path\to\codex.cmd"
$env:AGENTOS_OPENCODE_CLI = "C:\path\to\opencode.exe"
./start-dev.ps1
```

> 注意：真实 Agent 模式下如果找不到 CLI 或 Agent 执行失败，任务会标记为 **failed**，不会静默降级到 Mock。Mock 输出只在 `AGENTOS_FORCE_MOCK=true` 时出现。

## 运行流程

1. 在首页创建或导入一个 **Workspace**（指向一个本地项目目录）
2. 在工作区中创建 **Task**（输入任务描述）
3. 点击 **Run** 启动 4 阶段流水线：

```
Codex (Manager) → KimiCode (Worker) → OpenCode (Reviewer) → Codex (Final Review)
```

4. 流水线运行中可通过 **Cancel** 按钮中止（会杀掉后端正在执行的 Agent 进程）
5. 每个阶段的输出会持久化保存，刷新页面后仍然可见

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
| `AGENTOS_OPENCODE_CLI` | `opencode` | OpenCode 命令路径或名称 |
| `AGENTOS_KIMI_MODEL` | `kimi-for-coding/k2p7` | KimiCode 模型 |
| `AGENTOS_OPENCODE_MODEL` | `deepseek/deepseek-v4-flash` | OpenCode 模型 |
| `AGENTOS_AGENT_TIMEOUT` | `300000` (5 分钟) | 每个 Agent 超时时间（毫秒） |
| `PORT` | `3000` | 后端端口 |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3000` | 前端 API 地址 |
