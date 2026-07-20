# AgentOS Runtime Specification v2.0

## 09 — Conversation Runtime

> Status: Draft  
> Version: 2.0  
> Last Updated: 2026-07-19  
> Scope: AgentOS v2 Persistent Conversation, Message and Multi-Agent Collaboration Runtime  
> Depends On:
> - `00-Vision.md`
> - `01-Core-Concepts.md`
> - `02-Runtime-Lifecycle.md`
> - `03-Event-Model.md`
> - `04-Provider-Specification.md`
> - `05-Process-Runtime.md`
> - `06-Worktree-Runtime.md`
> - `07-Memory-Runtime.md`
> - `08-Policy-Runtime.md`
> Repository: `Zbyy0311/agentos`

---

## 1. Document Purpose

本文件定义 AgentOS v2 的 Conversation Runtime。

Conversation Runtime 是 AgentOS 中负责持久聊天、Agent 成员、群组协作、消息生命周期、流式消息、Task / Run 桥接、审批卡片、Artifact 引用、历史记录、上下文压缩、未读状态、通知和前端实时同步的协作运行时。

它规定：

- Conversation 的定义和边界；
- Direct Conversation；
- Group Conversation；
- Task Conversation；
- Run Conversation；
- System Conversation；
- Conversation Member；
- Agent Membership；
- User Membership；
- Message；
- Message Revision；
- Message Block；
- Message Attachment；
- Message Reference；
- Message Thread；
- Mention；
- Command；
- Message Routing；
- Agent Turn；
- Group Speaker Selection；
- Parallel Reply；
- Sequential Reply；
- Orchestrator；
- Task 创建；
- Run 启动；
- Approval Interaction；
- Runtime Event Projection；
- Streaming；
- Draft；
- Final Message；
- Read State；
- Unread Count；
- Notification；
- Presence；
- Typing；
- History；
- Context Window；
- Conversation Summary；
- Memory Integration；
- Search；
- Archive；
- Export；
- Retention；
- Policy；
- SQLite Schema；
- API；
- SSE / WebSocket；
- Inspector；
- 测试；
- v1 迁移。

本文件的目标是确保：

> Conversation 是 AgentOS 的持久协作空间，而不是一次 Provider Session、一次 HTTP 请求或一个临时前端状态。

---

## 2. Conversation Runtime Positioning

AgentOS v2 的协作链：

```text
User / Agent / System
        ↓
Conversation
        ↓
Message
        ↓
Routing and Intent Resolution
  ├── Chat Reply
  ├── Task Creation
  ├── Run Creation
  ├── Approval Decision
  ├── Artifact Reference
  └── Conversation Command
        ↓
Agent Turn / Runtime Action
        ↓
Provider Session / Run
        ↓
Runtime Event
        ↓
Conversation Projection
        ↓
Message / Status Card / Notification
```

Conversation Runtime 负责：

```text
谁在说话
说了什么
发给谁
是否需要响应
是否创建任务
是否启动执行
如何展示结果
```

它不负责：

- Provider CLI 参数；
- Process Tree；
- Worktree 创建；
- Memory 排名算法；
- Policy Rule 匹配；
- Git Merge 实现。

---

## 3. Core Principles

### 3.1 Conversation Is Durable

浏览器刷新、客户端断线或 Server 重启后，Conversation 和 Message 必须保留。

### 3.2 Conversation Is Not Provider Session

```text
Conversation
  = persistent collaboration history

Provider Session
  = one provider-native execution session
```

同一个 Conversation 可以产生多个 Task、Run 和 Provider Session。

### 3.3 Message Is Not Runtime Event

```text
Message
  = human-readable collaboration object

Runtime Event
  = structured runtime fact
```

Runtime Event 可以投影成 Message，但不能把二者合并成同一对象。

### 3.4 Chat Does Not Automatically Mean Run

用户发送普通消息时，系统不应默认启动工程执行。

必须通过：

- 明确命令；
- 明确任务意图；
- Workspace 自动运行规则；
- Agent 请求并经用户确认；

决定是否创建 Task 或 Run。

### 3.5 Agent Identity Is Persistent

Conversation 中展示的是 Agent Profile 身份。

Provider 可以在不同 Run 中切换，不改变 Agent 在 Conversation 中的角色身份。

### 3.6 Group Chat Requires Turn Control

多个 Agent 不能因为看到彼此消息而无限互相回复。

必须有：

- Turn Policy；
- Reply Budget；
- Mention Rule；
- Orchestrator；
- Loop Guard。

### 3.7 Streaming Is a Message Projection

流式文本必须最终归并为持久 Message 或 Message Revision。

不能只存在于前端内存。

### 3.8 Runtime State Must Be Referenced, Not Duplicated

Conversation 中的 Run 卡片可以展示状态。

真实状态仍来自：

- Run；
- Stage；
- Runtime Event；
- Artifact。

### 3.9 History Is Not Memory

Conversation 保存完整历史。

Memory Runtime 只提取未来值得使用的知识。

### 3.10 User Controls Collaboration

用户可以：

- 选择 Agent；
- 创建群聊；
- 添加或移除 Agent；
- 设置 Agent Role；
- 决定谁回复；
- 取消当前 Turn；
- 创建 Task；
- 启动 Run；
- Archive Conversation。

### 3.11 Every Automated Projection Is Idempotent

同一个 Runtime Event 不得重复生成多个相同 Message。

### 3.12 Conversation Must Degrade Gracefully

某个 Provider 不可用时，Conversation 仍可：

- 查看历史；
- 编辑 Task；
- 切换 Agent；
- 选择其他 Provider；
- 重试 Run。

---

# Part I — Conversation Domain Model

## 4. Conversation

### 4.1 Definition

Conversation 是一个持久的协作容器。

```ts
interface Conversation {
  id: string;

  workspaceId: string;

  type:
    | 'direct'
    | 'group'
    | 'task'
    | 'run'
    | 'system';

  title: string;

  description?: string;

  avatar?: string;

  status:
    | 'active'
    | 'muted'
    | 'archived'
    | 'deleted';

  ownerUserId: string;

  defaultAgentId?: string;

  orchestratorAgentId?: string;

  linkedTaskId?: string;

  linkedRunId?: string;

  replyPolicy: ConversationReplyPolicy;

  contextPolicy: ConversationContextPolicy;

  notificationPolicy: ConversationNotificationPolicy;

  retentionPolicyId?: string;

  lastMessageId?: string;

  lastMessageAt?: string;

  createdAt: string;

  updatedAt: string;

  archivedAt?: string;

  deletedAt?: string;

  version: number;
}
```

### 4.2 Conversation Invariants

1. Conversation 必须属于 Workspace。
2. Direct Conversation 至少包含一个 User 和一个 Agent。
3. Group Conversation 可以包含多个 Agent。
4. Task Conversation 必须关联 Task。
5. Run Conversation 必须关联 Run。
6. Conversation 不拥有 Provider Process。
7. Conversation 关闭不取消 Run。
8. Conversation 删除默认软删除。
9. Runtime Event Projection 必须幂等。
10. Conversation 状态变化必须产生 Event。
11. Archived Conversation 默认不可自动触发新 Turn。
12. Agent Membership 不等于 Provider Session。
13. 同一个 Agent 可以属于多个 Conversation。
14. 一个 Conversation 可以关联多个 Task 和 Run。
15. linkedTaskId / linkedRunId 只表示主关联，不限制其他引用。

---

## 5. Conversation Types

### 5.1 Direct Conversation

用户与一个主要 Agent 的单聊。

```text
User ↔ Backend Engineer
```

可以切换 Provider，但 Agent 身份保持不变。

### 5.2 Group Conversation

用户与多个 Agent 的群聊。

```text
User
├── Architect
├── Backend Engineer
├── Reviewer
└── Security Reviewer
```

必须配置 Reply Policy。

### 5.3 Task Conversation

围绕一个 Task 的持久讨论区。

可以包含：

- 需求澄清；
- Run 记录；
- Review；
- Approval；
- Artifact；
- 验收。

### 5.4 Run Conversation

围绕一个具体 Run 的执行对话。

主要用于：

- Runtime Status；
- Provider Output；
- User Intervention；
- Approval；
- Error；
- Resume；
- Result。

Run Conversation 不替代 Runtime Inspector。

### 5.5 System Conversation

用于：

- AgentOS 通知；
- Provider Authentication；
- Recovery；
- System Health；
- Policy Warning；
- Extension 安装结果。

System Conversation 默认只允许 System 发送消息。

---

## 6. Conversation Member

```ts
interface ConversationMember {
  id: string;

  conversationId: string;

  memberType:
    | 'user'
    | 'agent'
    | 'system'
    | 'extension';

  memberId: string;

  displayNameSnapshot: string;

  role:
    | 'owner'
    | 'participant'
    | 'orchestrator'
    | 'observer'
    | 'reviewer'
    | 'system';

  status:
    | 'active'
    | 'muted'
    | 'removed';

  replyMode:
    | 'always'
    | 'mentioned'
    | 'orchestrated'
    | 'manual'
    | 'never';

  priority: number;

  joinedAt: string;

  removedAt?: string;

  version: number;
}
```

### 6.1 Member Snapshot

Message 必须保存发送者显示名称快照。

Agent 后续改名不应改变历史消息显示。

### 6.2 Observer

Observer 可以读取 Conversation，但默认不自动回复。

### 6.3 Reviewer

Reviewer 可以被 Orchestrator 在需要 Review 时调用。

### 6.4 Removed Member

移除 Agent 后：

- 历史 Message 保留；
- Agent 不再接收新 Turn；
- 其 Task / Run 历史不删除。

---

## 7. Conversation Reply Policy

```ts
interface ConversationReplyPolicy {
  mode:
    | 'direct'
    | 'mention-only'
    | 'orchestrated'
    | 'round-robin'
    | 'parallel'
    | 'manual';

  maxAgentsPerTurn: number;

  maxRepliesPerAgentPerTurn: number;

  maxTotalRepliesPerTurn: number;

  allowAgentToAgentReplies: boolean;

  requireUserMentionForNewRun: boolean;

  orchestratorRequired: boolean;

  replyTimeoutMs?: number;

  loopGuard: ConversationLoopGuardPolicy;
}
```

### 7.1 Direct

默认 Agent 回复。

### 7.2 Mention-only

只有被 `@` 的 Agent 回复。

### 7.3 Orchestrated

Orchestrator 决定调用哪些 Agent。

### 7.4 Round-robin

按固定顺序回复，适合讨论模拟，不适合默认工程执行。

### 7.5 Parallel

多个 Agent 同时生成独立回复。

### 7.6 Manual

用户手动点击某个 Agent 响应。

---

## 8. Loop Guard

```ts
interface ConversationLoopGuardPolicy {
  maxAgentHops: number;

  requireUserMessageAfterAgentHops: number;

  duplicateContentThreshold: number;

  repeatedMentionLimit: number;

  stopOnNoNewInformation: boolean;

  stopOnSameAgentCycle: boolean;
}
```

### 8.1 Loop Examples

必须阻止：

```text
Agent A mentions Agent B
Agent B mentions Agent A
Agent A mentions Agent B
...
```

### 8.2 User Boundary

默认建议：

```text
Agent-to-Agent hops <= 2
```

超过后等待用户或 Orchestrator 决策。

---

## 9. Conversation Context Policy

