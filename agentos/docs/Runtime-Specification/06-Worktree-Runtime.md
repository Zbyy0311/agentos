# AgentOS Runtime Specification v2.0

## 06 — Worktree Runtime

> Status: Draft  
> Version: 2.0  
> Last Updated: 2026-07-19  
> Scope: AgentOS v2 Git Worktree Isolation Runtime  
> Depends On:
> - `00-Vision.md`
> - `01-Core-Concepts.md`
> - `02-Runtime-Lifecycle.md`
> - `03-Event-Model.md`
> - `04-Provider-Specification.md`
> - `05-Process-Runtime.md`
> Repository: `Zbyy0311/agentos`

---

## 1. Document Purpose

本文件定义 AgentOS v2 的 Worktree Runtime。

Worktree Runtime 是 AgentOS 中负责代码隔离、并发修改、Diff、Review、Merge、冲突处理、恢复和清理的 Git 执行层。

它规定：

- Workspace 与 Worktree 的边界；
- Run 级 Worktree；
- Stage 级 Worktree；
- Integration Worktree；
- Read-only 与 Modifying Run；
- Base Branch 与 Base Commit；
- Branch Naming；
- Worktree 创建、验证、使用和回收；
- 并发修改；
- 多 Provider 对比；
- Review；
- Diff 与 Patch；
- Commit；
- Rebase；
- Merge；
- Conflict；
- Abandon；
- Cleanup；
- Recovery；
- Orphan Worktree；
- Policy 与 Approval；
- Path Security；
- Artifact；
- Runtime Event；
- SQLite Schema；
- API；
- 测试；
- v1 迁移。

本文件是以下模块的行为规范：

- Worktree Manager；
- Git Runtime；
- Branch Manager；
- Diff Manager；
- Merge Manager；
- Conflict Manager；
- Worktree Recovery Manager；
- Worktree Cleanup Manager；
- Worktree Inspector；
- Run Isolation Planner。

---

## 2. Worktree Runtime Positioning

AgentOS v2 的代码执行链：

```text
Workspace
  ↓
Task
  ↓
Run
  ↓
Isolation Plan
  ├── Read-only Workspace View
  ├── Run Worktree
  ├── Stage Worktree
  └── Integration Worktree
        ↓
Provider / Tool / Test Process
        ↓
File Changes
        ↓
Diff / Patch / Commit
        ↓
Review
        ↓
Merge / Abandon
        ↓
Cleanup
```

Worktree Runtime 不只是执行：

```text
git worktree add
```

它负责整个代码修改生命周期。

---

## 3. Core Principles

### 3.1 Main Workspace Is Not a Shared Mutation Area

主 Workspace 默认不允许多个 Agent 直接修改。

```text
Workspace Root
  = project control boundary

Worktree
  = modifying execution boundary
```

### 3.2 Modification Is Isolated by Default

所有修改型 Run 默认：

```text
worktreeMode = required
```

### 3.3 Read-only Run May Avoid Worktree

只读任务可以直接读取 Workspace Root，但必须：

- 明确标记；
- 不允许写入；
- 经过 Path Policy；
- 记录 Base Commit。

### 3.4 Worktree Is Owned

每个活动 Worktree 必须有明确 Owner：

- Run；
- Stage；
- Integration；
- Manual Review。

### 3.5 Base Commit Is Immutable

Worktree 创建时必须冻结 Base Commit。

后续 Workspace 主分支变化不能改变该 Run 的历史起点。

### 3.6 Parallel Modification Requires Separate Branches

并行修改不得共享同一个 Worktree。

### 3.7 Merge Is a Separate Lifecycle

```text
Run completed
  ≠
Worktree merged
```

### 3.8 Cleanup Is Never Blind

存在未保存修改时，不得自动删除 Worktree。

### 3.9 Git Is the Source of Code Truth

AgentOS 不重新实现 Git。

AgentOS 只管理：

- Git 命令；
- Git 生命周期；
- Git Policy；
- Git Event；
- Git Artifact。

### 3.10 Worktree Must Be Recoverable

Server 重启后必须能够识别：

- 活动 Worktree；
- 未完成 Run；
- Dirty Worktree；
- 已 Merge Worktree；
- Orphan Worktree；
- Cleanup Required。

---

# Part I — Domain Model

## 4. Worktree

### 4.1 Definition

Worktree 是 AgentOS 对一个 Git Worktree 的持久化管理记录。

```ts
interface Worktree {
  id: string;

  workspaceId: string;

  runId: string;

  stageId?: string;

  parentWorktreeId?: string;

  worktreeType:
    | 'run'
    | 'stage'
    | 'integration'
    | 'review'
    | 'manual';

  isolationMode:
    | 'read-write'
    | 'read-only';

  path: string;

  branchName: string;

  baseBranch: string;

  baseCommit: string;

  headCommit?: string;

  targetBranch?: string;

  status:
    | 'reserved'
    | 'creating'
    | 'active'
    | 'dirty'
    | 'ready_for_review'
    | 'merge_pending'
    | 'merging'
    | 'merged'
    | 'conflicted'
    | 'abandoned'
    | 'cleanup_required'
    | 'deleting'
    | 'deleted'
    | 'orphaned'
    | 'failed';

  ownershipTokenHash: string;

  createdAt: string;
  activatedAt?: string;
  lastInspectedAt?: string;
  mergedAt?: string;
  abandonedAt?: string;
  deletedAt?: string;

  version: number;
  updatedAt: string;
}
```

### 4.2 Worktree Invariants

1. Worktree 必须属于 Workspace 和 Run。
2. Stage Worktree 必须关联 Stage。
3. 一个活动 Worktree 只能有一个修改 Owner。
4. Worktree Path 必须位于 AgentOS 管理目录或显式允许目录。
5. Branch Name 必须唯一。
6. Base Commit 创建后不可修改。
7. Worktree 删除前必须完成 Final Inspection。
8. Dirty Worktree 不得静默删除。
9. Merge 结果必须记录 Commit。
10. Worktree 状态变化必须产生 Runtime Event。
11. Worktree 不得被不同 Workspace 共享。
12. Worktree 目录不得直接作为长期 Artifact 存储。
13. Worktree 内 Process 必须由对应 Run 或 Stage 所有。
14. 主 Workspace 不应成为 Worktree 的嵌套子目录。
15. Worktree 不能创建在另一个 Worktree 内。

---

## 5. Isolation Plan

### 5.1 Definition

Isolation Plan 描述一次 Run 如何分配 Worktree。

```ts
interface IsolationPlan {
  runId: string;

  strategy:
    | 'none'
    | 'single-run-worktree'
    | 'stage-worktrees'
    | 'parallel-stage-worktrees'
    | 'integration-worktree';

  worktreeMode:
    | 'required'
    | 'preferred'
    | 'disabled';

  readOnly: boolean;

  baseBranch: string;

  baseCommit: string;

  targetBranch: string;

  runWorktreeRequired: boolean;

  stageWorktreeRules: Array<{
    workflowStageKey: string;
    mode:
      | 'inherit-run'
      | 'dedicated'
      | 'read-only'
      | 'none';
  }>;

  integrationRequired: boolean;

  cleanupPolicyId: string;

  mergePolicyId: string;
}
```

### 5.2 Planning Inputs

Isolation Planner 根据：

- Workflow；
- Stage 并行关系；
- Stage 是否修改；
- Provider Capability；
- User 配置；
- Git 状态；
- Workspace Policy；
- Merge Strategy；

生成 Isolation Plan。

### 5.3 Plan Snapshot

Run 启动前必须保存 Isolation Plan Snapshot。

---

## 6. Worktree Types

### 6.1 Run Worktree

适用于线性流程：

```text
Plan
  ↓
Implement
  ↓
Test
  ↓
Review
```

多个顺序 Stage 在同一个分支协作。

### 6.2 Stage Worktree

