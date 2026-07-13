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