```ts
interface ConversationContextPolicy {
  recentMessageLimit: number;

  maxCharacters: number;

  maxTokens?: number;

  includeSystemMessages: boolean;

  includeRunCards: boolean;

  includeToolDetails: boolean;

  includeRuntimeSummaries: boolean;

  useConversationSummary: boolean;

  useMemoryRuntime: boolean;

  allowCrossTaskContext: boolean;
}
```

---

## 10. Notification Policy

```ts
interface ConversationNotificationPolicy {
  muteAll: boolean;

  notifyOnMention: boolean;

  notifyOnAgentReply: boolean;

  notifyOnRunCompletion: boolean;

  notifyOnRunFailure: boolean;

  notifyOnApproval: boolean;

  notifyOnCriticalPolicyEvent: boolean;
}
```

---

# Part II — Message Domain Model

## 11. Message

### 11.1 Definition

Message 是 Conversation 中一个持久、可排序、可引用的协作对象。

```ts
interface Message {
  id: string;

  conversationId: string;

  workspaceId: string;

  senderType:
    | 'user'
    | 'agent'
    | 'system'
    | 'extension';

  senderId: string;

  senderDisplayNameSnapshot: string;

  messageType:
    | 'text'
    | 'task-reference'
    | 'run-reference'
    | 'run-status'
    | 'approval'
    | 'artifact'
    | 'review'
    | 'error'
    | 'system-notice'
    | 'command-result';

  status:
    | 'draft'
    | 'streaming'
    | 'final'
    | 'failed'
    | 'edited'
    | 'deleted';

  sequence: number;

  replyToMessageId?: string;

  threadRootMessageId?: string;

  sourceMessageId?: string;

  sourceEventId?: string;

  sourceTaskId?: string;

  sourceRunId?: string;

  sourceStageId?: string;

  sourceArtifactId?: string;

  clientMessageId?: string;

  idempotencyKey?: string;

  createdAt: string;

  finalizedAt?: string;

  editedAt?: string;

  deletedAt?: string;

  version: number;
}
```

### 11.2 Message Invariants

1. 同一 Conversation 中 Sequence 唯一且递增。
2. Message 创建后不可原地覆盖历史内容。
3. 编辑通过 Revision 表达。
4. Streaming Message 必须最终进入 Final、Failed 或 Deleted。
5. Runtime Event Projection 必须保留 `sourceEventId`。
6. User Client Retry 必须使用 `clientMessageId` 去重。
7. Message Delete 默认软删除。
8. Message 不保存 Provider Secret。
9. Message 引用的 Runtime 状态必须动态读取或带 Snapshot 标记。
10. Agent 消息必须关联 Agent Profile，而不是只关联 Provider。

---

## 12. Message Block

Message 内容由一个或多个 Block 组成。

```ts
interface MessageBlock {
  id: string;

  messageId: string;

  position: number;

  type:
    | 'text'
    | 'markdown'
    | 'code'
    | 'quote'
    | 'task-card'
    | 'run-card'
    | 'stage-card'
    | 'approval-card'
    | 'artifact-card'
    | 'diff-card'
    | 'review-card'
    | 'error-card'
    | 'tool-summary'
    | 'file-list'
    | 'image'
    | 'attachment'
    | 'system-status';

  contentJson: Record<string, unknown>;

  contentText?: string;

  status:
    | 'draft'
    | 'streaming'
    | 'final'
    | 'failed';

  createdAt: string;

  updatedAt: string;

  version: number;
}
```

### 12.1 Text Block

普通文本。

### 12.2 Markdown Block

结构化 Markdown。

### 12.3 Code Block

```ts
interface CodeBlockContent {
  language?: string;
  code: string;
  filePath?: string;
}
```

### 12.4 Run Card

只保存引用和必要 Snapshot：

```ts
interface RunCardContent {
  runId: string;
  taskId?: string;
  title: string;
  statusSnapshot: string;
  stageSummary?: string;
}
```

真实状态从 Run Runtime 获取。

### 12.5 Approval Card

显示 Approval Request，并将决策提交到 Policy Runtime。

### 12.6 Artifact Card

显示：

- Name；
- Type；
- Size；
- Sensitivity；
- Source Run；
- Access。

---

## 13. Message Revision

```ts
interface MessageRevision {
  id: string;

  messageId: string;

  revision: number;

  blocksSnapshotJson: string;

  editReason?: string;

  editedBy: string;

  createdAt: string;
}
```

### 13.1 User Edit

用户消息可在策略允许下编辑。

编辑后：

- 原内容保留 Revision；
- 已启动的 Run 不自动改变；
- 可以创建新 Task 或新 Run；
- UI 提示“该消息已编辑”。

### 13.2 Agent Edit

Agent 不应静默重写历史回复。

修正应通过：

- 新 Message；
- Correction Block；
- 或明确 Revision Event。

---

## 14. Message Attachment

```ts
interface MessageAttachment {
  id: string;

  messageId: string;

  artifactId?: string;

  fileReferenceId?: string;

  type:
    | 'artifact'
    | 'file-reference'
    | 'image'
    | 'document'
    | 'diff'
    | 'archive'
    | 'link';

  name: string;

  mimeType?: string;

  sizeBytes?: number;

  sensitivity:
    | 'normal'
    | 'restricted'
    | 'secret';

  createdAt: string;
}
```

### 14.1 Attachment Is Reference

Conversation 不复制完整 Artifact 数据。

Message 保存引用。

---

## 15. Message Reference

```ts
interface MessageReference {
  id: string;

  messageId: string;

  referenceType:
    | 'message'
    | 'task'
    | 'run'
    | 'stage'
    | 'artifact'
    | 'approval'
    | 'memory'
    | 'file'
    | 'agent';

  referenceId: string;

  displaySnapshot?: string;

  createdAt: string;
}
```

---

## 16. Mention

```ts
interface MessageMention {
  id: string;

  messageId: string;

  targetType:
    | 'user'
    | 'agent'
    | 'all'
    | 'role';

  targetId?: string;

  startOffset?: number;

  endOffset?: number;

  resolved: boolean;

  createdAt: string;
}
```

### 16.1 Mention Resolution

`@Backend` 必须解析到具体 Agent ID。

不能只按显示名称长期保存。

### 16.2 `@all`

默认不允许触发所有 Agent 同时执行修改型任务。

必须受 Reply Policy 和 Agent Budget 限制。

---

# Part III — Conversation Lifecycle

## 17. Conversation Creation

```ts
interface CreateConversationInput {
  workspaceId: string;

  type:
    | 'direct'
    | 'group'
    | 'task'
    | 'run'
    | 'system';

  title?: string;

  memberIds: Array<{
    memberType: ConversationMember['memberType'];
    memberId: string;
    role?: ConversationMember['role'];
    replyMode?: ConversationMember['replyMode'];
  }>;

  linkedTaskId?: string;

  linkedRunId?: string;

  replyPolicy?: Partial<ConversationReplyPolicy>;

  createdBy: string;

  idempotencyKey?: string;
}
```

### 17.1 Creation Sequence

```text
Validate Workspace
  ↓
Validate Conversation Type
  ↓
Validate Members
  ↓
Validate Agent Profiles
  ↓
Validate linked Task / Run
  ↓
Resolve Reply Policy
  ↓
Persist Conversation
  ↓
Persist Members
  ↓
Emit conversation.created
  ↓
Optionally create system welcome message
```

---

## 18. Conversation State Machine

```text
active
  ├── mute → muted
  ├── archive → archived
  └── delete → deleted

muted
  ├── unmute → active
  ├── archive → archived
  └── delete → deleted

archived
  ├── restore → active
  └── delete → deleted

deleted
  └── restore by retention policy, optional
```

### 18.1 Archived Conversation

Archived：

- 历史可读；
- 不自动回复；
- 不自动创建 Turn；
- 可恢复；
- Active Run 继续执行。

---

## 19. Member Lifecycle

```text
invited / added
  ↓
active
  ├── muted
  └── removed
```

Agent 加入群聊时，不自动收到全部历史 Prompt。

首次 Turn 使用 Context Policy 构建受控上下文。

---

## 20. Conversation Delete

删除默认软删除。

不得自动删除：

- Task；
- Run；
- Artifact；
- Memory；
- Approval；
- Runtime Event。

可以隐藏 Conversation 投影。

---

# Part IV — Message Lifecycle

## 21. User Message Submission

```ts
interface SendMessageInput {
  conversationId: string;

  senderUserId: string;

  blocks: Array<{
    type: MessageBlock['type'];
    contentJson: Record<string, unknown>;
    contentText?: string;
  }>;

  replyToMessageId?: string;

  attachments?: CreateMessageAttachmentInput[];

  mentions?: Array<{
    targetType: MessageMention['targetType'];
    targetId?: string;
  }>;

  clientMessageId: string;

  idempotencyKey: string;
}
```

### 21.1 Submission Sequence

```text
Validate Conversation
  ↓
Validate Membership
  ↓
Policy check
  ↓
Validate Blocks and Attachments
  ↓
Scan Secret / Sensitive Data
  ↓
Allocate Conversation Sequence
  ↓
Persist Message + Blocks
  ↓
Emit message.created
  ↓
Update Conversation lastMessage
  ↓
Update Read States
  ↓
Route Message
```

### 21.2 Persist Before Routing

User Message 必须先持久化，再触发 Agent Turn 或 Task Creation。

---

## 22. Message Routing Result

```ts
interface MessageRoutingResult {
  messageId: string;

  intent:
    | 'chat'
    | 'task-create'
    | 'run-create'
    | 'approval-decision'
    | 'conversation-command'
    | 'no-response';

  targetAgentIds: string[];

  orchestratorAgentId?: string;

  taskId?: string;

  runId?: string;

  approvalRequestId?: string;

  warnings: string[];
}
```

---

## 23. Agent Message Lifecycle

```text
Agent Turn created
  ↓
Streaming Message reserved
  ↓
Provider / Run produces text
  ↓
Message Blocks updated incrementally
  ↓
Final response produced
  ↓
Message finalized
```

### 23.1 Failure

Agent Turn 失败时：

- Streaming Message 进入 failed；
- 保留已产生内容；
- 创建 Error Block；
- 关联 Run / Provider Error；
- 用户可以 Retry。

---

## 24. System Projection Message

Runtime Event 投影：

```text
run.started
  → Run Status Message

approval.required
  → Approval Card

run.completed
  → Result Message

run.failed
  → Error Message

artifact.created
  → Artifact Card
```

### 24.1 Projection Idempotency

使用：

```text
projectorId + sourceEventId + projectionType
```

唯一约束。

---

## 25. Message Finalization

Final Message 必须：

- 完成所有 Streaming Block；
- 保存 Character Count；
- 保存 Source；
- 生成 Search Index；
- 更新 Conversation；
- 发 `message.finalized`；
- 更新未读状态。

---

# Part V — Intent and Command Runtime

## 26. Intent Types

```ts
type ConversationIntent =
  | 'chat'
  | 'create-task'
  | 'start-run'
  | 'retry-run'
  | 'cancel-run'
  | 'pause-run'
  | 'resume-run'
  | 'approve'
  | 'reject'
  | 'add-agent'
  | 'remove-agent'
  | 'change-reply-policy'
  | 'archive-conversation'
  | 'search-history'
  | 'save-memory'
  | 'unknown';
```

### 26.1 Explicit Beats Inferred

