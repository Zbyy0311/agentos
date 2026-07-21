# M2.3 Workspace/Agent/Provider Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 M2.3 退出门槛中已确认的 11 个缺口，并用高风险行为回归测试证明 M2.3 只能在全部要求通过后标记 VERIFIED。

**Architecture:** 继续使用当前 monorepo + SQLite + legacy JSON dual-read 架构。SQLite 是新 Workspace/Provider/Agent 的权威写入源；Legacy JSON 只读，首次迁移在内存中归一化 Kimi 配置后写入 SQLite。跨聚合创建由 WorkspaceManager 以单一 `inTransaction()` 包住，Repository 提供不重复开启事务的内部写入入口。

**Tech Stack:** Node.js 22 `node:sqlite`, TypeScript, `node:test`, pnpm workspace, MigrationRunner。

## Global Constraints

- 不得在 `SqliteStore` 构造函数中创建持久表；所有持久 Schema 变化必须注册为版本化 Migration。
- 不得由 Kimi/Legacy 迁移写回 `workspace/workspaces.json`；Kimi 修正只能在内存迁移数据或 SQLite 中完成。
- Repository 层的 Provider `update()` 与 `archive()` 必须强制接收 `expectedVersion`；不提供隐式读取当前版本的客户端写入路径。
- M2.4 不得承接本轮 Workspace/Provider 验收测试。
- 保留现有 API 和 monorepo 架构，禁止无关重构。

---

### Task 1: 建立 M2.3 高风险回归测试

**Files:**
- Modify: `apps/server/src/store/SqliteStore.test.ts`
- Modify: `apps/server/src/store/__tests__/ProviderConfigurationRepository.test.ts`
- Create: `apps/server/src/routes/providerConfigs.test.ts`
- Modify: `apps/server/src/migrations/__tests__/integration.test.ts`

**Interfaces:**
- Tests consume `SqliteStore`, `WorkspaceManager`, `ProviderConfigurationRepository`, provider route factory, and MigrationRunner.
- Tests produce executable acceptance evidence for rollback, JSON hash stability, SQLite-only workspace behavior, projection, isolation, optimistic concurrency, archive guard, migration strictness, and tombstone restart persistence.

- [ ] **Step 1: Write failing tests**

覆盖以下独立行为：

```ts
// SqliteStore.test.ts
test('rolls back the whole Workspace aggregate when a provider insert fails', ...);
test('new SQLite-only Workspace can create a Conversation', ...);
test('Kimi migration leaves legacy workspace JSON hash unchanged', ...);
test('Agent compatibility fields follow its Provider Configuration', ...);
test('deleted Workspace tombstone survives store restart', ...);

// ProviderConfigurationRepository.test.ts / provider route tests
test('repository update rejects missing expectedVersion', ...);
test('repository archive rejects missing or stale expectedVersion', ...);
test('provider route rejects cross-workspace update and archive', ...);
test('provider archive returns conflict while an enabled Agent references it', ...);

// migration integration / SqliteStore test
test('legacy migration rethrows unknown database errors', ...);
test('legacy Agent migration creates a Provider Configuration and binding', ...);
```

- [ ] **Step 2: Run each focused test and confirm RED**

Run:

```powershell
pnpm --filter @agentos/server exec node --import tsx --test src/store/SqliteStore.test.ts src/store/__tests__/ProviderConfigurationRepository.test.ts src/migrations/__tests__/integration.test.ts
```

Expected: newly added assertions fail for the current 75ad7486 implementation, including JSON hash mutation, missing projection, optional version, and non-atomic creation.

---

### Task 2: 修复 SQLite-first Workspace 聚合与 Agent 投影

**Files:**
- Modify: `apps/server/src/store/WorkspaceRepository.ts`
- Modify: `apps/server/src/managers/WorkspaceManager.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`

