# AgentOS Runtime Specification v2.0

## 13 — Runtime Inspector

> Status: Draft
> Version: 2.0
> Last Updated: 2026-07-19
> Scope: AgentOS v2 Runtime Inspection, Diagnosis, Replay and Recovery Interface
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
> - `09-Conversation-Runtime.md`
> - `10-Data-Model.md`
> - `11-API-Specification.md`
> - `12-UI-Architecture.md`
> Repository: `Zbyy0311/agentos`

---

## 1. Document Purpose

本文件定义 AgentOS v2 的 Runtime Inspector。

Runtime Inspector 是 AgentOS 用于查看、解释、诊断、控制和恢复 Runtime 的高级界面与应用层 Query Model。

它将以下 Runtime 事实聚合到一个可理解、可追踪、可操作的观察面：

- Workspace；
- Task；
- Run；
- Stage；
- Workflow Snapshot；
- Agent Snapshot；
- Provider Configuration Snapshot；
- Provider Session；
- Runtime Process；
- Worktree；
- Runtime Event；
- Memory Context；
- Policy Snapshot；
- Policy Decision；
- Approval；
- Artifact；
- Audit；
- Recovery。

本文件规定：

- Inspector 产品定位；
- Inspector 与 Runtime 的边界；
- Inspector Scope；
- Information Architecture；
- Run Overview；
- Stage Graph；
- Timeline；
- Event Viewer；
- Replay；
- Snapshot Viewer；
- Provider Session Viewer；
- Process Tree；
- Process Output；
- Worktree；
- Diff；
- Memory Context；
- Policy Decision；
- Approval；
- Artifact；
- Recovery；
- Audit；
- Inspector Query Model；
- API Contract；
- Realtime；
- Cursor；
- Freshness；
- Permissions；
- Redaction；
- Interaction；
- Performance；
- Accessibility；
- Testing；
- v1 Migration；
- Implementation Phases；
- Definition of Done。

---

## 2. Runtime Inspector Definition

Runtime Inspector 定义为：

> 一个基于持久 Current State、Immutable Snapshot、Runtime Event、Artifact 和 Audit Record 构建的可恢复观察与控制界面，使用户能够回答一次工程执行“正在发生什么、已经发生什么、为什么发生、产生了什么、能否恢复，以及下一步可以安全做什么”。

简化表达：

```text
Current State
+ Immutable Snapshot
+ Ordered Runtime Events
+ Artifacts
+ Audit
  ↓
Inspector Query Model
  ↓
Progressive UI
  ↓
Observe / Explain / Control / Recover
```

---

## 3. Inspector Is Not Runtime

Runtime Inspector 不拥有：

- Run 生命周期；
- Stage 生命周期；
- Provider Session 生命周期；
- Process 生命周期；
- Worktree 生命周期；
- Approval 生命周期；
- Artifact 生命周期。

Inspector 只能：

- 查询；
- 订阅；
- 解释；
- 发起明确 Command；
- 展示 Command 结果；
- 展示 Recovery 建议。

所有副作用必须进入：

```text
Inspector Action
  ↓
Public API Command
  ↓
Authentication
  ↓
Resource Authorization
  ↓
Policy Evaluation
  ↓
Runtime Service
  ↓
State + Event + Audit
```

禁止：

```text
Inspector component
  → direct child_process
  → direct git
  → direct SQLite
  → direct filesystem delete
```

---

## 4. Inspector Goals

Runtime Inspector 必须满足：

1. **可定位**
   用户能确定当前 Workspace、Task、Run、Stage、Agent 和 Provider。

2. **可理解**
   用户不必阅读全部 Raw Event 才能理解进度。

3. **可证明**
   每个重要状态能够链接到 Snapshot、Event、Artifact 或 Audit。

4. **可恢复**
   断线、刷新或 Server 重启后能够重建观察状态。

5. **可控制**
   Pause、Resume、Cancel、Retry、Approve、Merge 等操作具有明确边界。

6. **可解释**
   Memory、Policy、Provider、Worktree 和 Failure 的来源可查看。

7. **可扩展**
   新 Provider、Event、Artifact 和 Extension 不要求重写整个 Inspector。

8. **可降级**
   部分 Domain 查询失败时，其余 Inspector 仍可工作。

9. **可安全使用**
   Secret、Restricted Output 和危险操作受到权限与 Policy 约束。

10. **可处理大历史**
    100k Runtime Event、长日志和大型 Diff 不阻塞主线程。

---

# Part I — Core Principles

## 5. Read Model, Not Source of Truth

Inspector 是 Query Model。

它不是新的 Canonical Storage。

```text
Canonical:
  aggregate tables
  + event store
  + snapshots
  + artifacts
  + audit

Inspector:
  application-layer aggregation
  + cached projections
```

不建议创建一个包含所有 Domain 的超大 SQL View。

---

## 6. Current State and History Are Separate

Inspector 必须同时展示：

### Current State

```text
Run.status = running
```

### Historical Fact

```text
run.started at sequence 42
```

当前状态不能替代历史。

历史 Event 不能直接替代当前状态。

---

## 7. Execution-time Snapshot Wins

历史 Run 的解释必须使用执行时 Snapshot。

例如：

```text
Current Agent Profile
  ≠ Agent Snapshot used by Run

Current Provider Configuration
  ≠ Provider Snapshot used by Stage

Current Policy Profile
  ≠ Policy Snapshot used by Run
```

Inspector 可以提供 Compare：

```text
Execution-time Snapshot
vs
Current Configuration
```

但不能用当前配置覆盖历史事实。

---

## 8. Progressive Disclosure

Inspector 默认展示：

```text
Summary
  ↓
Domain Detail
  ↓
Runtime Event
  ↓
Raw Payload / Artifact
```

普通用户不应被迫直接面对：

- Raw JSON；
- PID；
- full environment；
- internal cursor；
- provider-native event；
- raw stderr。

Advanced Mode 才展示底层细节。

---

## 9. No Hidden Chain-of-Thought

Inspector 可以展示：

- Provider 可公开的 Text Delta；
- Tool Call；
- Command；
- File Change；
- Test Result；
- Summary；
- Structured Decision；
- Policy Explanation；
- Memory Retrieval Reason。

Inspector 不展示或推断：

- Hidden Chain-of-Thought；
- Private Scratchpad；
- Provider Internal Reasoning Token；
- 未明确公开的模型内部状态。

---

## 10. Never Guess Success

如果 Runtime 无法确认完成：

```text
unknown
recovery_required
failed
```

都优于猜测：

```text
completed
```

Inspector 必须明确区分：

- Confirmed；
- Inferred；
- Stale；
- Partial；
- Missing；
- Recovery Required。

---

## 11. Stable Identity

Inspector 中每个对象必须保持稳定 Identity：

- Run ID；
- Stage ID；
- Event ID；
- Process ID；
- Provider Session ID；
- Worktree ID；
- Approval ID；
- Artifact ID。

PID、Branch Name、Display Name 不是稳定对象 Identity。

---

## 12. Sequence-aware

Runtime Timeline 使用 Run-local Sequence。

客户端必须检测：

- Duplicate；
- Gap；
- Out-of-order；
- Cursor Expired。

检测 Gap 后：

```text
pause local incremental projection
  ↓
fetch missing durable events
  ↓
apply in sequence
  ↓
resume realtime
```

---

## 13. Partial Failure Tolerance

Inspector 聚合查询可能出现：

```text
Run loaded
Process service unavailable
Artifact index partial
Memory context restricted
```

不得让整个页面因一个子域失败而白屏。

每个 Section 有独立：

- loading；
- ready；
- empty；
- partial；
- stale；
- error；
- permission denied。

---

# Part II — Inspector Scope

## 14. Workspace Runtime Center

Workspace Runtime Center 是 Inspector 的入口列表。

展示：

- Active Runs；
- Waiting Approvals；
- Recovery Required；
- Orphan Processes；
- Dirty Worktrees；
- Provider Warnings；
- Recent Failures；
- Cleanup Required；
- Dead Letters，Advanced；
- Runtime Health。