优先级：

```text
Explicit Command
  > UI Action
  > Structured Message Block
  > Mention
  > Intent Inference
```

---

## 27. Conversation Commands

建议支持：

```text
/task
/run
/retry
/cancel
/pause
/resume
/approve
/reject
/add-agent
/remove-agent
/mode
/archive
/search
/memory
```

### 27.1 Commands Are Structured

解析后生成：

```ts
interface ConversationCommand {
  id: string;

  conversationId: string;

  sourceMessageId: string;

  type: ConversationIntent;

  arguments: Record<string, unknown>;

  requestedBy: string;

  status:
    | 'parsed'
    | 'validated'
    | 'executed'
    | 'failed';

  createdAt: string;
}
```

### 27.2 No Hidden Command

普通文本推断为高风险命令时，必须确认。

例如：

```text
“把它部署到线上”
```

不能直接执行 Push / Deploy。

---

## 28. Task Creation from Message

### 28.1 Explicit

用户使用 `/task` 或 UI 按钮。

### 28.2 Inferred

系统可以建议：

```text
这似乎是一个工程任务，是否创建 Task？
```

默认不自动执行修改型 Run。

### 28.3 Task Link

创建后：

- Message 关联 Task；
- 插入 Task Card；
- 发 `message.linked_to_task`；
- Conversation 可升级为 Task Conversation，用户选择。

---

## 29. Run Creation from Conversation

Run 创建需要：

- Task；
- Workflow；
- Agent；
- Provider；
- Policy；
- Worktree Mode。

缺少配置时：

- 使用已验证默认值；
- 或显示配置确认卡片。

### 29.1 Direct Agent Run

单聊中：

```text
User → Agent
```

可以创建单 Agent Workflow。

### 29.2 Group Run

群聊中不应简单让每个 Agent 启动独立 Run。

必须根据：

- Orchestrator；
- Workflow；
- Mention；
- Parallel Mode；

决定 Stage Graph。

---

## 30. Approval Commands

Approval 必须通过：

- Approval Card；
- Structured Command；
- API Action。

普通文本“好”不能默认批准高风险行为。

必须明确绑定 `approvalRequestId`。

---

# Part VI — Agent Turn Runtime

## 31. Agent Turn

### 31.1 Definition

Agent Turn 表示一个 Agent 对某条 Message 进行一次响应尝试。

```ts
interface AgentTurn {
  id: string;

  conversationId: string;

  sourceMessageId: string;

  agentId: string;

  orchestratorTurnId?: string;

  taskId?: string;

  runId?: string;

  providerSessionId?: string;

  status:
    | 'queued'
    | 'starting'
    | 'streaming'
    | 'waiting_approval'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'skipped';

  trigger:
    | 'direct'
    | 'mention'
    | 'orchestrator'
    | 'round-robin'
    | 'parallel'
    | 'manual'
    | 'runtime-projection';

  replyMessageId?: string;

  createdAt: string;

  startedAt?: string;

  completedAt?: string;

  version: number;
}
```

### 31.2 Agent Turn Is Not Run

简单聊天回复可以有 Agent Turn，但没有工程 Run。

复杂执行可以：

```text
Agent Turn
  ↓
Task / Run
  ↓
Result Message
```

---

## 32. Turn Creation Rules

Agent Turn 创建前检查：

- Conversation Active；
- Agent Active Member；
- Reply Mode；
- Mention；
- Turn Budget；
- Loop Guard；
- Provider Availability；
- Policy；
- Existing Active Turn；
- User Cancellation。

---

## 33. Turn Context

```ts
interface AgentTurnContext {
  conversationId: string;

  sourceMessageId: string;

  recentMessages: MessageContextItem[];

  conversationSummary?: string;

  memoryContextId?: string;

  taskContext?: {
    taskId: string;
    status: string;
  };

  runContext?: {
    runId: string;
    status: string;
  };

  memberContext: Array<{
    memberId: string;
    role: string;
  }>;

  replyInstruction: string;

  contextBudget: ConversationContextBudget;
}
```

---

## 34. Simple Chat Reply

不需要 Run 时：

```text
Agent Turn
  ↓
Provider Session, conversation mode
  ↓
Streaming Message
  ↓
Final Message
```

仍然需要：

- Provider Adapter；
- Policy；
- Event；
- Usage；
- Session；
- Cancel。

### 34.1 Chat Provider Session

可以不创建 Worktree。

默认只读。

---

## 35. Engineering Turn

需要执行工程任务时：

```text
Message
  ↓
Task
  ↓
Run
  ↓
Run Event Projection
  ↓
Agent Reply / Result Message
```

Conversation 不直接模拟 Run 状态。

---

## 36. Turn Cancellation

用户可以取消当前 Agent Turn。

### 36.1 Chat-only Turn

取消 Provider Session。

### 36.2 Run-backed Turn

取消 Turn 不一定取消 Run。

UI 必须区分：

- Stop reply streaming；
- Cancel Run；
- Hide projection。

默认 Run-backed Turn 需要明确“取消 Run”。

---

# Part VII — Group Conversation Runtime

## 37. Group Orchestrator

Orchestrator 是群聊中的发言和任务路由控制者。

可以是：

- Agent Profile；
- System Rule；
- User Manual Mode；
- Workflow Planner。

### 37.1 Responsibilities

- 判断哪些 Agent 应回复；
- 控制顺序；
- 避免重复；
- 选择并行或串行；
- 汇总结果；
- 触发 Task / Workflow；
- 控制 Reply Budget。

### 37.2 Orchestrator Is Not Provider

Orchestrator Agent 可以使用任何 Provider。

---

## 38. Orchestrator Turn

```ts
interface OrchestratorTurn {
  id: string;

  conversationId: string;

  sourceMessageId: string;

  orchestratorAgentId?: string;

  selectedAgentIds: string[];

  mode:
    | 'sequential'
    | 'parallel'
    | 'delegate'
    | 'single'
    | 'no-response';

  rationaleSummary?: string;

  status:
    | 'planning'
    | 'dispatching'
    | 'collecting'
    | 'summarizing'
    | 'completed'
    | 'failed'
    | 'cancelled';

  replyBudget: {
    maxAgents: number;
    maxReplies: number;
  };

  createdAt: string;

  completedAt?: string;
}
```

---

## 39. Sequential Group Reply

```text
User Message
  ↓
Architect replies
  ↓
Backend Agent replies using Architect summary
  ↓
Reviewer replies using result
  ↓
Orchestrator summarizes
```

适合：

- 方案 → 实现 → Review；
- 依赖明确的讨论；
- Task Workflow 规划。

---

## 40. Parallel Group Reply

```text
User Message
  ├── Codex Agent
  ├── KimiCode Agent
  └── OpenCode Agent
        ↓
Orchestrator Summary
```

适合：

- 多方案比较；
- 独立 Review；
- Provider Comparison。

### 40.1 Context Isolation

并行 Agent 默认看：

- User Message；
- Shared Context；
- Conversation Summary。

不自动看其他并行 Agent 尚未完成的回复。

---

## 41. Agent-to-Agent Message

Agent 可以发送面向另一个 Agent 的 Message。

必须：

- 显式 Mention；
- 受 Reply Policy；
- 计入 Hop；
- 计入 Reply Budget；
- 不自动触发无限 Turn。

### 41.1 Hidden Internal Coordination

Workflow 内部 Stage 协作不一定需要生成普通 Conversation Message。

可以使用：

- Stage Artifact；
- Runtime Event；
- Structured Output。

只将用户需要看到的内容投影到 Conversation。

---

## 42. Group Role Assignment

群聊成员可以设置角色：

```text
Architect
Implementer
Reviewer
Security Reviewer
Researcher
Orchestrator
Observer
```

Role 来源于 Agent Profile，不是临时 Provider 名称。

---

## 43. Duplicate Reply Suppression

多个 Agent 产生高度重复回复时：

- 不删除原结果；
- 可以折叠；
- Orchestrator 标记重复；
- UI 展示差异；
- 不重复创建相同 Task。

---

## 44. Group Run Creation

群聊创建 Run 时推荐：

```text
Conversation Group
  ↓
Workflow Definition
  ↓
Agent Selection
  ↓
Stage Graph
```

而不是：

```text
每个群成员都随意启动 CLI
```

---

# Part VIII — Streaming Runtime

## 45. Streaming Message Reservation

Agent Turn 开始时先创建：

```text
Message.status = streaming
```

并创建至少一个 Streaming Block。

### 45.1 Reservation Purpose

- Client Reconnect；
- Ordering；
- Idempotency；
- Failed Partial Content；
- Multi-client View。

---

## 46. Stream Delta

```ts
interface MessageStreamDelta {
  conversationId: string;

  messageId: string;

  blockId: string;

  deltaSequence: number;

  delta: string;

  channel:
    | 'assistant'
    | 'status'
    | 'review'
    | 'system';

  sourceEventId?: string;

  createdAt: string;
}
```

### 46.1 Delta Persistence

Foundation 推荐：

- Runtime Event 持久化 Delta；
- Message Block 定期 Checkpoint；
- Finalize 时保存完整内容。

不需要为每个字符单独写数据库。

---

## 47. Checkpoint

```ts
interface MessageStreamCheckpoint {
  messageId: string;

  blockId: string;

  lastDeltaSequence: number;

  contentSnapshot: string;

  contentHash: string;

  createdAt: string;
}
```

### 47.1 Interval

可以按：

- 时间；
- 字符数；
- Delta 数；

Checkpoint。

---

## 48. Reconnect

客户端提供：

```text
conversation sequence
message delta sequence
runtime event sequence
```

Server 补齐：

- 新 Message；
- 未完成 Streaming Content；
- Run Card 最新状态。

---

## 49. Stream Finalization

```text
Provider completes
  ↓
Flush decoder
  ↓
Flush pending deltas
  ↓
Validate final content
  ↓
Update Message Blocks
  ↓
Message.status = final
  ↓
Emit message.finalized
```

---

## 50. Stream Failure

```text
Provider fails
  ↓
Persist partial content
  ↓
Add Error Block
  ↓
Message.status = failed
  ↓
Emit message.failed
```

用户可以查看已产生部分。

---

## 51. Multiple Stream Channels

同一 Message 可以包含：

- Status Block；
- Assistant Text；
- Tool Summary；
- Artifact Card。

隐藏 Chain of Thought 不进入普通 Message。

只允许 Provider 明确公开的 Reasoning Summary。

---

# Part IX — Runtime Event Projection

## 52. Projection Architecture

```text
Runtime Event Store
  ↓
Conversation Projector
  ↓
Projection Rule
  ↓
Message / Block / Update
```

### 52.1 Projector Is Consumer

Conversation Projector 是 Event Bus Subscriber。

必须幂等。

---

## 53. Projection Rules

### `task.created`

创建 Task Card。

### `run.created`

创建 Run Card 或更新 Task Card。

### `run.started`

更新 Run Status Block。

### `stage.started`

可更新 Run Card，不默认创建新消息。

### `approval.required`

创建 Approval Message。

### `artifact.created`

根据重要性创建 Artifact Card 或附加到 Run Message。

### `run.completed`

创建 Result Message。

### `run.failed`

创建 Error Message。

### `task.completed`

更新 Task Card并创建 Acceptance Message。

---

## 54. Projection Granularity

普通 Conversation 不应被高频 Runtime Event 淹没。

默认：