**Interfaces:**
- `WorkspaceRepository.insert(workspace)` remains a standalone transactional API.
- Add an explicitly named no-nested-transaction write method used only inside an existing transaction, such as `insertWithinTransaction(workspace)`.
- `WorkspaceManager.create()` calls one outer `inTransaction(database, ...)` for workspace row, provider rows, and agent rows.
- `SqliteStore.assertWorkspaceExists()` checks `workspaceRepo.exists(workspaceId)` first and only then applies the documented legacy fallback.
- `listAgentProfiles()` joins `provider_configurations` and maps provider executable/args/model fields from the joined row while retaining profile identity fields.

- [ ] **Step 1: Make the rollback, SQLite-only Conversation, and projection tests RED** (from Task 1).
- [ ] **Step 2: Add `WorkspaceRepository.insertWithinTransaction()` and keep `insert()` as the outer transaction wrapper.** The inner method must contain only the workspace `INSERT`; it must not call `BEGIN`, `COMMIT`, or `ROLLBACK`.
- [ ] **Step 3: Move `WorkspaceManager.create()` database writes into one outer `inTransaction()`.** Keep filesystem initialization behavior unchanged; if any provider or agent insert throws, the outer transaction must roll back all three tables.
- [ ] **Step 4: Change `assertWorkspaceExists()` to SQLite-first.** A Workspace present only in SQLite must pass `createConversation()` and every existing caller of this assertion.
- [ ] **Step 5: Replace the Agent profile query with a `LEFT JOIN provider_configurations pc ON pc.id = ap.provider_config_id AND pc.workspace_id = ap.workspace_id`.** Return `cliCommand`, `cliArgs`, `model`, and `provider` from the joined Provider when the binding exists; use legacy profile columns only for unbound legacy rows.
- [ ] **Step 6: Run the focused Store tests and confirm GREEN.**

Run:

```powershell
pnpm --filter @agentos/server exec node --import tsx --test src/store/SqliteStore.test.ts
```

---

### Task 3: 收紧 Provider 乐观并发与 Workspace 隔离

**Files:**
- Modify: `apps/server/src/store/ProviderConfigurationRepository.ts`
- Modify: `apps/server/src/routes/providerConfigs.ts`
- Modify: `apps/server/src/store/__tests__/ProviderConfigurationRepository.test.ts`
- Modify: `apps/server/src/routes/providerConfigs.test.ts`

**Interfaces:**
- `update(config, expectedVersion: number)` is required.
- `archive(id, expectedVersion: number)` is required and must use the same OCC guard.
- HTTP PUT and DELETE require a numeric `expectedVersion`; omission is `400`, stale value is `409`.
- Archive still returns `409 PROVIDER_CONFIG_IN_USE` when an enabled Agent references the Provider, before mutating state.

- [ ] **Step 1: Make missing/stale update and archive tests RED.**
- [ ] **Step 2: Remove the Repository fallback that reads the current version when `expectedVersion` is omitted.** The SQL `WHERE` must always use the caller-provided expected version.
- [ ] **Step 3: Require `expectedVersion` in `archive()` and pass it through to `update()`.**
- [ ] **Step 4: Require numeric `expectedVersion` in DELETE route and preserve the active-agent conflict check.** Do not allow the route to archive before validating version or reference state.
- [ ] **Step 5: Add/update the route test for cross-workspace GET/PUT/DELETE and archive conflict.**
- [ ] **Step 6: Run repository and route tests and confirm GREEN.**

Run:

```powershell
pnpm --filter @agentos/server exec node --import tsx --test src/store/__tests__/ProviderConfigurationRepository.test.ts src/routes/providerConfigs.test.ts
```

---

### Task 4: 关闭 JSON 写入并实现严格、可审计 Legacy Migration