适用于某个 Stage 必须独立修改。

```text
Run
├── Stage A Worktree
└── Stage B Worktree
```

### 6.3 Integration Worktree

用于合并多个 Stage Worktree 的结果。

```text
Stage A Branch
Stage B Branch
Stage C Branch
      ↓
Integration Worktree
```

### 6.4 Review Worktree

用于只读或安全 Review。

Reviewer 可以：

- 查看 Branch；
- 执行 Test；
- 生成 Review Artifact；
- 不直接修改 Implementer Worktree。

### 6.5 Manual Worktree

用户显式创建，用于人工处理 Conflict 或 Review。

---

## 7. Worktree Ownership

```ts
interface WorktreeOwner {
  ownerType:
    | 'run'
    | 'stage'
    | 'integration'
    | 'review'
    | 'user';

  ownerId: string;

  acquiredAt: string;

  releasedAt?: string;
}
```

### 7.1 Ownership Rules

- Run Worktree → Run 所有；
- Stage Worktree → Stage 所有；
- Integration Worktree → Integration Stage 或 Merge Operation 所有；
- Review Worktree → Reviewer Stage 或 User 所有；
- User 手动接管后，自动 Process 不得继续写入。

### 7.2 Ownership Transfer

Ownership Transfer 必须：

- 停止原 Owner Process；
- 检查 Dirty 状态；
- 创建 Event；
- 更新 Lock；
- 记录操作者；
- 不隐式发生。

---

# Part II — Workspace and Git Preconditions

## 8. Git Workspace Detection

Worktree Runtime 启动前必须检查：

```text
git rev-parse --show-toplevel
git rev-parse --is-inside-work-tree
git rev-parse HEAD
git status --porcelain
```

### 8.1 Repository States

```ts
type GitWorkspaceState =
  | 'clean'
  | 'dirty'
  | 'unborn'
  | 'detached-head'
  | 'merge-in-progress'
  | 'rebase-in-progress'
  | 'cherry-pick-in-progress'
  | 'bisect-in-progress'
  | 'not-git'
  | 'invalid';
```

### 8.2 Invalid States

默认不允许从以下状态自动创建 Modifying Run：

- Merge in progress；
- Rebase in progress；
- Cherry-pick in progress；
- Unresolved conflicts；
- Invalid repository。

必须：

- 阻止；
- 或要求 User 明确选择 Base Commit。

---

## 9. Dirty Main Workspace

### 9.1 Principle

主 Workspace Dirty 不应被 Worktree Run 自动吸收。

### 9.2 Options

用户可以：

1. Commit 当前修改；
2. Stash 当前修改；
3. 选择已提交 Base Commit；
4. 取消 Run；
5. 显式创建 Snapshot Commit，仅在 Policy 允许时。

### 9.3 No Silent Stash

AgentOS 不得静默执行：

```text
git stash
```

因为可能影响用户工作状态。

### 9.4 Dirty Workspace and Worktree

只要 Base Commit 明确，Git 允许从已提交 Commit 创建 Worktree。

AgentOS 必须提示：

```text
主 Workspace 存在未提交修改，这些修改不会进入新 Worktree。
```

---

## 10. Base Branch and Base Commit

### 10.1 Resolution Priority

```text
Run Override
  > Task Setting
  > Workflow Setting
  > Workspace Default Branch
  > Current Branch
```

### 10.2 Base Commit

必须通过：

```text
git rev-parse <base-ref>
```

解析成完整 Commit SHA。

### 10.3 Detached HEAD

如果 Workspace 当前 Detached HEAD：

- 可以使用当前 Commit；
- 必须显式记录；
- Target Branch 需要单独选择。

### 10.4 Remote Base

如果使用远程 Branch：

- Fetch 属于 Network + Git Action；
- 必须经过 Policy；
- 不应默认自动更新远程引用。

---

# Part III — Isolation Strategies

## 11. No Worktree Strategy

适用于：

- 纯只读；
- 非 Git Workspace；
- 用户显式禁用；
- Runtime 诊断。

要求：

- `isolationMode = read-only`；
- 写操作由 Policy 拒绝；
- Process cwd 可为 Workspace Root；
- 记录 Base Commit 或 Directory Snapshot Metadata。

---

## 12. Single Run Worktree

### 12.1 Use Case

线性 Workflow，所有修改属于同一个实现分支。

```text
Run Worktree
├── Planning reads
├── Implementer modifies
├── Tests run
└── Reviewer reads
```

### 12.2 Rules

- 只有一个活动修改 Stage；
- Reviewer 默认只读；
- Stage 顺序可共享当前 Git 状态；
- Retry Stage 可以继续同一 Worktree，但必须记录 Attempt；
- Run Retry 默认创建新 Worktree。

---

## 13. Dedicated Stage Worktree

### 13.1 Use Case

Stage 需要独立输出：

- Alternative Implementation；
- Security Fix；
- Provider Comparison；
- Independent Review Fix。

### 13.2 Base

默认从 Run Base Commit 创建。

也可从某个前序 Stage Commit 创建，但必须明确依赖。

### 13.3 No Hidden Sharing

Stage Worktree 不得通过共享未提交文件互相传递结果。

传递方式：

- Commit；
- Patch Artifact；
- Structured Artifact；
- Explicit Merge。

---

## 14. Parallel Stage Worktrees

### 14.1 Use Case

多个 Agent 或 Provider 并行实现。

```text
Base Commit
├── Codex Worktree
├── KimiCode Worktree
└── OpenCode Worktree
```

### 14.2 Requirements

- 相同 Base Commit；
- 不同 Branch；
- 不同 Path；
- 独立 Process；
- 独立 Artifact；
- 独立 Usage；
- 独立 Review。

### 14.3 Selection

最终可以：

- 选一个 Branch；
- 组合多个 Patch；
- Merge 到 Integration Worktree；
- 放弃其余 Branch。

---

## 15. Integration Worktree

### 15.1 Definition

Integration Worktree 用于安全组合多个修改分支。

### 15.2 Creation

从：

- Base Commit；
- Target Branch；
- 选定 Stage Branch；

创建。

### 15.3 Integration Sequence

```text
Create Integration Worktree
  ↓
Merge or cherry-pick selected branches
  ↓
Resolve conflicts
  ↓
Run tests
  ↓
Create integration commit
  ↓
Review
  ↓
Merge to target
```

### 15.4 Integration Isolation

Integration 过程不得在主 Workspace Root 中执行。

---

# Part IV — Creation Lifecycle

## 16. Worktree Reservation

创建前先持久化：

```text
status = reserved
```

包含：

- ID；
- Path；
- Branch；
- Base Commit；
- Owner；
- Ownership Token。

### 16.1 Purpose

- 幂等；
- 防止重复 Path；
- 防止重复 Branch；
- 支持失败补偿；
- 支持 Recovery。

---

## 17. Path Generation

推荐目录：

```text
<agentos-data>/worktrees/<workspaceId>/<runId>/<worktreeId>
```

或 Workspace 内：

```text
<workspace>/.agentos/worktrees/<runId>/<worktreeId>
```

### 17.1 Preferred Location

推荐 Worktree 位于 Workspace 外部的 AgentOS Data Root，减少：

- Git 扫描污染；
- IDE 索引；
- Watch Restart；
- 递归目录；
- Artifact 混淆。

### 17.2 Path Rules

- 唯一；
- 规范化；
- 不包含用户原始 Prompt；
- 不使用 Task Title 作为唯一目录；
- 控制总长度；
- Windows Path Limit；
- 不嵌套；
- 不位于 Repository 内部。

---

## 18. Branch Naming

推荐：

```text
agentos/run/<shortRunId>/<slug>
```

Stage：

```text
agentos/run/<shortRunId>/stage/<stageKey>
```

Integration：

```text
agentos/run/<shortRunId>/integration
```

### 18.1 Naming Rules

