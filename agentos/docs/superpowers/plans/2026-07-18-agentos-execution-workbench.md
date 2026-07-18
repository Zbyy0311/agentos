# AgentOS Execution Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可重启恢复的持久事件顺序与 RunStep 状态机，并交付高可读聊天、任务树、工具轨迹、统计、静态执行档案和 Artifact 预览。

**Architecture:** SQLite `AgentEvent.sequence` 是执行顺序真相，SSE cursor 只负责短期传输重放。RunStep 使用 stable key 幂等创建、attempt 记录恢复/重试、sequence 表示公开顺序；前端从同一组持久数据投影实时 Inspector 和历史执行档案，不用 timestamp 或 UI 类型优先级猜顺序。

**Tech Stack:** TypeScript、Express、`node:sqlite`、Next.js 14、React 18、SSE、Vitest、Node Test Runner、react-markdown、remark-gfm、react-syntax-highlighter、@tanstack/react-virtual。

**Base:** 用户已验收并在 `docs/acceptance/provider-runtime-final.md` 记录的计划 A Task A6 HEAD。

**Branch:** `codex/agentos-execution-workbench`。

## Global Constraints

- 必须基于已通过计划 A 验收的 Provider Runtime HEAD。
- 不展示 reasoning 原文；任务树只保存服务端真实编排阶段。
- `RunStreamRegistry.cursor` 不持久化，不可作为历史排序依据。
- AgentEvent sequence 必须由 SQLite 原子分配，不由前端或 `Date.now()` 生成。
- RunStep created/update 必须幂等；重启后 Run、Execution、RunStep 终态一致。
- Markdown 不启用 raw HTML；代码、链接、图片和表格必须经过安全渲染。
- 第一版执行档案是静态筛选与定位，不实现 0.5x/1x/2x/4x、播放、暂停或拖动。

## Plan Start Gate

- [ ] 读取计划 A 最终验收记录并人工确认其中 HEAD 是本计划唯一基准。
- [ ] 执行 `git status --short`；非空则停止，不把计划 A 残留改动带入新分支。
- [ ] 执行 `git rev-parse HEAD` 并写入 `docs/acceptance/execution-workbench-baseline.md`。
- [ ] 确认分支不存在后执行 `git switch -c codex/agentos-execution-workbench`。

验收：baseline 文档包含 base branch、base HEAD、Node/pnpm 版本和全量测试结果；未执行 reset、clean 或覆盖性 checkout。

---

## Task B1：持久化 AgentEvent sequence

**Files:**

- Create: `docs/acceptance/execution-workbench-baseline.md`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `apps/server/src/events/EventBus.ts`
- Modify: `apps/server/src/events/createAgentEvent.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`
- Modify: `apps/server/src/services/RunStreamRegistry.ts`
- Modify: `apps/server/src/services/RunStreamRegistry.test.ts`
- Modify: `apps/server/src/index.ts`

**Interfaces:**

```ts
export interface AgentEventDraft<TPayload = Record<string, unknown>> {
  eventId: string;
  schemaVersion: 2;
  type: AgentEventType;
  workspaceId: string;
  conversationId: string;
  runId: string;
  executionId?: string;
  agentId?: string;
  timestamp: string;
  payload: TPayload;
}

export interface AgentEvent<TPayload = Record<string, unknown>> extends AgentEventDraft<TPayload> {
  sequence: number;
}

export interface PersistEventResult {
  event: AgentEvent;
  inserted: boolean;
}

export interface EventBusContract {
  publish(draft: AgentEventDraft): Promise<AgentEvent>;
  broadcastPersisted(event: AgentEvent): Promise<void>;
}
```

SQLite 新表：

```sql
CREATE TABLE IF NOT EXISTS run_event_sequences (
  run_id TEXT PRIMARY KEY,
  next_sequence INTEGER NOT NULL
);
```