**Files:**
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`
- Modify: `docs/implementation/schema-inventory.md` only if writer ownership statements become stale

**Interfaces:**
- Legacy workspaces are loaded as a clone, normalized in memory, and never passed to `JsonFileStore.saveWorkspaces()` by the M2.3 migration path.
- Legacy Agent migration creates the corresponding `provider_configurations` row and sets `agent_profiles.provider_config_id` in the same database transaction.
- `migrateLegacyWorkspaces()` is fail-closed: only a specifically identified, expected duplicate/canonical-path conflict may be handled; all other errors are rethrown with workspace ID context.
- Migration errors are observable through thrown errors; no empty `catch` blocks may hide schema, FK, corruption, or programming errors.

- [ ] **Step 1: Make JSON hash and strict migration tests RED.**
- [ ] **Step 2: Remove `migrateLegacyKimiWorkspaceConfigs()` JSON write-back and replace it with a pure in-memory normalization path shared by legacy Agent and Workspace migration.**
- [ ] **Step 3: Make legacy Agent migration transactional and idempotent.** For each legacy agent, insert or update its Provider Configuration, then bind `provider_config_id`; preserve custom CLI values and normalized Kimi values.
- [ ] **Step 4: Replace silent legacy Workspace catches with an explicit duplicate/canonical conflict predicate.** Rethrow all other errors with the original cause and Workspace ID.
- [ ] **Step 5: Run JSON hash, legacy binding, strict error, and existing legacy migration tests and confirm GREEN.**

Run:

```powershell
pnpm --filter @agentos/server exec node --import tsx --test src/store/SqliteStore.test.ts src/migrations/__tests__/integration.test.ts
```

---

### Task 5: 将 Tombstone 纳入版本化 Migration

**Files:**
- Create: `apps/server/src/migrations/migrations/004-workspace-tombstones.ts`
- Modify: `apps/server/src/migrations/default-registry.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/migrations/__tests__/integration.test.ts`

**Interfaces:**
- Migration `004` creates `_workspace_tombstones(workspace_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL)`.
- `SqliteStore` no longer executes `CREATE TABLE IF NOT EXISTS _workspace_tombstones` in its constructor.
- Existing M2.3 databases apply 004 through MigrationRunner and record its checksum in `_schema_migrations`.
- Tombstone filtering remains persistent across store close/reopen.

- [ ] **Step 1: Make the migration registry/schema assertion test RED** by requiring migration 004 and asserting the recorded migration plus tombstone table.
- [ ] **Step 2: Add migration 004 with canonical checksum and register it after 003.**
- [ ] **Step 3: Remove constructor-time tombstone DDL.** Keep only reads/writes to the table after `runMigrations()`.
- [ ] **Step 4: Run migration integration and tombstone restart tests and confirm GREEN.**

Run:

```powershell
pnpm --filter @agentos/server exec node --import tsx --test src/migrations/__tests__/integration.test.ts src/store/SqliteStore.test.ts
```

---

### Task 6: 更新报告并执行 M2.3 EXIT GATE 审计

**Files:**
- Modify: `docs/implementation/milestones/M2.3-workspace-agent-provider-report.md`
- Modify or Create: `scripts/verify-m2-3-workspace-agent-provider.ps1` if the existing acceptance command cannot express the full checklist

**Interfaces:**
- Report status remains `M2.3 IMPLEMENTED — final aggregate and verification remediation required` until all tests and checks are fresh.
- The report must not claim `all 65 marked PASS` or `M2.3 EXIT GATE PASSED — VERIFIED` while any required item is missing.
- The final checklist explicitly covers all user-named behaviors and records command output/counts.

- [ ] **Step 1: Run the complete server test suite and agent-core tests.**
- [ ] **Step 2: Run server build and repository-specific migration/Store/Provider focused tests.**
- [ ] **Step 3: Run a fresh source audit for forbidden JSON write-back, constructor DDL, optional Provider expectedVersion, and silent migration catches.**
- [ ] **Step 4: Update the report only to the status supported by fresh evidence, including any unrelated pre-existing failures separately.**
- [ ] **Step 5: Re-read this plan and audit every explicit requirement before marking the Goal complete.**

Expected verification commands:

```powershell
pnpm --filter @agentos/server test
pnpm --filter @agentos/agent-core test
pnpm --filter @agentos/server build
rg -n "legacy\.saveWorkspaces|CREATE TABLE IF NOT EXISTS _workspace_tombstones|update\(config: ProviderConfiguration, expectedVersion\?|archive\(id: string, expectedVersion\?" apps/server/src
```