- 可被 Git 接受；
- 长度限制；
- 去除非法字符；
- 不包含 Secret；
- 不使用完整用户输入；
- 冲突时增加短 ID；
- Branch 与 Worktree ID 可互相追踪。

---

## 19. Creation Request

```ts
interface CreateWorktreeRequest {
  workspaceId: string;

  runId: string;

  stageId?: string;

  worktreeType: Worktree['worktreeType'];

  isolationMode: Worktree['isolationMode'];

  baseBranch: string;

  baseCommit: string;

  branchName: string;

  path: string;

  targetBranch?: string;

  owner: WorktreeOwner;

  idempotencyKey: string;
}
```

---

## 20. Creation Sequence

```text
Validate request
  ↓
Validate repository state
  ↓
Resolve Base Commit
  ↓
Evaluate Policy
  ↓
Reserve Branch and Path
  ↓
Persist Worktree(reserved)
  ↓
Emit worktree.creation_requested
  ↓
Create Branch
  ↓
git worktree add
  ↓
Verify Worktree registration
  ↓
Verify HEAD = Base Commit
  ↓
Write ownership metadata
  ↓
Set active
  ↓
Emit worktree.created
```

### 20.1 Git Command

推荐直接参数化执行：

```text
git worktree add -b <branch> <path> <baseCommit>
```

不得使用未转义 Shell 字符串。

### 20.2 Existing Branch

如果 Branch 已存在：

- 不默认复用；
- 验证是否属于同一 Worktree Record；
- 否则返回冲突。

---

## 21. Creation Failure Compensation

失败后根据阶段补偿：

### Branch 未创建

- 标记 failed。

### Branch 已创建、Worktree 未创建

- 删除 Branch，前提是安全；
- 或标记 cleanup_required。

### Directory 部分创建

- 检查内容；
- 安全删除空目录；
- 非空则保留并标记。

### Git Registered but DB Update Failed

- 尝试 Remove；
- 无法 Remove 则 Recovery 扫描接管。

---

# Part V — Activation and Use

## 22. Activation

Worktree Active 前必须验证：

- Path 存在；
- `.git` 指向正确；
- Branch 正确；
- HEAD 正确；
- Owner 正确；
- 无 Conflict；
- 可读写；
- 不被其他 Run 占用。

### 22.1 Ownership Metadata

可在 AgentOS 数据目录保存：

```json
{
  "worktreeId": "wt_...",
  "workspaceId": "ws_...",
  "runId": "run_...",
  "stageId": "stage_...",
  "ownershipTokenHash": "..."
}
```

不建议在项目文件中写影响 Git 状态的 Metadata。

---

## 23. Process Integration

Provider、Tool、Test Process：

```text
cwd = worktree.path
```

Process Security Context：

```ts
{
  workspaceRoot,
  worktreePath,
  allowedWritePaths: [worktreePath]
}
```

### 23.1 Process Exit

Process Exit 后 Worktree Manager 必须重新检查：

- Git Status；
- File Changes；
- HEAD；
- Conflict；
- Untracked Files。

---

## 24. Stage Access Modes

### Read-write

可以修改 Worktree。

### Read-only

允许：

- Read；
- Git Diff；
- Test；
- Static Analysis。

拒绝：

- File Write；
- Commit；
- Branch Change；
- Merge。

### 24.1 Reviewer

Reviewer 默认：

```text
read-only
```

需要自动修复时应创建：

- 新 Fix Stage；
- 新 Stage Worktree；
- 或显式 Ownership Transfer。

---

# Part VI — Change Detection

## 25. Git Status Inspection

```ts
interface WorktreeStatusSnapshot {
  worktreeId: string;

  branchName: string;

  headCommit: string;

  staged: string[];

  modified: string[];

  deleted: string[];

  renamed: Array<{
    from: string;
    to: string;
  }>;

  untracked: string[];

  ignoredCount?: number;

  conflicted: string[];

  clean: boolean;

  inspectedAt: string;
}
```

### 25.1 Trigger Points

- Worktree 创建后；
- Process 启动前；
- Tool 完成后；
- Stage 完成前；
- Run 完成前；
- Merge 前；
- Cleanup 前；
- Recovery 时。

---

## 26. File Change Events

Git Status 与 File Watcher 可以共同产生：

- `file.created`；
- `file.modified`；
- `file.deleted`；
- `git.status_updated`；
- `worktree.dirty`。

### 26.1 Source of Truth

最终变更以 Git Status 和 Diff 为准。

File Watcher 只提供实时性。

---

## 27. Diff

```ts
interface WorktreeDiffSummary {
  worktreeId: string;

  baseCommit: string;

  headCommit: string;

  staged: {
    filesChanged: number;
    linesAdded: number;
    linesDeleted: number;
  };

  unstaged: {
    filesChanged: number;
    linesAdded: number;
    linesDeleted: number;
  };

  untrackedFiles: string[];

  binaryFiles: string[];

  diffArtifactId?: string;

  generatedAt: string;
}
```

### 27.1 Diff Bases

必须明确：

- Working Tree vs HEAD；
- HEAD vs Base Commit；
- Branch vs Target Branch；
- Stage Branch vs Integration Branch。

### 27.2 Default Review Diff

```text
Base Commit → Current Worktree HEAD + Uncommitted Changes
```

---

## 28. Patch Artifact

Worktree 进入 Review 前生成：

- Unified Diff；
- File List；
- Binary File Index；
- Git Status；
- Base Commit；
- Head Commit；
- Untracked Archive，可选。

### 28.1 Patch Immutability

Patch Artifact 创建后不可覆盖。

新的状态生成新 Artifact。

---

# Part VII — Commit Runtime

## 29. Commit Policy

AgentOS 不要求每个 Stage 自动 Commit。

支持：

```ts
type CommitMode =
  | 'none'
  | 'stage-end'
  | 'run-end'
  | 'manual'
  | 'provider-native';
```

### 29.1 Recommended Default

Run Worktree：

```text
run-end
```

Parallel Stage Worktree：

```text
stage-end
```

### 29.2 Provider Native Commit

Provider 创建 Commit 时必须产生 Git Event。

AgentOS 仍要验证：

- Commit 属于当前 Branch；
- Author；
- Message；
- Changed Files；
- No Secret；
- No Forbidden Paths。

---

## 30. Commit Request

```ts
interface CreateCommitRequest {
  worktreeId: string;

  message: string;

  authorName?: string;

  authorEmail?: string;

  includeUntracked: boolean;

  pathspec?: string[];

  requestedBy:
    | 'agent'
    | 'workflow'
    | 'user'
    | 'system';

  approvalRequestId?: string;
}
```

### 30.1 Commit Message

推荐：

```text
agentos(<run-short-id>): <task-summary>
```

Stage：

```text
agentos(<run-short-id>/<stage-key>): <summary>
```

### 30.2 No Hidden Global Git Config

AgentOS 不应静默修改用户全局 Git Config。

临时 Author 使用命令级配置。

---

## 31. Commit Sequence

```text
Inspect status
  ↓
Evaluate policy
  ↓
Stage selected files
  ↓
Secret scan
  ↓
Create commit
  ↓
Resolve commit SHA
  ↓
Update Worktree headCommit
  ↓
Emit git.commit_created
  ↓
Create commit Artifact
```

### 31.1 Empty Commit

默认不创建空 Commit。

需要时必须显式配置。

---

# Part VIII — Review Runtime

## 32. Ready for Review

Worktree 进入：

```text
ready_for_review
```

前必须：

- 停止修改 Process；
- 检查 Git Status；
- 生成 Diff；
- 生成 Artifact；
- 运行 Required Tests；
- 记录 HEAD；
- 无未解析 Conflict。

### 32.1 Review Package

