# Adaptive User Preference Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 AgentOS 项目记忆之外，增加一套按场景学习用户交互与工作方式的双层、可解释、可回滚的个人偏好记忆闭环。

**Architecture:** 使用同一个 `.agentos/agentos.sqlite` 保存全局用户偏好、Workspace 偏好、证据、投影和 Run 应用记录；项目知识仍由现有 Markdown + FTS5 + 候选审核链路负责。偏好链路分为确定性观察、证据账本、确定性投影、场景解析、上下文注入和运行后学习，所有偏好失败都降级为空上下文而不阻塞 Run。

**Tech Stack:** Node.js >= 22.5, TypeScript, Express, `node:sqlite`, Next.js 14, React 18, Vitest, PowerShell.

## Global Constraints

- 保持现有 monorepo、SQLite、事件总线、SSE 和 Agent 适配器；不引入 Redis、Kafka、向量数据库、知识图谱、新模型 SDK、账户系统或云同步。
- 项目知识记忆继续按 Workspace 隔离、Markdown 持久化、FTS5 检索、候选审核和 `MemoryUsage` 记录。
- 个人偏好只能描述交互和工作方式，不能携带项目代码、客户名称、业务事实、私有思维链、隐藏 Prompt、密钥、Authorization 头或环境变量。
- `当前用户明确要求 > 系统安全规则 > Workspace 配置 > 已学习偏好`。
- 偏好生命周期固定为 `observed -> provisional -> stable -> dormant`；`observed`/`dormant` 不注入。
- 场景固定为 `coding`、`debugging`、`planning`、`review`、`explanation`、`general`；第一阶段不允许动态创建新维度。
- 晋升阈值固定：`provisional` 至少 2 个独立 Run 且总分 >= 6；`stable` 至少 4 个独立 Run、总分 >= 12 且最近 4 个相关 Run 无 `-4` 强冲突；总分 < 0 或最近 3 个 Run 中至少 2 个有 `-3/-4` 负证据则 `dormant`。
- 置信度固定为 `clamp(0, 100, round(50 + score * 3))`；成功无返工的 `+1` 每个投影最多累计 3 分；第一阶段不做纯时间衰减。
- 每个任务必须先写失败测试、确认失败原因，再写最小实现；每个任务结束运行任务级测试和相关回归测试并提交。

---

