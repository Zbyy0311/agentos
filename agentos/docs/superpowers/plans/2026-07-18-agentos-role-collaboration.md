# AgentOS Role Collaboration and Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将群聊升级为 Provider、协作角色、权限相互独立的可路由团队，并为 waiting_user、部分写入失败、运行意图和 Provider 原生工具审批建立可审计流程。

**Architecture:** Workspace Agent 的 Provider 决定通过哪个 CLI 运行，ConversationMember 的 `roleKind` 决定协作职责，RuntimePolicy 决定允许做什么。群聊默认 `leader_route`：显式 @mention 优先，否则 leader 决定自己回答、调用部分成员或启动完整流水线；所有 handoff、waiting 和审批都落入同一 Run、RunStep、AgentEvent sequence。

**Tech Stack:** TypeScript、Express、SQLite、SSE、React 18、Next.js 14、Vitest、Node Test Runner。

**Base:** 用户已验收并在 `docs/acceptance/execution-workbench-final.md` 记录的计划 B Task B6 HEAD。

**Branch:** `codex/agentos-role-collaboration`。

## Global Constraints

- 必须基于计划 B 已完成的 persisted AgentEvent sequence 和 recoverable RunStep。
- Provider、CollaborationRole、AgentPermission 不得互相推断。
- 群聊默认不运行完整团队；显式 mentions 和 leader routing 决定参与者。
- 不保存私有 reasoning；leader route 只保存公开 decision/reason。
- 共享工作区同一时刻最多一个 write-capable execution。
- 写入 execution 失败并产生文件变化时必须暂停，不能默认继续。
- 产品文案使用“工作区只读”，不得宣传为系统级完全只读。
- 工具审批只对 Adapter 明确支持 permission request/response 的 Provider 启用。

## Plan Start Gate

- [ ] 读取计划 B 最终验收记录并人工确认其中 HEAD 是本计划唯一基准。
- [ ] 执行 `git status --short`；非空则停止并先划清残留改动归属。
- [ ] 执行 `git rev-parse HEAD` 并写入 `docs/acceptance/role-collaboration-baseline.md`。
- [ ] 确认分支不存在后执行 `git switch -c codex/agentos-role-collaboration`。

验收：baseline 文档包含 base branch、base HEAD、Node/pnpm 版本和全量测试结果；计划 A1 本地 API 安全测试仍通过。

---

## Task C1：Workspace Agent Presence

**Files:**

- Create: `docs/acceptance/role-collaboration-baseline.md`
- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/server/src/services/AgentPresenceService.ts`
- Create: `apps/server/src/services/AgentPresenceService.test.ts`
- Create: `apps/server/src/routes/agentPresence.ts`
- Modify: `apps/server/src/index.ts`
- Create: `apps/web/src/lib/agentPresence.ts`
- Create: `apps/web/src/lib/agentPresence.test.ts`
- Modify: `apps/web/src/components/chat/AgentList.tsx`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`

**Interfaces:**

```ts
export type AgentPresenceState = 'disabled' | 'idle' | 'queued' | 'working' | 'waiting' | 'failed';

export interface AgentPresence {
  agentId: string;
  state: AgentPresenceState;
  activity?: string;
  runId?: string;
  conversationId?: string;
  updatedAt: string;
}
```

- [ ] **Step C1.1：先写 disabled 优先级测试**

```ts
test('disabled overrides active and recent failed executions', () => {
  const presence = service.resolve(disabledAgent(), [runningExecution(), failedExecution()]);
  assert.equal(presence.state, 'disabled');
  assert.equal(presence.runId, undefined);
});
```

- [ ] **Step C1.2：实现派生规则**

```ts
if (!agent.enabled) return disabledPresence(agent);
```

启用 Agent 再按 `waiting > working > queued > failed > idle`。failed 只保持 30 秒，然后回 idle 并保留最近 activity。Presence 不新增持久化表，从 Agent/Run/Execution/ExecutionEvent 派生。

- [ ] **Step C1.3：新增只读 API**

```http
GET /api/workspaces/:workspaceId/agents/presence
```

Workspace 不存在返回 404；只返回当前 Workspace Agent。

- [ ] **Step C1.4：前端同步**

