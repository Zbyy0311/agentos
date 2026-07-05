# Architecture Decisions

| Date | Decision | Rationale | Alternatives |
|------|----------|-----------|-------------|
| 2026-06-27 | Use pnpm workspace monorepo | Unified dep management, local package linking | npm workspaces, turborepo |
| 2026-06-27 | Use Markdown + JSON for data storage | Simpler than DB for MVP, easy to inspect | SQLite, PostgreSQL |
| 2026-06-27 | Use SSE instead of WebSocket | Simpler protocol, HTTP-native streaming | WebSocket |
| 2026-06-27 | Mock CLIs for first version | Allows testing without real Agent installations | Skip testing, real CLIs only |
| 2026-06-27 | child_process.spawn for CLI calls | Standard Node.js, no extra deps | execa, node-pty |