`agent_events` 新增 `sequence INTEGER`，迁移完成后唯一索引：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS agent_events_run_sequence
ON agent_events (run_id, sequence);
```

- [ ] **Step B1.1：先写同 Run 原子顺序测试**

```ts
test('assigns monotonic sequence per run and keeps duplicate event ids idempotent', async () => {
  const first = store.appendAgentEvent(draft({ eventId: 'event-a', runId: 'run-a' }));
  const second = store.appendAgentEvent(draft({ eventId: 'event-b', runId: 'run-a' }));
  const duplicate = store.appendAgentEvent(draft({ eventId: 'event-a', runId: 'run-a' }));
  assert.equal(first.event.sequence, 1);
  assert.equal(second.event.sequence, 2);
  assert.equal(duplicate.event.sequence, 1);
  assert.equal(duplicate.inserted, false);
});
```

- [ ] **Step B1.2：迁移旧事件顺序**

Store migration 在事务内按每个 run 的 `timestamp ASC, rowid ASC` 仅做一次历史 backfill；然后设置 `run_event_sequences.next_sequence = MAX(sequence) + 1`。这是旧数据迁移规则，不是新事件排序规则。

- [ ] **Step B1.3：让 EventBus 先持久化再广播**

```ts
export class EventBus {
  constructor(
    private readonly persist: (draft: AgentEventDraft) => PersistEventResult,
    private readonly onSubscriberError: (error: unknown, event: AgentEvent) => void,
  ) {}

  async publish(draft: AgentEventDraft): Promise<AgentEvent> {
    const result = this.persist(draft);
    if (result.inserted) await this.broadcastPersisted(result.event);
    return result.event;
  }

  async broadcastPersisted(event: AgentEvent): Promise<void> {
    const results = await Promise.allSettled(
      [...this.subscribers].map(subscriber => subscriber(event)),
    );
    results.forEach(result => {
      if (result.status === 'rejected') this.onSubscriberError(result.reason, event);
    });
  }
}
```

删除 `index.ts` 中 `eventBus.subscribe(event => store.appendAgentEvent(event))`，改为 `new EventBus(draft => store.appendAgentEvent(draft), reportSubscriberError)`。普通事件通过 `publish` 持久化；已经在领域事务内持久化的事件只能通过 `broadcastPersisted` 广播。subscriber 失败写诊断但不得 reject 已提交的 Run/Execution。

- [ ] **Step B1.4：SSE 继续使用 cursor，但 data 包含 sequence**

`RunStreamRegistry` cursor 从 1 开始、保留 60 秒的行为不变；当 data 是 AgentEvent 时带 persisted sequence。前端去重优先 eventId，历史排序优先 sequence。

- [ ] **Step B1.5：验证并发发布**

并发 `Promise.all` 发布 1000 个同 Run draft，断言 sequence 为 1..1000 且无重复；不同 Run 均从 1 开始。

- [ ] **Step B1.6：运行测试**

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/store/SqliteStore.test.ts src/services/RunStreamRegistry.test.ts
pnpm.cmd --filter @agentos/server test
pnpm.cmd -r run build
```

- [ ] **Step B1.7：提交**

```powershell
git add docs/acceptance/execution-workbench-baseline.md packages/shared/src/types/index.ts apps/server/src/events/EventBus.ts apps/server/src/events/createAgentEvent.ts apps/server/src/store/SqliteStore.ts apps/server/src/store/SqliteStore.test.ts apps/server/src/services/RunStreamRegistry.ts apps/server/src/services/RunStreamRegistry.test.ts apps/server/src/index.ts
git commit -m "feat: persist ordered agent event sequences"
```

### Task B1 验收标准

- 新事件 sequence 由 SQLite 原子分配，单 Run 严格单调递增。
- 重复 eventId 不消耗新 sequence，也不再次广播。
- 单个 subscriber 抛错不阻止其他 subscriber，也不让已提交业务操作失败。
- 旧 AgentEvent 全部完成 backfill，记录数不减少。
- SSE cursor 重连测试不回归，但历史 UI 不使用 cursor 排序。
- 1000 并发事件测试无重复 sequence 或唯一约束错误。

---