进入 Workspace 加载一次；页面可见时 15 秒刷新；当前会话 SSE 立即更新；页面隐藏时停止 timer，恢复时立即刷新。

- [ ] **Step C1.5：验证**

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/AgentPresenceService.test.ts
pnpm.cmd --filter @agentos/web test
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web build
```

- [ ] **Step C1.6：提交**

```powershell
git add docs/acceptance/role-collaboration-baseline.md packages/shared/src/types/index.ts apps/server/src/services/AgentPresenceService.ts apps/server/src/services/AgentPresenceService.test.ts apps/server/src/routes/agentPresence.ts apps/server/src/index.ts apps/web/src/lib/agentPresence.ts apps/web/src/lib/agentPresence.test.ts apps/web/src/components/chat/AgentList.tsx apps/web/src/app/workspace/[id]/page.tsx
git commit -m "feat: show workspace agent presence"
```

### Task C1 验收标准

- disabled 永远覆盖历史 failed/running 数据。
- 多 Agent 状态同时可见，不只跟随当前选中 Agent。
- Server 重启后 Presence 可从数据库派生。
- 轮询在隐藏页面停止，无 timer 泄漏。

---

## Task C2：显式协作角色与群聊策略

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/routes/conversations.ts`
- Modify: `apps/server/src/routes/conversations.test.ts`
- Modify: `apps/web/src/components/chat/GroupCreator.tsx`
- Create: `apps/web/src/components/chat/GroupEditor.tsx`

**Interfaces:**

```ts
export type CollaborationRole = 'leader' | 'worker' | 'reviewer' | 'specialist';
export type GroupDispatchMode = 'leader_route' | 'full_pipeline' | 'mentioned_only';

export interface ConversationMember {
  conversationId: string;
  agentId: string;
  roleKind: CollaborationRole;
  roleTitle: string;
  sequence: number;
  createdAt: string;
}

export interface GroupMemberInput {
  agentId: string;
  roleKind: CollaborationRole;
  roleTitle: string;
  sequence: number;
}

export interface Conversation {
  // existing fields
  dispatchMode?: GroupDispatchMode;
}
```

- [ ] **Step C2.1：先写迁移和校验测试**

旧成员 `is_leader=1` 迁移为 leader；其他成员迁移为 worker，不按 Provider 推断 reviewer。每个 group 必须恰好一个 leader，至少两个成员，roleTitle 1-80 字符。sequence 必须是非负整数且同一 conversation 唯一。

- [ ] **Step C2.2：迁移 schema**

`conversation_members` 新增 `role_kind` 与 `sequence`；`conversations` 新增 `dispatch_mode`。迁移先按 leader 优先、`created_at ASC, rowid ASC` 为旧成员回填 10、20、30…，再创建 `UNIQUE(conversation_id, sequence)`；旧 group 默认 `leader_route`，direct conversation 保持 null。

- [ ] **Step C2.3：更新创建/编辑 API**

POST/PATCH 接收 `members: GroupMemberInput[]` 和 `dispatchMode`。Agent provider/permissions 不改变 roleKind；OpenCode 可选 worker，Codex/Kimi 可选 reviewer。

- [ ] **Step C2.4：更新 UI**

每个成员提供 roleKind select、roleTitle input 与上移/下移排序；提交时按当前数组顺序生成 10、20、30… sequence。标准团队预设：Codex leader、Kimi worker、OpenCode reviewer；这是 UI 默认值，不是运行时推断规则。

