# 会话级模型与思考强度记忆 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 持久化每个会话自己的模型和思考强度，并在切换会话、切换智能体、刷新或重启后恢复。

**Architecture:** 在现有 SQLite `conversations` 表中增加可为空的 `model` 和 `thinking_effort` 字段；共享 `Conversation` 类型携带它们，服务端通过专用 settings PATCH 接口做能力校验并保存。前端以会话设置覆盖智能体默认值，已存在会话修改后立即保存，新会话首次发送时保存当前选择。

**Tech Stack:** TypeScript, Node.js `node:test`, Express, SQLite `node:sqlite`, React 18, Next.js 14, pnpm.

## Global Constraints

- 会话设置是最小持久化粒度；不得把发送区选择写回智能体全局默认值。
- 空模型表示恢复智能体默认模型；旧 SQLite 数据库必须无损迁移。
- 群聊继续使用成员各自配置，不引入单一群聊模型选择。
- 每个生产行为变更先写失败测试并确认失败，再写最小实现。
- 保留现有工作区中与本功能无关的用户改动，不执行 reset、checkout 或批量格式化。

---

### Task 1: 扩展会话类型与 SQLite 持久化

**Files:**
- Modify: `packages/shared/src/types/index.ts:73-81`
- Modify: `apps/server/src/store/SqliteStore.ts:54-62,231-289,545-655`
- Test: `apps/server/src/store/SqliteStore.test.ts`

**Interfaces:**
- `Conversation` produces optional `model?: string` and `thinkingEffort?: ThinkingEffort`.
- `SqliteStore.updateConversationSettings(workspaceId, conversationId, settings)` accepts `{ model?: string | null; thinkingEffort?: ThinkingEffort | null }` and returns the updated `Conversation`.

- [ ] **Step 1: Write the failing store tests**

Add a test that creates two direct conversations, stores different settings, reopens the SQLite store, and asserts each conversation retains its own model and effort. Add a legacy-schema test whose existing `conversations` table lacks both columns, then instantiate `SqliteStore` and assert a settings update succeeds.

- [ ] **Step 2: Run the store tests to verify the expected failure**

Run:

```powershell
pnpm --filter @agentos/server test -- --test-name-pattern "conversation settings|legacy.*conversation"
```

Expected: FAIL because `Conversation` has no settings fields and `SqliteStore.updateConversationSettings` is not implemented.

- [ ] **Step 3: Implement the minimal SQLite support**

Add nullable columns to the `CREATE TABLE conversations` definition and call `ensureColumn` for both columns after schema creation. Include the columns in `ConversationRow`, `SELECT`, `INSERT`, mapping, and the update method. Preserve null values as omitted optional properties in the returned shared type.

- [ ] **Step 4: Run store tests to verify persistence**

Run:

```powershell
pnpm --filter @agentos/server test -- --test-name-pattern "conversation settings|legacy.*conversation"
```

Expected: the new tests PASS.

### Task 2: Add the validated conversation settings API

**Files:**
- Modify: `apps/server/src/routes/conversations.ts:88-148,296-341`
- Test: `apps/server/src/routes/conversations.test.ts`

**Interfaces:**
- `PATCH /conversations/:conversationId/settings` consumes `{ model: string | null; thinkingEffort: ThinkingEffort }`.
- The endpoint returns `{ conversation: Conversation }` and rejects invalid combinations with HTTP 400.

- [ ] **Step 1: Write the failing route tests**

Add a route test with two conversations for the same agent. PATCH conversation A with `{ model: 'model-a', thinkingEffort: 'high' }`, PATCH conversation B with `{ model: 'model-b', thinkingEffort: 'low' }`, GET the conversation list, and assert the two settings remain separate. Add assertions that an unavailable model and an unsupported effort return 400 and do not change the stored conversation.

- [ ] **Step 2: Run the route tests to verify failure**

Run:

```powershell
pnpm --filter @agentos/server test -- --test-name-pattern "conversation settings"
```

Expected: FAIL with 404 because the settings route does not exist.

- [ ] **Step 3: Implement the settings route**

Resolve the conversation and its direct agent, parse `model` (`null` means default), validate `thinkingEffort` with the existing `isThinkingEffort`, obtain the agent capability through `withCapability`, reuse `validateRuntimeOverrides` for model/effort compatibility, then call `store.updateConversationSettings`. Reject group conversations with settings because their UI uses member configuration.

- [ ] **Step 4: Run route tests to verify the API**

Run:

```powershell
pnpm --filter @agentos/server test -- --test-name-pattern "conversation settings"
```

Expected: all new settings route tests PASS.

### Task 3: Restore and save settings in the Web composer

**Files:**
- Modify: `apps/web/src/lib/composerSettings.ts`
- Test: `apps/web/src/lib/composerSettings.test.ts`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx:45-160,190-275`

**Interfaces:**
- `getInitialComposerSettings(agent, conversationSettings?)` returns normalized settings where conversation values override agent defaults.
- The page calls the settings endpoint after a selection change and after creating a new conversation before sending its first message.

- [ ] **Step 1: Write the failing composer tests**

Add tests proving a conversation model and effort override agent defaults, and proving an unsupported saved effort is normalized to the selected model's supported default.

- [ ] **Step 2: Run Web tests to verify failure**

Run:

```powershell
& '.\apps\web\node_modules\.bin\tsx.cmd' --test 'apps/web/src/lib/composerSettings.test.ts'
```

Expected: FAIL because `getInitialComposerSettings` does not accept conversation settings.

- [ ] **Step 3: Implement Web persistence flow**

Initialize composer state from the active conversation settings plus the selected agent. Add a `persistConversationSettings` callback that PATCHes the current conversation and updates the matching item in `conversations` or `groups`. Call it from model and effort handlers for existing conversations. When `createConversation` creates a new direct conversation, persist the current composer pair before `handleSend` posts the message. Keep group behavior unchanged.

- [ ] **Step 4: Run Web unit tests and type-check**

Run:

```powershell
& '.\apps\web\node_modules\.bin\tsx.cmd' --test @(Get-ChildItem -LiteralPath 'apps/web/src/lib' -Filter '*.test.ts' | ForEach-Object FullName)
& '.\apps\web\node_modules\.bin\tsc.cmd' --noEmit -p 'apps/web/tsconfig.json'
```

Expected: all Web tests PASS and TypeScript exits with code 0.

### Task 4: Full verification and acceptance

**Files:**
- Verify: `apps/server`, `apps/web`, `packages/agent-core`, `packages/shared`

- [ ] **Step 1: Run server and agent-core tests**

Run serially:

```powershell
pnpm --filter @agentos/agent-core test
pnpm --filter @agentos/server test
```

Expected: zero failures.

- [ ] **Step 2: Build server and Web**

Run:

```powershell
pnpm --filter @agentos/server build
pnpm --filter @agentos/web build
```

Expected: both builds exit with code 0.

- [ ] **Step 3: Perform the user acceptance flow**

In the running AgentOS workspace, set conversation A to model A + high, set conversation B for the same agent to model B + low, switch to another agent and back, then reload the page. Confirm A and B restore their own values, and confirm a new conversation starts with the agent default values.

- [ ] **Step 4: Review the final diff**

Run:

```powershell
git -C 'E:\workspace\Multi-Agent' -c safe.directory=E:/workspace/Multi-Agent diff --check -- agentos/packages/shared/src/types/index.ts agentos/apps/server/src/store/SqliteStore.ts agentos/apps/server/src/routes/conversations.ts agentos/apps/web/src/lib/composerSettings.ts agentos/apps/web/src/app/workspace/[id]/page.tsx
```

Expected: no whitespace errors and no unrelated file edits from this feature.