## Task B2：RunStep 幂等状态机、attempt 与重启恢复

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Create: `apps/server/src/services/RunStepService.ts`
- Create: `apps/server/src/services/RunStepService.test.ts`
- Modify: `apps/server/src/services/ConversationService.ts`
- Modify: `apps/server/src/services/ConversationService.test.ts`
- Modify: `apps/server/src/runRecovery.ts`
- Create: `apps/server/src/runRecovery.test.ts`
- Modify: `apps/server/src/routes/runs.ts`
- Modify: `apps/server/src/routes/runs.test.ts`

**Interfaces:**

```ts
export type RunStepKind = 'context' | 'agent' | 'review' | 'artifact' | 'summary';
export type RunStepStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'skipped';

export interface RunStep {
  id: string;
  stableStepKey: string;
  workspaceId: string;
  runId: string;
  parentStepId?: string;
  executionId?: string;
  agentId?: string;
  kind: RunStepKind;
  title: string;
  status: RunStepStatus;
  sequence: number;
  attempt: number;
  createdEventSequence: number;
  updatedEventSequence: number;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunStepInput {
  stableStepKey: string;
  workspaceId: string;
  runId: string;
  parentStepId?: string;
  agentId?: string;
  kind: RunStepKind;
  title: string;
  sequence: number;
}

export interface UpdateRunStepInput {
  workspaceId: string;
  runId: string;
  stableStepKey: string;
  status: RunStepStatus;
  executionId?: string;
  summary?: string;
}

export interface RunStepMutation {
  eventId: string;
  operation: 'create' | 'update';
  input: CreateRunStepInput | UpdateRunStepInput;
}

export interface PersistRunStepMutationResult {
  step: RunStep;
  event: AgentEvent;
  inserted: boolean;
}

export interface RunStepStore {
  persistRunStepMutation(
    mutation: RunStepMutation,
    eventDraft: AgentEventDraft,
  ): PersistRunStepMutationResult;
}
```

索引：

```sql
CREATE UNIQUE INDEX run_steps_stable_key
ON run_steps (run_id, stable_step_key);

CREATE UNIQUE INDEX run_steps_sibling_sequence
ON run_steps (run_id, IFNULL(parent_step_id, ''), sequence);
```

- [ ] **Step B2.1：先写幂等创建和索引测试**

```ts
test('returns the existing logical step for the same stable key', async () => {
  const first = await service.createOrGet(input({ stableStepKey: 'direct.agent' }));
  const second = await service.createOrGet(input({ stableStepKey: 'direct.agent' }));
  assert.equal(first.id, second.id);
  assert.equal(store.listRunSteps('workspace-a', 'run-a').length, 1);
});
```

另测两个不同 stable key 使用相同 sibling sequence 时触发唯一约束，并增加事务失败注入：Step 写入失败时 AgentEvent/sequence 均回滚，AgentEvent 写入失败时 Step/sequence 均回滚。

- [ ] **Step B2.2：实现状态转换**

```ts
const allowed: Record<RunStepStatus, readonly RunStepStatus[]> = {
  pending: ['running', 'cancelled', 'skipped'],
  running: ['waiting', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'failed', 'cancelled'],
  completed: [], failed: [], cancelled: [], skipped: [],
};
```

同一终态更新幂等；waiting 恢复时复用同一 stable key，绑定新 executionId 并 `attempt += 1`。

- [ ] **Step B2.3：初始化 direct Run 模板**

```ts
const directSteps = [
  { stableStepKey: 'direct.context', sequence: 10, kind: 'context', title: '准备上下文' },
  { stableStepKey: 'direct.agent', sequence: 20, kind: 'agent', title: 'Agent 执行' },
  { stableStepKey: 'direct.artifacts', sequence: 30, kind: 'artifact', title: '收集变更与产物' },
  { stableStepKey: 'direct.summary', sequence: 40, kind: 'summary', title: '交付结果' },
] as const;
```

sequence 以 10 递增，后续可插入步骤但同级顺序仍唯一。

- [ ] **Step B2.4：实现 Store 级原子 Step/Event 事务**

`SqliteStore.persistRunStepMutation(mutation, eventDraft)` 在同一 SQLite transaction 中：