- [ ] **Step C2.5：验证**

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/routes/conversations.test.ts src/store/SqliteStore.test.ts
pnpm.cmd --filter @agentos/web test
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web build
```

- [ ] **Step C2.6：提交**

```powershell
git add packages/shared/src/types/index.ts apps/server/src/store/SqliteStore.ts apps/server/src/routes/conversations.ts apps/server/src/routes/conversations.test.ts apps/web/src/components/chat/GroupCreator.tsx apps/web/src/components/chat/GroupEditor.tsx
git commit -m "feat: add explicit collaboration roles"
```

### Task C2 验收标准

- Provider、roleKind、roleTitle、permissions 分别存储和显示。
- Reviewer 不再通过 `provider === opencode` 推断。
- OpenCode worker、Kimi reviewer 等组合可保存并刷新恢复。
- 旧 group 迁移后恰好一个 leader，行为不丢失。
- 成员 sequence 持久化且同一 group 唯一，mentioned/full pipeline 刷新后顺序不变。

---

## Task C3：@Agent、Leader Router 与 waiting_user 恢复

**Files:**

- Create: `apps/server/src/services/GroupDispatchService.ts`
- Create: `apps/server/src/services/GroupDispatchService.test.ts`
- Create: `apps/server/src/services/GroupOrchestrator.ts`
- Create: `apps/server/src/services/GroupOrchestrator.test.ts`
- Modify: `apps/server/src/services/ConversationService.ts`
- Modify: `apps/server/src/services/ConversationService.test.ts`
- Modify: `apps/server/src/routes/conversations.ts`
- Create: `apps/web/src/components/chat/MentionPicker.tsx`
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`

**Interfaces:**

```ts
export interface GroupMessageInput {
  content: string;
  mentionedAgentIds: string[];
}

export type DispatchDecision =
  | { action: 'self'; publicReason: string }
  | { action: 'members'; agentIds: string[]; publicReason: string }
  | { action: 'full_pipeline'; publicReason: string }
  | { action: 'need_user'; question: string };

export interface DispatchEnvelope {
  nonce: string;
  decision: DispatchDecision;
}

export function createDispatchNonce(): string;
export function parseDispatchEnvelope(
  finalAssistantMessage: string,
  expectedNonce: string,
  members: readonly ConversationMember[],
): DispatchDecision;

export interface GroupTurn {
  stableStepKey: string;
  agentId: string;
  roleKind: CollaborationRole;
  prompt: string;
}
```

- [ ] **Step C3.1：先写 mention 校验测试**

前端 MentionPicker 保存 agentId，不依赖解析 display name。Server 校验 mentioned ids 均属于当前 group；`@all` 展开为全部启用成员。伪造非成员 id 返回 400。

- [ ] **Step C3.2：实现 dispatch precedence**

```text
请求有 mentionedAgentIds -> mentioned_only
Conversation.dispatchMode=full_pipeline -> full_pipeline
Conversation.dispatchMode=mentioned_only 且无 mentions -> leader only
Conversation.dispatchMode=leader_route -> 先运行 leader router
```

- [ ] **Step C3.3：隔离 Leader Router 执行**

Router 使用独立 Execution/RunStep，`workspaceWrite=false`、network blocked（Provider 能强制时）、tools disabled，不读取仓库文件，也不把 Router 原始控制输出保存为普通聊天消息。输入仅包含用户目标、已脱敏的 group member id/role/title 与允许动作。Server 每次生成 128-bit 随机 nonce。

- [ ] **Step C3.4：定义结构化或 nonce route envelope**

当 detected Provider 的 `jsonSchemaOutput=true` 时，Adapter 使用严格 `DispatchEnvelope` JSON Schema；否则要求最终 assistant message 的最后一个完整非空行为：

```text
AGENTOS_DISPATCH::7ee2e44ddf654150aa4a07c4a33d3ad1::eyJub25jZSI6IjdlZTJlNDRkZGY2NTQxNTBhYTRhMDdjNGEzM2QzYWQxIiwiZGVjaXNpb24iOnsiYWN0aW9uIjoic2VsZiIsInB1YmxpY1JlYXNvbiI6IuWIhuaekOS7u-WKoSJ9fQ
```

base64url JSON 必须包含相同 nonce 和唯一 decision。只解析 Router 独立调用的最终 assistant message，不扫描用户消息、仓库内容、tool output 或普通 Agent 正文。截断、nonce 不匹配、多个有效 envelope、未知 action 均 fail closed 为 `need_user` 或 leader self，并写 diagnostic；不得自动启动全团队。控制行在生成用户可见 Router 摘要前移除。

无论哪条路径，Server 都重新校验 agentIds 属于当前 group、enabled 且没有重复，并按持久化 member.sequence 排序；Provider 输出不能决定任意 Agent id 或执行顺序。

- [ ] **Step C3.5：构造串行 turns**