---

## 15. Run Inspector

Run Inspector 是主要 Inspector Scope。

它聚合：

```text
Run
├── Task
├── Attempt Tree
├── Stages
├── Snapshots
├── Provider Sessions
├── Processes
├── Worktrees
├── Memory Contexts
├── Policy Decisions
├── Approvals
├── Artifacts
├── Events
├── Recovery
└── Audit
```

---

## 16. Stage Inspector

Stage Inspector 聚焦：

- Stage Definition Snapshot；
- Dependencies；
- Attempt；
- Agent Snapshot；
- Provider Session；
- Process；
- Worktree；
- Memory Context；
- Input；
- Output；
- Contract；
- Events；
- Failure；
- Retry。

---

## 17. Provider Session Inspector

聚焦：

- Provider Type；
- Adapter；
- Configuration Snapshot；
- Native Session Reference；
- Process；
- Authentication State；
- Capability；
- Stream Mode；
- Raw Output Reference；
- Normalized Events；
- Exit；
- Failure；
- Resume Capability。

---

## 18. Process Inspector

聚焦：

- AgentOS Process ID；
- Native PID；
- Parent / Children；
- Executable；
- Redacted Args；
- CWD；
- Environment Profile Reference；
- Status；
- Usage；
- stdout / stderr；
- Exit；
- Termination；
- Recovery Identity。

---

## 19. Worktree Inspector

聚焦：

- Workspace；
- Owner；
- Branch；
- Base Commit；
- Head Commit；
- Target；
- Status；
- Changes；
- Diff；
- Review；
- Conflict；
- Merge；
- Cleanup；
- Locks。

---

## 20. Memory Context Inspector

聚焦：

- Retrieval Request；
- Query；
- Scope；
- Candidate Entries；
- Selected Entries；
- Rank；
- Score；
- Reasons；
- Budget；
- Exclusions；
- Truncation；
- Prompt Artifact；
- Source Lineage。

---

## 21. Policy and Approval Inspector

聚焦：

- Principal；
- Action；
- Resource；
- Context；
- Risk；
- Matched Rules；
- Precedence；
- Decision；
- Approval Request；
- Grant；
- Re-evaluation；
- Execution Result。

---

## 22. Artifact Inspector

聚焦：

- Artifact Type；
- Source；
- Producer；
- Version；
- MIME；
- Size；
- Checksum；
- Sensitivity；
- References；
- Preview；
- Retention；
- Integrity。

---

## 23. Recovery Inspector

聚焦：

- Recovery Scan；
- Classification；
- Evidence；
- Missing Resource；
- Suggested Action；
- Risk；
- Preserve；
- Reattach；
- Fail Stable；
- Cleanup；
- Audit。



# Part III — Information Architecture

## 24. Inspector Surfaces

Runtime Inspector 有两个 Surface：

### Context Inspector

右侧非阻塞 Panel。

适合：

- 快速查看；
- 当前 Conversation / Task 上下文；
- 小范围控制；
- 轻量 Timeline。

### Full Inspector

独立完整 Route。

适合：

- 大 Timeline；
- Process Tree；
- Output；
- Replay；
- Diff；
- Recovery；
- Audit；
- Compare。

---

## 25. Route Contract

建议 Route：

```text
/workspaces/:workspaceId/runtime
/runs/:runId
/runs/:runId/overview
/runs/:runId/stages/:stageId
/runs/:runId/events
/runs/:runId/processes
/runs/:runId/worktrees
/runs/:runId/memory
/runs/:runId/policy
/runs/:runId/artifacts
/runs/:runId/recovery
/runs/:runId/audit
```

对象 Deep Link：

```text
/processes/:processId
/worktrees/:worktreeId
/events/:eventId
/artifacts/:artifactId
/approvals/:approvalRequestId
```

---

## 26. Main Layout

```text
┌─────────────────────────────────────────────────────────────┐
│ Run Header / Status / Connection / Primary Controls         │
├──────────────┬──────────────────────────────┬───────────────┤
│ Section Nav  │ Main Inspector Canvas        │ Detail Panel  │
│              │                              │               │
│ Overview     │ Stage Graph / Timeline       │ Selected      │
│ Events       │ Process Tree / Diff          │ Event/Object  │
│ Processes    │ Memory / Policy / Artifact   │               │
└──────────────┴──────────────────────────────┴───────────────┘
```

### 26.1 Standard Width

Section Navigation 可折叠。

Detail Panel 按需打开。

### 26.2 Compact Width

Section Navigation 变为 Tabs / Menu。

Detail 变为 Sheet。

---

## 27. Run Header

必须展示：

- Task Title；
- Run ID，Copy；
- Status；
- Reason；
- Attempt；
- Parent / Child；
- Workflow；
- Started；
- Duration；
- Connection State；
- Last Event Sequence；
- Worktree Status；
- Pending Approval；
- Recovery Warning；
- Primary Controls。

---

## 28. Status Attention

Run 状态的 UI Attention 建议：

```text
recovery_required
waiting_approval
cancelling
failed
running
paused
queued
completed
cancelled
```

此优先级仅用于视觉提示，不改变 Domain Status。

---

## 29. Primary Controls

根据状态和权限显示：

- Start；
- Pause；
- Resume；
- Cancel；
- Retry；
- Open Task；
- Review；
- Merge；
- Accept；
- Resolve Approval；
- Recovery Action。

不允许展示无法通过 API 执行的伪操作。

---

# Part IV — Run Overview

## 30. Overview Summary

Overview 首屏回答：

1. 这是什么 Run？
2. 当前处于什么状态？
3. 当前谁在工作？
4. 使用哪个 Provider？
5. 是否正在修改代码？
6. 是否等待用户？
7. 最近发生了什么？
8. 是否有错误？
9. 产生了什么结果？
10. 下一步可以做什么？

---

## 31. Overview Cards

建议：

```text
Status
Current Stage
Agent / Provider
Worktree
Approval
Result
Failure
Recovery
```

Card 只展示 Summary。

点击后定位到对应 Section。

---

## 32. Attempt Tree

展示：

```text
Initial Run
├── Retry failed-stage
├── Provider-switch Run
└── Review-fix Run
```

必须区分：

- Parent；
- Root；
- Sibling；
- Accepted Run。

Retry 不是原 Run 的状态重置。

---

## 33. Snapshot Summary

Overview 显示 Snapshot IDs 和摘要：

- Workflow；
- Agent；
- Provider；
- Policy；
- Memory Context；
- Base Commit。

Snapshot 未创建或损坏时显示 Recovery Warning。

---

# Part V — Stage Graph and Execution Flow

## 34. Stage Graph

Stage Graph 由 Workflow Snapshot 和 Run Stage State 构建。

必须支持：

- Linear；
- Parallel；
- Branch；
- Join；
- Conditional；
- Skipped；
- Retry Attempt。

---

## 35. Stable Layout

同一 Run 中 Stage Graph Layout 必须稳定。

Event 更新不能导致节点随机换位。

推荐将布局结果缓存为 View State 或 Projection Metadata。

---

## 36. Stage Node

显示：

- Stage Key；
- Display Name；
- Status；
- Agent；
- Provider；
- Attempt；
- Duration；
- Dependencies；
- Worktree；
- Approval；
- Output Contract；
- Failure。

---

## 37. Stage Selection

选择 Stage 后：

- Timeline 自动过滤，可选；
- Detail Panel 打开；
- URL 更新；
- Focus 可恢复；
- Graph 不重新布局。

---

## 38. Parallel Stage

并行 Stage 显示：

- 独立状态；
- 独立 Provider Session；
- 独立 Worktree，按策略；
- Join Condition；
- Blocking Dependency。

---

# Part VI — Runtime Timeline

## 39. Timeline Definition

Runtime Timeline 是 Runtime Event 的用户可读投影。

它不是 Message Timeline，也不是 Raw Log。

```text
Runtime Event
  ↓
Timeline Projector
  ↓
Timeline Item
```

---

## 40. Timeline Modes

### Summary

展示：

