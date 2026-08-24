# M4-P5E Integrated Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining M4-P5E integration gap with deterministic evidence that an initial Conversation SSE disconnect is transport-only, while preserving the single Dispatcher → ProcessCancelCoordinator → owned Process tree → StageExecutionCoordinator → Session/LifecycleTransactionService cancellation path.

**Architecture:** Keep `ProcessCancelCoordinator`, `StageExecutionCoordinator`, `finalizeAttemptOnce`, `OperationService`, and `LifecycleTransactionService` as the only cancellation/finalization authorities. Remove only the initial Conversation route's transport-close abort side effect. Add tests at the route boundary and at the composed run-engine/lifecycle boundary so explicit cancellation still reaches the existing coordinator and durable lifecycle transaction, while a disconnected client cannot cancel execution.

**Tech Stack:** TypeScript, Node.js `node:test`, Express, SQLite test store, `tsx`, Vitest, pnpm workspaces.

**Spec:** `docs/implementation/milestones/M4-p5-implementation-plan.md` (P5E historical integrated gate), the existing P5A–P5D implementation, and the M4-P5E user objective. Current Windows production scope is retained; POSIX-only real-OS work and P6 are out of scope.

## Global Constraints

- Work only in the isolated branch `runtime/m4-p5e-integrated-cancellation` at base `673a7d498e15b954a49a281262ea6ec428193d56`.
- Do not touch the primary dirty checkout or the PR61 worktree.
- Do not modify P5B ownership semantics, add a second cancellation path, bypass LifecycleTransactionService, or start P6.
- Production changes are limited to the initial Conversation stream disconnect behavior. Test and plan files may be added or updated only when directly supporting P5E evidence.
- Use TDD: add each new regression test, run it red, then make the smallest production change and run it green.
- Preserve terminal protection, event ordering, optimistic versions, durable output finalization/abort, and exact process ownership evidence.

---

## Task 1: Establish the isolated baseline and acceptance inventory

- [ ] Verify the worktree path, branch, exact base, clean tracked status, and remote topology.
- [ ] Run the focused baseline suites needed for the files under test: Conversation routes, run-engine dispatcher/coordinator, process-runtime, and the Shared M3 harness. Record first-failure evidence without rerunning until-green.
- [ ] Inspect the existing P5A–P5D tests and identify the exact assertions available for process facts, session facts, finalization, LTS transition, terminal protection, and version/event counts.

## Task 2: Add the failing initial Conversation disconnect regression test

- [ ] Extend `apps/server/src/routes/conversations.test.ts` with a deterministic real-runtime fixture using the existing temporary workspace and `process.execPath`, plus a filesystem/child-process barrier so the test does not depend on a sleep.
- [ ] Start an initial `/messages/stream` request, wait until the child has entered the barrier, cancel/abort the HTTP response body to model browser disconnect, release the child, and await the durable run outcome from the store.
- [ ] Assert that the run completes rather than becoming cancelled, that the execution reaches its terminal success state, and that the route's transport disconnect does not create a second execution or message.
- [ ] Run only this test and capture the expected red result against the current route implementation, where `res.close` aborts the request signal.

## Task 3: Apply the minimal transport-only production fix

- [ ] In `apps/server/src/routes/conversations.ts`, remove only the `abortController.abort()` call from the initial message-stream `res.on('close')` handler. Keep the `AbortSignal` passed to `ConversationService` so explicit caller cancellation remains supported.
- [ ] Add a short code comment only if needed to make the transport-only ownership boundary clear; do not alter resume-stream behavior or service cancellation semantics.
- [ ] Rerun the focused disconnect regression and the existing ConversationService explicit-signal-cancellation test; require green evidence for both.

## Task 4: Add deterministic P5E composed cancellation/lifecycle evidence

- [ ] Add or extend the run-engine integration test under `apps/server/src/services/run-engine/` using the real `RunEngineProviderDispatcher`, `StageExecutionCoordinator`, `ProcessCancelCoordinator`, `OperationService`, and `LifecycleTransactionService` composition already present in the repository.
- [ ] Use a controllable child process and explicit cancellation to prove the ordered chain: dispatcher cancellation invokes the existing coordinator; the owned process tree is stopped; process/session evidence is attached; the finalization arbiter settles once; and the canonical Run/Stage/Operation state becomes cancelled through the LTS transaction.
- [ ] Assert that bare or invalid process evidence is rejected, valid non-empty owned-tree evidence is accepted, terminal state is not overwritten, and no duplicate terminal lifecycle event/outbox effect is produced.
- [ ] Keep any installed-Kimi test explicitly environment-gated. If the executable, authentication, or network prerequisite is absent, report `REAL_GATE_BLOCKED` with the exact prerequisite instead of retrying or silently claiming a pass.

## Task 5: Verify regressions and P5E scope

- [ ] Run the targeted route and P5E integration tests once after implementation, then the process-runtime suite because the P5E chain depends on its public coordinator/driver contracts.
- [ ] Run the complete server suite, the Shared M3 harness (`packages/shared/m3-runtime.test.ts`), and the workspace build using the repository's canonical commands.
- [ ] Run `git diff --check`, inspect the final diff and status, confirm no unexpected production files or P5B/P6 changes, and verify the final tree contains only the planned files.
- [ ] Record exact pass/skip/failure counts, real-gate status, and any pre-existing or environment-blocked evidence without rerun-until-green behavior.

## Task 6: Commit and publish the verified implementation branch

- [ ] Before mutation, report the exact changed/unexpected files, scope boundary, base/head topology, and verification evidence.
- [ ] Create one ordinary forward commit on `runtime/m4-p5e-integrated-cancellation`; do not amend, rebase, merge, or create a PR.
- [ ] Push the branch to the configured HTTPS remote, then verify the remote branch resolves to the committed SHA and the local worktree is clean.
- [ ] Report P5D unchanged, P5E implemented and verified to the extent of available gates, and P6 not started.