```ts
interface WorktreeReviewPackage {
  worktreeId: string;

  taskId: string;

  runId: string;

  stageId?: string;

  baseCommit: string;

  headCommit: string;

  diffArtifactId: string;

  changedFilesArtifactId: string;

  testArtifactIds: string[];

  reviewSummaryArtifactId?: string;

  approvalHistory: string[];

  warnings: string[];
}
```

---

## 33. Review Outcomes

```ts
type WorktreeReviewOutcome =
  | 'approved'
  | 'changes_requested'
  | 'rejected'
  | 'manual_review_required';
```

### 33.1 Approved

可以进入 Merge Pending。

### 33.2 Changes Requested

建议创建：

- Child Run；
- Fix Stage；
- 新 Worktree；
- 或在原 Worktree 继续，前提是历史 Attempt 可追踪。

### 33.3 Rejected

Worktree 保留，等待 Abandon 或人工处理。

---

## 34. Reviewer Isolation

Reviewer 不应直接污染 Implementer Worktree。

推荐：

- Read-only Review；
- Review Worktree；
- Patch Artifact；
- 独立 Fix Worktree。

---

# Part IX — Synchronization and Update

## 35. Target Branch Advancement

Run 执行期间，Target Branch 可能产生新 Commit。

Merge 前必须检查：

```text
targetCurrentCommit
vs
run.baseCommit
```

### 35.1 Outcomes

- 未变化；
- Fast-forward Compatible；
- Requires Rebase；
- Merge Conflict Risk；
- Protected Branch Changed。

---

## 36. Rebase Policy

```ts
type RebaseMode =
  | 'never'
  | 'manual'
  | 'before-merge'
  | 'auto-if-clean';
```

### 36.1 Rebase Is Mutating

必须：

- Policy；
- Event；
- Conflict Handling；
- New Diff；
- Tests；
- Review Validity Check。

### 36.2 Review Invalidation

Rebase 后原 Review 可能失效。

Policy 决定是否需要重新 Review。

---

## 37. Refresh Base

不允许直接修改 Worktree 的 `baseCommit` 历史字段。

Rebase 后记录：

```ts
interface WorktreeBaseUpdate {
  originalBaseCommit: string;
  rebasedOntoCommit: string;
  resultingHeadCommit: string;
  eventId: string;
}
```

---

# Part X — Merge Runtime

## 38. Merge Policy

```ts
interface WorktreeMergePolicy {
  strategy:
    | 'merge-commit'
    | 'squash'
    | 'rebase-merge'
    | 'fast-forward'
    | 'cherry-pick'
    | 'manual';

  targetBranch: string;

  requireApproval: boolean;

  requireReview: boolean;

  requireTests: boolean;

  requireCleanWorktree: boolean;

  allowTargetAdvance: boolean;

  autoMergeIfClean: boolean;

  pushAfterMerge: boolean;

  deleteBranchAfterMerge: boolean;

  cleanupWorktreeAfterMerge: boolean;
}
```

### 38.1 Default

推荐：

```text
strategy = squash or merge-commit
requireApproval = true
requireReview = true
requireTests = true
pushAfterMerge = false
```

---

## 39. Merge Request

```ts
interface MergeWorktreeRequest {
  worktreeId: string;

  targetBranch: string;

  strategy: WorktreeMergePolicy['strategy'];

  requestedBy: string;

  approvalRequestId?: string;

  expectedHeadCommit: string;

  expectedTargetCommit?: string;

  idempotencyKey: string;
}
```

### 39.1 Optimistic Check

Merge 前确认：

- Worktree HEAD 未变；
- Target Branch 未超出允许范围；
- Review 对应同一 Diff；
- Tests 对应当前 Commit；
- Approval 未过期。

---

## 40. Merge Execution Location

Merge 不应直接在用户主 Workspace 中执行。

推荐：

- Integration Worktree；
- Dedicated Merge Worktree；
- Bare Repository Context。

### 40.1 Main Workspace Safety

如果主 Workspace Dirty，Merge 不应影响用户未提交修改。

---

## 41. Merge Sequence

```text
Receive merge request
  ↓
Validate Worktree status
  ↓
Validate expected commits
  ↓
Evaluate Policy
  ↓
Create Approval if required
  ↓
Acquire target branch merge lock
  ↓
Create / activate integration context
  ↓
Refresh target reference if allowed
  ↓
Apply merge strategy
  ↓
Detect conflict
  ├── conflict → conflict lifecycle
  └── clean
        ↓
      Run required tests
        ↓
      Create merge commit
        ↓
      Update target ref
        ↓
      Create Merge Artifact
        ↓
      Emit git.merge_completed
        ↓
      Mark Worktree merged
```

### 41.1 Target Lock

同一 Target Branch 同时只允许一个 Merge Operation。

---

## 42. Merge Result

```ts
interface WorktreeMergeResult {
  worktreeId: string;

  sourceBranch: string;

  targetBranch: string;

  strategy: string;

  previousTargetCommit: string;

  sourceHeadCommit: string;

  resultingTargetCommit?: string;

  mergeCommit?: string;

  fastForward: boolean;

  conflicted: boolean;

  conflictArtifactId?: string;

  mergeArtifactId?: string;

  testsPassed?: boolean;

  completedAt: string;
}
```

---

## 43. Push

Push 是 Merge 之后的独立高风险操作。

默认：

```text
pushAfterMerge = false
```

### 43.1 Push Requirements

- Policy；
- Approval；
- Remote；
- Branch；
- Force Flag；
- Credential；
- Network；
- Audit。

### 43.2 No Implicit Force

禁止隐式：

```text
--force
--force-with-lease
```

---

# Part XI — Conflict Runtime

## 44. Conflict Detection

Conflict 可发生于：

- Merge；
- Rebase；
- Cherry-pick；
- Patch Apply；
- Integration。

### 44.1 Conflict State

```text
status = conflicted
```

### 44.2 Conflict Artifact

必须包含：

- Source Branch；
- Target Branch；
- Base Commit；
- Conflicted Files；
- Git Status；
- Conflict Markers；
- Operation Type；
- Recovery Commands；
- Event Chain。

---

## 45. Conflict Resolution Modes

```ts
type ConflictResolutionMode =
  | 'manual'
  | 'agent-assisted'
  | 'new-run'
  | 'abort';
```

### 45.1 Manual

创建或保留 Integration Worktree，用户处理。

### 45.2 Agent-assisted

创建独立 Conflict Resolution Stage。

Agent 必须：

- 在 Conflict Worktree 中工作；
- 不直接修改 Target；
- 重新运行 Tests；
- 重新 Review。

### 45.3 New Run

创建 Child Run。

### 45.4 Abort

执行：

```text
git merge --abort
git rebase --abort
git cherry-pick --abort
```

具体命令取决于 Operation。

---

## 46. Conflict Resolution Lifecycle

```text
Conflict detected
  ↓
Stop merge operation
  ↓
Persist conflicted state
  ↓
Create Conflict Artifact
  ↓
Emit git.merge_conflicted
  ↓
User selects resolution mode
  ↓
Resolve / Abort
  ↓
Inspect status
  ↓
Run tests
  ↓
New review
  ↓
Retry merge
```

### 46.1 No Silent Conflict Resolution

AgentOS 不得自动选择某一侧内容而不记录。

---

# Part XII — Abandon and Cleanup

## 47. Abandon

Abandon 表示不再计划 Merge 该 Worktree。

### 47.1 Preconditions

- 没有活动 Process；
- 没有进行中的 Git Operation；
- Dirty 状态已展示；
- 用户确认；
- 必要 Artifact 已生成。

### 47.2 Sequence

```text
Abandon requested
  ↓
Inspect Worktree
  ↓
Generate final Diff Artifact
  ↓
Cancel pending approvals
  ↓
Mark abandoned
  ↓
Emit worktree.abandoned
  ↓
Apply cleanup policy
```

---

## 48. Cleanup Policy