- Run；
- Stage；
- Tool；
- Command；
- File；
- Approval；
- Test；
- Artifact；
- Error；
- Recovery。

### Detailed

增加：

- Provider；
- Process；
- Worktree；
- Memory；
- Policy；
- Usage。

### Raw Event

按 Sequence 展示 Canonical Event。

仅 Advanced Mode。

---

## 41. Timeline Item

```ts
interface RuntimeTimelineItem {
  id: string;

  runId: string;
  stageId?: string;

  kind:
    | 'run'
    | 'stage'
    | 'provider'
    | 'process'
    | 'tool'
    | 'command'
    | 'file'
    | 'test'
    | 'worktree'
    | 'memory'
    | 'policy'
    | 'approval'
    | 'artifact'
    | 'recovery'
    | 'error'
    | 'system';

  status?: string;

  title: string;
  summary?: string;

  firstSequence: number;
  lastSequence: number;

  startedAt?: string;
  completedAt?: string;
  durationMs?: number;

  sourceRefs: InspectorResourceReference[];

  severity?: string;
  visibility?: string;

  expandable: boolean;
}
```

---

## 42. Event Aggregation

允许聚合：

- `stream.text_delta`；
- Tool Progress；
- Process Usage Samples；
- Heartbeat；
- repeated status；
- file delta；
- recovery scan detail。

必须单独保留：

- Run Terminal；
- Stage Terminal；
- Approval；
- Policy Deny；
- Error；
- Merge；
- Artifact Finalized；
- Recovery Result。

---

## 43. Timeline Grouping

支持按：

- Stage；
- Correlation；
- Tool Call；
- Process；
- Time；
- Domain。

默认按 Sequence。

---

## 44. Timeline Filter

支持：

- Stage；
- Type；
- Domain；
- Severity；
- Source；
- Agent；
- Provider；
- Process；
- Worktree；
- Approval；
- Artifact；
- Text Query；
- Sequence Range；
- Time Range。

---

## 45. Live Tail

Live Tail 默认仅在用户位于底部时开启。

用户向上滚动后：

- 保持当前位置；
- 显示 New Events Count；
- 提供 Jump to Latest。

不得强制抢夺 Scroll。

---

## 46. Timeline Bookmark

Foundation 可使用 URL 和 Client-local State 保存：

```text
runId
sequence
filters
selectedItem
```

Future 可增加 Server Saved View。

不需要现在新增 Canonical Runtime 表。

---

# Part VII — Event Viewer and Replay

## 47. Event Row

Event Row 展示：

- Sequence；
- Timestamp；
- Type；
- Domain；
- Stage；
- Source；
- Correlation；
- Severity；
- Summary；
- Visibility。

---

## 48. Event Detail

展开后展示：

- Event ID；
- Schema Version；
- Run ID；
- Stage ID；
- Causation ID；
- Correlation ID；
- Producer；
- Principal；
- Resource References；
- Redacted Payload；
- Artifact References；
- Previous / Next；
- Raw JSON，Advanced。

---

## 49. Raw JSON

Raw JSON：

- 只读；
- Syntax Highlight；
- 可 Copy，按权限；
- Secret Redacted；
- 大 Payload 转 Artifact；
- 不允许编辑后回写 Event。

---

## 50. Correlation Trace

用户选择 Correlation 后可以看到：

```text
User Command
  ↓
Policy Decision
  ↓
Approval
  ↓
Process Start
  ↓
Tool Call
  ↓
File Change
  ↓
Artifact
```

---

## 51. Causation Trace

Causation Trace 展示事件链，而不是按时间猜测因果。

缺失 Causation 时标记：

```text
causation unavailable
```

---

## 52. Replay

Replay 只重放 Event 和 Projection。

不重新：

- 启动 Provider；
- 运行 Process；
- 修改文件；
- 调用网络；
- 发起 Approval；
- 合并 Worktree。

---

## 53. Replay Cursor

```ts
interface ReplayCursor {
  runId: string;
  fromSequence: number;
  toSequence?: number;
  currentSequence: number;
  speed: number;
  paused: boolean;
}
```

---

## 54. Replay Modes

### Step

单 Event 前进。

### Timed

按原时间比例或压缩比例播放。

### Jump

跳转：

- Stage Boundary；
- Approval；
- Error；
- Terminal；
- Bookmark。

---

## 55. Replay Compatibility

如果旧 Event Schema 无法完全渲染：

- 保留 Raw Event；
- 显示 Compatibility Warning；
- 使用 Fallback Renderer；
- 不修改历史 Event。

---

# Part VIII — Snapshot Inspector

## 56. Snapshot Types

Inspector 支持：

- Workflow Snapshot；
- Stage Definition Snapshot；
- Agent Snapshot；
- Provider Snapshot；
- Policy Snapshot；
- Memory Context Snapshot；
- Environment Profile Reference；
- Output Contract Snapshot。

---

## 57. Snapshot View

展示：

- Snapshot ID；
- Entity ID；
- Version；
- Hash；
- Created；
- Used By；
- Content；
- Redaction；
- Integrity。

---

## 58. Snapshot Compare

支持：

```text
Run Snapshot
vs
Current Entity
```

显示：

- Added；
- Removed；
- Changed；
- Security-sensitive Difference；
- Runtime Impact。

Compare 不暗示旧 Run 使用当前值。

---

## 59. Snapshot Integrity

Hash 不匹配时：

- 标记 Critical；
- 禁止静默继续；
- 创建 Recovery / Audit；
- 保留 Artifact；
- 不猜测 Snapshot 内容。

---

# Part IX — Provider Session Inspector

## 60. Provider Session Header

展示：

- Provider Type；
- Adapter；
- Configuration Snapshot；
- Agent；
- Stage；
- Status；
- Native Session Reference；
- Process；
- Started；
- Last Activity；
- Ended；
- Resume Capability。

---

## 61. Provider Identity

必须区分：

```text
Agent:
  Backend Engineer

Provider:
  KimiCode

Configuration:
  provider_kimicode_local
```

不得显示成单一身份。

---

## 62. Provider Health

显示执行时与当前状态：

- Executable Found；
- Version；
- Authentication；
- Capability；
- Validation Time；
- Current Health；
- Execution-time Health Snapshot。

---

## 63. Native Session Reference

Native Session Reference：

- 默认折叠；
- 不直接读取为 AgentOS Conversation；
- 可以用于 Resume / Diagnostic；
- 受权限控制；
- 不展示 Credential。

---

## 64. Provider Output

分为：

- Normalized Runtime Event；
- Public Text Stream；
- Raw stdout Artifact；
- Raw stderr Artifact；
- Adapter Warning。

用户默认先看到 Normalized Event。

---

## 65. Provider Failure

显示：

- Canonical Error Code；
- Provider-native Code；
- Exit；
- Auth State；
- Retryable；
- Suggested Action；
- Related Log Artifact；
- Recovery Capability。



# Part X — Process Inspector

## 66. Process Tree

Process Tree 使用 AgentOS Process ID 建立层级。

```text
Provider Session Process
├── Shell
│   ├── Test Runner
│   └── Build Tool
└── Helper Process
```

---

## 67. Process Node

显示：

- Process ID；
- Native PID；
- Parent Process ID；
- Type；
- Status；
- Executable；
- Redacted Args；
- CWD；
- Started；
- Last Activity；
- CPU；
- Memory；
- Exit；
- Termination Reason。

---

## 68. PID Warning

PID 仅作为当前平台信息。

它不能作为：

- Durable Identity；
- Recovery 唯一依据；
- Authorization Resource；
- Cross-restart Reference。

---

## 69. Process Usage

支持：

- CPU；
- RSS；
- Peak Memory；
- Duration；
- Child Count；
- Output Bytes；
- Last Activity。

Usage Sample 可受 Retention 清理。

Inspector 必须显示采样范围和是否 Partial。

---

## 70. Process Output Viewer

支持：

- stdout；
- stderr；
- merged，明确标识；
- tail；
- Range；
- Search；
- Wrap；
- Copy；
- Download Artifact；
- Follow。