- Run 状态聚合；
- Tool 调用折叠；
- File Changes 折叠；
- Approval 单独消息；
- Error 单独消息；
- Result 单独消息。

Runtime Inspector 展示完整 Event。

---

## 55. Dynamic Card State

Run Card 可以保存 Snapshot，但 UI 应查询当前 Run 状态。

```text
Message Snapshot
  + Live Run State
```

历史 Replay 时使用 Snapshot。

---

## 56. Projection Failure

Projection 失败：

- 不影响 Run；
- 写 Dead Letter；
- 可重放；
- 不重复生成；
- Conversation 显示同步警告，可选。

---

# Part X — Approval in Conversation

## 57. Approval Message

```ts
interface ApprovalMessageContent {
  approvalRequestId: string;

  runId: string;

  stageId?: string;

  category: string;

  riskLevel: string;

  title: string;

  description: string;

  requestSummary: Record<string, unknown>;

  allowedScopes: string[];

  statusSnapshot: string;
}
```

### 57.1 Live State

真实状态来自 Approval Runtime。

---

## 58. Approval Interaction

用户点击：

- Approve Once；
- Approve Run；
- Approve Workspace，允许时；
- Reject；
- Cancel Run。

### 58.1 Text Reply

普通文本回复不能自动批准。

可以解析明确命令：

```text
/approve approval_123 once
```

---

## 59. Approval Update

Approval 决策后：

- 更新 Card；
- 产生 System Message，可选；
- Run 恢复或失败；
- 保留决策者和时间。

---

# Part XI — History and Context

## 60. Conversation History

Conversation History 包含：

- User Message；
- Agent Message；
- System Message；
- Task Card；
- Run Card；
- Approval；
- Artifact；
- Review；
- Error。

### 60.1 History Source of Truth

Message Store 是 Conversation 历史来源。

Runtime Event Store 是执行历史来源。

---

## 61. Context Window

```ts
interface ConversationContextBudget {
  maxMessages: number;

  maxCharacters: number;

  maxTokens?: number;

  reserveForSystem: number;

  reserveForUserMessage: number;

  reserveForMemory: number;

  reserveForTaskContext: number;
}
```

### 61.1 Selection Order

推荐：

```text
Current User Message
  ↓
Reply Target
  ↓
Recent Relevant Messages
  ↓
Pinned Conversation Constraints
  ↓
Conversation Summary
  ↓
Task / Run References
  ↓
Memory Context
```

---

## 62. Context Item

```ts
interface MessageContextItem {
  messageId: string;

  senderType: string;

  senderId: string;

  content: string;

  createdAt: string;

  relevanceReason: string;

  tokenEstimate: number;

  truncated: boolean;
}
```

---

## 63. Context Filtering

默认排除：

- 高频 Run Status；
- 重复 Tool Log；
- 已被 Summary 覆盖的旧消息；
- Deleted Message；
- Secret；
- 大型 Attachment Content；
- Hidden Reasoning；
- 与当前 Agent 无关的并行 Agent 内部细节。

---

## 64. Conversation Summary

```ts
interface ConversationSummary {
  id: string;

  conversationId: string;

  fromSequence: number;

  toSequence: number;

  summary: string;

  decisions: string[];

  constraints: string[];

  openQuestions: string[];

  taskReferences: string[];

  runReferences: string[];

  sourceMessageIds: string[];

  generatedAt: string;

  supersedesSummaryId?: string;

  version: number;
}
```

### 64.1 Summary Is Versioned

不能覆盖旧 Summary。

新 Summary 可以 Supersede。

---

## 65. Summary Trigger

- Message 数量；
- Character Budget；
- Token Budget；
- Archive；
- Agent 加入；
- Task 创建；
- User 手动请求。

---

## 66. Summary Safety

Summary 不得：

- 把 Agent 推断写成用户事实；
- 丢失否定；
- 扩大 Scope；
- 保存 Secret；
- 隐藏未解决冲突；
- 把失败 Run 说成成功。

---

## 67. Memory Integration

Conversation Runtime 可以请求 Memory Runtime：

- 检索 Agent / Workspace / Conversation Memory；
- 创建 Conversation Summary Candidate；
- 保存用户显式偏好；
- 提升 Task Constraint。

Conversation Runtime 不直接操作 Memory Ranking。

---

# Part XII — Search Runtime

## 68. Message Search

支持：

- Text；
- Sender；
- Agent；
- Date；
- Task；
- Run；
- Artifact；
- Approval；
- Message Type；
- Has Attachment；
- Mention。

---

## 69. Search Result

```ts
interface ConversationSearchResult {
  messageId: string;

  conversationId: string;

  sequence: number;

  senderDisplayName: string;

  snippet: string;

  matchedTerms: string[];

  createdAt: string;

  taskId?: string;

  runId?: string;
}
```

---

## 70. Search Index

Foundation 使用 SQLite FTS5。

索引：

- Text；
- Markdown；
- Code Text，可配置；
- Title；
- Sender；
- Task / Run display metadata。

不索引 Secret Attachment Content。

---

# Part XIII — Read State and Notifications

## 71. Conversation Read State

```ts
interface ConversationReadState {
  conversationId: string;

  userId: string;

  lastReadMessageSequence: number;

  lastReadMessageId?: string;

  lastReadAt: string;

  unreadCount: number;

  mentionCount: number;

  approvalCount: number;
}
```

### 71.1 Server Authority

Unread Count 由 Server 根据 Sequence 计算。

客户端缓存不是唯一来源。

---

## 72. Read Receipt

本地单用户版本可只记录 User Read State。

未来多人协作可扩展成员级 Read Receipt。

---

## 73. Notification

```ts
interface ConversationNotification {
  id: string;

  conversationId: string;

  userId: string;

  type:
    | 'mention'
    | 'agent-reply'
    | 'run-completed'
    | 'run-failed'
    | 'approval'
    | 'critical-policy'
    | 'system';

  sourceMessageId?: string;

  sourceRunId?: string;

  sourceApprovalId?: string;

  status:
    | 'pending'
    | 'delivered'
    | 'read'
    | 'dismissed';

  createdAt: string;

  deliveredAt?: string;

  readAt?: string;
}
```

---

## 74. Notification Deduplication

相同 Run 的高频 Stage Event 不应生成大量 Notification。

推荐：

- Approval 立即通知；
- Run Terminal 通知；
- Critical Policy 通知；
- 普通 Stage 只更新 Conversation Card。

---

# Part XIV — Presence and Typing

## 75. Presence

```ts
interface ConversationPresence {
  conversationId: string;

  memberType: string;

  memberId: string;

  status:
    | 'online'
    | 'viewing'
    | 'idle'
    | 'offline';

  lastSeenAt: string;
}
```

Presence 是 Ephemeral。

不进入主 Message Store。

---

## 76. Typing

```ts
interface TypingIndicator {
  conversationId: string;

  memberType: string;

  memberId: string;

  state:
    | 'typing'
    | 'thinking'
    | 'streaming'
    | 'stopped';

  expiresAt: string;
}
```

### 76.1 Agent Thinking

只能显示状态：

```text
Agent is preparing a response
```

不得伪装展示隐藏 Chain of Thought。

---

# Part XV — Policy and Security

## 77. Conversation Policy Actions

```text
conversation.create
conversation.read
conversation.update
conversation.archive
conversation.delete
conversation.add_member
conversation.remove_member
conversation.change_reply_policy
message.send
message.edit
message.delete
message.attach
message.mention
message.create_task
message.start_run
message.approve
message.export
```

---

## 78. Member Permission

```ts
interface ConversationPermission {
  canRead: boolean;

  canSend: boolean;

  canEditOwn: boolean;

  canDeleteOwn: boolean;

  canManageMembers: boolean;

  canCreateTask: boolean;

  canStartRun: boolean;

  canApprove: boolean;

  canExport: boolean;

  canViewRestrictedAttachments: boolean;
}
```

---

## 79. Sensitive Message

消息发送前扫描：

- Secret；
- Token；
- Password；
- Private Key；
- `.env`；
- Credential；
- Restricted Path；
- Private URL。

### 79.1 Secret Detection

命中 Secret：

- 阻止；
- 脱敏；
- 或改为 Secret Reference。

---

## 80. Attachment Security

Attachment 必须检查：

- Mime Type；
- Size；
- Sensitivity；
- Artifact Access；
- Path；
- Malware Scan，未来；
- Prompt Injection；
- External Link。

---

## 81. Agent Message Trust

Agent Message 是 Untrusted Output。

UI 渲染必须防止：

- HTML Injection；
- Script；
- Dangerous Link；
- Terminal Escape；
- Fake Approval Button；
- Fake System Message。

---

## 82. Message Rendering

Markdown 渲染必须：

- 禁止 Raw HTML，默认；
- Sanitization；
- Link Warning；
- Code Block Isolation；
- No Auto Execute；
- No Clipboard Script；
- No Hidden Form。

---

## 83. Run Creation Permission

从 Conversation 启动 Run 必须检查：

- User；
- Conversation；
- Agent；
- Provider；
- Policy；
- Workspace；
- Task；
- Worktree Mode。

Agent 自己不能因为一句普通回复直接开启 Unsafe Run。

---

# Part XVI — Event Model

## 84. Conversation Events

建议事件：

```text
conversation.created
conversation.updated
conversation.muted
conversation.unmuted
conversation.archived
conversation.restored
conversation.deleted
conversation.member_added
conversation.member_updated
conversation.member_removed
conversation.reply_policy_changed
conversation.summary_created
conversation.summary_superseded
conversation.read_state_updated
conversation.notification_created

message.created
message.routing_completed
message.streaming_started
message.stream_checkpointed
message.finalized
message.failed
message.edited
message.deleted
message.attachment_added
message.linked_to_task
message.linked_to_run
message.projection_created

turn.created
turn.started
turn.streaming
turn.waiting_approval
turn.completed
turn.failed
turn.cancelled
turn.skipped

orchestrator.turn_created
orchestrator.agents_selected
orchestrator.summary_created
orchestrator.turn_completed
```

---

## 85. `conversation.created`

```ts
interface ConversationCreatedPayload {
  type: Conversation['type'];

  title: string;

  memberIds: string[];

  linkedTaskId?: string;

  linkedRunId?: string;

  createdBy: string;
}
```

---

## 86. `message.created`

```ts
interface ConversationMessageCreatedPayload {
  messageId: string;

  conversationId: string;

  senderType: Message['senderType'];

  senderId: string;

  messageType: Message['messageType'];

  sequence: number;

  replyToMessageId?: string;
}
```

---

## 87. `message.routing_completed`

```ts
interface MessageRoutingCompletedPayload {
  messageId: string;

  intent: ConversationIntent;

  targetAgentIds: string[];

  taskId?: string;

  runId?: string;

  approvalRequestId?: string;

  warnings: string[];
}
```

---

## 88. `turn.created`

```ts
interface AgentTurnCreatedPayload {
  turnId: string;

  sourceMessageId: string;

  agentId: string;

  trigger: AgentTurn['trigger'];

  runBacked: boolean;

  runId?: string;
}
```

---

## 89. `conversation.summary_created`

```ts
interface ConversationSummaryCreatedPayload {
  summaryId: string;

  fromSequence: number;

  toSequence: number;

  sourceMessageCount: number;

  generatedBy: string;
}
```

---

# Part XVII — Persistence

