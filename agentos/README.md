# AgentOS

本地多 Agent 调度平台，管理 Codex、KimiCode、OpenCode 等 CLI Agent 协同开发同一项目。

## 快速启动

```bash
pnpm install
pnpm dev
```

## 项目结构

```
agentos/
├── apps/
│   ├── web/          # Next.js 前端
│   └── server/       # Node.js 后端
├── packages/
│   ├── shared/       # 共享类型
│   └── agent-core/   # Agent Runner
├── agent-memory/     # Agent 共享记忆
├── docs/             # 标准文档
└── workspace/        # demo 项目
```