- full pipeline：leader plan -> workers/specialists -> reviewers -> leader summary。
- mentioned only：按成员在 group 中 sequence 串行执行；若提到 leader 则 leader 直接回答。
- leader members：只执行 decision 中列出的成员，之后 leader summary。
- 同一时刻共享工作区最多一个 write-capable execution。

- [ ] **Step C3.6：Leader need_user**

need_user 或现有 waiting marker：leader step -> waiting，后续 step 保持 pending，Run -> waiting_user。用户回复后复用同一 Run 和 stable steps，leader step 绑定新 executionId、attempt +1；不得重新创建 worker/reviewer steps。

- [ ] **Step C3.7：有界 handoff**

每次只传原始目标、公开计划/结论、文件变化、Artifact 标题和失败摘要，最多 12,000 字符；不传 raw JSONL、stderr、完整工具输出或 reasoning。

- [ ] **Step C3.8：验证**

测试必须包含用户伪造 envelope、仓库文件包含 envelope、Router 正文引用示例、截断 JSON、多 envelope、错误 nonce、非成员 agentId 和 subscriber 重放。

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/GroupDispatchService.test.ts src/services/GroupOrchestrator.test.ts src/services/ConversationService.test.ts
pnpm.cmd --filter @agentos/web test
pnpm.cmd -r run build
```

- [ ] **Step C3.9：提交**

```powershell
git add apps/server/src/services/GroupDispatchService.ts apps/server/src/services/GroupDispatchService.test.ts apps/server/src/services/GroupOrchestrator.ts apps/server/src/services/GroupOrchestrator.test.ts apps/server/src/services/ConversationService.ts apps/server/src/services/ConversationService.test.ts apps/server/src/routes/conversations.ts apps/web/src/components/chat/MentionPicker.tsx apps/web/src/components/chat/ChatPanel.tsx apps/web/src/app/workspace/[id]/page.tsx
git commit -m "feat: route group tasks to explicit members"
```

### Task C3 验收标准

- `@Codex/@Kimi/@OpenCode/@all` 只触发明确目标。
- leader_route 可 self、部分成员、完整流水线或 need_user。
- 简单消息不会默认启动全部 Agent。
- waiting_user 在同一 Run/RunStep 恢复，attempt 正确递增。
- handoff 事件可审计且不含私有 reasoning/raw 日志。
- Router 只读无工具，控制通道与用户正文分离；伪造、截断或 nonce mismatch 不会启动成员。
- 成员执行顺序只来自 `ConversationMember.sequence`，不信任模型返回顺序。

---

## Task C4：写入成员失败后的暂停决策

**Entry Gate:** 计划 A1 本地 API 安全中间件已全局生效；否则不得注册 decision resolve 写路由。

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Create: `apps/server/src/services/RunDecisionService.ts`
- Create: `apps/server/src/services/RunDecisionService.test.ts`
- Modify: `apps/server/src/services/GroupOrchestrator.ts`
- Modify: `apps/server/src/services/ConversationService.ts`
- Modify: `apps/server/src/routes/conversations.ts`
- Create: `apps/web/src/components/runs/RunDecisionCard.tsx`

**Interfaces:**

```ts
export type PartialWriteDecision = 'keep_and_continue' | 'retry_current' | 'abort';