```ts
interface WorktreeCleanupPolicy {
  afterMerged:
    | 'immediate'
    | 'deferred'
    | 'manual'
    | 'retain';

  afterAbandoned:
    | 'immediate'
    | 'deferred'
    | 'manual'
    | 'retain';

  afterFailed:
    | 'deferred'
    | 'manual'
    | 'retain';

  retainDays?: number;

  archiveDiffBeforeDelete: boolean;

  deleteBranch: boolean;

  pruneGitMetadata: boolean;

  requireClean: boolean;
}
```

### 48.1 Recommended Defaults

- Merged → Deferred Cleanup；
- Abandoned → Manual or Deferred；
- Failed → Retain；
- Archive Diff → true；
- Require Clean → true。

---

## 49. Cleanup Safety Check

删除前必须检查：

- 无活动 Process；
- 无 Owner Lock；
- 无 Pending Merge；
- 无 Conflict Operation；
- Git Status；
- Diff Artifact；
- Branch Commit；
- User Retain Flag；
- Path Ownership Token；
- Path 位于允许 Root；
- Directory 不包含外部文件。

---

## 50. Cleanup Sequence

```text
Cleanup requested
  ↓
Acquire cleanup lock
  ↓
Final inspection
  ↓
Archive required artifacts
  ↓
git worktree remove
  ↓
Verify path removed
  ↓
Delete branch if policy allows
  ↓
git worktree prune
  ↓
Mark deleted
  ↓
Emit worktree.deleted
```

### 50.1 Force Removal

`git worktree remove --force` 默认禁止。

需要：

- User Approval；
- Archived Diff；
- Ownership Verification；
- No Active Process；
- Audit。

---

## 51. Cleanup Failure

失败时：

```text
status = cleanup_required
```

记录：

- Path；
- Git Registration；
- Branch；
- Dirty State；
- Error；
- Suggested Command；
- Retryable。

---

# Part XIII — Recovery Runtime

## 52. Startup Recovery

Server 启动时扫描：

- 数据库活动 Worktree；
- `git worktree list --porcelain`；
- Managed Worktree Root；
- Active Run；
- Active Process；
- Branch；
- Directory；
- Ownership Metadata。

---

## 53. Recovery Classification

```ts
type WorktreeRecoveryClassification =
  | 'healthy'
  | 'missing-directory'
  | 'missing-git-registration'
  | 'untracked-by-database'
  | 'branch-mismatch'
  | 'head-mismatch'
  | 'owner-mismatch'
  | 'dirty-terminal-run'
  | 'active-run'
  | 'orphaned'
  | 'cleanup-required'
  | 'unknown';
```

### 53.1 Healthy

数据库、Git 和目录一致。

### 53.2 Missing Directory

Git 或数据库记录存在，但目录消失。

### 53.3 Untracked by Database

Git Worktree 存在，但 AgentOS 无记录。

### 53.4 Head Mismatch

实际 HEAD 与记录不同。

不得静默覆盖记录。

### 53.5 Dirty Terminal Run

Run 已终止，但 Worktree 仍 Dirty。

必须保留并提示。

---

## 54. Recovery Identity

使用：

- Worktree ID；
- Path；
- Branch；
- Base Commit；
- Ownership Token；
- Workspace ID；
- Run ID；
- Git Registration。

不能只依赖目录名称。

---

## 55. Recovery Actions

```ts
type WorktreeRecoveryAction =
  | 'reattach'
  | 'adopt'
  | 'mark-orphaned'
  | 'preserve'
  | 'cleanup'
  | 'manual-review'
  | 'ignore';
```

### 55.1 Adopt

只在以下情况允许：

- Ownership 可验证；
- Workspace 一致；
- Branch 一致；
- 无冲突 Owner；
- 用户或 Policy 允许。

---

## 56. Orphan Worktree

Orphan Worktree：

- 目录存在；
- Git Registered；
- 但无有效 Run Owner；
- 或 Run 已删除；
- 或数据库丢失。

默认策略：

- 保留；
- 标记；
- 生成 Diff；
- 等待用户决定。

不得直接删除。

---

## 57. Recovery Events

```text
worktree.recovery_started
worktree.recovered
worktree.recovery_failed
worktree.orphaned
worktree.cleanup_required
```

---

# Part XIV — Non-Git Workspace

## 58. Directory Workspace

非 Git Workspace 无法使用 Git Worktree。

支持降级策略：

```ts
type DirectoryIsolationMode =
  | 'read-only'
  | 'copy'
  | 'reflink'
  | 'snapshot'
  | 'disabled';
```

### 58.1 Read-only

最安全。

### 58.2 Copy

复制项目目录。

缺点：

- 慢；
- 占空间；
- 无 Git Merge；
- Diff 需要文件比较。

### 58.3 Reflink

文件系统支持时节省空间。

### 58.4 Snapshot

依赖平台能力。

---

## 59. No Silent Fallback

Worktree Mode 为 Required 时，非 Git Workspace 必须失败：

```text
WORKTREE_GIT_REQUIRED
```

不能静默切换 Copy。

用户必须显式选择 Directory Isolation。

---

## 60. Directory Diff

需要生成：

- File Hash；
- Added；
- Modified；
- Deleted；
- Binary；
- Patch，可生成时；
- Archive Artifact。

Merge 由文件级 Copy 或人工处理，不使用 Git Merge 语义。

---

# Part XV — Policy and Security

## 61. Worktree Policy Context

```ts
interface WorktreePolicyContext {
  workspaceId: string;

  runId: string;

  stageId?: string;

  operation:
    | 'create'
    | 'write'
    | 'commit'
    | 'rebase'
    | 'merge'
    | 'push'
    | 'abandon'
    | 'delete'
    | 'adopt';

  workspaceRoot: string;

  worktreePath?: string;

  branchName?: string;

  targetBranch?: string;

  dirty?: boolean;

  force?: boolean;
}
```

---

## 62. Protected Operations

默认需要 Approval：

- Merge 到默认分支；
- Push；
- Force Push；
- Delete Dirty Worktree；
- Delete Branch with unmerged commits；
- Rebase reviewed branch；
- Execute Git Hook；
- Modify `.git` internals；
- Adopt unknown Worktree；
- Use Workspace Root for modifying Run。

---

## 63. Protected Branch

Workspace 可配置：

```ts
interface ProtectedBranchPolicy {
  patterns: string[];

  requireApproval: boolean;

  requireReview: boolean;

  requireTests: boolean;

  denyForcePush: boolean;

  denyDirectProviderWrite: boolean;
}
```

---

## 64. Path Security

必须验证：

- Worktree Root；
- Canonical Path；
- Symlink；
- Junction；
- UNC；
- Device Path；
- Nested Repository；
- Submodule；
- Ownership Token；
- Directory Traversal。

### 64.1 Delete Guard

删除目录前：

```text
resolvedPath startsWith managedWorktreeRoot
AND ownershipToken valid
AND worktreeId matches
```

否则拒绝。

---

## 65. Git Hooks

Provider 触发 Git 操作可能执行 Hook。

策略选项：

```ts
type GitHookMode =
  | 'allow'
  | 'deny'
  | 'require-approval'
  | 'isolated';
```

默认建议：

```text
require-approval
```

或在 AgentOS 自动 Commit 时禁用非必要 Hook。

---

## 66. Submodules

Submodule 需要额外 Policy：

- 初始化；
- 更新；
- Network；
- Nested Git；
- 修改 Submodule Pointer；
- Submodule 内 Worktree。

v2 Foundation 可以：

- 支持只读；
- 修改前要求 Approval；
- 不自动递归更新。

---

## 67. LFS

Git LFS 可能触发 Network 和大文件下载。

必须经过：

- Network Policy；
- Disk Space Check；
- Artifact Size Policy。

---

# Part XVI — Artifact Runtime

## 68. Required Worktree Artifacts

每个修改型 Run 至少生成：

- Base Metadata；
- Final Git Status；
- Unified Diff；
- Changed File List；
- Test Report Reference；
- Worktree Summary；
- Merge Report 或 Abandon Report。