## 90. Conversation Schema

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,

  type TEXT NOT NULL,

  title TEXT NOT NULL,
  description TEXT,
  avatar TEXT,

  status TEXT NOT NULL,

  owner_user_id TEXT NOT NULL,

  default_agent_id TEXT,
  orchestrator_agent_id TEXT,

  linked_task_id TEXT,
  linked_run_id TEXT,

  reply_policy_json TEXT NOT NULL,
  context_policy_json TEXT NOT NULL,
  notification_policy_json TEXT NOT NULL,

  retention_policy_id TEXT,

  last_message_id TEXT,
  last_message_at TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT,

  version INTEGER NOT NULL
);
```

---

## 91. Member Schema

```sql
CREATE TABLE conversation_members (
  id TEXT PRIMARY KEY,

  conversation_id TEXT NOT NULL,

  member_type TEXT NOT NULL,
  member_id TEXT NOT NULL,

  display_name_snapshot TEXT NOT NULL,

  role TEXT NOT NULL,
  status TEXT NOT NULL,
  reply_mode TEXT NOT NULL,

  priority INTEGER NOT NULL,

  joined_at TEXT NOT NULL,
  removed_at TEXT,

  version INTEGER NOT NULL,

  UNIQUE(conversation_id, member_type, member_id)
);
```

---

## 92. Message Schema

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,

  conversation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,

  sender_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_display_name_snapshot TEXT NOT NULL,

  message_type TEXT NOT NULL,
  status TEXT NOT NULL,

  sequence INTEGER NOT NULL,

  reply_to_message_id TEXT,
  thread_root_message_id TEXT,

  source_message_id TEXT,
  source_event_id TEXT,
  source_task_id TEXT,
  source_run_id TEXT,
  source_stage_id TEXT,
  source_artifact_id TEXT,

  client_message_id TEXT,
  idempotency_key TEXT,

  created_at TEXT NOT NULL,
  finalized_at TEXT,
  edited_at TEXT,
  deleted_at TEXT,

  version INTEGER NOT NULL,

  UNIQUE(conversation_id, sequence),
  UNIQUE(conversation_id, client_message_id)
);
```

---

## 93. Message Block Schema

```sql
CREATE TABLE message_blocks (
  id TEXT PRIMARY KEY,

  message_id TEXT NOT NULL,

  position INTEGER NOT NULL,

  type TEXT NOT NULL,

  content_json TEXT NOT NULL,
  content_text TEXT,

  status TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  version INTEGER NOT NULL,

  UNIQUE(message_id, position)
);
```

---

## 94. Revision Schema

```sql
CREATE TABLE message_revisions (
  id TEXT PRIMARY KEY,

  message_id TEXT NOT NULL,

  revision INTEGER NOT NULL,

  blocks_snapshot_json TEXT NOT NULL,

  edit_reason TEXT,
  edited_by TEXT NOT NULL,

  created_at TEXT NOT NULL,

  UNIQUE(message_id, revision)
);
```

---

## 95. Attachment Schema

```sql
CREATE TABLE message_attachments (
  id TEXT PRIMARY KEY,

  message_id TEXT NOT NULL,

  artifact_id TEXT,
  file_reference_id TEXT,

  type TEXT NOT NULL,

  name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,

  sensitivity TEXT NOT NULL,

  created_at TEXT NOT NULL
);
```

---

## 96. Mention Schema

```sql
CREATE TABLE message_mentions (
  id TEXT PRIMARY KEY,

  message_id TEXT NOT NULL,

  target_type TEXT NOT NULL,
  target_id TEXT,

  start_offset INTEGER,
  end_offset INTEGER,

  resolved INTEGER NOT NULL,

  created_at TEXT NOT NULL
);
```

---

## 97. Turn Schema

```sql
CREATE TABLE agent_turns (
  id TEXT PRIMARY KEY,

  conversation_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,

  agent_id TEXT NOT NULL,

  orchestrator_turn_id TEXT,

  task_id TEXT,
  run_id TEXT,
  provider_session_id TEXT,

  status TEXT NOT NULL,
  trigger TEXT NOT NULL,

  reply_message_id TEXT,

  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,

  version INTEGER NOT NULL
);
```

---

## 98. Orchestrator Turn Schema

```sql
CREATE TABLE orchestrator_turns (
  id TEXT PRIMARY KEY,

  conversation_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,

  orchestrator_agent_id TEXT,

  selected_agent_ids_json TEXT NOT NULL,

  mode TEXT NOT NULL,
  rationale_summary TEXT,

  status TEXT NOT NULL,

  reply_budget_json TEXT NOT NULL,

  created_at TEXT NOT NULL,
  completed_at TEXT
);
```

---

## 99. Read State Schema

```sql
CREATE TABLE conversation_read_states (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,

  last_read_message_sequence INTEGER NOT NULL,
  last_read_message_id TEXT,
  last_read_at TEXT NOT NULL,

  unread_count INTEGER NOT NULL,
  mention_count INTEGER NOT NULL,
  approval_count INTEGER NOT NULL,

  PRIMARY KEY(conversation_id, user_id)
);
```

---

## 100. Summary Schema

```sql
CREATE TABLE conversation_summaries (
  id TEXT PRIMARY KEY,

  conversation_id TEXT NOT NULL,

  from_sequence INTEGER NOT NULL,
  to_sequence INTEGER NOT NULL,

  summary TEXT NOT NULL,

  decisions_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  open_questions_json TEXT NOT NULL,

  task_references_json TEXT NOT NULL,
  run_references_json TEXT NOT NULL,
  source_message_ids_json TEXT NOT NULL,

  generated_at TEXT NOT NULL,

  supersedes_summary_id TEXT,

  version INTEGER NOT NULL
);
```

---

## 101. Projection Schema

```sql
CREATE TABLE conversation_projections (
  id TEXT PRIMARY KEY,

  projector_id TEXT NOT NULL,

  source_event_id TEXT NOT NULL,

  projection_type TEXT NOT NULL,

  conversation_id TEXT NOT NULL,

  message_id TEXT,

  created_at TEXT NOT NULL,

  UNIQUE(projector_id, source_event_id, projection_type)
);
```

---

## 102. Indexes

```sql
CREATE INDEX idx_conversations_workspace_status
ON conversations(workspace_id, status, last_message_at);

CREATE INDEX idx_members_conversation_status
ON conversation_members(conversation_id, status);

CREATE INDEX idx_messages_conversation_sequence
ON messages(conversation_id, sequence);

CREATE INDEX idx_messages_source_run
ON messages(source_run_id);

CREATE INDEX idx_messages_source_task
ON messages(source_task_id);

CREATE INDEX idx_messages_source_event
ON messages(source_event_id);

CREATE INDEX idx_turns_conversation_status
ON agent_turns(conversation_id, status);

CREATE INDEX idx_turns_run
ON agent_turns(run_id);

CREATE INDEX idx_mentions_target
ON message_mentions(target_type, target_id);

CREATE INDEX idx_attachments_artifact
ON message_attachments(artifact_id);
```

---

## 103. FTS5

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  message_id UNINDEXED,
  conversation_id UNINDEXED,
  sender_display_name,
  content_text,
  task_text,
  run_text,
  tokenize = 'unicode61'
);
```

---

## 104. Transaction Requirements

必须事务化：

- Conversation + Members Create；
- User Message + Blocks + Attachments；
- Conversation Sequence Allocation；
- Message Finalize；
- Message Edit + Revision；
- Runtime Event Projection；
- Approval Card Create；
- Task Link；
- Run Link；
- Read State Update；
- Member Add / Remove；
- Archive；
- Summary Create + Supersede。



# Part XVIII — Runtime Services

## 105. Conversation Runtime Interface

```ts
interface ConversationRuntime {
  createConversation(
    input: CreateConversationInput
  ): Promise<Conversation>;

  updateConversation(
    conversationId: string,
    input: UpdateConversationInput
  ): Promise<Conversation>;

  addMember(
    conversationId: string,
    input: AddConversationMemberInput
  ): Promise<ConversationMember>;

  removeMember(
    conversationId: string,
    memberId: string,
    removedBy: string
  ): Promise<void>;

  sendMessage(
    input: SendMessageInput
  ): Promise<Message>;

  editMessage(
    messageId: string,
    input: EditMessageInput
  ): Promise<Message>;

  deleteMessage(
    messageId: string,
    deletedBy: string
  ): Promise<void>;

  routeMessage(
    messageId: string
  ): Promise<MessageRoutingResult>;

  createAgentTurn(
    input: CreateAgentTurnInput
  ): Promise<AgentTurn>;

  cancelAgentTurn(
    turnId: string,
    input: CancelAgentTurnInput
  ): Promise<void>;

  markRead(
    input: MarkConversationReadInput
  ): Promise<ConversationReadState>;

  search(
    input: SearchConversationInput
  ): Promise<ConversationSearchResult[]>;

  archive(
    conversationId: string,
    archivedBy: string
  ): Promise<void>;

  restore(
    conversationId: string,
    restoredBy: string
  ): Promise<void>;

  export(
    input: ExportConversationInput
  ): Promise<Artifact>;
}
```

---

## 106. Internal Components

```text
Conversation Runtime
├── Conversation Service
├── Member Service
├── Message Service
├── Message Sequence Allocator
├── Message Block Service
├── Attachment Service
├── Mention Resolver
├── Intent Resolver
├── Command Parser
├── Message Router
├── Agent Turn Manager
├── Orchestrator
├── Streaming Message Manager
├── Runtime Event Projector
├── Approval Projector
├── Conversation Context Builder
├── Conversation Summary Service
├── Read State Service
├── Notification Service
├── Search Index
├── Retention Manager
├── Recovery Manager
└── Export Service
```

---

## 107. Repository Ports

```ts
interface ConversationRepository {}
interface ConversationMemberRepository {}
interface MessageRepository {}
interface MessageBlockRepository {}
interface MessageRevisionRepository {}
interface AgentTurnRepository {}
interface ConversationSummaryRepository {}
interface ConversationProjectionRepository {}
interface ConversationReadStateRepository {}
interface ConversationNotificationRepository {}
```

Repository 不负责：

- Provider 调用；
- Runtime Event 解析；
- Policy Rule 判断；
- Prompt 生成。

---

## 108. External Runtime Ports

Conversation Runtime 可以通过 Port 使用：

```ts
interface ConversationRuntimePorts {
  agentRegistry: AgentRegistryPort;

  taskRuntime: TaskRuntimePort;

  runRuntime: RunRuntimePort;

  providerRuntime: ConversationProviderPort;

  memoryRuntime: ConversationMemoryPort;

  policyRuntime: ConversationPolicyPort;

  artifactRuntime: ConversationArtifactPort;

  approvalRuntime: ConversationApprovalPort;

  runtimeEventStore: RuntimeEventStorePort;
}
```

---

# Part XIX — APIs

## 109. Conversation APIs

```text
GET    /api/conversations
POST   /api/conversations
GET    /api/conversations/:id
PATCH  /api/conversations/:id
DELETE /api/conversations/:id