---

## 71. Output Safety

Output 被视为不受信文本。

禁止：

- 执行 ANSI Escape；
- 注入 HTML；
- 自动打开 Link；
- 解释为系统 Approval；
- 暴露 Secret。

可选择安全 ANSI Renderer，但必须 Allowlist。

---

## 72. Output Retention

如果 Raw Output 已清理：

- 显示 Retention 状态；
- 保留 Summary；
- 保留 Terminal Event；
- 保留 Error Code；
- 提供相关 Artifact，若仍存在。

---

## 73. Process Control

普通控制优先：

```text
Run Cancel
Stage Cancel
```

高级控制：

- Stop Process；
- Pause Process，平台支持时；
- Resume Process；
- Cleanup Orphan。

Force Stop：

- 明确影响 Process Tree；
- Policy 评估；
- Approval，按风险；
- Idempotency；
- Audit。

---

# Part XI — Worktree and Diff Inspector

## 74. Worktree Summary

展示：

- Worktree ID；
- Path，按权限；
- Branch；
- Base Commit；
- Head Commit；
- Target Branch；
- Status；
- Owner；
- Lock；
- Changed Files；
- Review；
- Merge；
- Cleanup。

---

## 75. Base Commit

Base Commit 是 Run 执行解释的重要部分。

Inspector 必须明确：

```text
Run started from abc123
Current main is def456
```

避免用户误以为 Diff 基于当前 Target。

---

## 76. Worktree Status

必须支持：

- creating；
- active；
- dirty；
- ready_for_review；
- conflict；
- merged；
- abandoned；
- cleanup_required；
- deleted；
- recovery_required。

具体状态以 Worktree Runtime 为准。

---

## 77. File Change Tree

显示：

- Added；
- Modified；
- Deleted；
- Renamed；
- Untracked；
- Binary；
- Ignored，Advanced。

---

## 78. Diff Viewer

支持：

- Unified；
- Split；
- File Tree；
- Syntax；
- Search；
- Collapse；
- Line Link；
- Artifact；
- Review Reference。

大型 Diff：

- Lazy Load；
- Range；
- Virtualization；
- Worker Parse。

---

## 79. Review Package

展示：

- Summary；
- Changed Files；
- Test；
- Warning；
- Security Finding；
- Reviewer；
- Decision；
- Requested Changes；
- Review Artifact。

---

## 80. Merge Readiness

Merge 前必须展示：

- Source Head；
- Target；
- Expected Target Commit；
- Strategy；
- Conflict；
- Tests；
- Approval；
- Branch Lock；
- Cleanup Plan。

---

## 81. Merge Action

Inspector 只提交 Merge Command。

不能直接运行：

```text
git merge
git push
```

Merge Result 必须来自 Operation、Event 和 Worktree Merge Record。

---

## 82. Cleanup Action

Cleanup 展示：

- Dirty State；
- Unmerged Changes；
- Preserved Artifacts；
- Branch Delete；
- Worktree Delete；
- Force；
- Risk。

默认不选择 Force。

---

# Part XII — Memory Context Inspector

## 83. Retrieval Summary

展示：

- Query Text；
- Run；
- Stage；
- Agent；
- Provider；
- Strategy；
- Scope；
- Budget；
- Requested At；
- Completed At。

---

## 84. Selected Memory Entry

每个 Entry 显示：

- Title；
- Scope；
- Category；
- Authority；
- Confidence；
- Importance；
- Score；
- Rank；
- Reasons；
- Source；
- Snapshot Content；
- Characters / Tokens；
- Conflict；
- Stale。

---

## 85. Selection Explanation

Inspector 必须回答：

```text
为什么选择？
为什么未选择？
为什么排序在这里？
为什么被截断？
```

---

## 86. Exclusion Reasons

标准 Reason：

- below threshold；
- budget exceeded；
- duplicate；
- conflict；
- expired；
- restricted；
- scope mismatch；
- provider incompatibility；
- superseded；
- manually excluded。

---

## 87. Memory Content Safety

Memory Content 可能含 Prompt Injection。

Inspector 必须标记：

- User-authored；
- Imported；
- Agent-proposed；
- System-managed；
- Untrusted Source；
- Restricted。

Imported Memory 不得伪装成 Policy。

---

## 88. Prompt Context View

可展示实际注入的 Context Artifact。

要求：

- Secret Redacted；
- Hidden Reasoning Excluded；
- Section Boundaries；
- Source References；
- Token Estimate；
- Truncation Marker。

---

# Part XIII — Policy and Approval Inspector

## 89. Policy Decision Trace

展示：

```text
Principal
  ↓
Action
  ↓
Resource
  ↓
Context
  ↓
Matched Rules
  ↓
Precedence
  ↓
Risk
  ↓
Decision
```

---

## 90. Policy Decision

显示：

- Decision ID；
- Snapshot；
- Principal；
- Action；
- Resource；
- Risk；
- Matched Rules；
- Explanation；
- Constraint；
- Approval Required；
- Evaluated At；
- Execution Result。

---

## 91. Rule Precedence

按真实评估顺序展示：

- Priority；
- Specificity；
- Deny Override；
- Exception；
- Grant；
- Default。

不能由 UI 自行重新计算并作为权威结果。

---

## 92. Approval Request

显示：

- Exact Action；
- Exact Resource；
- Target；
- Risk；
- Reason；
- Requested By；
- Run / Stage；
- Allowed Scope；
- Expires；
- Current Version；
- Prior Decision。

---

## 93. Approval Resolution

按钮必须明确：

- Approve Once；
- Approve Action；
- Approve Stage；
- Approve Run；
- Reject；
- Cancel Run。

默认最小 Scope。

---

## 94. Re-evaluation

Approval 后显示：

```text
Approved
  ↓
Policy Re-evaluated
  ↓
Allowed / Denied / Changed Request
  ↓
Action Executed / Not Executed
```

Approved 不等于 Action 一定完成。

---

## 95. Unsafe Mode

Unsafe Mode 在 Inspector Header 常驻显示：

- Scope；
- Reason；
- Enabled By；
- Started；
- Expires；
- Remaining Hard Denies；
- Disable。

---

# Part XIV — Artifact Inspector

## 96. Artifact Index

按以下方式分组：

- Result；
- Diff；
- Test；
- Log；
- Raw Output；
- Review；
- Memory；
- Snapshot；
- Debug；
- Recovery；
- Export。

---

## 97. Artifact Metadata

显示：

- Artifact ID；
- Type；
- Name；
- MIME；
- Size；
- Checksum；
- Version；
- Immutable；
- Sensitivity；
- Source；
- Storage State；
- Retention；
- Created；
- Finalized。

---

## 98. Artifact Preview

支持：

- Text；
- Markdown；
- JSON；
- Image；
- Diff；
- Log；
- Archive Index；
- Binary Metadata。

不在 Browser 中直接执行 Artifact。

---

## 99. Artifact Reference Graph

展示 Artifact 与：

- Task；
- Run；
- Stage；
- Process；
- Worktree；
- Message；
- Approval；
- Memory；
- Audit；

之间的引用。

---

## 100. Artifact Integrity

Checksum Failure：

- 标记 Corrupted；
- 禁止当作可信 Result；
- 创建 Audit；
- 提供 Recovery；
- 保留 Metadata。

---

## 101. Artifact Access

Web：

- Preview；
- Download；
- Copy Reference。

Future Tauri：

- Open Native；
- Reveal；
- Save As。

所有本地能力通过 Platform Adapter。

---

# Part XV — Recovery Inspector

## 102. Recovery Principles

1. 不猜测成功。
2. 优先保留用户代码和 Artifact。
3. Recovery Action 必须可审计。
4. Destructive Cleanup 不默认。
5. Recovery 不能创建重复 Run。
6. Reattach 优于重启未知进程。
7. 无法恢复时稳定失败并允许新 Run。

---

## 103. Recovery Scan

展示扫描对象：

- Run；
- Stage；
- Provider Session；
- Process；
- Approval；
- Worktree；
- Queue；
- Event Sequence；
- Projection；
- Artifact；
- Lock；
- Outbox。