## Task 1: 共享类型与 SQLite 增量迁移

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`

**Interfaces:**

- Produces `PreferenceScope`, `PreferenceContextKind`, `PreferenceDimension`, `PreferenceProjectionStatus`, `PreferenceSignalType`, `PreferenceEvidence`, `PreferenceProjection`, `PreferenceApplication`, and `PreferenceContext` shared types.
- Produces Store methods: `getDefaultUserProfile()`, `getPreferenceEvidence()`, `listPreferenceEvidence()`, `createPreferenceEvidence()`, `listPreferenceProjections()`, `upsertPreferenceProjection()`, `createPreferenceApplication()`, `listPreferenceApplications()`, `setPreferenceLearningEnabled()`, `clearPreferenceProjections()`, and `sleepPreferenceProjection()`.

- [ ] **Step 1: Write the failing persistence test**

Add a test in `apps/server/src/store/SqliteStore.test.ts` that opens a fresh store, creates two Workspace runs, inserts global and Workspace evidence, upserts a projection, records an application, closes/reopens the store, and asserts all rows survive. Assert Workspace A cannot read Workspace B's local projection and clearing projections leaves evidence rows intact.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```powershell
pnpm --filter @agentos/server test -- SqliteStore.test.ts
```

Expected: FAIL because the preference types and Store methods/tables do not exist.

- [ ] **Step 3: Add shared enums and SQLite tables**

Add the constrained unions and interfaces to `packages/shared/src/types/index.ts`. In `SqliteStore.initializeSchema()`, add additive `CREATE TABLE IF NOT EXISTS` statements for `user_profiles`, `preference_evidence`, `preference_projections`, `preference_projection_evidence`, and `preference_applications`, plus indexes and foreign-key-safe workspace/profile filters. Use `INSERT OR IGNORE` for the single default profile so reopening does not duplicate it.

- [ ] **Step 4: Implement the minimal Store methods**

Implement normalized row mapping and workspace/profile scoping in `SqliteStore.ts`. Enforce evidence uniqueness on `(profile_id, source_event_id, dimension, context_kind, candidate_value, signal_type, polarity)`, validate enum values before SQL writes, and make clear/sleep operations transactional. Preserve evidence when projections are cleared.

- [ ] **Step 5: Run the focused test and migration regression**

Run:

```powershell
pnpm --filter @agentos/server test -- SqliteStore.test.ts
pnpm --filter @agentos/server test -- MemoryService.test.ts MemoryRetriever.test.ts
```

Expected: the new persistence test and all existing memory tests pass.

- [ ] **Step 6: Commit**

```powershell
git add packages/shared/src/types/index.ts apps/server/src/store/SqliteStore.ts apps/server/src/store/SqliteStore.test.ts
git commit -m "feat: add preference memory persistence"
```

**Acceptance:** A fresh database and an existing database both initialize successfully; evidence, projections and applications survive restart; local projections remain Workspace-scoped; clearing projections never deletes evidence; existing memory tests remain green.

## Task 2: Evidence validation与确定性投影器

**Files:**

- Create: `apps/server/src/services/PreferenceRules.ts`
- Create: `apps/server/src/services/PreferenceProjector.ts`
- Create: `apps/server/src/services/PreferenceProjector.test.ts`
- Modify: `packages/shared/src/types/index.ts` to add any missing constrained preference value unions

**Interfaces:**

- `PreferenceRules.ts` exports `PREFERENCE_DIMENSIONS`, `PREFERENCE_CONTEXTS`, `PREFERENCE_VALUES`, `EVIDENCE_WEIGHTS`, `PROMOTION_THRESHOLDS`, `normalizePreferenceEvidence()`, and `calculatePreferenceProjection()`.
- `calculatePreferenceProjection(evidence: PreferenceEvidence[], scope: PreferenceScope, workspaceId?: string): PreferenceProjection | undefined` is pure and deterministic.

- [ ] **Step 1: Write failing projector tests**

Cover these independent behaviors:

```ts
test('keeps the first evidence observed without injecting it', () => {
  const projection = calculatePreferenceProjection([evidence('+4', 'run-1')], 'workspace', 'ws-a');
  assert.equal(projection?.status, 'observed');
});

test('promotes after two runs and score six', () => {
  const projection = calculatePreferenceProjection([
    evidence('+4', 'run-1'), evidence('+3', 'run-2'),
  ], 'workspace', 'ws-a');
  assert.equal(projection?.status, 'provisional');
});

test('keeps opposite preferences in separate contexts', () => {
  const coding = calculatePreferenceProjection(codingEvidence, 'workspace', 'ws-a');
  const planning = calculatePreferenceProjection(planningEvidence, 'workspace', 'ws-a');
  assert.equal(coding?.preferredValue, 'direct_execution');
  assert.equal(planning?.preferredValue, 'plan_first');
});

test('deactivates after repeated negative evidence', () => {
  const projection = calculatePreferenceProjection(negativeEvidence, 'workspace', 'ws-a');
  assert.equal(projection?.status, 'dormant');
});
```

- [ ] **Step 2: Run projector tests and confirm they fail for missing exports**

```powershell
pnpm --filter @agentos/server test -- PreferenceProjector.test.ts
```

Expected: FAIL with missing module/export errors.

- [ ] **Step 3: Implement validation and projection calculation**

Normalize summaries to a bounded length, reject unknown dimensions/contexts/values and missing source IDs, clamp weights to the allowed range, deduplicate by the Store fingerprint, aggregate by candidate value, apply the capped success score, count distinct Run IDs, and calculate the fixed confidence formula. Require the global scope eligibility rule before returning a global projection.

- [ ] **Step 4: Run projector tests and refactor only while green**

```powershell
pnpm --filter @agentos/server test -- PreferenceProjector.test.ts
```

Expected: all projector tests PASS with no production warnings.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/services/PreferenceRules.ts apps/server/src/services/PreferenceProjector.ts apps/server/src/services/PreferenceProjector.test.ts packages/shared/src/types/index.ts
git commit -m "feat: add preference projection rules"
```

**Acceptance:** Projection behavior is pure, deterministic and fully covered for observed/provisional/stable/dormant states, capped success scores, cross-context coexistence, global eligibility and negative downgrade.

## Task 3: 场景解析、偏好解析与上下文注入

**Files:**