1. 按 eventId 检查幂等；已存在则返回原 event/step，`inserted=false`。
2. 为 run 分配下一个 AgentEvent sequence。
3. create/update RunStep，并把该 sequence 写入 created/updatedEventSequence。
4. 插入包含最终 step snapshot 的 AgentEvent。
5. commit 后返回 `PersistRunStepMutationResult`。

任一步失败全部 rollback，不广播。`RunStepService` 收到 committed result 后调用 `eventBus.broadcastPersisted(result.event)`；严禁再调用 `publish` 导致重复持久化。broadcast subscriber 失败只记录诊断，不改变 transaction 结果。

- [ ] **Step B2.5：绑定真实生命周期**

- context：RunContextBuilder 开始/完成。
- agent：Execution queued -> running/waiting/terminal。
- artifacts：collector finalize 开始/完成。
- summary：响应消息与 Run 终态持久化完成。
- cancel/fail：当前 step terminal，后续 pending 进入 cancelled/skipped。

每次 created/update 都通过 `persistRunStepMutation` 原子提交，不允许“先 publish 再更新 step”或“先更新 step 再 publish”的双写路径。

- [ ] **Step B2.6：修复启动恢复**

扩展 `recoverInterruptedRuns`：

1. 找出 queued/running Run。
2. 将其非终态 Execution 更新为 failed，原因“服务重启导致执行中断”。
3. 将关联 running step 更新为 failed。
4. 将未开始 pending step 更新为 skipped。
5. waiting_user Run/Step 保持 waiting，不标失败。
6. 重复执行 recovery 不产生第二次状态变化或重复事件。

- [ ] **Step B2.7：扩展 Run Details**

`AgentRunDetails.steps` 按 `sequence ASC` 返回；旧 Run 返回空数组，不临时伪造。

- [ ] **Step B2.8：运行测试**

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/RunStepService.test.ts src/services/ConversationService.test.ts src/runRecovery.test.ts src/routes/runs.test.ts
pnpm.cmd --filter @agentos/server test
pnpm.cmd -r run build
```

- [ ] **Step B2.9：提交**

```powershell
git add packages/shared/src/types/index.ts apps/server/src/store/SqliteStore.ts apps/server/src/services/RunStepService.ts apps/server/src/services/RunStepService.test.ts apps/server/src/services/ConversationService.ts apps/server/src/services/ConversationService.test.ts apps/server/src/runRecovery.ts apps/server/src/runRecovery.test.ts apps/server/src/routes/runs.ts apps/server/src/routes/runs.test.ts
git commit -m "feat: persist recoverable run steps"
```

### Task B2 验收标准

- `UNIQUE(run_id, stable_step_key)` 真正防止重复逻辑步骤。
- 同级 sequence 唯一；不再使用 `(run_id, order_index, id)` 伪唯一索引。
- waiting_user 恢复复用原 step 并增加 attempt，不重复创建模板。
- Server 重启后 Run、Execution、RunStep 同步进入 failed/skipped；waiting 保持可恢复。
- recovery 重复执行幂等，AgentEvent 不重复。
- RunStep 与对应 AgentEvent 在同一 transaction 中提交；任何失败注入后两者都不存在半完成状态。
- 已持久化事件只走 `broadcastPersisted`，subscriber 异常不让 Run 变为 failed。

---

## Task B3：执行 Inspector 与任务树

**Files:**

- Create: `apps/web/src/lib/runSteps.ts`
- Create: `apps/web/src/lib/runSteps.test.ts`
- Create: `apps/web/src/components/runs/RunTaskTree.tsx`
- Modify: `apps/web/src/lib/executionInspector.ts`
- Modify: `apps/web/src/components/chat/ExecutionInspector.tsx`
- Modify: `apps/web/src/components/chat/ExecutionInspector.test.tsx`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**

```ts
export interface RunTaskTreeItem {
  id: string;
  stableStepKey: string;
  title: string;
  status: RunStepStatus;
  sequence: number;
  attempt: number;
  agentId?: string;
  durationMs?: number;
}