---

## 104. Recovery Classification

```ts
type InspectorRecoveryClassification =
  | 'healthy'
  | 'reattachable'
  | 'externally-running'
  | 'resumable'
  | 'process-missing'
  | 'orphan-process'
  | 'worktree-preserve'
  | 'worktree-cleanup-required'
  | 'approval-restorable'
  | 'projection-rebuildable'
  | 'artifact-partial'
  | 'snapshot-corrupt'
  | 'event-gap'
  | 'manual-review'
  | 'unrecoverable'
  | 'unknown';
```

---

## 105. Recovery Evidence

每项建议必须列出证据：

- Current DB State；
- Last Event；
- Process Identity；
- PID Start Time；
- Executable；
- Recovery Token；
- Worktree Exists；
- Head Commit；
- Approval Status；
- Artifact Checksum；
- Projection Cursor。

---

## 106. Recovery Confidence

```text
confirmed
high
medium
low
unknown
```

Confidence 是 Recovery Manager 计算结果。

UI 不自行提高 Confidence。

---

## 107. Recovery Actions

可能操作：

- Reattach；
- Restore Approval；
- Return to Queue；
- Mark Failed；
- Preserve Worktree；
- Rebuild Projection；
- Rebuild FTS；
- Retry Outbox；
- Cleanup Orphan；
- Release Lock；
- Manual Review；
- Create Retry Run。

---

## 108. Recovery Action Safety

每个 Action 显示：

- Expected State；
- Evidence；
- Side Effects；
- Data Preserved；
- Data Removed；
- Policy；
- Approval；
- Idempotency；
- Result Event。

---

## 109. Orphan Process

显示：

- Process Identity；
- Executable；
- CWD；
- Start；
- Usage；
- Possible Owner；
- Risk；
- Stop；
- Adopt，若支持；
- Ignore，受限。

---

## 110. Worktree Preserve

Run Terminal 但 Worktree Active 时：

- 不自动删除；
- 标记 Cleanup Required；
- 展示 Diff；
- 允许 Review；
- 允许 Merge；
- 允许 Archive；
- 允许 Cleanup。

---

# Part XVI — Audit Inspector

## 111. Audit Scope

展示：

- User Command；
- Agent Action；
- Policy Decision；
- Approval；
- Runtime Transition；
- Merge；
- Cleanup；
- Recovery；
- Admin Action；
- Secret Reference Access，受限。

---

## 112. Audit Record

显示：

- Audit ID；
- Actor；
- Client；
- Action；
- Resource；
- Result；
- Request ID；
- Policy Decision；
- Idempotency Key Hash；
- Time；
- Related Event；
- Related Artifact。

---

## 113. Audit vs Event

```text
Runtime Event
  = what happened in execution

Audit Record
  = who requested or authorized an important action
```

二者可以互相引用，但不能互相替代。

---

# Part XVII — Inspector Query Model

## 114. Aggregate DTO

```ts
interface RunInspectorView {
  run: InspectorRunSummary;
  task: InspectorTaskSummary;

  attemptTree: InspectorRunAttemptNode[];

  snapshots: InspectorSnapshotIndex;

  stages: InspectorStageSummary[];

  providerSessions: InspectorProviderSessionSummary[];
  processes: InspectorProcessSummary[];
  worktrees: InspectorWorktreeSummary[];

  memoryContexts: InspectorMemoryContextSummary[];

  policy: {
    snapshot?: InspectorPolicySnapshotSummary;
    decisions: InspectorPolicyDecisionSummary[];
  };

  approvals: InspectorApprovalSummary[];
  artifacts: InspectorArtifactSummary[];

  recovery: InspectorRecoverySummary;
  auditSummary: InspectorAuditSummary;

  eventCursor: {
    firstSequence?: number;
    lastSequence?: number;
    latestPersistedSequence?: number;
  };

  freshness: InspectorFreshness;

  permissions: InspectorPermissions;

  warnings: InspectorWarning[];
  partialErrors: InspectorSectionError[];

  version: number;
}
```

---

## 115. Resource Reference

```ts
interface InspectorResourceReference {
  type:
    | 'workspace'
    | 'task'
    | 'run'
    | 'stage'
    | 'agent'
    | 'provider-config'
    | 'provider-session'
    | 'process'
    | 'worktree'
    | 'memory'
    | 'memory-context'
    | 'policy-decision'
    | 'approval'
    | 'artifact'
    | 'event'
    | 'audit';

  id: string;
  label?: string;
}
```

---

## 116. Freshness

```ts
interface InspectorFreshness {
  generatedAt: string;
  latestEventSequence?: number;
  projectionSequence?: number;

  status:
    | 'fresh'
    | 'slightly-stale'
    | 'stale'
    | 'resyncing'
    | 'partial';

  staleSections: string[];
}
```

---

## 117. Permissions

```ts
interface InspectorPermissions {
  canReadRestrictedEvents: boolean;
  canReadRawOutput: boolean;
  canReadFullPaths: boolean;
  canControlRun: boolean;
  canControlStage: boolean;
  canControlProcess: boolean;
  canResolveApproval: boolean;
  canMerge: boolean;
  canCleanup: boolean;
  canExecuteRecovery: boolean;
}
```

UI 隐藏不可用 Action 的同时，Server 仍必须授权。

---

## 118. Section Error

```ts
interface InspectorSectionError {
  section: string;
  code: string;
  detail: string;
  retryable: boolean;
  requestId?: string;
}
```

---

## 119. Query Assembly

推荐 Application Service：

```text
RunInspectorQueryService
  ├── RunRepository
  ├── TaskRepository
  ├── SnapshotRepository
  ├── StageRepository
  ├── ProviderSessionRepository
  ├── ProcessRepository
  ├── WorktreeRepository
  ├── MemoryRepository
  ├── PolicyRepository
  ├── ApprovalRepository
  ├── ArtifactRepository
  ├── EventStore
  ├── AuditRepository
  └── RecoveryService
```

---

## 120. No Mega Transaction

Inspector Query 不需要将所有 Domain 放进一个长数据库事务。

要求：

- 每个结果有生成时间；
- 标明 Sequence；
- 允许 Partial；
- 必要时重试；
- 不阻塞 Runtime 写入。



# Part XVIII — API Contract

## 121. Inspector Endpoint

Canonical Foundation Endpoint：

```text
GET /api/runs/:runId/inspector
```

推荐 Query：

```text
include
eventLimit
eventAfterSequence
stageId
detailLevel
```

示例：

```text
GET /api/runs/run_123/inspector
  ?include=stages,providerSessions,processes,worktrees,approvals,artifacts
  &detailLevel=summary
```

---

## 122. Include Whitelist

允许：

```text
task
attemptTree
snapshots
stages
providerSessions
processes
worktrees
memoryContexts
policy
approvals
artifacts
recovery
auditSummary
```

Events 不应默认全量嵌入聚合响应。

---

## 123. Dedicated Endpoints

Inspector 使用既有 Domain API：

```text
GET /api/runs/:runId
GET /api/runs/:runId/stages
GET /api/runs/:runId/events
GET /api/runs/:runId/replay
GET /api/runs/:runId/snapshot
GET /api/runs/:runId/checkpoints
GET /api/runs/:runId/audit
GET /api/runs/:runId/processes
GET /api/runs/:runId/worktrees

GET /api/stages/:stageId
GET /api/stages/:stageId/provider-session
GET /api/stages/:stageId/processes
GET /api/stages/:stageId/worktree
GET /api/stages/:stageId/memory-context

GET /api/provider-sessions/:providerSessionId
GET /api/processes/:processId/tree
GET /api/processes/:processId/output
GET /api/processes/:processId/usage

GET /api/worktrees/:worktreeId/status
GET /api/worktrees/:worktreeId/diff
GET /api/worktrees/:worktreeId/reviews
GET /api/worktrees/:worktreeId/merges

GET /api/policy-decisions/:policyDecisionId
GET /api/approvals/:approvalRequestId

GET /api/artifacts/:artifactId
GET /api/artifacts/:artifactId/content
```

