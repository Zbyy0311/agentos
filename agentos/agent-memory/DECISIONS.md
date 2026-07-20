# Architecture Decisions

| Date | Decision | Rationale | Alternatives |
|------|----------|-----------|-------------|
| 2026-06-27 | Use pnpm workspace monorepo | Unified dep management, local package linking | npm workspaces, turborepo |
| 2026-06-27 | Use Markdown + JSON for data storage | Simpler than DB for MVP, easy to inspect | SQLite, PostgreSQL |
| 2026-06-27 | Use SSE instead of WebSocket | Simpler protocol, HTTP-native streaming | WebSocket |
| 2026-06-27 | Mock CLIs for first version | Allows testing without real Agent installations | Skip testing, real CLIs only |
| 2026-06-27 | child_process.spawn for CLI calls | Standard Node.js, no extra deps | execa, node-pty |
| 2026-07-12 | AgentOS v2 uses SQLite for chat collaboration state | Local relational history, group membership, execution events, and workspace isolation | Continue JSON-only storage |
| 2026-07-12 | Group collaboration is leader-mediated | Avoid duplicate work: leader plans, members execute sequentially, leader summarizes | Broadcast every message to all agents |
| 2026-07-13 | Chat session management uses a custom context menu with transactional deletion | Keeps the existing dark UI consistent, supports rename/copy/delete for groups and direct sessions, and prevents orphaned SQLite records | Native browser menu, action-only overflow button |
| 2026-07-14 | Keep project memory on Markdown + SQLite metadata, use FTS5 with bounded deterministic fallback, and require explicit candidate approval | Preserves inspectable files and existing migrations while preventing unapproved or hidden model output from entering prompts | Vector database, automatic permanent writes, background model extraction |
| 2026-07-14 | Record only observable execution evidence | Run details need reproducible status, CLI timing, and file changes without persisting secrets, raw CLI output, or private chain-of-thought | Full transcript capture, raw process log persistence |
| 2026-07-14 | Persist task logs as metadata-only diagnostics | Prompt and CLI output can contain secrets; durable logs retain safe labels, counts, exit codes, timings, and public AgentOS terminal messages only | Persist raw args, Prompt, stdout, or stderr |

## 2026-07-14 收尾决策

- 关键事件持久化失败必须显式使业务结果失败；不能为了返回成功而吞掉 EventBus subscriber 错误。
- 验收服务使用 3100/3101 和临时项目根目录，开发服务不得与生产构建共享 `.next` 生命周期。
- 记忆候选优先从公开执行证据确定性提取；接受前不进入 FTS 或 Prompt，接受后保留 `sourceRunIds`。
- 单聊 `waiting_user` 使用同一 Run 下的新 Execution 恢复；群聊等待标记明确失败。
- 真实外部 Agent gate 与确定性 fixture gate 分开报告；fixture 通过不能替代 Codex/Kimi/OpenCode release gate。
