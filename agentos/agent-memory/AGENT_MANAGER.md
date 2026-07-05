# Agent Manager Config

## Agents
| Name | Role | CLI Command | CLI Args | Model | Status |
|------|------|-------------|----------|-------|--------|
| Codex | Manager | `echo` | `[]` | - | mock |
| KimiCode | Worker | `echo` | `[]` | - | mock |
| OpenCode | Reviewer | `echo` | `[]` | - | mock |

## Pipeline
1. `codex_manager` — Codex Manager: 任务分解与决策
2. `kimi_worker` — KimiCode Worker: 代码实现
3. `opencode_reviewer` — OpenCode Reviewer: 代码审查
4. `codex_final_review` — Codex Final Review: 最终决策

## Switching from Mock to Real CLI
Real agent CLI configuration lives in `packages/agent-core/src/config.ts` and can be overridden with environment variables:

```typescript
AGENTOS_CODEX_CLI=codex.cmd
AGENTOS_OPENCODE_CLI=opencode.exe
AGENTOS_KIMI_MODEL=kimi-for-coding/k2p7
AGENTOS_OPENCODE_MODEL=deepseek/deepseek-v4-flash
```