- Create: `apps/server/src/services/PreferenceContextClassifier.ts`
- Create: `apps/server/src/services/PreferenceResolver.ts`
- Create: `apps/server/src/services/PreferenceContextBuilder.ts`
- Create: `apps/server/src/services/PreferenceContextBuilder.test.ts`

**Interfaces:**

- `classifyPreferenceContext(input: { objective: string; conversationType?: ConversationType; hasFileChanges?: boolean }): PreferenceContextKind`
- `resolvePreferenceProjections(input: { projections: PreferenceProjection[]; workspaceId: string; contextKind: PreferenceContextKind }): ResolvedPreference[]`
- `buildPreferenceContext(input: { projections: PreferenceProjection[]; workspaceId: string; objective: string; conversationType?: ConversationType }): PreferenceContext`

- [ ] **Step 1: Write failing classifier/resolver/context tests**

Assert coding/debugging/planning/review/explanation detection, `general` fallback, Workspace-context precedence, close-confidence conflict suppression, provisional/stable filtering, and the 800-character budget. Assert the generated text begins with the fixed historical-default warning.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
pnpm --filter @agentos/server test -- PreferenceContextBuilder.test.ts
```

Expected: FAIL because the classifier, resolver and builder do not exist.

- [ ] **Step 3: Implement minimal deterministic behavior**

Use bounded keyword/metadata rules for the first classifier and return `general` when uncertain. Resolve in this order: Workspace scene, global scene, Workspace general, global general. When opposite values at the same priority differ by less than 10 confidence points, omit that dimension. Render only resolved dimension/value pairs, mark provisional values as suggestions, and truncate by whole sections under 800 characters.

- [ ] **Step 4: Run focused and existing context tests**

```powershell
pnpm --filter @agentos/server test -- PreferenceContextBuilder.test.ts RunContextBuilder.test.ts
```

Expected: all new and existing context tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/services/PreferenceContextClassifier.ts apps/server/src/services/PreferenceResolver.ts apps/server/src/services/PreferenceContextBuilder.ts apps/server/src/services/PreferenceContextBuilder.test.ts
git commit -m "feat: resolve contextual user preferences"
```

**Acceptance:** The same user can have contradictory coding/planning defaults; only the current context is selected; uncertain conflicts are omitted; injected preference text is bounded, labeled as historical defaults and never overrides the current request.

## Task 4: 证据观察与投影编排

**Files:**

- Create: `apps/server/src/services/PreferenceObserver.ts`
- Create: `apps/server/src/services/PreferenceService.ts`
- Create: `apps/server/src/services/PreferenceObserver.test.ts`
- Modify: `apps/server/src/store/SqliteStore.ts` only for missing query helpers

**Interfaces:**

- `PreferenceObserver.observeRun(input: ObserveRunInput): PreferenceEvidence[]`
- `PreferenceService.recordRunEvidence(input: ObserveRunInput): Promise<PreferenceProjection[]>`
- `PreferenceService.resolveForRun(input: ResolvePreferenceInput): Promise<PreferenceContext>`
- `PreferenceService.recordApplications(runId: string, applications: PreferenceApplication[]): void`
- `PreferenceService.pauseLearning(profileId: string): void`, `clearLearning(profileId: string): void`, `sleepProjection(profileId: string, projectionId: string): void`

- [ ] **Step 1: Write failing observer tests**

Use real `PreferenceObserver` inputs containing a user request, assistant result summary, later user correction and Run status. Assert direct correction yields `-4`, repeated behavior across distinct Runs yields positive evidence, failed/cancelled Runs do not produce success evidence, and output summaries contain no full message or secret-like values. Assert duplicate source IDs are ignored by `PreferenceService`.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
pnpm --filter @agentos/server test -- PreferenceObserver.test.ts
```

Expected: FAIL with missing observer/service implementations.

- [ ] **Step 3: Implement deterministic observation and orchestration**

Observe only user-visible messages, public Run status/result summary, file-change counts and known execution events. Detect bounded patterns for direct correction, repeated workflow instructions, follow-up rework and successful applied preference. Store evidence first, recalculate affected Workspace and eligible global projections in a transaction, then return the new projections. Keep the semantic observer behind an injected optional interface; if absent or it throws, skip soft evidence without affecting the Run.

- [ ] **Step 4: Run focused and server service tests**

```powershell
pnpm --filter @agentos/server test -- PreferenceObserver.test.ts MemoryCandidateService.test.ts ConversationService.test.ts
```

Expected: all tests PASS; the existing memory-candidate and conversation behavior is unchanged.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/services/PreferenceObserver.ts apps/server/src/services/PreferenceService.ts apps/server/src/services/PreferenceObserver.test.ts apps/server/src/store/SqliteStore.ts
git commit -m "feat: learn preference evidence from runs"
```

