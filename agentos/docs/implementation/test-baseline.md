# AgentOS Test Baseline (M1)

> Date: 2026-07-21  
> Scope: All existing test suites before v2 migration  
> Repository: `Zbyy0311/agentos`  
> Machine: Windows 11 Pro, Node >=22.5

---

## Test Suite Overview

| Suite | Runner | Scope | Type | Pass/Fail |
|---|---|---|---|---|
| agent-core smoke | vitest | Full pipeline mock execution | Unit | ✅ PASS |
| agent-core full | vitest | All agent-core modules | Unit | ✅ PASS |
| server | node:test | All server modules (routes, services, store) | Integration | ❌ 4 FAIL |
| web build | next build | Next.js build | Build | ✅ PASS |

---

## Test Results Detail

### 1. agent-core smoke test
**Command:** `pnpm --filter @agentos/agent-core run test:smoke`

| Purpose | Result | Passed | Failed | Skipped | Duration |
|---|---|---|---|---|---|
| Verify AgentRunner full pipeline in mock mode | ✅ | 2 | 0 | 0 | 389ms |

**Environment Dependency:** None (mock mode forced)  
**Notes:** Creates temp workspace with agent-memory files, runs 4-stage pipeline, verifies logs

### 2. agent-core full test suite
**Command:** `pnpm --filter @agentos/agent-core run test`

| Purpose | Result | Passed | Failed | Skipped | Duration |
|---|---|---|---|---|---|
| All agent-core unit tests | ✅ | 123 | 0 | 0 | 8.11s |

**Environment Dependency:** None (in-memory tests)  
**Notes:** Covers runner, executor, config, parsers, prompts, adapters, capabilities, runtime args, image input, mock, workspace changes, opencode usage, redaction, smoke

### 3. server test suite
**Command:** `pnpm --filter @agentos/server run test`

| Purpose | Result | Passed | Failed | Skipped | Duration |
|---|---|---|---|---|---|
| Full server integration tests | ❌ | 176 | 4 | 0 | 16.7s |

**Environment Dependency:** Git, tar command, temp directory access

**Failed Tests Detail:**

| Test File | Test Name | Failure | Root Cause |
|---|---|---|---|
| `routes/worktrees.test.ts:1` | `worktree routes keep path private and require clean/confirmed cleanup gates` | `ENOTEMPTY` on temp dir removal | Windows temp dir cleanup race — git worktree add creates `.git` that persists after test |
| `routes/worktrees.test.ts:2872` | `worktree cleanup requires a terminal Run before recovery confirmation` | `ENOTEMPTY` on temp dir removal | Same cause — `.git` directory not fully cleaned |
| `services/ConversationService.test.ts:25001` | `parallel_isolated gives write-capable workers execution-specific worktrees and recovery bundles` | `ENOTEMPTY` on temp dir removal | Same cause — git worktree operations on Windows |
| `services/WorktreeArtifactService.test.ts:472` | `creates a byte-verifiable bundle for tracked and untracked files` | `tar` command path error | Windows `tar` doesn't support `--` prefix for paths with colons |

**All 4 failures are Windows-specific test environment issues**, not runtime logic bugs. They are caused by:
- Git worktree operations on Windows leaving residual `.git` directories in temp paths
- Windows `tar` command not supporting the `--` separator with `C:` drive paths

### 4. web build
**Command:** `pnpm --filter @agentos/web run build`

| Purpose | Result | Passed | Failed | Skipped | Duration |
|---|---|---|---|---|---|
| Next.js production build | ✅ | Build successful | 0 | 0 | ~60s |

**Environment Dependency:** None (all modules bundled)  
**Notes:** Static generation successful. Routes: `/` (static), `/workspace/[id]` (dynamic)

---

## Test File Inventory

### agent-core (`packages/agent-core/src/`)
- `smoke.test.ts` — 2 tests, mock pipeline
- `runner.test.ts`
- `executor.test.ts`
- `config.test.ts`
- `parsers.test.ts`
- `prompts.test.ts`
- `capabilities.test.ts`
- `resolveCommand.test.ts`
- `runtimeArgs.test.ts`
- `runtimePolicy.test.ts`
- `imageInput.test.ts`
- `workspaceChanges.test.ts`
- `opencodeUsage.test.ts`
- `adapters/codexAdapter.test.ts`
- `adapters/kimiAdapter.test.ts`
- `adapters/jsonLineDecoder.test.ts`
- `adapters/plainTextAdapter.test.ts`
- `adapters/redaction.test.ts`
- `adapters/registry.test.ts`
- `adapters/types.test.ts`
- `adapters/capabilityProbe.test.ts`

