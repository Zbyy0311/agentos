# Full-suite receipt — codex/lite-compaction-inspector @ 21e0f7a8 (+ working tree)

Command (server): `node --import tsx --test --test-concurrency=1 "src/**/*.test.ts"`
Raw exit: 1 — tests 2852 / pass 2839 / fail 5 / skipped 8
Log: `server-suite-full.log`

Command (web): `node scripts/run-tests.mjs`
Raw exit: 0 — tests 176 / pass 176 / fail 0 / skipped 0
Log: `web-suite-full.log`

## The five server failures, classified from their own first error line

| Test | First line | Class |
|---|---|---|
| worktree routes keep path private and require clean/confirmed cleanup gates | `ENOTEMPTY, Directory not empty: ...agentos-worktree-route-r7pptr` | Windows teardown flake |
| worktree cleanup requires a terminal Run before recovery confirmation | `ENOTEMPTY, Directory not empty: ...agentos-worktree-route-U7I6t8` | Windows teardown flake |
| parallel_isolated gives write-capable workers execution-specific worktrees and recovery bundles | `ENOTEMPTY, Directory not empty: ...agentos-conversation-service-xPsfbB` | Windows teardown flake |
| [M27-P3-T005] Source preflight runs under acquired-and-released Ownership with zero Backup and zero Attempt | `ENOTEMPTY, Directory not empty: ...agentos-m27-p3-tasks-UNTT94` | Windows teardown flake |
| R47 a held client connection cannot block release on loopback or named pipe ownership | `SERVER_OWNERSHIP_UNAVAILABLE` | Windows ownership/port flake |

None of the five names or failures belongs to the files this slice touches
(`RuntimeInspector*`, `ConversationCompactionInspector`, `conversationRuntime*`,
`ProviderCompactionSummarizer`): the slice's own suites are green (46/46, 24/24, 16/16,
5/5, 9/9 web). The suite was run exactly once and was not retried for green.