export function toRunTaskTree(steps: readonly RunStep[]): RunTaskTreeItem[];
```

- [ ] **Step B3.1：先写 sequence/upsert 测试**

覆盖乱序 arrival、重复 eventId、相同 step 更新、waiting -> running attempt、terminal duration 和空态。

- [ ] **Step B3.2：实现实时状态 upsert**

`page.tsx` 收到 `run.step.created/updated` 后按 step id upsert，展示按 step.sequence 排序。SSE 重放重复 eventId 不得重复应用。

- [ ] **Step B3.3：实现 Inspector 信息架构**

```text
Agent / 团队摘要
当前动作
任务进度
工具历史（最近 8 条，可展开）
Tokens / Duration / Files
打开完整执行档案
```

waiting 显示蓝色；failed 红色；cancelled/skipped 弱化；不显示 reasoning。

- [ ] **Step B3.4：刷新恢复**

进入已有 Conversation 时加载最新 Run Details 的 steps/events；切换 Conversation 清空旧 state；实时事件随后从 persisted sequence 继续。

- [ ] **Step B3.5：验证**

```powershell
pnpm.cmd --filter @agentos/web test
pnpm.cmd --filter @agentos/web build
```

- [ ] **Step B3.6：提交**

```powershell
git add apps/web/src/lib/runSteps.ts apps/web/src/lib/runSteps.test.ts apps/web/src/components/runs/RunTaskTree.tsx apps/web/src/lib/executionInspector.ts apps/web/src/components/chat/ExecutionInspector.tsx apps/web/src/components/chat/ExecutionInspector.test.tsx apps/web/src/app/workspace/[id]/page.tsx apps/web/src/app/globals.css
git commit -m "feat: show live run task progress"
```

### Task B3 验收标准

- direct Run 实时显示 4 个服务端步骤，刷新后顺序与状态一致。
- 重放/重连不会重复 step 或 tool card。
- plain fallback 仍显示任务树和通用状态，工具区明确无结构化数据。
- 1280/1440/1920px 与深浅色均无横向溢出或 Inspector 覆盖聊天。

---

## Task B4：聊天 GFM、代码、Diff 与长会话体验

**Files:**

- Modify: `apps/web/package.json`
- Create: `apps/web/src/components/chat/MarkdownMessage.tsx`
- Create: `apps/web/src/components/chat/MarkdownMessage.test.tsx`
- Create: `apps/web/src/components/chat/DiffBlock.tsx`
- Create: `apps/web/src/lib/chatScroll.ts`
- Create: `apps/web/src/lib/chatScroll.test.ts`
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`
- Modify: `apps/web/src/components/chat/ComposerControls.tsx`
- Modify: `apps/web/src/lib/responseRendering.ts`
- Modify: `apps/web/src/app/globals.css`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/services/ConversationService.ts`
- Modify: `apps/server/src/services/ConversationService.test.ts`

**Dependencies:**

```json
{
  "react-markdown": "^9.0.1",
  "remark-gfm": "^4.0.0",
  "react-syntax-highlighter": "^15.6.1",
  "@tanstack/react-virtual": "^3.13.12"
}
```

- [ ] **Step B4.1：先写 Markdown 失败测试**

测试 GFM table、标题、嵌套列表、任务列表、链接、inline code、fenced code、Diff、恶意 raw HTML、`javascript:` URL、远程 tracking pixel 以及同源 Artifact 图片。

- [ ] **Step B4.2：实现安全 MarkdownMessage**

使用 `react-markdown + remark-gfm`，不启用 `rehype-raw`。链接只允许 http/https；本地相对文件路径匹配现有 Artifact 时打开预览，否则提供复制路径。远程 http/https 图片默认不发起网络请求，只显示域名、风险提示和“加载外部图片”按钮；用户明确点击后使用 `referrerPolicy="no-referrer"` 加载。仅 AgentOS 同源 Artifact URL 可自动内联。代码块超过 80 行默认折叠，保留“展开全部”。

- [ ] **Step B4.3：实现代码和 Diff 视觉**

代码按 language class 使用 syntax highlighter；diff 行按 `+/-/@@` 分层，长行横向滚动，不强制换行破坏 patch。

- [ ] **Step B4.4：区分四类消息层级**

- user：强调色、靠右、较窄宽度。
- agent：正文卡、Agent 名称/角色、Markdown。
- system：低强调状态卡。
- tool：不混入正文，保留 Inspector/执行档案入口。

Run 终态对应的最后 agent message 增加“最终结论”标签。为历史映射，`ConversationMessage` 增加可选 `runId`，`ConversationService` 在创建最终响应消息时写入当前 runId，SQLite 迁移增加可空列；旧消息保持 undefined。

- [ ] **Step B4.5：输入框和滚动锚点**

Textarea 根据内容自动高度，最小 96px、最大 40vh；用户停留底部时跟随新 chunk，向上阅读时不抢滚动并显示“有新消息”按钮。

- [ ] **Step B4.6：长会话虚拟列表**

消息超过 100 条时启用 `@tanstack/react-virtual`；图片/代码块高度变化后重新测量。100 条以下保持简单 DOM，避免无必要复杂度。

- [ ] **Step B4.7：验证**

```powershell
pnpm.cmd install --frozen-lockfile=false
pnpm.cmd --filter @agentos/web test
pnpm.cmd --filter @agentos/web build
```

- [ ] **Step B4.8：提交**

```powershell
git add apps/web/package.json pnpm-lock.yaml apps/web/src/components/chat/MarkdownMessage.tsx apps/web/src/components/chat/MarkdownMessage.test.tsx apps/web/src/components/chat/DiffBlock.tsx apps/web/src/lib/chatScroll.ts apps/web/src/lib/chatScroll.test.ts apps/web/src/components/chat/ChatPanel.tsx apps/web/src/components/chat/ComposerControls.tsx apps/web/src/lib/responseRendering.ts apps/web/src/app/globals.css packages/shared/src/types/index.ts apps/server/src/store/SqliteStore.ts apps/server/src/services/ConversationService.ts apps/server/src/services/ConversationService.test.ts
git commit -m "feat: improve chat reading experience"
```

### Task B4 验收标准

- Markdown 表格渲染为真实 table，不显示原始竖线文本。
- 代码高亮、Diff、长代码折叠和文件路径操作可用。
- raw HTML 与危险 URL 不执行。
- 远程 Markdown 图片默认不加载；只有同源 Artifact 自动内联。
- 用户/Agent/系统/工具视觉层级明确，最终结论不与工具过程混杂。
- 用户向上阅读时流式 chunk 不抢滚动；点击“有新消息”回到底部。
- 500 条消息 fixture 可滚动，DOM 节点数量受虚拟列表控制。

---

## Task B5：静态执行档案与 Artifact 内联预览

**Files:**

- Create: `apps/web/src/lib/executionArchive.ts`
- Create: `apps/web/src/lib/executionArchive.test.ts`
- Create: `apps/web/src/components/runs/ExecutionArchive.tsx`
- Create: `apps/web/src/components/runs/ArtifactPreviewDialog.tsx`
- Modify: `apps/web/src/components/runs/ArtifactShelf.tsx`
- Modify: `apps/web/src/components/runs/RunDetails.tsx`
- Modify: `apps/web/src/lib/artifacts.ts`
- Modify: `apps/server/src/routes/artifacts.ts`
- Modify: `apps/server/src/routes/artifacts.test.ts`

**Interfaces:**

```ts
export type ArchiveItemKind = 'step' | 'status' | 'tool' | 'output' | 'artifact' | 'terminal';