---

## 124. Inspector Response ETag

Run Inspector 返回：

```text
ETag
```

ETag 表达聚合 Query 版本或最新已知 Sequence。

它不替代子资源 ETag。

---

## 125. Inspector Commands

Inspector 发起既有 Command：

```text
POST /api/runs/:runId/pause
POST /api/runs/:runId/resume
POST /api/runs/:runId/cancel
POST /api/runs/:runId/retry

POST /api/stages/:stageId/pause
POST /api/stages/:stageId/resume
POST /api/stages/:stageId/cancel
POST /api/stages/:stageId/retry
POST /api/stages/:stageId/skip

POST /api/processes/:processId/stop
POST /api/processes/:processId/cleanup

POST /api/worktrees/:worktreeId/review
POST /api/worktrees/:worktreeId/merge
POST /api/worktrees/:worktreeId/cleanup

POST /api/approvals/:approvalRequestId/approve
POST /api/approvals/:approvalRequestId/reject
```

---

## 126. Recovery APIs

使用：

```text
GET  /api/system/recovery
POST /api/system/recovery/scan
POST /api/system/recovery/actions/:actionId/execute
```

Future 可以增加 Run-scoped Recovery Query，但不应复制 Recovery Manager 状态。

---

## 127. API Error

Inspector 必须处理：

- 401；
- 403；
- 404；
- 409；
- 410 Cursor Expired；
- 412 Version Conflict；
- 423 Locked；
- 429；
- 503 Partial Runtime；
- 504。

错误依据稳定 `code`。

---

## 128. Idempotency and Concurrency

以下 Action 必须使用 Idempotency Key：

- Cancel；
- Retry；
- Approval Resolve；
- Merge；
- Cleanup；
- Recovery Action。

以下 Action 使用：

- `If-Match`；
- `expectedVersion`；
- `expectedHeadCommit`；
- `expectedTargetCommit`。

---

# Part XIX — Realtime and Recovery

## 129. Initial Load

```text
GET Inspector Summary
  ↓
GET recent events
  ↓
subscribe Run Stream after latest sequence
```

先读取 Durable State，再连接 Realtime。

---

## 130. Run Stream

```text
GET /api/runs/:runId/stream
```

使用：

- `afterSequence`；
- `Last-Event-ID`；
- Runtime Event ID。

---

## 131. Reconnect

```text
stream disconnected
  ↓
UI marks reconnecting
  ↓
Run remains unchanged
  ↓
request missing events
  ↓
refresh affected resources
  ↓
resume stream
```

---

## 132. Event Application

Event 到达后：

1. 校验 Run；
2. 校验 Sequence；
3. 去重；
4. Patch relevant Query；
5. Append Timeline Projection；
6. Invalidate affected Domain；
7. Update Freshness；
8. Render。

---

## 133. Gap Detection

如果收到：

```text
expected = 101
received = 104
```

必须：

- 标记 Resyncing；
- 不把 104 当作连续事实；
- 查询 101–103；
- 再应用 104；
- 或重新加载 Summary。

---

## 134. Duplicate Event

重复 Event：

- 不重复 Timeline Item；
- 不重复 Toast；
- 不重复 Completion Feedback；
- 不重复触发 Fetch。

---

## 135. Cursor Expired

返回 `410` 时：

- 清除失效 Cursor；
- 完整拉取当前 State；
- 拉取可用历史范围；
- 显示 Retention Warning；
- 继续实时订阅。

---

## 136. Multi-client

多个客户端可以同时查看同一 Run。

一个客户端的：

- Panel；
- Filter；
- Scroll；
- Selection；

不影响其他客户端。

Domain Command 通过 Server 并发控制。

---

# Part XX — Inspector Client State

## 137. Client State

```ts
interface RuntimeInspectorClientState {
  runId: string;

  activeSection: string;
  selectedStageId?: string;
  selectedResource?: InspectorResourceReference;

  timelineMode: 'summary' | 'detailed' | 'raw';
  timelineFilters: Record<string, unknown>;

  liveTail: boolean;

  sectionNavCollapsed: boolean;
  detailPanelOpen: boolean;
  detailPanelWidth?: number;

  advancedMode: boolean;
}
```

---

## 138. Persistence

Local / URL：

- Active Section；
- Selected Stage；
- Selected Event；
- Sequence；
- Filters；
- Timeline Mode；
- Advanced Mode，按用户偏好。

Server Preference：

- Inspector Width；
- Default Detail Level；
- Code Wrap；
- Diff Mode；
- Density。

不持久化：

- Hover；
- Animation；
- Pointer Velocity；
- Temporary Drag；
- Focus Ring；
- Loading Spinner。

---

## 139. Deep Link

Deep Link 必须恢复：

- Run；
- Section；
- Stage；
- Event；
- Sequence；
- Resource；
- Filter，安全范围。

权限不足时返回受控 Error，不泄露资源存在性。

---

# Part XXI — Interaction Architecture

## 140. Context Inspector Opening

从 Conversation Run Card 打开时：

- Right Inspector 滑入；
- Canvas 保持；
- Run Card 保持 Source Highlight；
- 无 Blocking Scrim；
- 动画可打断。

---

## 141. Full Inspector Transition

Open Full View：

- 保留 Run Identity；
- 保留 Selected Section；
- 保留 Selected Event；
- 保留 Sequence；
- 使用短 Shared Context Transition；
- 支持 Browser Back。

---

## 142. Control Feedback

Command 提交后：

```text
pointer-down feedback
  ↓
command pending
  ↓
Operation / Resource accepted
  ↓
Runtime Event confirms transition
```

不得在 Server 确认前显示 Terminal Success。

---

## 143. Confirmation

Modal 仅用于：

- Force Kill；
- Force Cleanup；
- Hard Delete；
- Unsafe Mode；
- Merge with high risk；
- Recovery destructive action。

普通 Pause、Open、Filter 不使用 Modal。

---

## 144. Keyboard

建议：

```text
G O  Overview
G E  Events
G P  Processes
G W  Worktrees
G M  Memory
G A  Artifacts

J/K  next/previous timeline item
Enter open detail
Esc close detail
F search/filter
L toggle live tail
```

不得覆盖浏览器或系统关键快捷键。

---

## 145. Motion

遵循 `12-UI-Architecture.md`：

- pointer-down 即时反馈；
- Panel 可打断；
- 默认临界阻尼；
- 普通切换无 Bounce；
- Reduced Motion 使用 Crossfade；
- 大 Timeline 更新不进行逐项位移动画。

---

# Part XXII — Performance

## 146. Performance Targets

建议：

| Operation | Target |
|---|---|
| Inspector summary p95 | < 1 s |
| Section switch cached | < 100 ms |
| Event row open | < 100 ms |
| New event visible after commit | < 200 ms |
| Timeline filter local | < 100 ms for loaded page |
| Process tail update | < 200 ms |
| Deep link restore | < 1 s typical |

---

## 147. Large Event History

100k Event：

- Cursor Pagination；
- Virtualization；
- Summary Aggregation；
- Lazy Detail；
- Range Replay；
- No full JSON preload。

---

## 148. Event Virtualization

要求：

- Stable Item Key；
- Dynamic Height Cache；
- Scroll Anchor；
- Focus Preservation；
- Selection Preservation；
- Accessible Offscreen Strategy。

---

## 149. Output Streaming

Process Output：

- Byte Offset；
- Chunk Buffer；
- Tail Limit；
- Pause Follow；
- Worker Search；
- Artifact Download。

不保留无限 Browser String。

---

## 150. Lazy Sections

初始只加载：

- Run；
- Task；
- Stage Summary；
- Approval Summary；
- Recent Timeline；
- Recovery Warning。

按需加载：

- Raw Events；
- Raw Output；
- Full Diff；
- Audit；
- Snapshot Content；
- Artifact Content。

---

## 151. Worker Use

推荐 Worker：

- Large JSON Format；
- Diff Parse；
- Timeline Aggregation；
- Search；
- Syntax Highlight；
- Log Index。