POST   /api/conversations/:id/archive
POST   /api/conversations/:id/restore
POST   /api/conversations/:id/mute
POST   /api/conversations/:id/unmute
```

### 109.1 List Filters

```text
workspaceId
type
status
agentId
taskId
runId
hasUnread
hasApproval
updatedAfter
search
```

---

## 110. Member APIs

```text
GET    /api/conversations/:id/members
POST   /api/conversations/:id/members
PATCH  /api/conversations/:id/members/:memberId
DELETE /api/conversations/:id/members/:memberId
```

### 110.1 Member Update

支持：

- Role；
- Reply Mode；
- Priority；
- Muted；
- Orchestrator。

---

## 111. Message APIs

```text
GET    /api/conversations/:id/messages
POST   /api/conversations/:id/messages
GET    /api/messages/:messageId
PATCH  /api/messages/:messageId
DELETE /api/messages/:messageId
GET    /api/messages/:messageId/revisions
GET    /api/messages/:messageId/references
```

### 111.1 Pagination

推荐基于 Sequence：

```text
beforeSequence
afterSequence
limit
```

不应只依赖时间戳。

---

## 112. Turn APIs

```text
GET  /api/conversations/:id/turns
GET  /api/turns/:turnId
POST /api/conversations/:id/turns
POST /api/turns/:turnId/cancel
POST /api/turns/:turnId/retry
```

### 112.1 Manual Agent Reply

```text
POST /api/conversations/:id/agents/:agentId/reply
```

创建 Manual Agent Turn。

---

## 113. Command APIs

通常 Command 通过 Message 进入。

Inspector 可提供：

```text
GET /api/messages/:id/command
POST /api/messages/:id/command/retry
```

---

## 114. Task and Run Bridge APIs

```text
POST /api/messages/:id/create-task
POST /api/messages/:id/start-run
POST /api/messages/:id/link-task
POST /api/messages/:id/link-run
```

### 114.1 Start Run Input

```ts
interface StartRunFromMessageInput {
  taskId?: string;

  createTaskIfMissing: boolean;

  workflowDefinitionId?: string;

  agentIds?: string[];

  providerOverrides?: Record<string, string>;

  policyProfileId?: string;

  worktreeMode?: string;

  confirmationToken?: string;
}
```

---

## 115. Read State APIs

```text
GET  /api/conversations/read-state
POST /api/conversations/:id/read
POST /api/conversations/:id/unread
```

---

## 116. Search APIs

```text
GET /api/conversations/search
GET /api/conversations/:id/search
```

---

## 117. Summary APIs

```text
GET  /api/conversations/:id/summaries
POST /api/conversations/:id/summaries
POST /api/conversations/:id/summaries/:summaryId/accept
POST /api/conversations/:id/summaries/:summaryId/supersede
```

---

## 118. Export APIs

```text
POST /api/conversations/:id/export
```

支持：

- Markdown；
- JSON；
- JSONL；
- HTML；
- Debug Bundle。

---

# Part XX — Realtime Transport

## 119. Conversation SSE

Endpoint：

```text
GET /api/conversations/:conversationId/stream
```

Query：

```text
afterMessageSequence
afterRuntimeEventSequence
```

### 119.1 Stream Events

```text
conversation-message
message-delta
message-checkpoint
message-finalized
message-failed
conversation-updated
member-updated
read-state-updated
notification
presence
typing
runtime-projection
keepalive
```

---

## 120. WebSocket

WebSocket 适合：

- Multi-conversation Subscription；
- Typing；
- Presence；
- Approval Interaction；
- Agent Turn Control；
- Message Delta；
- Read State；
- Group Orchestration。

### 120.1 Canonical Payload

传输层不得改变持久对象语义。

---

## 121. Reconnect Protocol

客户端保存：

```text
lastMessageSequence
lastMessageDeltaSequence
lastRuntimeEventSequence
```

重连流程：

```text
Connect
  ↓
Fetch missed durable messages
  ↓
Fetch streaming checkpoints
  ↓
Fetch current run / approval state
  ↓
Subscribe realtime
```

---

## 122. Multi-client Consistency

同一 User 可以在多个客户端打开 Conversation。

要求：

- Message 幂等；
- Read State 取最大 Sequence；
- Approval 只决策一次；
- Turn Cancel 幂等；
- Streaming Delta 去重；
- Conversation Update 使用 Version。

---

## 123. Browser Disconnect

Browser Disconnect：

- 不取消 Agent Turn，除非纯临时 Draft 且明确配置；
- 不取消 Run；
- 不删除 Streaming Message；
- 只结束订阅。

---

# Part XXI — Conversation UI Requirements

> **Document Authority Clarification**
>
> `09-Conversation-Runtime.md` 定义 Conversation UI 必须表达什么——Conversation 领域特有的数据要求、交互模式和展示内容。
>
> `12-UI-Architecture.md` 定义整个 AgentOS 产品 UI 如何布局、渲染、响应、动效、适配平台并连接到 Runtime API。
>
> 以下全局架构定义请参见 `12-UI-Architecture.md`：
> - App Shell、Navigation Rail、Context Sidebar、Main Canvas、Inspector Panel
> - Layout 断点与自适应策略（Wide / Standard / Compact / Narrow）
> - Design Tokens（Color、Typography、Spacing、Radius、Elevation、Motion）
> - Motion Architecture（Immediate Response、Direct Manipulation、Interruptibility、Velocity、Spring）
> - Platform Adapter（Browser / Future Tauri）
> - Client State Architecture（Server State、Realtime State、Local View State、Draft State）
> - Streaming Batching 与 Rendering 策略
> - Accessibility（Keyboard、Focus、Target Size、Contrast、Screen Reader）
> - Error、Offline、Reconnecting 状态的全局处理
> - Component 状态合同（idle / loading / empty / error / stale 等）

## 124. Information Architecture

推荐：

```text
Left Sidebar
├── Workspace
├── Direct Agents
├── Group Conversations
├── Task Conversations
├── Run Conversations
└── Archived

Main Panel
├── Conversation Header
├── Member / Agent Status
├── Message Timeline
├── Run / Approval / Artifact Cards
└── Composer

Right Inspector
├── Conversation Info
├── Members
├── Linked Tasks
├── Linked Runs
├── Artifacts
├── Memory Context
└── Runtime Inspector Link
```

---

## 125. Conversation List Item

应展示：

- Avatar；
- Title；
- Type；
- Last Message；
- Last Time；
- Unread；
- Mention；
- Pending Approval；
- Active Run；
- Muted；
- Archived。

---

## 126. Conversation Header

应展示：

- Conversation Title；
- Workspace；
- Agent Members；
- Reply Mode；
- Active Run；
- Provider Health Summary；
- Add Agent；
- Settings；
- Search；
- Archive。

---

## 127. Composer

Composer 支持：

- Text；
- Markdown；
- `@Agent`；
- Slash Command；
- Attachment；
- Create Task；
- Start Run；
- Choose Reply Target；
- Choose Group Mode；
- Stop Streaming。

### 127.1 Send Behavior

普通 Enter：

- Send Message。

明确 Start Run：

- 独立按钮或 Command；
- 显示配置摘要；
- 高风险时确认。

---

## 128. Agent Selector

Direct Conversation 左侧选择 Agent 后：

- 显示与该 Agent 的持久历史；
- 不按 Provider 分裂 Conversation；
- Provider 切换记录在 Run / Session。

---

## 129. Group Composer

群聊发送前可以选择：

```text
Ask:
  @Architect
  @Reviewer
  Selected Agents
  Orchestrator
  All within policy
```

并选择：

- Single；
- Sequential；
- Parallel；
- Discussion only；
- Create Workflow Run。

---

## 130. Runtime Output Presentation

类似 Coding Agent CLI 的逐字输出可以通过：

```text
stream.text_delta
  ↓
MessageStreamDelta
  ↓
Streaming Text Block
```

同时 Tool / File / Command 以独立折叠卡片展示。

不把所有内容拼成一段纯文本。

---

## 131. Agent History View

点击 Agent 后显示：

- Direct Conversations；
- Group Membership；
- Messages；
- Tasks；
- Runs；
- Provider Sessions；
- Recent Artifacts；
- Agent Memory；
- Failures；
- Usage。

Agent History 不是直接读取 Provider 本地历史目录的简单文本转储。

Provider Native History 作为 Session Reference。

---

## 132. Message Actions

User Message：

- Reply；
- Edit；
- Create Task；
- Start Run；
- Save Memory；
- Copy；
- Delete。

Agent Message：

- Reply；
- Create Task；
- Retry；
- Compare Provider；
- Save Memory Candidate；
- Open Runtime；
- View Sources。

Run Card：

- Open；
- Pause；
- Resume；
- Cancel；
- Retry；
- Review；
- Merge。

---

# Part XXII — Retention, Archive and Export

## 133. Conversation Retention Policy

```ts
interface ConversationRetentionPolicy {
  retainMessagesDays: number | null;

  retainStreamingDeltasDays: number;

  retainRevisions: boolean;

  retainDeletedMessagesDays?: number;

  retainSystemMessagesDays?: number;

  archiveAfterInactiveDays?: number;

  compactRuntimeStatusMessages: boolean;
}
```

---

## 134. Message Compaction

可以压缩：

- 高频 Run Status Update；
- Tool Progress；
- Streaming Delta；
- Repeated System Notice。

必须保留：

- User Message；
- Final Agent Message；
- Approval；
- Run Terminal；
- Error；
- Artifact；
- Task / Run Link；
- Revision。

---

## 135. Archive

Archive 不删除内容。

Archive 后：

- 从 Active List 隐藏；
- 保留 Search；
- 保留 Task / Run；
- 禁止自动 Agent Reply；
- 可恢复。

---

## 136. Export

Export 必须区分：

### User-readable

- Markdown；
- HTML；
- PDF，未来。

### Machine-readable

- JSON；
- JSONL；
- Conversation Bundle。

### Debug

- Message；
- Turn；
- Projection；
- Runtime Event References；
- Provider Session References；
- Redacted Logs。

---

## 137. Export Security

默认排除：

- Secret；
- Restricted Artifact Content；
- Raw Provider Credential；
- Hidden Reasoning；
- Deleted Content，按策略；
- Internal Policy Metadata，普通导出。

---

## 138. Conversation Bundle

```text
conversation/
├── conversation.json
├── members.json
├── messages.jsonl
├── revisions.jsonl
├── attachments.json
├── task-references.json
├── run-references.json
├── approvals.json
├── summaries.json
├── artifacts.json
└── export-report.json
```

---

# Part XXIII — Recovery Runtime

## 139. Startup Recovery

Server 启动后扫描：

- Streaming Message；
- Active Agent Turn；
- Orchestrator Turn；
- Pending Projection；
- Pending Approval Message；
- Active Run Card；
- Read State；
- Unsent Notification。

---

## 140. Recovery Classification

```ts
type ConversationRecoveryClassification =
  | 'healthy'
  | 'streaming-turn-alive'
  | 'streaming-turn-missing'
  | 'run-still-active'
  | 'projection-missing'
  | 'projection-duplicate'
  | 'approval-state-stale'
  | 'message-checkpoint-missing'
  | 'unknown';
