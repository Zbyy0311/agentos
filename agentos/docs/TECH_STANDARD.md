# Technology Standards

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14, React 18, TypeScript, Tailwind CSS |
| Backend | Node.js, Express, TypeScript |
| Agent Core | Node.js, child_process.spawn |
| Data | Markdown + JSON files |
| Package Manager | pnpm |
| Monorepo | pnpm workspace |

## Directory Structure

```
agentos/
├── apps/
│   ├── web/              # Next.js frontend
│   └── server/           # Express API server
├── packages/
│   ├── shared/           # Shared TypeScript types
│   └── agent-core/       # Agent runner logic
├── agent-memory/         # Agent shared memory (Markdown)
├── docs/                 # Standard documents
├── workspace/            # Demo project workspace
├── logs/                 # Per-task logs
└── package.json          # Root workspace
```

## API Specification

### Task Management

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/tasks | Create a new task |
| POST | /api/tasks/:taskId/run | Execute agent pipeline (SSE stream) |
| GET | /api/tasks/:taskId/logs | Get task logs |
| GET | /api/tasks/:taskId/diff | Get git diff |
| GET | /api/tasks/:taskId/status | Get task status and logs |

### SSE Events

Pipeline execution streams events:

- `event: status` — task-level status change
- `event: stage` — per-agent stage progress
- `event: done` — pipeline complete

## Agent Runner Specification

Each agent function must:

1. Read agent-memory/*.md for context
2. Build a structured prompt
3. Call the agent's CLI via child_process.spawn
4. Capture stdout and stderr
5. Log results to AGENT_LOG.md
6. Write per-task log file
7. Return structured TaskLog

## Logging Specification

```
logs/{taskId}/
  codex_manager.log
  kimi_worker.log
  opencode_reviewer.log
  codex_final_review.log
```

Each log contains: timestamp, duration, exit code, stdout, stderr.

## Git Diff Specification

- All diffs are run against workspace/demo-project/
- Use `git diff` to show unstaged changes
- Display results in the frontend diff panel