export interface ExecutionArchiveItem {
  id: string;
  sequence: number;
  kind: ArchiveItemKind;
  title: string;
  detail?: string;
  agentId?: string;
  failed: boolean;
}

export interface ArchiveFilter {
  kinds: ArchiveItemKind[];
  agentId?: string;
  failuresOnly: boolean;
  fileChangesOnly: boolean;
}

export function buildExecutionArchive(details: AgentRunDetails): ExecutionArchiveItem[];
```

- [ ] **Step B5.1：先写 sequence 排序测试**

输入相同 timestamp、乱序数组和不同类型事件；断言只按 persisted sequence 排序，stable id 仅用于非法旧数据兜底并产生 warning。

- [ ] **Step B5.2：实现静态筛选**

提供 Agent、工具、文件变化、失败、终态筛选和文本搜索；点击 item 定位对应 step/tool/artifact。没有播放、timer 或速度状态。

- [ ] **Step B5.3：实现 Artifact 预览**

- image：安全 URL 内联。
- diff/report/log/文本 file：最多加载 256 KiB。
- 二进制/大文件：显示元数据并在新标签打开。
- UI 文案统一为“产物/打开/仅元数据”。

- [ ] **Step B5.4：安全路由测试**

继续覆盖 Workspace 越权、路径穿越、symlink 逃逸、伪 MIME、过大内容和 `nosniff`/CSP 响应头。

- [ ] **Step B5.5：验证**

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/routes/artifacts.test.ts
pnpm.cmd --filter @agentos/web test
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web build
```