---

## 152. Cache

缓存：

- Immutable Snapshot；
- Terminal Event；
- Final Artifact Metadata；
- Completed Run Summary。

谨慎缓存：

- Running Status；
- Approval；
- Recovery；
- Process。

---

# Part XXIII — Security and Privacy

## 153. Sensitive Data

默认隐藏：

- Secret Value；
- Token；
- Cookie；
- Private Key；
- Full Environment；
- Restricted Path；
- Unredacted Args；
- Hidden Reasoning；
- Provider Credential；
- Internal Authentication Material。

---

## 154. Redaction

Redaction 在 Server 优先执行。

Client 再做 Defense-in-depth。

不得只依赖 CSS 隐藏 Secret。

---

## 155. Restricted Sections

可能受限：

- Raw Event；
- Raw stdout / stderr；
- Full Path；
- Policy Internal Metadata；
- Audit；
- Secret Access Record；
- Recovery Admin Action；
- Dead Letter。

---

## 156. Untrusted Content

以下均为不受信：

- Agent Message；
- Provider Output；
- Log；
- Markdown；
- Artifact Text；
- File Content；
- Command Output。

要求：

- Sanitization；
- No Script；
- No Raw HTML by default；
- Link Protocol Allowlist；
- No approval impersonation；
- No automatic command execution。

---

## 157. Approval Authenticity

Approval Card 只能由 Approval Resource 渲染。

Event、Agent Message、Artifact 内容不能生成可执行 Approval Button。

---

## 158. Audit Access

Audit Query 需要权限。

普通用户可看与自己 Run 相关的用户友好记录。

Advanced Audit 可包含更严格信息。

---

## 159. Export

Inspector Export 可以生成：

- User Report；
- Runtime Report；
- Debug Bundle；
- Event Range；
- Recovery Report。

默认排除：

- Secret；
- Restricted Raw Output；
- Hidden Reasoning；
- Credential；
- Non-authorized Full Path。

---

# Part XXIV — Accessibility

## 160. Screen Reader Structure

建议 Landmark：

- Header；
- Navigation；
- Main；
- Complementary Detail；
- Status Region。

---

## 161. Live Updates

不逐 Event 全部朗读。

只宣布：

- Waiting Approval；
- Run Completed；
- Run Failed；
- Recovery Required；
- Connection Lost；
- Connection Restored。

---

## 162. Process Tree Accessibility

Process Tree：

- Tree Role；
- Expand / Collapse；
- Level；
- Position；
- Keyboard Navigation；
- Accessible Status。

---

## 163. Timeline Accessibility

Timeline：

- Logical Sequence；
- Heading Group；
- Event Summary；
- Expand Button；
- Time；
- Status；
- No color-only meaning。

---

## 164. Reduced Motion and Transparency

遵循 UI Architecture：

- Reduced Motion 关闭 Spring 位移和 Overshoot；
- Reduced Transparency 将 Glass 转 Solid；
- More Contrast 使用强 Border 和 Focus。

---

# Part XXV — Error and Degraded States

## 165. Inspector-level Error

仅在 Run 本体无法读取时使用 Full-page Error。

显示：

- Code；
- Detail；
- Request ID；
- Retry；
- Back；
- Diagnostics。

---

## 166. Section-level Error

Section Error 不阻塞其他 Section。

示例：

```text
Process usage temporarily unavailable.
Process state and output remain accessible.
```

---

## 167. Stale State

Stale Badge 显示：

- Last Updated；
- Latest Event Sequence；
- Projection Sequence；
- Reconnecting；
- Refresh。

不把 Stale 当作 Failed。

---

## 168. Deleted or Retained Resource

资源已清理：

- 显示 Tombstone；
- 保留 Reference；
- 显示 Retention；
- 不显示 404 空白页；
- 提供相关 Run / Artifact。

---

# Part XXVI — Testing

## 169. Query Contract Tests

覆盖：

- Complete；
- Partial；
- Restricted；
- Missing；
- Stale；
- Terminal；
- Recovery Required；
- 100k Event；
- No Artifact；
- Corrupted Snapshot。

---

## 170. Timeline Tests

- Sequence；
- Duplicate；
- Gap；
- Aggregation；
- Filter；
- Correlation；
- Causation；
- Live Tail；
- Scroll Anchor；
- Cursor Expired；
- Replay。

---

## 171. Control Tests

- Pause；
- Resume；
- Cancel；
- Retry；
- Approval；
- Merge；
- Cleanup；
- Recovery；
- Idempotency；
- Version Conflict；
- Lock Conflict。

---

## 172. Recovery Tests

- Process alive；
- Process missing；
- Orphan；
- Worktree preserved；
- Approval restored；
- Projection rebuilt；
- Snapshot corrupt；
- Artifact partial；
- Event gap；
- unknown state。

---

## 173. Security Tests

- Unauthorized Run；
- Restricted Event；
- Raw Output；
- Secret Redaction；
- Path；
- Markdown XSS；
- Approval Impersonation；
- Forged UI Action；
- Cross Workspace；
- Audit Permission。

---

## 174. Accessibility Tests

- Keyboard；
- Screen Reader；
- Focus；
- Virtual Timeline；
- Process Tree；
- 200% Zoom；
- Reduced Motion；
- More Contrast。

---

## 175. Performance Tests

- 100k Events；
- 10k Output Chunks；
- Large Diff；
- 100 Processes；
- 100 Artifacts；
- 20 Events/sec；
- Reconnect Gap；
- Low-end Windows Browser。

---

# Part XXVII — v1 Migration

## 176. Current v1 Inspection

v1 主要依赖：

- SSE Status；
- Stage Text；
- Thinking Text；
- stdout；
- Log；
- Task Output。

问题：

- 无 Durable Run Inspector；
- 无 Event Sequence；
- 无 Process Resource；
- 无 Provider Session；
- 无 Worktree Inspector；
- 无 Memory Context；
- 无 Policy Trace；
- 无 Recovery Evidence；
- Browser Disconnect 影响观察和执行。

---

## 177. Compatibility Inspector

迁移期可以从 v1 数据构建有限 Inspector：

```text
Legacy Task
  ↓
Compatibility Run
  ↓
Mapped Stage
  ↓
Legacy SSE / Log
  ↓
Compatibility Timeline Item
```

必须标记：

```text
legacy
partial
unverified
```

---

## 178. Migration Order

1. Run Summary；
2. Durable Events；
3. Stage Timeline；
4. Provider Session；
5. Process Tree；
6. Worktree；
7. Approval；
8. Memory Context；
9. Recovery；
10. Audit。

---

## 179. No Raw-log Lock-in

Legacy Log 可以作为 Artifact 保留。

新 Inspector 不应继续以 Log Parser 作为核心状态来源。

---

# Part XXVIII — Implementation Phases

## 180. Phase 1 — Inspector Foundation

- Route；
- Query Service；
- Run Header；
- Overview；
- Stage Summary；
- Recent Timeline；
- Realtime；
- Error；
- Permissions。

---

## 181. Phase 2 — Events and Replay

- Event List；
- Filter；
- Detail；
- Raw JSON；
- Correlation；
- Causation；
- Cursor；
- Replay；
- Virtualization。

---

## 182. Phase 3 — Process and Provider

- Provider Session；
- Process Tree；
- Output；
- Usage；
- Control；
- Failure；
- Raw Output Artifact。

---

## 183. Phase 4 — Worktree and Artifact

- Worktree Summary；
- File Tree；
- Diff；
- Review；
- Merge Readiness；
- Artifact Index；
- Preview；
- Integrity。

---

## 184. Phase 5 — Memory and Policy

- Memory Context；
- Selection Reasons；
- Policy Trace；
- Approval；
- Grant；
- Unsafe Mode。

---

## 185. Phase 6 — Recovery and Audit

- Recovery Scan；
- Evidence；
- Action；
- Orphan；
- Projection Recovery；
- Audit；
- Export；
- Debug Bundle。

---

## 186. Phase 7 — Hardening