export interface PendingRunDecision {
  id: string;
  workspaceId: string;
  runId: string;
  executionId: string;
  kind: 'partial_write_failure';
  fileChanges: RunFileChange[];
  allowedDecisions: PartialWriteDecision[];
  resolvedDecision?: PartialWriteDecision;
  createdAt: string;
  resolvedAt?: string;
}
```

- [ ] **Step C4.1：先写失败矩阵测试**

```text
只读 execution 失败 -> 记录失败，按编排策略继续
写入 execution 失败 + 0 file changes -> 记录失败，继续
写入 execution 失败 + file changes > 0 -> Run waiting_user
leader plan 失败 -> Run failed
leader summary 失败 -> Run failed
```

- [ ] **Step C4.2：持久化 PendingRunDecision**

`run_decisions` 以 run/execution/kind 唯一；重复失败事件不创建第二条 decision。waitingQuestion 明确列出变化文件和三个可用动作。

- [ ] **Step C4.3：实现三个动作**

- keep_and_continue：保留现状，失败 step 保持 failed，继续下一 step。
- retry_current：复用同一 logical step，attempt +1，在当前工作区状态上重试。
- abort：Run cancelled，后续 pending steps cancelled。

共享工作区第一版不提供“自动回滚本阶段”，因为无法证明用户没有同时编辑相同文件；UI 明确说明可靠恢复在 Worktree 阶段提供。

- [ ] **Step C4.4：前端决策卡**

展示失败 Agent、变化文件、风险说明和三个按钮；用户决策后禁用重复提交，SSE 更新 Run/step。

- [ ] **Step C4.5：重启恢复**

Server 重启后 unresolved decision 保持 waiting_user；用户仍可解决。resolved decision 重放不得重复执行。

- [ ] **Step C4.6：验证**

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/RunDecisionService.test.ts src/services/GroupOrchestrator.test.ts src/services/ConversationService.test.ts
pnpm.cmd --filter @agentos/web test
pnpm.cmd -r run build
```

- [ ] **Step C4.7：提交**

```powershell
git add packages/shared/src/types/index.ts apps/server/src/store/SqliteStore.ts apps/server/src/services/RunDecisionService.ts apps/server/src/services/RunDecisionService.test.ts apps/server/src/services/GroupOrchestrator.ts apps/server/src/services/ConversationService.ts apps/server/src/routes/conversations.ts apps/web/src/components/runs/RunDecisionCard.tsx
git commit -m "feat: pause after partial agent writes"
```

### Task C4 验收标准

- 写入失败且有文件变化时绝不自动继续。
- 三种决策均幂等、可审计、可重启恢复。
- UI 不承诺共享工作区可安全自动回滚。
- retry attempt 与 RunStep/Execution 关联正确。

---

## Task C5：Run Intent 与工作区只读策略

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Create: `packages/agent-core/src/runtimePolicy.ts`
- Create: `packages/agent-core/src/runtimePolicy.test.ts`
- Modify: `packages/agent-core/src/conversationRunner.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/routes/conversations.ts`
- Create: `apps/web/src/components/chat/RunModeSelector.tsx`
- Modify: `apps/web/src/components/chat/ComposerControls.tsx`
- Modify: `apps/web/src/components/runs/RunDetails.tsx`

**Interfaces:**

```ts
export type RunIntent = 'ask' | 'execute' | 'review';

export interface RuntimePolicy {
  workspaceWrite: boolean;
  networkPolicy: 'provider-default' | 'blocked' | 'allowed';
  toolPolicy: 'read-only' | 'configured' | 'approval';
  extraArgs: string[];
  promptPrefix: string;
  enforcement: 'sandbox' | 'cli-flag' | 'unsupported';
}
```

- [ ] **Step C5.1：先写 policy matrix**

- ask/review：workspaceWrite=false；Provider 无 enforceable workspace read-only 时 unsupported。
- execute：由 Agent permissions 决定 workspaceWrite。
- network 默认为 provider-default；没有真实阻断能力时不显示 blocked。
- review prompt 要求发现、证据、严重度和建议，不修改文件。

- [ ] **Step C5.2：迁移 AgentRun intent**

旧 Run 默认 execute；非法 API 输入返回 400；Run Details 展示 intent 和完整 RuntimePolicy snapshot。

- [ ] **Step C5.3：实现工作区写入测试**

fake CLI 尝试写 Workspace；ask/review 必须因 sandbox/flag 拒绝或 Server 在启动前返回 409。测试只证明 Workspace 未写，不宣称用户目录、临时目录、网络或 Provider session 完全无副作用。

- [ ] **Step C5.4：更新产品文案**

统一使用“工作区只读”；Run Details 显示 enforcement、networkPolicy 和 toolPolicy。禁止“完全只读”“系统级沙箱”等超出证据的文案。

- [ ] **Step C5.5：验证**

```powershell
pnpm.cmd --filter @agentos/agent-core exec vitest run src/runtimePolicy.test.ts src/conversationRunner.test.ts
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web test
pnpm.cmd -r run build
```

- [ ] **Step C5.6：提交**