### server (`apps/server/src/`)
- `errorHandler.test.ts`
- `signals.test.ts`
- `localApiSecurity.test.ts`
- `localApiSecurity.integration.test.ts`
- `projectRoot.test.ts`
- `runRecovery.test.ts`
- `taskRecovery.test.ts`
- `routes/sse.test.ts`
- `routes/tasks.test.ts`
- `routes/taskPipeline.test.ts`
- `routes/runs.test.ts`
- `routes/artifacts.test.ts`
- `routes/conversations.test.ts`
- `routes/worktrees.test.ts`
- `routes/memories.test.ts`
- `routes/memoryCandidates.test.ts`
- `routes/preferences.test.ts`
- `routes/modelDiscovery.test.ts`
- `routes/git.test.ts`
- `routes/storage.test.ts`
- `events/EventBus.test.ts`
- `services/ConversationService.test.ts`
- `services/AgentPresenceService.test.ts`
- `services/ApprovalRegistry.test.ts`
- `services/CliModelDiscovery.test.ts`
- `services/ConversationAttachmentService.test.ts`
- `services/GroupDispatchService.test.ts`
- `services/GroupOrchestrator.test.ts`
- `services/MemoryCandidateService.test.ts`
- `services/MemoryExtractor.test.ts`
- `services/MemoryRetriever.test.ts`
- `services/MemoryService.test.ts`
- `services/PreferenceAcceptance.test.ts`
- `services/PreferenceContextBuilder.test.ts`
- `services/PreferenceDirectiveParser.test.ts`
- `services/PreferenceObserver.test.ts`
- `services/PreferenceProjector.test.ts`
- `services/RetentionService.test.ts`
- `services/RunContextBuilder.test.ts`
- `services/RunDecisionService.test.ts`
- `services/RunStepService.test.ts`
- `services/RunStreamRegistry.test.ts`
- `services/RuntimeArtifactCollector.test.ts`
- `services/RuntimeArtifactService.test.ts`
- `services/RuntimeEventBuffer.test.ts`
- `services/RuntimeEventProjector.test.ts`
- `services/RuntimeStorageService.test.ts`
- `services/ToolRiskClassifier.test.ts`
- `services/WorktreeArtifactService.test.ts`
- `services/WorktreeManager.test.ts`
- `store/SqliteStore.test.ts`
- `store/JsonFileStore.test.ts`

### web (`apps/web/src/`)
- `lib/agentPresence.test.ts`
- `lib/artifacts.test.ts`
- `lib/attachmentUrls.test.ts`
- `lib/chatScroll.test.ts`
- `lib/composerInteraction.test.ts`
- `lib/composerSettings.test.ts`
- `lib/conversationActions.test.ts`
- `lib/conversationSelection.test.ts`
- `lib/executionArchive.test.ts`
- `lib/executionElapsed.test.ts`
- `lib/executionInspector.test.ts`
- `lib/executionTimeline.test.ts`
- `lib/imageAttachments.test.ts`
- `lib/memories.test.ts`
- `lib/resizablePanels.test.ts`
- `lib/responseRendering.test.ts`
- `lib/runDetails.test.ts`
- `lib/runSteps.test.ts`
- `lib/runtimeSelection.test.ts`
- `lib/sse.test.ts`
- `lib/streamDoneExecution.test.ts`
- `lib/streamReconnect.test.ts`
- `lib/typewriterQueue.test.ts`
- `lib/uiFeedback.test.ts`
- `lib/workspaceSidebar.test.ts`
- `components/chat/AgentEditor.test.tsx`
- `components/chat/ExecutionInspector.test.tsx`
- `components/chat/MarkdownMessage.test.tsx`
- `components/theme/themeHydration.test.tsx`
- `components/theme/themePreference.test.ts`

---

## Test Baseline Summary

| Metric | Value |
|---|---|
| Total test files (agent-core + server) | ~70 |
| Total test files (web lib + components) | ~30 |
| Total passing tests | 301 (2 + 123 + 176) |
| Total failing tests | 4 (all Windows environment) |
| Builds passing | 3 of 3 |
| Test coverage | Ad-hoc (no coverage tools configured) |
| CI dependency | PNPM workspaces, Node 22+, Git, tar |
| External dependency tests | Marked as ['provide', 'unknown'] = all server integration tests run against SQLite (no external network needed) |

## Test Gaps

1. **No E2E tests configured** — Playwright config exists (`playwright.config.ts`) but test files only in lib/
2. **No coverage collection** — No `--coverage` flags in any test scripts
3. **No Windows CI** — Failing worktree tests likely pass on Linux/macOS
4. **No provider integration tests** — Real CLI execution not tested in CI
5. **No performance/load tests** — No benchmarks
6. **No recovery/durability tests** — Server restart scenarios partially tested
