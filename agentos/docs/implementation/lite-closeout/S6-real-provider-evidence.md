# S6 real Provider execution evidence

Scope: LITE-09-104/105/106/107/108/110 and LITE-07-105. Every claim below is
backed by a run against the real Codex CLI on this machine, or by the named
test file. No mock drives a PASS claim in this document.

## Production wiring added in this slice

| File | Role |
|---|---|
| `apps/server/src/services/summarizationCliProfiles.ts` | the code-level allowlist of CLIs allowed to summarize, plus the frozen identity helper |
| `apps/server/src/services/ProviderCompactionSummarizer.ts` | the summary execution channel; runs through agent-core `CLIExecutor` in an isolated scratch directory |
| `apps/server/src/services/ConversationCompactionTrigger.ts` | the automatic trigger evaluated before a Turn assembles its context |
| `apps/server/src/services/ConversationTurnDriver.ts` | before-assembly trigger hook, plus the existing hard-budget gate |
| `apps/server/src/routes/conversationRuntime.ts` | composition: one engine, one summarizer, one trigger per runtime router |
| `scripts/verify-compaction-real-summary.mjs` | the real-provider verification described below |

## Why the summary path is the CLI path

A Conversation Turn does not execute through the RunEngine provider registry;
it drives the Agent's CLI through agent-core `CLIExecutor`
(`packages/agent-core/src/conversationRunner.ts`). The summarizer therefore uses
the same channel, so the compaction run cannot drift from how the Conversation
actually executes.

## Read-only enforcement is CLI-level, not prompt-level

`resolveAgentRuntimeConfig` receives only an `AgentConfig`, so the
`RuntimePolicy` carried by `ConversationAgentRunner` never reaches
`CLIExecutor` and the `--sandbox read-only` flag is never added automatically.
Within CLIExecutor, `workspaceRoot` only sets the child's working directory.
Because a prompt is not an enforcement boundary, read-only proof was moved into
the allowlist itself: the Codex profile declares
`['exec', '--sandbox', 'read-only', '--skip-git-repo-check']`, and
`ProviderCompactionSummarizer` refuses any profile that does not declare the
`--sandbox read-only` pair.

Two CLI facts were established by direct runs rather than assumption:

- the summary runs in an isolated scratch directory, so `codex exec` needs
  `--skip-git-repo-check` (without it the CLI exits 2: "Not inside a trusted
  directory");
- `--skip-git-repo-check` is scoped to the `exec` subcommand, so `exec` must
  come first. With the flag placed before `exec` the CLI exits 2 with
  "unexpected argument '--skip-git-repo-check' found".

## Run — `scripts/verify-compaction-real-summary.mjs`

```
cwd:      apps/server
command:  node --import tsx ../../scripts/verify-compaction-real-summary.mjs
result:   REAL_COMPACTION_SUMMARY: passed
  model=gpt-5.6-luna adapter=cli.codex@1.0.0 firstRunMs=15124 repeatMs=1
  summaryChars=209 sourceMessages=4 policy=lite-v1
  summaryHead="The entire exchange repeatedly states one invariant: “The runtime keeps Tasks, Runs and Processes distinct.” …"
```

Asserted in that run:

| Assertion | Requirement |
|---|---|
| the trigger derives a frozen identity `codex` / `cli.codex@1.0.0` / model `gpt-5.6-luna` | LITE-09-106 |
| the allowlist declares `--sandbox read-only` and `--skip-git-repo-check` | LITE-09-106 |
| a real Provider produced a non-empty summary inside `summaryMaxTokens` | LITE-09-106 |
| the durable task records adapter id, version and model | LITE-09-106 |
| the task publishes from a bounded prefix (4 of 12 messages) and the recent window is retained | LITE-09-105 |
| the run is evaluated against the immutable `lite-v1` policy row | LITE-09-104 |
| publishing records a `review-required`, `agent-derived` Candidate on the task | LITE-07-105 |
| the canonical Workspace Event is `memory.candidate_created` with `correlation_id=memory-compaction:<taskId>` and `causation_id=<taskId>` | LITE-07-105, LITE-07-108 |
| a repeat over the same source converges on the published row in 1 ms with exactly one durable task | LITE-09-107 |

## Failure semantics exercised locally

| Behavior | Evidence |
|---|---|
| missing summarizer profile fails closed | `ProviderCompactionSummarizer.test.ts`, `ConversationCompactionTrigger.test.ts` |
| adapter identity mismatch fails closed | `ProviderCompactionSummarizer.test.ts` |
| empty frozen model fails closed | `ProviderCompactionSummarizer.test.ts` |
| profile without CLI-level read-only fails closed | `ProviderCompactionSummarizer.test.ts` |
| the first `tool.*` or `approval.requested` event aborts the run | `ProviderCompactionSummarizer.test.ts` |
| hard timeout aborts the run | `ProviderCompactionSummarizer.test.ts` |
| non-zero exit keeps the exit code in the classified failure | `ProviderCompactionSummarizer.test.ts` |
| one running compaction per Conversation, version CAS, bounded retry, stable failure | `CompactionRepository.test.ts`, `lite-migration-029.test.ts` |
| summary + tail over the hard budget blocks the Provider call and preserves messages | `CompactionContextApplication.test.ts` |

## Defect found by this slice

The read-only guarantee for a compaction run was prompt-level only until this
slice: an allowlisted profile with no `--sandbox read-only` pair would have
started a writable CLI. The summarizer now refuses such a profile, and the
allowlist declares the sandbox pair explicitly.

+## Automatic trigger, adoption and Inspector (real HTTP turn path)

`apps/server/src/routes/conversationRuntime.compaction.test.ts` drives the real
runtime router (`createConversationRuntimeRoutes`) with one direct Codex
Conversation: ten long Messages seeded through the real message endpoint, then
one real `POST .../messages/stream` turn. The Provider call itself is the
deterministic mock, so the test proves wiring and application, not Provider
behaviour; the real Provider behaviour is the run above.

Result: 1 test, 1 passed. Asserted:

| Assertion | Requirement |
|---|---|
| exactly one compaction task exists and it is `published` with a durable summary | LITE-07-105 |
| the task carries its review Candidate | LITE-07-105 |
| only a bounded old prefix is compressed (`0 < sourceMessageCount < seeded`) | LITE-09-105 |
| the adopted summary id in the Turn's frozen snapshot equals the published task | LITE-09-105, LITE-13-101 |
| the covered Messages are absent from the frozen history while the newest seeded Message stays in the tail | LITE-09-105 |
| no original Message was deleted | LITE-09-105 |
| the Inspector names the adopting `turnId` and `snapshotId`, and that snapshot is the Turn's own `context_snapshot_id` | LITE-13-101 |
| the Inspector explains the policy (`lite-v1`, 0.7 / 0.5 / 8) and the budget source (`lite-v1-fallback`) | LITE-09-104, LITE-13-101 |
| a second Turn converges: exactly one task after the repeat | LITE-09-107 |

### Defect found by this test

The trigger originally evaluated the threshold over the RAW transcript. Because
the raw history keeps growing, every following Turn produced a new bounded
prefix, a new source hash and therefore a new compaction task, each chaining the
previous summary. The trigger now evaluates the EFFECTIVE context: Messages an
already-published summary covers are excluded, only the uncompressed tail is
considered, and the previous summary is chained into the next one. If the
published summary's end anchor can no longer be located, the previous summary is
not reused as a prefix and the attempt recomputes from the full transcript
(LITE-09-109) instead of compressing a range whose boundary cannot be proven.

### Inspector adoption surface

`GET /conversations/:conversationId/compactions` gained a read-only `adoptions`
list derived from the durable `cr_turn_context_snapshots` rows: each entry names
`summaryId`, the adopting `turnId` and the `snapshotId`. A published summary that
no Turn adopted is reported as unadopted (`conversationCompactionInspector.test.ts`).