### 68.1 Optional

- Commit Bundle；
- Conflict Bundle；
- Untracked File Archive；
- Patch Series；
- Review Package；
- Git Log。

---

## 69. Worktree Summary Artifact

```ts
interface WorktreeSummaryArtifact {
  worktreeId: string;

  workspaceId: string;

  runId: string;

  stageId?: string;

  branchName: string;

  baseBranch: string;

  baseCommit: string;

  headCommit: string;

  status: Worktree['status'];

  filesChanged: number;

  linesAdded: number;

  linesDeleted: number;

  testResults: string[];

  reviewOutcome?: string;

  mergeResult?: string;

  warnings: string[];
}
```

---

## 70. Debug Bundle

```text
worktree/
├── worktree.json
├── isolation-plan.json
├── base.json
├── status.json
├── diff.patch
├── changed-files.json
├── git-log.txt
├── review.json
├── merge.json
├── conflicts/
└── events.jsonl
```

---

# Part XVII — Event Model

## 71. Worktree Events

`03-Event-Model.md` 已定义基础事件。

Worktree Runtime 补充：

```text
worktree.reserved
worktree.creation_requested
worktree.created
worktree.activated
worktree.ownership_acquired
worktree.ownership_released
worktree.dirty
worktree.status_inspected
worktree.ready_for_review
worktree.review_completed
worktree.merge_requested
worktree.merging
worktree.merged
worktree.conflicted
worktree.abandoned
worktree.cleanup_started
worktree.deleted
worktree.cleanup_required
worktree.recovery_started
worktree.recovered
worktree.orphaned
```

---

## 72. `worktree.reserved`

```ts
interface WorktreeReservedPayload {
  path: string;

  branchName: string;

  baseBranch: string;

  baseCommit: string;

  worktreeType: Worktree['worktreeType'];

  ownerType: WorktreeOwner['ownerType'];

  ownerId: string;
}
```

---

## 73. `worktree.status_inspected`

```ts
interface WorktreeStatusInspectedPayload {
  headCommit: string;

  clean: boolean;

  stagedCount: number;

  modifiedCount: number;

  deletedCount: number;

  untrackedCount: number;

  conflictedCount: number;
}
```

---

## 74. `worktree.review_completed`

```ts
interface WorktreeReviewCompletedPayload {
  outcome: WorktreeReviewOutcome;

  reviewedBy: string;

  diffArtifactId: string;

  reviewArtifactId?: string;

  currentHeadCommit: string;
}
```

---

## 75. `worktree.merge_requested`

```ts
interface WorktreeMergeRequestedPayload {
  sourceBranch: string;

  targetBranch: string;

  sourceHeadCommit: string;

  expectedTargetCommit?: string;

  strategy: string;

  requestedBy: string;
}
```

---

## 76. `worktree.conflicted`

```ts
interface WorktreeConflictedPayload {
  operation:
    | 'merge'
    | 'rebase'
    | 'cherry-pick'
    | 'patch';

  conflictedFiles: string[];

  conflictArtifactId: string;

  sourceBranch?: string;

  targetBranch?: string;
}
```

---

# Part XVIII — Persistence

## 77. SQLite Schema

```sql
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  parent_worktree_id TEXT,

  worktree_type TEXT NOT NULL,
  isolation_mode TEXT NOT NULL,

  path TEXT NOT NULL UNIQUE,
  branch_name TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  head_commit TEXT,
  target_branch TEXT,

  status TEXT NOT NULL,

  ownership_token_hash TEXT NOT NULL,

  created_at TEXT NOT NULL,
  activated_at TEXT,
  last_inspected_at TEXT,
  merged_at TEXT,
  abandoned_at TEXT,
  deleted_at TEXT,

  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,

  UNIQUE(workspace_id, branch_name)
);
```

---

## 78. Supporting Tables

### Ownership

```sql
CREATE TABLE worktree_owners (
  worktree_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY(worktree_id, owner_type, owner_id, acquired_at)
);
```

### Base Updates