```

---

## 141. Streaming Turn Recovery

### Provider / Run Alive

- 恢复 Event Subscription；
- 继续 Message Delta；
- 更新 Checkpoint。

### Provider Missing

- Finalize Partial Message as Failed；
- 添加 Error Block；
- 关联 Recovery Failure；
- 允许 Retry。

### Run Active but Turn Lost

- 重建 Projection Turn；
- 不创建新 Run。

---

## 142. Projection Recovery

Conversation Projector 启动时：

- 扫描未处理 Runtime Event；
- 根据 Projector Cursor 补投影；
- 依靠唯一约束去重；
- 更新 Dynamic Card。

---

## 143. Approval Recovery

Pending Approval：

- 重新读取 Approval Runtime；
- 更新 Card；
- 不重新创建 Approval Request；
- 保留原 Message。

---

## 144. Recovery Events

```text
conversation.recovery_started
conversation.recovery_completed
message.streaming_recovered
message.streaming_recovery_failed
message.projection_recovered
turn.recovered
turn.recovery_failed
```

---

# Part XXIV — Error Model

## 145. Conversation Runtime Error

```ts
interface ConversationRuntimeError {
  code: ConversationErrorCode;

  message: string;

  phase:
    | 'validation'
    | 'creation'
    | 'membership'
    | 'message'
    | 'routing'
    | 'intent'
    | 'command'
    | 'turn'
    | 'orchestration'
    | 'streaming'
    | 'projection'
    | 'summary'
    | 'search'
    | 'notification'
    | 'retention'
    | 'export'
    | 'recovery';

  conversationId?: string;

  messageId?: string;

  turnId?: string;

  retryable: boolean;

  suggestedAction?: string;

  details?: Record<string, unknown>;
}
```

---

## 146. Error Codes

```ts
type ConversationErrorCode =
  | 'CONVERSATION_NOT_FOUND'
  | 'CONVERSATION_TYPE_INVALID'
  | 'CONVERSATION_ARCHIVED'
  | 'CONVERSATION_DELETED'
  | 'CONVERSATION_VERSION_CONFLICT'
  | 'CONVERSATION_ACCESS_DENIED'
  | 'CONVERSATION_MEMBER_NOT_FOUND'
  | 'CONVERSATION_MEMBER_EXISTS'
  | 'CONVERSATION_AGENT_UNAVAILABLE'
  | 'CONVERSATION_ORCHESTRATOR_REQUIRED'
  | 'CONVERSATION_REPLY_POLICY_INVALID'
  | 'MESSAGE_INPUT_INVALID'
  | 'MESSAGE_TOO_LARGE'
  | 'MESSAGE_SECRET_DETECTED'
  | 'MESSAGE_NOT_FOUND'
  | 'MESSAGE_EDIT_FORBIDDEN'
  | 'MESSAGE_ALREADY_DELETED'
  | 'MESSAGE_SEQUENCE_CONFLICT'
  | 'MESSAGE_DUPLICATE_CLIENT_ID'
  | 'MESSAGE_ATTACHMENT_INVALID'
  | 'MESSAGE_ROUTING_FAILED'
  | 'MESSAGE_INTENT_AMBIGUOUS'
  | 'MESSAGE_COMMAND_INVALID'
  | 'MESSAGE_PROJECTION_FAILED'
  | 'MESSAGE_STREAM_FAILED'
  | 'MESSAGE_STREAM_SEQUENCE_CONFLICT'
  | 'TURN_NOT_FOUND'
  | 'TURN_ALREADY_ACTIVE'
  | 'TURN_BUDGET_EXCEEDED'
  | 'TURN_LOOP_DETECTED'
  | 'TURN_PROVIDER_UNAVAILABLE'
  | 'TURN_CANCEL_FAILED'
  | 'ORCHESTRATOR_FAILED'
  | 'CONVERSATION_SUMMARY_FAILED'
  | 'CONVERSATION_SEARCH_FAILED'
  | 'CONVERSATION_EXPORT_FAILED'
  | 'CONVERSATION_RECOVERY_FAILED'
  | 'CONVERSATION_UNKNOWN_ERROR';
```

---

# Part XXV — Testing

## 147. Unit Tests

必须覆盖：

- Conversation Type；
- Member Validation；
- Reply Policy；
- Loop Guard；
- Message Sequence；
- Client Message Idempotency；
- Message Revision；
- Mention Resolution；
- Command Parsing；
- Intent Priority；
- Task Link；
- Run Link；
- Projection Idempotency；
- Stream Delta Ordering；
- Checkpoint；
- Context Budget；
- Summary；
- Read State；
- Notification Dedup；
- Archive；
- Export Redaction。

---

## 148. Conversation Contract Tests

1. Create Direct Conversation；
2. Create Group Conversation；
3. Add Agent；
4. Remove Agent；
5. Send User Message；
6. Retry Client Request；
7. Mention Agent；
8. Mention Unknown Agent；
9. Create Task；
10. Start Run；
11. Stream Agent Reply；
12. Fail Agent Reply；
13. Edit User Message；
14. Project Run Started；
15. Project Approval；
16. Resolve Approval；
17. Project Run Completed；
18. Archive；
19. Restore；
20. Search；
21. Export。

---

## 149. Group Runtime Tests

必须覆盖：

- Mention-only；
- Orchestrated；
- Sequential；
- Parallel；
- Manual；
- Agent-to-Agent Hop；
- Loop Detection；
- Reply Budget；
- Duplicate Reply；
- Orchestrator Failure；
- Agent Unavailable；
- Provider Switch；
- Group Run Creation。

---

## 150. Streaming Tests

- UTF-8 Delta；
- Delta Retry；
- Duplicate Delta；
- Out-of-order Delta；
- Checkpoint；
- Browser Disconnect；
- Multi-client；
- Server Restart；
- Provider Failure；
- Partial Message；
- Finalization；
- Large Output；
- Tool Card + Text Block。

---

## 151. Projection Tests

- Persist Event then Project；
- Duplicate Event；
- Projector Restart；
- Missing Projection；
- Dynamic Run Card；
- Approval State Change；
- Artifact Sensitivity；
- Run Failure；
- Task Acceptance。

---

## 152. Security Tests

- Raw HTML；
- Script；
- Malicious Markdown Link；
- Secret in Message；
- Secret Attachment；
- Fake Approval Button；
- Prompt Injection Attachment；
- Unauthorized Run Start；
- Agent Attempts Unsafe Mode；
- Restricted Artifact；
- Deleted Message Access。

---

## 153. End-to-End Direct Chat

```text
Create Direct Conversation
  ↓
Send Message to Backend Agent
  ↓
Agent Turn
  ↓
Provider Session
  ↓
Streaming Message
  ↓
Final Message
  ↓
History Search
```

---

## 154. End-to-End Engineering Task

```text
User sends requirement
  ↓
Create Task
  ↓
Run Configuration Card
  ↓
Start Run
  ↓
Run Status Projection
  ↓
Approval Card
  ↓
User Approves
  ↓
Run Completes
  ↓
Artifact and Result Message
  ↓
User Accepts Task
```

---

## 155. End-to-End Group Chat

```text
Group:
  Architect
  Implementer
  Reviewer

User sends task
  ↓
Orchestrator selects sequential mode
  ↓
Architect reply
  ↓
Workflow Run
  ↓
Implementer Stage
  ↓
Reviewer Stage
  ↓
Orchestrator Summary
  ↓
Final Conversation Message
```

---

## 156. Mock Conversation Runtime

```ts
type MockConversationScenario =
  | 'direct-chat'
  | 'group-mention'
  | 'group-parallel'
  | 'orchestrated'
  | 'stream-success'
  | 'stream-failure'
  | 'approval'
  | 'run-completion'
  | 'loop-detected'
  | 'duplicate-message'
  | 'projection-replay'
  | 'server-recovery';
```

---

# Part XXVI — v1 Migration

## 157. Current v1 Model

当前 v1 主要是：

```text
Task Form
  ↓
Fixed Pipeline
  ↓
SSE Output Page
```

主要问题：

- 没有持久 Conversation；
- Agent 只能被任务调用；
- 无单聊；
- 无群聊；
- 无 Agent Membership；
- 无 Mention；
- 无 Message Domain；
- 无 Task / Run Card；
- 无 Agent History；
- SSE 断线与执行耦合；
- Provider stdout 直接展示；
- 无 Approval Card；
- 无 Read State；
- 无 Conversation Search；
- 无 Group Turn Control；
- 无 Conversation Summary；
- 无 Message Projection。

---

## 158. Migration Target

```text
Conversation
  ↓
Message
  ↓
Agent Turn / Task / Run
  ↓
Runtime Event
  ↓
Conversation Projection
```

---

## 159. Migration Step 1 — Introduce Conversation and Message

为旧 Task 创建默认 Task Conversation。

把：

- Task Description；
- Stage Output；
- Final Result；

迁移为 Message 或 Card。

---

## 160. Migration Step 2 — Persist SSE Output

旧 SSE `thinking`：

```text
stream.text_delta
  ↓
Streaming Message Block
```

Run Terminal：

```text
run.completed / failed
  ↓
