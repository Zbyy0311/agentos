# S8 acceptance log — real product runs

Scope: S8 of the tightened Lite closeout plan. Every entry records a real run
of the repository's own acceptance verifiers against a real server, the raw
result, and the classification of each failure under LITE-00-004 / S0 rules.
First-run failures are preserved; nothing is re-run until it is green.

## Run 1 — `scripts/verify-agentos-e2e.ps1` (first run, pre-fix)

| Field | Value |
|---|---|
| Worktree | `agentos-lite-s8-acceptance` (`codex/lite-s8-acceptance`) |
| Baseline | main `948b8008` (PR #146), full workspace build `pnpm -r run build` green |
| Command | `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-agentos-e2e.ps1` |
| Log | `docs/implementation/lite-closeout/evidence/S8-first-run-e2e.log` |
| Exit | 1 (pre-recovery phase 1, recovery phase 0) |
| Environment | Windows, Node 24.18.0, server on port 3200; `codex`, `kimi`, `opencode` all resolvable |

### Gate results (raw)

```
REAL_DIRECT_CODEX: passed
REAL_DIRECT_KIMI: failed - kimi status=failed; failure=KimiCode CLI 执行失败（退出码 1）
REAL_DIRECT_OPENCODE: passed
REAL_GROUP: failed - expected 'completed', actual 'failed'
REAL_MEMORY_INJECTION: passed
REAL_MEMORY_CANDIDATE: passed
REAL_CLI_FAILURE: passed
REAL_CLI_CANCEL: failed - expected 'cancelled', actual 'running'
REAL_WAITING_USER: passed
REAL_EXTERNAL_AGENT: failed
DETERMINISTIC_LIFECYCLE: passed
RECOVERY: not_run (pre-recovery phase) / passed (recovery phase)
MEMORY_CANDIDATE: passed
```

### Classification

| Gate | Classification | Evidence |
|---|---|---|
| `REAL_DIRECT_CODEX` | PASS (product) | real Codex CLI completed end to end |
| `REAL_DIRECT_OPENCODE` | PASS (product) | real OpenCode CLI completed end to end |
| `REAL_MEMORY_INJECTION`, `REAL_MEMORY_CANDIDATE`, `REAL_CLI_FAILURE`, `REAL_WAITING_USER`, `DETERMINISTIC_LIFECYCLE`, `RECOVERY` | PASS (product) | see log |
| `REAL_DIRECT_KIMI` | ENVIRONMENT, not a product defect | the Kimi CLI exits 1 because the account's weekly quota is exhausted (observed earlier as HTTP 403 on the same account). No AgentOS code path is involved before the CLI exits. |
| `REAL_GROUP` | ENVIRONMENT, downstream of Kimi | a three-agent group run cannot complete while one member's CLI refuses to start; the group assertions are about one shared Run and three executions, which the failing member prevents. |
| `REAL_CLI_CANCEL` | **STALE GATE**, product behavior is the frozen one | see below |
| `REAL_EXTERNAL_AGENT` | aggregate of the above | defined as `failures.length === 0` over the real-provider matrix |

### `REAL_CLI_CANCEL` — stale verification asset, not a regression

The gate disconnected the SSE subscription while the CLI was running and then
required the Run to reach `cancelled`. The repository deliberately stopped
behaving that way in M4-P5E (commit `87c212ad`, "feat: complete M4 P5E
integrated cancellation gate"), which replaced the disconnect abort with:

```ts
res.on('close', () => {
  unsubscribe();
  stopHeartbeat();
  // The initial stream is a transport subscription; disconnecting it must
  // not cancel the owned execution. Explicit cancellation uses the public
  // operation path and its proof-backed Process stop authority.
});
```

This matches the frozen Lite rules that a Run survives browser disconnect
(LITE-00-004) and that cancellation and recovery keep the normative
lifecycle. The gate therefore encoded pre-convergence behavior.

Remediation (`scripts/verify-agentos-e2e.mjs`): the gate now asserts the Run
is **still running** after the transport disconnect, and then cancels through
the public Run cancel path
(`POST /api/workspaces/:workspaceId/conversations/:conversationId/runs/:runId/cancel`,
`apps/server/src/routes/conversations.ts:512`), asserting `cancelled`. The
first-run failure stays recorded above; the corrected gate is re-run in Run 2.

## Notes

- `REAL_EXTERNAL_AGENT` cannot be green while the Kimi weekly quota is
  exhausted, so LITE-04-001 / LITE-04-101 stay open on environment evidence
  rather than being marked PASS or DEFERRED.
- Windows retained the E2E temp root because a file handle was still open; the
  verifier reports this explicitly and it does not affect the gate results.