```sql
CREATE TABLE worktree_base_updates (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  original_base_commit TEXT NOT NULL,
  rebased_onto_commit TEXT NOT NULL,
  resulting_head_commit TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### Reviews

```sql
CREATE TABLE worktree_reviews (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  diff_artifact_id TEXT NOT NULL,
  review_artifact_id TEXT,
  created_at TEXT NOT NULL
);
```

### Merge Operations

```sql
CREATE TABLE worktree_merges (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  strategy TEXT NOT NULL,
  source_head_commit TEXT NOT NULL,
  previous_target_commit TEXT,
  resulting_target_commit TEXT,
  merge_commit TEXT,
  status TEXT NOT NULL,
  conflict_artifact_id TEXT,
  merge_artifact_id TEXT,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
```

---

## 79. Indexes

```sql
CREATE INDEX idx_worktrees_workspace
ON worktrees(workspace_id);

CREATE INDEX idx_worktrees_run
ON worktrees(run_id);

CREATE INDEX idx_worktrees_stage
ON worktrees(stage_id);

CREATE INDEX idx_worktrees_status
ON worktrees(status);

CREATE INDEX idx_worktrees_branch
ON worktrees(branch_name);

CREATE INDEX idx_worktree_merges_target
ON worktree_merges(target_branch, status);
```

---

## 80. Concurrency

必须使用：

- Version；
- Ownership Lock；
- Target Branch Merge Lock；
- Idempotency Key；
- Transaction；
- Expected Commit。

防止：

- 两次创建同 Branch；
- 两次 Merge；
- Cleanup 与 Merge 冲突；
- Process 在 Cleanup 后继续写；
- Reviewer 与 Implementer 同时修改。

---

# Part XIX — APIs

## 81. Worktree Query APIs

```text
GET /api/workspaces/:workspaceId/worktrees
GET /api/runs/:runId/worktrees
GET /api/worktrees/:worktreeId
GET /api/worktrees/:worktreeId/status
GET /api/worktrees/:worktreeId/diff
GET /api/worktrees/:worktreeId/events
GET /api/worktrees/:worktreeId/artifacts
```

---

## 82. Control APIs

```text
POST /api/worktrees
POST /api/worktrees/:id/inspect
POST /api/worktrees/:id/commit
POST /api/worktrees/:id/review
POST /api/worktrees/:id/rebase
POST /api/worktrees/:id/merge
POST /api/worktrees/:id/abandon
POST /api/worktrees/:id/cleanup
POST /api/worktrees/:id/adopt
```

### 82.1 Prefer Run APIs

普通执行应由 Run Lifecycle 自动管理 Worktree。

直接 Worktree API 主要用于：

- Inspector；
- Manual Recovery；
- Manual Review；
- Merge；
- Cleanup。

---

## 83. Worktree Inspector View

```ts
interface WorktreeInspectorView {
  worktree: Worktree;

  owner?: WorktreeOwner;

  isolationPlan: IsolationPlan;

  gitStatus: WorktreeStatusSnapshot;

  diff?: WorktreeDiffSummary;

  processes: RuntimeProcessSnapshot[];

  review?: {
    outcome: WorktreeReviewOutcome;
    artifactId?: string;
  };

  merge?: WorktreeMergeResult;

  artifacts: Artifact[];

  recentEvents: RuntimeEvent[];

  recoveryWarnings: string[];

  cleanupSafe: boolean;

  cleanupBlockers: string[];
}
```

---

# Part XX — Testing

## 84. Unit Tests

必须覆盖：

- Branch Naming；
- Path Generation；
- Path Security；
- Isolation Plan；
- Ownership；
- Base Commit Resolution；
- Dirty Workspace Decision；
- Merge Policy；
- Cleanup Safety；
- Recovery Classification；
- Commit Validation；
- Optimistic Commit Check；
- Event Payload；
- Directory Isolation。

---

## 85. Git Contract Tests

使用临时 Repository 测试：

1. Clean Repository；
2. Dirty Main Workspace；
3. Create Worktree；
4. Create Stage Worktree；
5. Parallel Worktrees；
6. File Modify；
7. Untracked File；
8. Binary File；
9. Commit；
10. Diff；
11. Merge；
12. Merge Conflict；
13. Rebase；
14. Rebase Conflict；
15. Abandon；
16. Cleanup；
17. Branch Delete；
18. Worktree Prune；
19. Missing Directory；
20. Orphan Worktree。

---

## 86. Windows Tests

必须覆盖：

- Windows Path；
- Drive Letter；
- Path with Spaces；
- Unicode；
- Junction；
- Long Path；
- Locked File；
- Running Process Blocks Delete；
- Git for Windows；
- Worktree Root Outside Repository；
- Case-insensitive Branch Collision。

---

## 87. POSIX Tests

必须覆盖：

- Symlink；
- Permission；
- Unix Path；
- Locked File；
- Case-sensitive Branch；
- Worktree Outside Repository；
- Process cwd；
- Cleanup。

---

## 88. Integration Tests

### 88.1 Single Run Worktree

```text
Task
  ↓
Run Worktree
  ↓
KimiCode modifies
  ↓
Tests
  ↓
Review
  ↓
Merge
```

### 88.2 Parallel Provider Comparison

```text
Base
├── Codex Worktree
├── KimiCode Worktree
└── OpenCode Worktree
```

验证：

- 无共享修改；
- 独立 Diff；
- 独立 Artifact；
- 可选择一个 Merge。

### 88.3 Browser Disconnect

Worktree 和 Process 继续存在。

### 88.4 Server Restart

Recovery 能重新识别 Worktree。

### 88.5 Merge Conflict

不破坏 Target Branch。

### 88.6 Cleanup Blocker

Dirty Worktree 不被自动删除。

---

## 89. Mock Git Runtime

Mock 支持：

```ts
type MockGitScenario =
  | 'clean'
  | 'dirty'
  | 'create-failure'
  | 'branch-conflict'
  | 'path-conflict'
  | 'modify'
  | 'commit'
  | 'merge-clean'
  | 'merge-conflict'
  | 'rebase-conflict'
  | 'missing-directory'
  | 'orphan'
  | 'cleanup-failure';
```

---

# Part XXI — v1 Migration

## 90. Current v1 State

当前 v1 主要在：

```text
Workspace Root
```

中执行多个 Agent。

问题：

- Agent 修改互相覆盖；
- 并发风险；
- Review 污染实现；
- 无 Run Isolation；
- Diff 无明确 Owner；
- 无 Branch 生命周期；
- 无 Merge 管理；
- 无 Conflict Runtime；
- 无 Recovery；
- 无 Cleanup Policy。

---

## 91. Migration Step 1 — Read-only Detection

先区分：

```text
read-only
modifying
```

只读流程暂时保留 Workspace Root。

---

## 92. Migration Step 2 — Single Run Worktree

所有修改型旧 Pipeline 使用一个 Run Worktree。

```text
Old Four-stage Workflow
  ↓
One Run Worktree
```

保持行为稳定。

---

## 93. Migration Step 3 — Process cwd

Provider Process：

```text
cwd = runWorktree.path
```

不再使用 Workspace Root。

---

## 94. Migration Step 4 — Diff and Artifact

Run 完成时生成：

- Diff；
- Changed Files；
- Worktree Summary。

---

## 95. Migration Step 5 — Review and Merge

加入：

- Ready for Review；
- User Approval；
- Merge；
- Abandon。

---

## 96. Migration Step 6 — Stage Worktrees

并行 Workflow 和 Provider Comparison 再引入 Stage Worktree。

---

## 97. Migration Step 7 — Recovery and Cleanup

最后加入：

- Startup Recovery；
- Orphan；
- Deferred Cleanup；
- Worktree Inspector。

---

# Part XXII — Implementation Structure

## 98. Recommended Package

```text
packages/git-runtime/
├── src/
│   ├── git-client.ts
│   ├── repository-inspector.ts
│   ├── isolation-planner.ts
│   ├── worktree-manager.ts
│   ├── worktree-repository.ts
│   ├── ownership-manager.ts
│   ├── branch-manager.ts
│   ├── status-manager.ts
│   ├── diff-manager.ts
│   ├── commit-manager.ts
│   ├── review-manager.ts
│   ├── merge-manager.ts
│   ├── conflict-manager.ts
│   ├── recovery-manager.ts
│   ├── cleanup-manager.ts
│   ├── directory-isolation.ts
│   ├── errors.ts
│   ├── events.ts
│   └── testing/
└── package.json
```

---

## 99. Git Client

所有 Git 命令必须经过 Git Client。

```ts
interface GitClient {
  run(
    request: GitCommandRequest
  ): Promise<GitCommandResult>;
}
```

Git Client 使用 Process Runtime。

```text
Git Runtime
  ↓
Process Manager
  ↓
git executable
```

Git Runtime 不直接裸 Spawn。

---

## 100. Dependencies

Worktree Runtime 可以依赖：

- Process Runtime；
- Storage；
- Event Sink；
- Artifact Sink；
- Policy Engine；
- Approval；
- Clock；
- Secret Scanner。

不得依赖：

- Web UI；
- Provider-specific Adapter；
- Conversation UI；
- Model；
- Prompt。

---

# Part XXIII — Error Model

## 101. Worktree Error

```ts
interface WorktreeRuntimeError {
  code: WorktreeErrorCode;

  message: string;

  phase:
    | 'validation'
    | 'reservation'
    | 'creation'
    | 'activation'
    | 'inspection'
    | 'diff'
    | 'commit'
    | 'review'
    | 'rebase'
    | 'merge'
    | 'conflict'
    | 'abandon'
    | 'cleanup'
    | 'recovery';

  worktreeId?: string;

  retryable: boolean;

  suggestedAction?: string;

  details?: Record<string, unknown>;
}
```

---

## 102. Error Codes

```ts
type WorktreeErrorCode =
  | 'WORKTREE_GIT_REQUIRED'
  | 'WORKTREE_REPOSITORY_INVALID'
  | 'WORKTREE_REPOSITORY_BUSY'
  | 'WORKTREE_BASE_NOT_FOUND'
  | 'WORKTREE_BASE_INVALID'
  | 'WORKTREE_BRANCH_EXISTS'
  | 'WORKTREE_BRANCH_INVALID'
  | 'WORKTREE_PATH_EXISTS'
  | 'WORKTREE_PATH_INVALID'
  | 'WORKTREE_PATH_OUTSIDE_ALLOWED_ROOT'
  | 'WORKTREE_NESTED_NOT_ALLOWED'
  | 'WORKTREE_RESERVATION_FAILED'
  | 'WORKTREE_CREATE_FAILED'
  | 'WORKTREE_ACTIVATION_FAILED'
  | 'WORKTREE_OWNER_CONFLICT'
  | 'WORKTREE_NOT_FOUND'
  | 'WORKTREE_STATUS_FAILED'
  | 'WORKTREE_DIFF_FAILED'
  | 'WORKTREE_DIRTY'
  | 'WORKTREE_CONFLICT'
  | 'WORKTREE_COMMIT_FAILED'
  | 'WORKTREE_REBASE_FAILED'
  | 'WORKTREE_MERGE_FAILED'
  | 'WORKTREE_MERGE_CONFLICT'
  | 'WORKTREE_TARGET_CHANGED'
  | 'WORKTREE_REVIEW_STALE'
  | 'WORKTREE_POLICY_DENIED'
  | 'WORKTREE_APPROVAL_REQUIRED'
  | 'WORKTREE_ACTIVE_PROCESS'
  | 'WORKTREE_CLEANUP_UNSAFE'
  | 'WORKTREE_CLEANUP_FAILED'
  | 'WORKTREE_RECOVERY_FAILED'
  | 'WORKTREE_ORPHANED'
  | 'WORKTREE_UNKNOWN_ERROR';
```

---

# Part XXIV — Implementation Phases

## 103. Phase 1 — Run Worktree Foundation

- Worktree Schema；
- Git Client；
- Repository Inspection；
- Base Commit；
- Run Worktree；
- Process cwd；
- Status；
- Diff；
- Cleanup Guard；
- Event。

---

## 104. Phase 2 — Review and Merge

- Review Package；
- Commit；
- Approval；
- Integration Context；
- Merge；
- Conflict Artifact；
- Target Lock。

---

## 105. Phase 3 — Stage Isolation

- Stage Worktree；
- Parallel Worktrees；
- Provider Comparison；
- Integration Worktree；
- Ownership Transfer。

---

## 106. Phase 4 — Recovery and Non-Git

- Startup Recovery；
- Orphan；
- Deferred Cleanup；
- Directory Copy / Reflink；
- Worktree Inspector。

---

# Part XXV — Definition of Done

## 107. Worktree Runtime Foundation DoD

Foundation 完成必须满足：

1. 修改型 Run 默认创建 Worktree。
2. 主 Workspace 不被 Provider 直接修改。
3. Worktree 有 Durable Record。
4. Base Commit 被冻结。
5. Branch 和 Path 唯一。
6. Process cwd 指向 Worktree。
7. Browser Disconnect 不影响 Worktree。
8. Run 完成生成 Diff Artifact。
9. Dirty Worktree 不被静默删除。
10. Worktree 可 Review。
11. Merge 与 Run Completion 分离。
12. Merge 经过 Policy 和 Approval。
13. Target Branch Merge 有 Lock。
14. Conflict 不破坏 Target Branch。
15. Merge Conflict 生成 Artifact。
16. Worktree Cleanup 幂等。
17. Server Startup 可恢复 Worktree。
18. Orphan 可识别。
19. Path Delete 有 Ownership Guard。
20. Git 命令通过 Process Runtime。
21. v1 固定 Workflow 可在一个 Run Worktree 中运行。
22. Windows 和 POSIX Contract Tests 通过。
23. Parallel Stage 不共享 Worktree。
24. Run Retry 默认创建新 Worktree。
25. Worktree Inspector 可展示完整状态。

---

# Part XXVI — Anti-Patterns

## 108. Shared Workspace Mutation

错误：

```text
Codex
KimiCode
OpenCode
  ↓
same Workspace Root
```

正确：

```text
Run / Stage
  ↓
owned Worktree
```

---

## 109. Run Completed Means Merge

错误：

```text
Run completed
  → automatically merge main
```

正确：

```text
Run completed
  ↓
Review
  ↓
Approval
  ↓
Merge
```

---

## 110. Silent Fallback

错误：

```text
Worktree create failed
  → use Workspace Root
```

正确：

```text
Worktree required
  → Run failed
```

或用户显式选择降级。

---

## 111. Blind Cleanup

错误：

```text
rm -rf worktreePath
```

正确：

```text
Ownership Verify
  ↓
Process Check
  ↓
Git Status
  ↓
Artifact Archive
  ↓
git worktree remove
  ↓
Path Verify
```

---

## 112. Parallel Stages Share Branch

错误：

```text
Stage A + Stage B
  ↓
same Worktree
```

正确：

```text
Stage A Worktree
Stage B Worktree
  ↓
Integration
```

---

## 113. Reviewer Modifies Implementer Worktree

错误：

```text
Reviewer finds issue
  → edits same files
```

正确：

```text
Reviewer emits findings
  ↓
Fix Stage / Child Run
```

---

## 114. Base Commit Changes in Place

错误：

```text
worktree.baseCommit = latestMain
```

正确：

```text
Preserve original Base
Record Rebase Operation
```

---

## 115. Merge in Main Checkout

错误：

```text
cd workspaceRoot
git merge ...
```

正确：

```text
Integration Worktree
  ↓
Merge
```

---

## 116. Path Name as Ownership

错误：

```text
directory name contains run id
→ safe to delete
```

正确：

```text
Database Record
+ Ownership Token
+ Canonical Path
+ Git Registration
→ ownership
```

---

# Part XXVII — Global Invariants

## 117. Worktree Runtime Invariants

AgentOS v2 必须始终满足：

1. Workspace 与 Worktree 分离。
2. 修改型 Run 默认使用 Worktree。
3. 主 Workspace 默认只作为控制边界。
4. Worktree 必须有 Owner。
5. Base Commit 不可修改。
6. Run Retry 默认创建新 Worktree。
7. Parallel Modifying Stage 必须独立。
8. Stage 间结果通过 Commit、Patch 或 Artifact 传递。
9. Worktree Path 必须受控。
10. Worktree 不得嵌套。
11. Worktree Branch 必须唯一。
12. Git 命令必须通过 Process Runtime。
13. Process cwd 必须与 Isolation Plan 一致。
14. Reviewer 默认只读。
15. Run Completed 不等于 Merge。
16. Merge 必须有独立生命周期。
17. Merge 默认需要 Review 和 Approval。
18. Push 默认不自动执行。
19. Target Branch Merge 必须串行。
20. Merge 前必须验证 Expected Commit。
21. Conflict 不得静默解决。
22. Conflict 必须产生 Artifact。
23. Rebase 不得覆盖原 Base 历史。
24. Review 必须绑定具体 Head Commit 和 Diff。
25. Head 变化后 Review 可能失效。
26. Dirty Worktree 不得盲删。
27. Cleanup 必须幂等。
28. Cleanup 前必须检查 Active Process。
29. Force Cleanup 必须审批。
30. Worktree Recovery 不得只依赖目录名。
31. Orphan 默认保留。
32. 非 Git 降级不得静默。
33. Git Hook 必须受 Policy 控制。
34. Submodule 和 LFS 必须考虑 Network Policy。
35. Worktree 状态变化必须产生 Runtime Event。
36. Diff 和 Merge Result 必须生成 Artifact。
37. Worktree 数据必须持久化。
38. v1 共享目录修改模型必须废弃。
39. Integration 不应在用户主 Checkout 执行。
40. Worktree Runtime 必须可通过临时仓库完整测试。

---

# Part XXVIII — Final Definition

## 118. Final Definition

AgentOS v2 Worktree Runtime 定义如下：

> Worktree Runtime 是 AgentOS 用于管理代码隔离与变更生命周期的 Git 执行层。它根据 Workflow 和 Stage 并发关系为 Run 创建 Run Worktree、Stage Worktree 或 Integration Worktree，冻结 Base Commit，分配唯一 Branch 和 Path，将 Provider、Tool、Git 和 Test Process 限制在受控 Worktree 中，并持续记录 Git Status、File Change、Diff、Commit、Review、Conflict、Merge、Abandon、Recovery 和 Cleanup。Run 的执行完成与代码合并相互独立，所有 Merge、Push、Force Cleanup 和受保护 Branch 操作都必须经过 Policy 与 Approval。

简化表达：

```text
Workspace
  ↓
Isolation Plan
  ↓
Run / Stage Worktree
  ↓
Provider Process in Worktree
  ↓
File Change + Git Status
  ↓
Diff + Artifact
  ↓
Review
  ↓
Integration Worktree
  ↓
Merge / Conflict / Abandon
  ↓
Cleanup / Recovery
```

推荐隔离模型：

```text
Sequential Workflow:
  One Run Worktree

Parallel Modifying Workflow:
  One Stage Worktree per Stage

Multiple Result Integration:
  Dedicated Integration Worktree

Reviewer:
  Read-only or Review Worktree
```

本文件定义的 Worktree Runtime 是 AgentOS v2 多 Agent 并发修改、跨 Provider 对比、安全 Review、可靠 Merge、冲突处理和代码执行隔离的 Git 基础。
