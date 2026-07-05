# Project Brief

AgentOS — 本地多 Agent 调度平台

## Goal
提供一个本地运行的多 Agent 调度平台，管理 Codex、KimiCode、OpenCode 等 CLI Agent 协同开发同一个项目。

## Key Principles
1. Codex 作为 Manager，负责拆任务、调度、总结、最终决策
2. KimiCode 作为 Worker，负责主要代码实现
3. OpenCode 作为 Reviewer / Builder，负责项目初始化、架构实现、代码审查、风险检查
4. 所有 Agent 不共享真实上下文，但共享同一套 Markdown 记忆文件
5. 所有操作必须可追溯
6. 所有代码修改必须经过 Git diff 展示
7. 前端不能直接调用 CLI，必须通过后端调用
8. 后端负责启动 CLI 进程、读取输出、记录日志、管理任务状态
9. 第一版实现 MVP，不追求复杂功能