**Acceptance:** A completed Run can create explainable evidence and reproject preferences; failures and cancellations do not create false positive success evidence; learning failures never throw into the conversation path; duplicate observations are idempotent; no private or full-message content is stored.

## Task 5: 接入 ConversationService 与运行记录

**Files:**

- Modify: `apps/server/src/services/ConversationService.ts`
- Modify: `apps/server/src/services/ConversationService.test.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/routes/runs.ts`
- Modify: `packages/shared/src/types/index.ts` to add preference applications to `AgentRunDetails`

**Interfaces:**

- `ConversationService` receives an optional `PreferenceService` without breaking existing constructor call sites.
- Every direct, resumed and group Run builds preference context before creating the Agent runner.
- Completed Run stores `PreferenceApplication` rows and schedules best-effort post-run observation after status persistence.
- `GET /api/workspaces/:workspaceId/runs/:runId` returns preference applications alongside `usedMemories`.

- [ ] **Step 1: Write failing ConversationService integration tests**

Add a fake `PreferenceService` that returns a context marker and records applications. Assert direct, resume and group prompts contain the marker; assert a completed Run records applications; assert a thrown learning error leaves the Run completed and response successful.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
pnpm --filter @agentos/server test -- ConversationService.test.ts runs.test.ts
```

Expected: FAIL because ConversationService does not build or persist preference context.

- [ ] **Step 3: Implement minimal integration**

Instantiate `PreferenceService` once in `apps/server/src/index.ts`. Extend the existing memory context result path to append the preference context as a separate labeled block, pass `PreferenceApplication` records through the same completion path for direct/resume/group runs, and invoke post-run observation in a guarded best-effort promise after the Run is marked completed. Do not change current memory usage failure semantics.

- [ ] **Step 4: Run server integration and full package tests**

```powershell
pnpm --filter @agentos/server test -- ConversationService.test.ts runs.test.ts
pnpm --filter @agentos/server test
pnpm --filter @agentos/agent-core test
```

Expected: all commands exit 0; existing prompt/memory behavior remains green.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/services/ConversationService.ts apps/server/src/services/ConversationService.test.ts apps/server/src/index.ts apps/server/src/routes/runs.ts packages/shared/src/types/index.ts
git commit -m "feat: apply learned preferences to runs"
```

**Acceptance:** Direct, resumed and group runs all receive the correct contextual preference block; explicit current requests still win; completed Runs remain successful if learning fails; applications are queryable and linked to their projection IDs.

## Task 6: 偏好 API 与可见控制面板

**Files:**