Result / Error Message
```

---

## 161. Migration Step 3 — Decouple Browser

删除：

```text
SSE close
→ cancel pipeline
```

Conversation Stream 只订阅。

---

## 162. Migration Step 4 — Direct Agent Conversations

为每个 Agent Profile 支持持久 Direct Conversation。

旧 Agent 运行记录通过：

- Agent Turn；
- Run Reference；
- Provider Session Reference；

展示。

---

## 163. Migration Step 5 — Group Conversations

加入：

- Member；
- Role；
- Mention；
- Reply Policy；
- Orchestrator；
- Turn Budget。

---

## 164. Migration Step 6 — Task and Run Bridge

Composer 中：

- 普通聊天；
- Create Task；
- Start Run；

明确分离。

---

## 165. Migration Step 7 — Projection and Inspector

Run、Approval、Artifact、Error 通过 Projector 进入 Conversation。

完整细节链接 Runtime Inspector。

---

## 166. Migration Step 8 — Archive and Search

增加：

- Conversation List；
- Search；
- Read State；
- Archive；
- Export。

---

# Part XXVII — Implementation Structure

## 167. Recommended Package

```text
packages/conversation-runtime/
├── src/
│   ├── conversation-runtime.ts
│   ├── conversation-service.ts
│   ├── conversation-repository.ts
│   ├── member-service.ts
│   ├── member-repository.ts
│   ├── message-service.ts
│   ├── message-repository.ts
│   ├── message-sequence.ts
│   ├── message-block-service.ts
│   ├── revision-service.ts
│   ├── attachment-service.ts
│   ├── mention-resolver.ts
│   ├── intent-resolver.ts
│   ├── command-parser.ts
│   ├── message-router.ts
│   ├── turn/
│   │   ├── turn-manager.ts
│   │   ├── turn-repository.ts
│   │   ├── loop-guard.ts
│   │   └── context-builder.ts
│   ├── orchestration/
│   │   ├── orchestrator.ts
│   │   ├── speaker-selector.ts
│   │   └── reply-budget.ts
│   ├── streaming/
│   │   ├── stream-manager.ts
│   │   ├── delta-store.ts
│   │   └── checkpoint.ts
│   ├── projection/
│   │   ├── runtime-projector.ts
│   │   ├── projection-rules.ts
│   │   └── projection-repository.ts
│   ├── summary/
│   │   ├── summary-service.ts
│   │   └── summary-repository.ts
│   ├── search/
│   ├── read-state/
│   ├── notification/
│   ├── recovery/
│   ├── retention/
│   ├── export/
│   ├── errors.ts
│   ├── events.ts
│   └── testing/
└── package.json
```

---

## 168. Dependencies

Conversation Runtime 可以依赖：

- Storage；
- Event Store / Event Bus；
- Agent Registry；
- Task Runtime；
- Run Runtime；
- Provider Runtime Port；
- Memory Runtime；
- Policy Runtime；
- Approval Runtime；
- Artifact Runtime；
- Clock。

不得依赖：

- 具体 Provider CLI；
- Process Driver；
- Git Client；
- Worktree 实现细节；
- Secret Value；
- Hidden Chain of Thought。

---

# Part XXVIII — Implementation Phases

## 169. Phase 1 — Direct Conversation Foundation

- Conversation；
- Member；
- Message；
- Message Block；
- Direct Agent Chat；
- Streaming；
- Agent Turn；
- Message Sequence；
- Persistence；
- SSE；
- Search；
- Basic UI。

---

## 170. Phase 2 — Task and Run Bridge

- Create Task；
- Start Run；
- Run Card；
- Runtime Event Projection；
- Approval Card；
- Artifact Card；
- Error Card；
- Browser Disconnect Recovery。

---

## 171. Phase 3 — Group Conversation

- Multi-Agent Members；
- Mention；
- Reply Policy；
- Orchestrator；
- Sequential；
- Parallel；
- Loop Guard；
- Reply Budget；
- Group UI。

---

## 172. Phase 4 — History and Productization

- Agent History；
- Summary；
- Memory Integration；
- Read State；
- Notification；
- Archive；
- Export；
- Inspector；
- Recovery；
- Retention。

---

# Part XXIX — Definition of Done

## 173. Conversation Runtime Foundation DoD

Foundation 完成必须满足：

1. Conversation 是持久对象。
2. Message 是持久对象。
3. Direct Agent Conversation 可用。
4. Group Conversation 可创建。
5. Agent Membership 与 Provider Session 分离。
6. Agent 显示身份来自 Agent Profile。
7. User Message 先持久化再路由。
8. Message Sequence 唯一且递增。
9. Client Retry 不重复创建 Message。
10. Streaming Message 可断线恢复。
11. Streaming 最终形成 Final 或 Failed Message。
12. Browser Disconnect 不取消 Run。
13. Browser Disconnect 不删除 Message。
14. 普通 Chat 与 Start Run 分离。
15. Message 可以创建 Task。
16. Message 可以启动 Run。
17. Run 状态通过 Projection 展示。
18. Runtime Event 与 Message 分离。
19. Projection 幂等。
20. Approval 通过持久 Card 展示。
21. 普通文本“好”不自动批准高风险 Action。
22. Artifact 通过 Reference 展示。
23. Conversation History 可搜索。
24. Archived Conversation 不自动触发 Agent。
25. Agent Turn 与 Run 分离。
26. Group Conversation 有 Reply Policy。
27. Group Conversation 有 Loop Guard。
28. Parallel Reply 有 Agent Budget。
29. Agent-to-Agent Reply 有 Hop Limit。
30. Conversation Context 有 Budget。
31. Conversation Summary 可版本化。
32. History 与 Memory 分离。
33. Provider 只能获得受控 Turn Context。
34. Secret 不进入普通 Message。
35. Markdown 渲染经过 Sanitization。
36. Read State 和 Unread Count 可用。
37. Server Startup 可恢复 Streaming Turn 和 Projection。
38. v1 Task Pipeline 可映射为 Task Conversation。
39. Agent History 可以查看 Message、Task、Run 和 Session 引用。
40. Direct、Group、Streaming、Projection 和 Security 测试通过。

---

# Part XXX — Anti-Patterns

## 174. Conversation Equals Provider Session

错误：

```text
One chat window
  = one CLI process
```

正确：

```text
Conversation
  ↓
many Agent Turns
  ↓
many Provider Sessions
```

---

## 175. Every Message Starts a Run

错误：

```text
User sends text
  → execute code immediately
```

正确：

```text
Intent Resolution
  ↓
Chat / Task / Run / Approval
```

---

## 176. Provider Name as Agent Identity

错误：

```text
Conversation Member:
  KimiCode
```

正确：

```text
Conversation Member:
  Backend Engineer

Current Provider:
  KimiCode
```

除非用户明确创建的 Agent Profile 名就叫 KimiCode。

---

## 177. Raw stdout as Message History

错误：

```text
Every stdout chunk
  → standalone chat message
```

正确：

```text
Runtime Event
  ↓
Streaming Block / Tool Card / Artifact
```

---

## 178. Agent Echo Loop

错误：

```text
A replies to B
B replies to A
unbounded
```

正确：

```text
Reply Policy
+ Hop Limit
+ Turn Budget
+ Orchestrator
```

---

## 179. Group Chat Equals Parallel CLI Launch

错误：

```text
All members
  → start provider process
```

正确：

```text
Message Router
  ↓
Orchestrator / Workflow
  ↓
Selected Agent Turns
```

---

## 180. Runtime State Copied into Message

错误：

```text
Run Card status is permanent copied text
```

正确：

```text
Snapshot for history
+ Live Run State for current UI
```

---

## 181. Edit Rewrites History

错误：

```text
UPDATE message content
```

正确：

```text
Message Revision
+ edited marker
```

---

## 182. Approval by Ambiguous Text

错误：

```text
User: 好
→ approve git push
```

正确：

```text
Approval Card
+ approvalRequestId
+ explicit decision
```

---

## 183. Full History Prompt

错误：

```text
All conversation messages
  → provider prompt
```

正确：

```text
Recent relevant messages
+ summary
+ task context
+ memory budget
```

---

## 184. Conversation Delete Cascades Runtime

错误：

```text
Delete chat
  → delete Task / Run / Artifact
```

正确：

```text
Conversation soft delete
Runtime history preserved
```

---

## 185. Hidden Group Coordination Floods UI

错误：

```text
Every internal stage event
  → chat message
```

正确：

```text
Internal Runtime Event
  ↓
Aggregated user-facing projection
```

---

# Part XXXI — Global Invariants

## 186. Conversation Runtime Invariants

AgentOS v2 必须始终满足：

1. Conversation 是持久协作容器。
2. Conversation 不等于 Provider Session。
3. Conversation 不等于 Run。
4. Message 不等于 Runtime Event。
5. Runtime Event 可以幂等投影为 Message。
6. Conversation 关闭不取消 Run。
7. Browser Disconnect 不取消 Run。
8. Browser Disconnect 不删除 Streaming Message。
9. User Message 必须先持久化再路由。
10. Message Sequence 必须唯一且递增。
11. Client Message ID 必须支持幂等。
12. Message 编辑必须保留 Revision。
13. Message 删除默认软删除。
14. Agent 身份来自 Agent Profile。
15. Provider 切换不改变 Agent 历史身份。
16. Agent Membership 不等于 Provider Session。
17. 普通 Message 不默认创建 Run。
18. 高风险 Intent 必须确认。
19. Task Creation 与 Run Creation 必须分离。
20. Agent Turn 不等于 Run。
21. Chat-only Turn 可以没有 Worktree。
22. Run-backed Turn 的取消必须区分停止回复和取消 Run。
23. Group Chat 必须有 Reply Policy。
24. Group Chat 必须有 Reply Budget。
25. Agent-to-Agent 回复必须有 Hop Limit。
26. Orchestrator 不得无限调用 Agent。
27. Parallel Agent 默认上下文隔离。
28. Group Run 必须通过 Workflow 或明确编排。
29. Runtime 高频 Event 不应淹没 Conversation。
30. Approval 必须绑定 Approval Request。
31. 模糊文本不得自动批准。
32. Artifact 在 Message 中以 Reference 存在。
33. Run Card 当前状态来自 Run Runtime。
34. Historical Replay 可以使用 Snapshot。
35. Conversation History 不等于 Memory。
36. Conversation Context 必须有 Budget。
37. Conversation Summary 必须版本化。
38. Summary 不得把推断变成事实。
39. Provider 只获得受控 Turn Context。
40. Hidden Chain of Thought 不得进入 Message。
41. Message Markdown 必须安全渲染。
42. Secret 不得进入普通 Message Store。
43. Attachment 必须经过权限和敏感性检查。
44. Archived Conversation 默认不自动响应。
45. Conversation Delete 不级联删除 Runtime 对象。
46. Projection Consumer 必须幂等。
47. Projection Failure 不得使 Run 失败。
48. Pending Approval 必须可在重启后恢复。
49. Streaming Turn 必须可恢复或稳定失败。
50. Conversation Runtime 必须支持 Direct 和 Group 两种核心协作方式。
51. Agent History 必须关联 Conversation、Task、Run 和 Provider Session。
52. Read State 必须由 Server Sequence 计算。
53. Notification 必须聚合高频 Runtime 状态。
54. Presence 和 Typing 是 Ephemeral。
55. “Thinking”只能表示状态，不得泄露隐藏 Reasoning。
56. v1 SSE Output 必须迁移为 Streaming Message 和 Runtime Projection。
57. v1 Task-only UI 不能继续作为唯一交互入口。
58. Runtime Inspector 与 Conversation Timeline 必须分工。
59. Search、Archive 和 Export 必须可用。
60. Conversation Runtime 必须通过多客户端和断线恢复测试。

---

# Part XXXII — Final Definition

## 187. Final Definition

AgentOS v2 Conversation Runtime 定义如下：

> Conversation Runtime 是 AgentOS 用于承载用户、长期 Agent、System 和 Extension 之间持久协作的消息运行时。Conversation 保存成员、角色、回复策略、上下文策略和通知策略；Message 保存用户可读的文本、Task、Run、Approval、Artifact、Review 和 Error；Agent Turn 表示某个 Agent 对某条 Message 的一次响应尝试；Group Orchestrator 负责在多 Agent Conversation 中选择发言者、执行顺序、并行模式和回复预算。Conversation 中的工程执行通过 Task 和 Run Runtime 完成，运行状态通过 Runtime Event Projector 幂等投影为 Message Card。Streaming Output 先形成持久 Streaming Message 和 Checkpoint，客户端断线后可恢复，最终归并为 Final 或 Failed Message。Conversation History 与 Memory 分离，Provider 只能接收经过 Context Budget、Summary 和 Memory Retrieval 构建的受控上下文。

简化表达：

```text
User / Agent Message
  ↓
Persistent Conversation
  ↓
Intent + Routing
  ├── Chat Agent Turn
  ├── Create Task
  ├── Start Run
  ├── Resolve Approval
  └── Conversation Command
        ↓
Provider / Runtime
        ↓
Runtime Events
        ↓
Idempotent Conversation Projection
        ↓
Streaming Text + Cards + Final Result
```

单聊模型：

```text
User
  ↔
Persistent Agent Profile
  ↓
Provider may change per Turn or Run
```

群聊模型：

```text
User Message
  ↓
Reply Policy + Orchestrator
  ↓
Selected Agent Turns
  ├── Sequential
  ├── Parallel
  └── Workflow-backed
        ↓
Aggregated User-facing Result
```

Conversation 与 Runtime 的最终边界：

```text
Conversation:
  collaboration, messages, identity, routing, history

Task:
  durable engineering intent

Run:
  one execution attempt

Provider Session:
  provider-native execution session

Runtime Event:
  structured execution fact

Message Projection:
  human-readable view of selected runtime facts
```

本文件定义的 Conversation Runtime 是 AgentOS v2 微信式 Agent 聊天界面、持久单聊、多 Agent 群聊、Agent 历史、Task / Run 入口、Approval Center、流式 CLI 展示和长期协作体验的产品基础。