- Accessibility；
- Visual Regression；
- Performance；
- Security；
- Large Data；
- Low-end Device；
- Multi-client；
- Documentation。

---

# Part XXIX — Definition of Done

## 187. Runtime Inspector DoD

Runtime Inspector 完成必须满足：

1. Run Inspector 有稳定 Route。
2. Inspector 只消费 Runtime API。
3. Inspector 不直接执行 Process、Git 或 Filesystem。
4. Overview 能解释当前 Run。
5. Task、Run、Stage 和 Attempt 可区分。
6. 历史 Run 使用执行时 Snapshot。
7. Stage Graph Layout 稳定。
8. Timeline 基于 Runtime Event。
9. Timeline 不等于 Raw Log。
10. Timeline 支持 Summary、Detailed、Raw。
11. Event 支持 Sequence Pagination。
12. Event Gap 可恢复。
13. Duplicate Event 不重复展示。
14. Cursor Expired 可 Full Resync。
15. Replay 不重新执行 Runtime。
16. Raw JSON 只读。
17. Hidden Chain-of-Thought 不展示。
18. Agent 与 Provider 明确分离。
19. Provider Session 可查看。
20. Process Tree 使用 AgentOS Process ID。
21. PID 不作为 Durable Identity。
22. Output 使用 Range 和 Tail。
23. Output 作为不受信内容处理。
24. Worktree 显示 Base、Head 和 Target。
25. Diff 支持大型文件。
26. Merge 显示 Expected Commit。
27. Merge 通过 API、Policy 和 Operation。
28. Memory Context 能解释选择和排除。
29. Policy Trace 使用真实评估结果。
30. Approval 默认最小 Scope。
31. Approval 后展示 Re-evaluation。
32. Unsafe Mode 常驻可见。
33. Artifact 不暴露 Storage Path。
34. Recovery 不猜测成功。
35. Recovery 展示 Evidence 和 Confidence。
36. Destructive Recovery 不默认。
37. Audit 与 Event 可互相引用。
38. Partial Section Error 不导致整页失败。
39. Stale State 明确。
40. Restricted Data 受权限保护。
41. Secret 在 Server Redact。
42. Agent Content 不能伪造 Approval。
43. Inspector Summary p95 目标小于 1 秒。
44. 100k Event 使用 Virtualization。
45. Streaming 不抢夺 Scroll。
46. Keyboard 可完成核心查看。
47. Focus 在 Realtime Update 中稳定。
48. Reduced Motion 可用。
49. Browser Disconnect 不取消 Run。
50. Web Inspector 可被未来 Tauri 直接复用。

---

# Part XXX — Anti-patterns

## 188. Inspector as Second Runtime

错误：

```text
Inspector state decides Run terminal status
```

正确：

```text
Inspector renders Runtime state
```

---

## 189. Mega SQL View

错误：

```text
one view joins all runtime tables and event payloads
```

正确：

```text
application-layer query service
+ domain repositories
+ partial result
```

---

## 190. Raw Log First

错误：

```text
open inspector
→ giant stdout terminal
```

正确：

```text
overview
→ timeline
→ domain detail
→ raw output
```

---

## 191. Event per Token in DOM

错误：

```text
one DOM row per text delta
```

正确：

```text
aggregate streaming deltas
```

---

## 192. PID as Identity

错误：

```text
/processes/1234
```

其中 1234 是 PID。

正确：

```text
/processes/proc_...
```

---

## 193. Approval from Markdown

错误：

```text
Agent writes [Approve]
```

正确：

```text
Approval Resource
→ trusted component
```

---

## 194. Current Config for Historical Run

错误：

```text
show current provider model as run model
```

正确：

```text
execution snapshot
+ optional current comparison
```

---

## 195. Direct Force Action

错误：

```text
button
→ taskkill /F
```

正确：

```text
command
→ policy
→ approval
→ process runtime
→ event
```

---

## 196. Reconnect Means Retry Run

错误：

```text
SSE reconnect
→ create new Run
```

正确：

```text
resume observation from sequence
```

---

# Part XXXI — Global Invariants

## 197. Inspector Invariants

AgentOS v2 Runtime Inspector 必须始终满足：

1. Inspector ≠ Runtime。
2. Inspector State ≠ Domain State。
3. Timeline ≠ Event Store。
4. Event ≠ Log。
5. Event ≠ Message。
6. Run ≠ Task。
7. Run ≠ Process。
8. Agent ≠ Provider。
9. Provider Session ≠ Process。
10. Worktree ≠ Workspace。
11. Artifact ≠ Local Path。
12. Current Config ≠ Historical Snapshot。
13. PID ≠ Process Identity。
14. Browser Session ≠ Run Lifecycle。
15. Reconnect ≠ Retry。
16. Replay ≠ Re-execution。
17. Approval ≠ Execution Success。
18. Run Completed ≠ Merged。
19. Run Completed ≠ Task Accepted。
20. Raw Output ≠ Canonical State。
21. Inspector Actions 必须通过 API。
22. 高风险 Action 必须通过 Policy。
23. Command 必须幂等。
24. Merge 必须使用 Expected Commit。
25. Recovery 不得猜测成功。
26. Recovery 默认保留 Worktree。
27. Destructive Action 不得默认选择。
28. Event 必须按 Sequence 应用。
29. Event Gap 必须 Resync。
30. Duplicate Event 必须去重。
31. Partial Query 必须显式标记。
32. Stale Query 必须显式标记。
33. Restricted Data 必须授权。
34. Secret 不得进入普通 Inspector Payload。
35. Hidden Chain-of-Thought 不得进入 Inspector。
36. Agent Output 不得伪造系统组件。
37. 大 Event 列表必须虚拟化。
38. 大 Output 必须 Range / Tail。
39. Timeline 聚合不能删除 Terminal Fact。
40. Audit 不能替代 Event。
41. Event 不能替代 Audit。
42. Snapshot Integrity Failure 必须可见。
43. Current and Historical 状态必须可区分。
44. Inspector 必须支持 Deep Link。
45. Inspector 必须支持 Keyboard。
46. Realtime Update 不得抢夺 Scroll。
47. Realtime Update 不得丢失 Focus。
48. Reduced Motion 必须可用。
49. UI Partial Failure 不得影响 Runtime。
50. Tauri Host 不改变 Inspector Domain Contract。

---

# Part XXXII — Final Definition

## 198. Final Definition

AgentOS v2 Runtime Inspector 定义如下：

> Runtime Inspector 是建立在 AgentOS Canonical State、Immutable Snapshot、Ordered Runtime Event、Artifact 和 Audit 之上的应用层观察与控制系统。它以 Run Inspector 为主要入口，通过 Overview、Stage Graph、Timeline、Event Viewer、Provider Session、Process Tree、Worktree、Memory Context、Policy Decision、Approval、Artifact、Recovery 和 Audit 等渐进视图解释一次工程执行。Inspector 不拥有 Runtime 生命周期，不从 stdout 猜测状态，不直接执行 Process 或 Git；所有控制操作都通过统一 API、Policy、Idempotency 和并发保护进入 Runtime。客户端断线只中断观察，重新连接后根据 Sequence 恢复。

核心观察路径：

```text
Run Summary
  ↓
Stage Flow
  ↓
Runtime Timeline
  ↓
Domain Object
  ↓
Canonical Event / Snapshot / Artifact / Audit
```

核心控制路径：

```text
Inspector Action
  ↓
API Command
  ↓
Authorization
  ↓
Policy / Approval
  ↓
Runtime Service
  ↓
State + Event + Audit
  ↓
Inspector Realtime Update
```

核心恢复路径：

```text
Detected Inconsistency
  ↓
Recovery Evidence
  ↓
Classification + Confidence
  ↓
Safe Suggested Action
  ↓
Policy / Approval
  ↓
Idempotent Recovery
  ↓
Event + Audit
```

本文件是 AgentOS v2 Runtime Inspector、Run Timeline、Debug View、Replay、Recovery Center 和未来 Tauri Desktop Runtime View 的统一规范。