- [ ] **Step B5.6：提交**

```powershell
git add apps/web/src/lib/executionArchive.ts apps/web/src/lib/executionArchive.test.ts apps/web/src/components/runs/ExecutionArchive.tsx apps/web/src/components/runs/ArtifactPreviewDialog.tsx apps/web/src/components/runs/ArtifactShelf.tsx apps/web/src/components/runs/RunDetails.tsx apps/web/src/lib/artifacts.ts apps/server/src/routes/artifacts.ts apps/server/src/routes/artifacts.test.ts
git commit -m "feat: add searchable execution archives"
```

### Task B5 验收标准

- 档案严格按 AgentEvent sequence 展示，不以 timestamp/type priority 排序。
- 可以只看失败、工具、文件修改或指定 Agent。
- Artifact 小文本/图片可内联，大文件安全降级。
- 不存在回放 timer、速度选择或自动滚动同步复杂度。
- 刷新后相同 Run 产生相同档案顺序和筛选结果。

---

## Task B6：执行工作台阶段验收

**Files:**

- Create: `scripts/verify-execution-workbench.mjs`
- Create: `scripts/verify-execution-workbench.ps1`
- Create: `docs/acceptance/execution-workbench-final.md`
- Modify: `docs/AGENTOS_V2.md`
- Modify: `docs/PROJECT_OVERVIEW.md`

- [ ] **Step B6.1：自动化回归**

```powershell
pnpm.cmd --filter @agentos/agent-core test
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web test
pnpm.cmd -r run build
git diff --check
```

- [ ] **Step B6.2：大数据 fixture Gate**

生成 1000 个 AgentEvent、100 个 tool pair、20 个 RunStep、500 条消息和 5 个 Artifact。断言：

- Run Details API 本机冷查询小于 500ms。
- `buildExecutionArchive` 处理 1000 事件小于 50ms。
- 页面 5 秒内可交互，工具/消息筛选无明显冻结。
- SSE 重放重复 300 事件后 UI 无重复项。

- [ ] **Step B6.3：人工浏览器体验 Gate**

本阶段人工检查 Markdown 表格、代码、Diff、输入框、滚动锚点、虚拟列表、Inspector 和 Artifact；自动 Playwright Gate 在计划 D 固化。

- [ ] **Step B6.4：提交**

```powershell
git add scripts/verify-execution-workbench.mjs scripts/verify-execution-workbench.ps1 docs/acceptance/execution-workbench-final.md docs/AGENTOS_V2.md docs/PROJECT_OVERVIEW.md
git commit -m "docs: close execution workbench acceptance"
```

### Task B6 验收标准

- 全量测试/构建/diff check 通过。
- 重启、waiting resume、SSE 重放和大数据 fixture 均通过。
- 文档明确本阶段浏览器 Gate 为人工，不冒充一键自动化。
- 用户确认聊天阅读体验和执行档案后再进入计划 C。

## 计划 B 停止点

完成后停止实施。只有 persisted sequence、RunStep reconcile、聊天 GFM 和静态档案全部通过，才允许计划 C 把群聊编排绑定到 RunStep。