- Create: `apps/server/src/routes/preferences.ts`
- Create: `apps/server/src/routes/preferences.test.ts`
- Modify: `apps/server/src/index.ts`
- Create: `apps/web/src/components/preference/PreferencePanel.tsx`
- Create: `apps/web/src/components/preference/PreferenceList.tsx`
- Create: `apps/web/src/lib/preferences.ts`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`
- Modify: `apps/web/src/app/globals.css` to add the preference-panel status styles required by the existing signal theme

**Interfaces:**

- `GET /api/preferences?workspaceId=<id>&context=<kind>` returns projections and learning state.
- `GET /api/preferences/evidence?workspaceId=<id>&projectionId=<id>` returns redacted source summaries.
- `POST /api/preferences/pause` toggles learning for the local profile.
- `POST /api/preferences/clear` clears injectable projections while retaining audit evidence.
- `POST /api/preferences/:projectionId/sleep` sleeps one projection.
- `GET /api/workspaces/:workspaceId/runs/:runId/preferences` returns applications for the Run.

- [ ] **Step 1: Write failing route tests**

Assert that projection lists are filtered by Workspace/context, evidence responses contain IDs and short summaries but not full source messages, pause/clear/sleep mutate only the intended profile/projection, and invalid IDs return the existing JSON error shape.

- [ ] **Step 2: Run route tests and verify RED**

```powershell
pnpm --filter @agentos/server test -- preferences.test.ts
```

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement routes and redacted responses**

Register the preferences router before the JSON error handler. Use the default profile for the local app, require a valid Workspace for Workspace-scoped queries, and map database errors to existing route conventions. Never return raw user message content.

- [ ] **Step 4: Implement the minimal panel**

Add a “系统对我的理解” panel reachable from the Workspace page. Render status, scope, context, confidence, independent Run count and recent support time; link source Runs through the existing Run details callback; provide pause, clear and sleep controls with confirmation. Do not add thumbs-up/down controls.

- [ ] **Step 5: Run server tests and web build**

```powershell
pnpm --filter @agentos/server test -- preferences.test.ts runs.test.ts
pnpm --filter @agentos/web build
```

Expected: route tests PASS and web build exits 0 without TypeScript errors.

- [ ] **Step 6: Commit**

```powershell
git add apps/server/src/routes/preferences.ts apps/server/src/routes/preferences.test.ts apps/server/src/index.ts apps/web/src/components/preference apps/web/src/app/workspace/[id]/page.tsx apps/web/src/lib/preferences.ts apps/web/src/app/globals.css
git commit -m "feat: add preference memory controls"
```

**Acceptance:** The user can inspect learned preferences and their redacted evidence, pause learning, clear injectable projections and sleep one projection; local Workspace filtering is enforced; no explicit rating workflow is introduced; server tests and web build pass.

## Task 7: 全链路验收、隐私回归与文档更新

**Files:**

- Create: `apps/server/src/services/PreferenceAcceptance.test.ts`
- Create: `scripts/verify-preference-memory.ps1`
- Create: `docs/acceptance/adaptive-user-preference-memory.md`
- Modify: `README.md` and `docs/MEMORY_SYSTEM.md` only for confirmed UTF-8 documentation updates

**Interfaces:**

- `scripts/verify-preference-memory.ps1` runs the focused server tests, full server/agent-core tests, web build and a deterministic acceptance scenario.
- Acceptance output records exact commands, exit codes, test counts and privacy assertions.

- [ ] **Step 1: Write the failing end-to-end acceptance test**

Create a temporary SQLite project with two Workspaces and simulate four independent completed Runs in one scene plus opposite behavior in another. Assert observed -> provisional -> stable, context-specific coexistence, application recording, negative downgrade, global eligibility, clear/sleep behavior and privacy redaction.

- [ ] **Step 2: Run the acceptance test and verify RED**

```powershell
pnpm --filter @agentos/server test -- PreferenceAcceptance.test.ts
```

Expected: FAIL until all prior tasks are integrated.

- [ ] **Step 3: Implement the acceptance harness and PowerShell wrapper**

The wrapper must stop on the first non-zero command, print command names and exit codes, use a temporary port/data root where needed, and clean up its own child processes and temporary files. The acceptance test must inspect SQLite rows and API-shaped objects for absence of full source text and sensitive-value patterns.

- [ ] **Step 4: Run the complete verification set**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-preference-memory.ps1
```

Expected: focused preference tests, `pnpm --filter @agentos/server test`, `pnpm --filter @agentos/agent-core test`, and `pnpm --filter @agentos/web build` all exit 0; the acceptance report contains the six scenario assertions and no privacy violations.

- [ ] **Step 5: Update documentation and perform final diff review**

Document the two-layer boundary, implicit signals, promotion thresholds, controls and verification command in `docs/MEMORY_SYSTEM.md`, then run `git diff --check`, UTF-8 parser checks and `git status --short`.

- [ ] **Step 6: Commit**

```powershell
git add apps/server/src/services/PreferenceAcceptance.test.ts scripts/verify-preference-memory.ps1 docs/acceptance/adaptive-user-preference-memory.md README.md docs/MEMORY_SYSTEM.md
git commit -m "test: verify adaptive preference memory"
```

**Acceptance:** The deterministic scenario proves every lifecycle and scope requirement; full tests/build pass; the verifier owns its temporary processes and leaves no unrelated memory log changes; acceptance documentation contains exact evidence and privacy checks.

## Final Review Checklist

- [ ] All seven tasks are committed separately.
- [ ] Evidence is explainable through Run/source IDs and never contains full user messages or secrets.
- [ ] Project memory behavior and candidate approval remain unchanged.
- [ ] Global and Workspace preferences coexist without leakage.
- [ ] Current user instructions override learned defaults.
- [ ] Preference failures never fail a completed Run.
- [ ] The acceptance script and report pass from a clean server process.