```powershell
git add packages/shared/src/types/index.ts packages/agent-core/src/runtimePolicy.ts packages/agent-core/src/runtimePolicy.test.ts packages/agent-core/src/conversationRunner.ts apps/server/src/store/SqliteStore.ts apps/server/src/routes/conversations.ts apps/web/src/components/chat/RunModeSelector.tsx apps/web/src/components/chat/ComposerControls.tsx apps/web/src/components/runs/RunDetails.tsx
git commit -m "feat: audit workspace execution policies"
```

### Task C5 验收标准

- Run intent 与 policy snapshot 可从 SQLite/Run Details 审计。
- ask/review 无可强制工作区只读能力时返回 409。
- UI 精确说明 Workspace、network、tool 和 enforcement 边界。
- execute 不绕过 Agent permissions。

---

## Task C6：Provider 原生工具审批透传

**Entry Gate:** 计划 A1 本地 API 安全中间件已全局生效；否则不得注册 approval resolve、grant revoke 等写路由。

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/agent-core/src/adapters/types.ts`
- Modify: `packages/agent-core/src/executor.ts`
- Create: `apps/server/src/services/ApprovalRegistry.ts`
- Create: `apps/server/src/services/ApprovalRegistry.test.ts`
- Create: `apps/server/src/services/ToolRiskClassifier.ts`
- Create: `apps/server/src/services/ToolRiskClassifier.test.ts`
- Create: `apps/server/src/routes/approvals.ts`
- Create: `apps/server/src/routes/approvals.test.ts`
- Modify: `apps/server/src/index.ts`
- Create: `apps/web/src/components/runs/ToolApprovalCard.tsx`
- Create: `apps/web/src/components/runs/ApprovalGrantPanel.tsx`

**Interfaces:**

```ts
export type ApprovalDecision = 'allow_once' | 'allow_run' | 'allow_conversation' | 'deny';

export interface ToolApprovalRequest {
  id: string;
  workspaceId: string;
  runId: string;
  executionId: string;
  agentId: string;
  provider: AgentProvider;
  providerVersion?: string;
  sanitizedConfigHash: string;
  toolName: string;
  actionFingerprint: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  commandSummary?: string;
  affectedPaths: string[];
  createdAt: string;
}

export interface ApprovalGrant {
  id: string;
  workspaceId: string;
  conversationId: string;
  provider: AgentProvider;
  providerVersion?: string;
  sanitizedConfigHash: string;
  toolPattern: string;
  actionFingerprint: string;
  maximumRisk: 'low' | 'medium' | 'high';
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
}

export interface AgentCliAdapter {
  // existing methods
  encodeApprovalDecision?(requestId: string, decision: ApprovalDecision): string;
}
```

Normalized events 增加 `approval.requested` 与 `approval.resolved`。

- [ ] **Step C6.1：先写 capability Gate 测试**

`capabilities.approvalEvents=false` 时 UI/API 明确 unavailable，Executor 不保持 stdin 等待，也不伪造审批卡。

- [ ] **Step C6.2：实现风险分类**

- low：只读文件、搜索。
- medium：测试、构建。
- high：受限写文件、固定版本依赖安装、明确目标联网命令。
- critical：删除、Git commit/push、执行未知脚本、任意依赖安装或无法规范化的命令。

分类结果是 UI 风险提示，不替代 Provider permission enforcement。

- [ ] **Step C6.3：实现审批等待与决策**

支持 Provider 的 invocation 保持 stdin pipe；Parser 发出 approval.requested 后 Executor 等待 `ApprovalRegistry.resolve`，将 Adapter 编码的响应写回 stdin。超时/取消/重启均 deny 并结束 Execution。

- [ ] **Step C6.4：作用域授权与安全上限**

- allow_once：适用于全部风险级别，只解决当前 request。
- allow_run：仅 low/medium/high，在当前 runId 终态时自动失效。
- allow_conversation：仅 low/medium，必须设置 `expiresAt`，最长 24 小时。
- critical 永远只显示 allow_once/deny；Git push、删除、未知脚本和任意依赖安装不能创建 conversation grant。
- deny 不创建 grant。

toolPattern 只使用 Adapter 规范化后的 canonical tool id；actionFingerprint 包含 normalized command、受影响路径类别、Provider version 与 sanitized config hash。Provider、version、config hash、tool id 或 fingerprint 任一变化时 grant 不匹配，不允许宽泛 regex/glob 回退。

- [ ] **Step C6.5：API 与 UI**

```http
POST /api/workspaces/:workspaceId/approvals/:requestId/resolve
Content-Type: application/json

{"decision":"allow_once"}
```

审批卡显示 Agent、Provider、工具、风险、命令摘要、受影响路径和作用域按钮。

```http
GET /api/workspaces/:workspaceId/approval-grants
DELETE /api/workspaces/:workspaceId/approval-grants/:grantId
```

ApprovalGrantPanel 显示有效期、Provider/version、tool pattern、最大风险与撤销动作。撤销幂等并产生公开审计事件。

- [ ] **Step C6.6：验证**

```powershell
pnpm.cmd --filter @agentos/agent-core test
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/ApprovalRegistry.test.ts src/services/ToolRiskClassifier.test.ts src/routes/approvals.test.ts
pnpm.cmd --filter @agentos/web test
pnpm.cmd -r run build
```

- [ ] **Step C6.7：提交**

```powershell
git add packages/shared/src/types/index.ts packages/agent-core/src/adapters/types.ts packages/agent-core/src/executor.ts apps/server/src/services/ApprovalRegistry.ts apps/server/src/services/ApprovalRegistry.test.ts apps/server/src/services/ToolRiskClassifier.ts apps/server/src/services/ToolRiskClassifier.test.ts apps/server/src/routes/approvals.ts apps/server/src/routes/approvals.test.ts apps/server/src/index.ts apps/web/src/components/runs/ToolApprovalCard.tsx apps/web/src/components/runs/ApprovalGrantPanel.tsx
git commit -m "feat: pass through provider tool approvals"
```

### Task C6 验收标准

- 仅 capability=true 的 Provider 显示并处理逐工具审批。
- allow_once/run/conversation/deny 作用域正确且可审计。
- 重启、超时、取消默认 deny，不留下永久 waiting Promise。
- 不支持审批协议的 Provider 使用运行前 policy，并显示 unsupported。
- 风险标签不被宣传为系统级拦截保证。
- critical 仅允许 allow_once；conversation grant 仅覆盖 low/medium 且最长 24 小时。
- Grant 可查看、撤销、过期；Provider/version/config hash/tool/fingerprint 变化后自动失效。

---

## Task C7：协作阶段验收

**Files:**

- Create: `scripts/verify-role-collaboration.mjs`
- Create: `scripts/verify-role-collaboration.ps1`
- Create: `docs/acceptance/role-collaboration-final.md`
- Modify: `docs/AGENTOS_V2.md`

- [ ] **Step C7.1：自动化矩阵**

覆盖 direct/group、三 dispatch mode、mentions、leader self/partial/full/need_user、waiting resume、read failure、write failure no changes、partial write decision、approval supported/unsupported、restart。

- [ ] **Step C7.2：全量验证**

```powershell
pnpm.cmd --filter @agentos/agent-core test
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web test
pnpm.cmd -r run build
git diff --check
```

- [ ] **Step C7.3：真实浏览器人工 Gate**

验证 Agent Presence、角色编辑、@mention、leader_route、waiting、部分写入暂停、Run intent 和审批卡；自动浏览器 Gate 在计划 D 固化。

- [ ] **Step C7.4：提交**

```powershell
git add scripts/verify-role-collaboration.mjs scripts/verify-role-collaboration.ps1 docs/acceptance/role-collaboration-final.md docs/AGENTOS_V2.md
git commit -m "docs: close role collaboration acceptance"
```

### Task C7 验收标准

- 简单消息不会默认跑完整团队。
- Provider、roleKind、permissions 的组合测试通过。
- waiting/partial write/approval 重启恢复无永久 running。
- 全量测试构建通过，用户确认后才进入 Worktree 计划。

## 计划 C 停止点

完成后停止实施。`parallel_isolated` 仍必须返回 409；只有计划 D 完成 clean gate、完整 Artifact 恢复和安全清理后才能启用。
