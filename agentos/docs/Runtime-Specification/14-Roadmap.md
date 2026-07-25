# AgentOS Runtime Specification v2.0

## 14 — Roadmap

> Status: Draft
> Version: 2.0
> Last Updated: 2026-07-19
> Scope: AgentOS v2 Incremental Implementation, Migration and Release Roadmap
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
> - `13-Runtime-Inspector.md`
> Repository: `Zbyy0311/agentos`

---

## 1. Document Purpose

本文件定义 AgentOS v2 的统一实施 Roadmap。

它将 `00–13` 中分散的 Foundation Scope、Migration Step、Implementation Phase、Definition of Done 和 Testing Requirement 收敛为一条可以逐步执行、验证和发布的工程路线。

本文件规定：

- Roadmap 原则；
- 当前基线；
- 状态定义；
- Priority；
- Workstream；
- Dependency；
- Critical Path；
- Parallel Work；
- Milestone；
- Release；
- Migration；
- Feature Flag；
- Worktree；
- Agent Collaboration；
- Quality Gate；
- Testing；
- Documentation；
- Risk；
- Metrics；
- Rollback；
- Tauri 时机；
- Non-goals；
- Roadmap Governance。

本 Roadmap 的目标不是预测准确日期，而是确保：

> AgentOS v2 每一步都产生可运行、可验证、可回退的增量，不通过一次整仓重写来追求最终架构。

---

## 2. Roadmap Definition

AgentOS v2 Roadmap 定义为：

```text
Architecture Contract
  ↓
Incremental Runtime Replacement
  ↓
Durable Safe Execution
  ↓
Conversation and Workbench
  ↓
Inspector and Recovery
  ↓
Group Collaboration
  ↓
Productization
  ↓
Future Desktop Host
```

---

## 3. No Calendar Promise

本文件默认不承诺具体日期。

原因：

- 当前开发资源可能变化；
- Provider CLI 行为可能变化；
- v1 技术债务需要 Repo Audit；
- Windows Process 和 Worktree Recovery 存在不确定性；
- UI Quality 需要迭代。

Roadmap 使用：

- Dependency；
- Milestone；
- Exit Gate；
- Effort Class；
- Risk；

而不是未经验证的 Deadline。

---

## 4. Current Baseline

已完成的架构基线：

```text
00 Vision
01 Core Concepts
02 Runtime Lifecycle
03 Event Model
04 Provider Specification
05 Process Runtime
06 Worktree Runtime
07 Memory Runtime
08 Policy Runtime
09 Conversation Runtime
10 Data Model
11 API Specification
12 UI Architecture
13 Runtime Inspector
14 Roadmap
```

该状态仅表示 Specification 已建立。

它不自动表示相应代码已完成。

---

## 5. Implementation Status Is Evidence-based

任何 Milestone 状态必须来自：

- Code；
- Test；
- Migration；
- Runtime Evidence；
- Acceptance Report；
- Git Commit；
- CI Result。

不能仅因：

- 文档存在；
- 页面存在；
- Mock 通过；
- 单次手动演示；

就标记为完成。

---

# Part I — Roadmap Principles

## 6. Incremental Replacement

采用 Strangler Pattern：

```text
Existing v1 Path
  ↓
Compatibility Boundary
  ↓
New v2 Service
  ↓
Feature Flag
  ↓
Migration
  ↓
Old Path Retired
```

不进行整仓推倒重写。

---

## 7. One Canonical Truth

迁移期间必须尽快明确 Canonical Source。

避免长期：

```text
JSON says running
SQLite says failed
SSE says done
```

每个阶段都必须定义：

- Source of Truth；
- Compatibility Read；
- Compatibility Write；
- Cutover；
- Rollback。

---

## 8. Contracts Before Parallel Implementation

允许多个 Agent 并行前，必须先冻结：

- Domain Boundary；
- API DTO；
- Event Envelope；
- Error Code；
- Database Migration；
- Package Ownership；
- Test Fixture。

否则并行会制造集成冲突。

---

## 9. Durable Before Beautiful

实现优先级：

```text
Correct
  ↓
Durable
  ↓
Recoverable
  ↓
Observable
  ↓
Safe
  ↓
Usable
  ↓
Polished
```

Apple-style Motion 不能早于基本 Runtime 正确性。

---

## 10. Safety Before Autonomy

以下能力必须先于复杂多 Agent 自治：

- Policy；
- Approval；
- Worktree Isolation；
- Process Cancellation；
- Recovery；
- Audit。

---

## 11. Web-first, Tauri-ready

当前优先：

```text
Web UI
+ Independent AgentOS Server
```

未来：

```text
Tauri Host
+ same Web UI
+ AgentOS Server Sidecar
```

Tauri 不进入 Foundation Critical Path。

---

## 12. Test at Every Boundary

每个 Workstream 都必须有：

- Unit；
- Contract；
- Integration；
- Recovery；
- Security，按需；
- End-to-end，按 Milestone。

---

## 13. No Silent Scope Expansion

每个 Milestone 明确：

- Included；
- Excluded；
- Exit Gate。

出现新需求时：

- 加入 Backlog；
- 标记 Dependency；
- 不直接塞进当前 Milestone。

---

# Part II — Status and Priority

## 14. Status Values

```text
proposed
specified
ready
in_progress
blocked
implemented
verified
released
deprecated
retired
```

### 14.1 Specified

规范已完成，不代表代码完成。

### 14.2 Implemented

代码已存在，不代表达到发布质量。

### 14.3 Verified

Acceptance Gate 和测试已通过。

### 14.4 Released

进入默认用户路径。

---

## 15. Priority

### P0 — Foundation

没有它，v2 Runtime 不能成立。

### P1 — Core Product

没有它，AgentOS 不能形成完整工作台。

### P2 — Productization

提高质量、扩展和长期维护。

### P3 — Future

当前不进入主线。

---

## 16. Effort Class

```text
XS  isolated small change
S   one bounded component
M   multi-component feature
L   cross-domain feature
XL  architectural migration
```

Effort 仅用于比较，不等于时间承诺。

---

# Part III — Workstreams

## 17. Workstream A — Storage and Domain Core

负责：

- SQLite；
- Migration；
- Repository；
- Unit of Work；
- Identity；
- Task；
- Run；
- Stage；
- Snapshot；
- Event Store；
- Outbox；
- Idempotency；
- Lock。

---

## 18. Workstream B — Process and Provider Runtime

负责：

- Process Manager；
- Process Tree；
- Output；
- Cancellation；
- Timeout；
- Recovery Identity；
- Provider Registry；
- Provider Configuration；
- Provider Adapter；
- KimiCode Direct；
- Codex；
- OpenCode；
- Authentication；
- Validation。

---

## 19. Workstream C — Git, Worktree and Artifact

负责：

- Git Runtime；
- Worktree；
- Base Commit；
- Diff；
- Commit；
- Review；
- Merge；
- Conflict；
- Cleanup；
- Artifact Metadata；
- Artifact Storage；
- Checksum；
- Retention。

---

## 20. Workstream D — Policy, Approval and Memory

负责：

- Policy Profile；
- Rules；
- Decision；
- Risk；
- Approval；
- Grant；
- Unsafe Mode；
- Secret Reference；
- Memory Entry；
- Candidate；
- Retrieval；
- Context；
- Conflict；
- Explanation。

---

## 21. Workstream E — Conversation and Public API

负责：

- Conversation；
- Member；
- Message；
- Turn；
- Orchestrator；
- Projection；
- REST；
- SSE；
- WebSocket；
- OpenAPI；
- SDK；
- Preference API。

---

## 22. Workstream F — Web UI and Inspector

负责：

- Design System；
- App Shell；
- Conversation UI；
- Workbench；
- Runtime Inspector；
- Approval Center；
- Provider Settings；
- Memory UI；
- Artifact Viewer；
- Accessibility；
- Motion；
- Platform Adapter。

---

## 23. Workstream G — Migration, QA and Release

负责：

- v1 Compatibility；
- Data Migration；
- Feature Flag；
- Test Harness；
- CI；
- Fixture；
- Performance；
- Security；
- Recovery Drill；
- Release；
- Rollback；
- Documentation。

---

# Part IV — Dependency Graph

## 24. High-level Dependency

```text
Architecture Baseline
        ↓
Storage + Domain Core
        ↓
Lifecycle + Event + API Foundation
        ↓
Process + Provider Runtime
        ↓
Git / Worktree / Artifact
        ↓
Policy / Approval / Recovery
        ↓
Conversation + Memory
        ↓
Web UI Foundation
        ↓
Workbench + Runtime Inspector
        ↓
Group Collaboration
        ↓
Productization
        ↓
Future Tauri
```

---

## 25. Parallelizable Tracks

Contracts 冻结后可以并行：

```text
Track A:
  Storage + Event

Track B:
  Process Platform Abstraction

Track C:
  UI Design System + Static App Shell

Track D:
  Test Harness + Fixtures
```

但 Track B 不能绕过 Track A 的 Process Schema 和 Event Contract。

---

## 26. Shared-core Conflict Zones

以下文件或模块不应由多个 Agent 同时无协调修改：

- shared domain types；
- database schema；
- event envelope；
- API error model；
- Run state machine；
- Process Manager interface；
- package exports；
- root workspace config；
- migration registry。

---

## 27. Critical Path

Foundation Critical Path：

```text
SQLite
→ Task / Run
→ Event Store
→ Process Runtime
→ Provider Adapter
→ Worktree
→ Policy / Approval
→ Recovery
→ Workbench / Inspector
```

Conversation Group Autonomy 不在 Critical Path。



# Part V — Release Structure

## 28. Release R0 — Architecture Baseline

目标：

```text
00–14 Specification complete
+ cross-document alignment
+ implementation entry criteria
```

包含：

- Runtime Specification；
- UI Architecture；
- Runtime Inspector；
- Roadmap；
- ADR；
- Naming；
- Package Boundary；
- Migration Principle。

Exit Gate：

- 00–14 无文件引用错误；
- Agent / Provider / Task / Run / Process 边界一致；
- Browser Disconnect 规则一致；
- Web-first / Tauri-ready 一致；
- 无空正式规范文件；
- Docs Commit 可审查。

Effort：

```text
S
```

---

## 29. Release R1 — Runtime Foundation

目标：

```text
Durable Task and Run
+ Event Store
+ Process-owned execution
+ Provider abstraction
```

包含 Milestone：

- M1 Repository Audit and Test Baseline；
- M2 Storage and Domain Core；
- M3 Lifecycle, Events and API Foundation；
- M4 Process and Provider Runtime。

Exit Gate：

- Run survives browser disconnect；
- Retry creates new Run；
- Runtime Event ordered and durable；
- KimiCode direct adapter works；
- Process tree cancellation works；
- Server restart has defined recovery；
- v1 compatibility route available。

---

## 30. Release R2 — Safe Engineering Execution

目标：

```text
Isolated changes
+ artifacts
+ policy
+ approval
+ recovery
```

包含：

- M5 Git / Worktree / Artifact；
- M6 Policy / Approval；
- M7 Recovery Hardening。

Exit Gate：

- modifying Run uses Worktree by default；
- base commit immutable；
- diff and artifact traceable；
- merge is separate from Run completion；
- risky action requires Policy；
- approval survives restart；
- recovery never guesses success。

---

## 31. Release R3 — Collaboration Workbench

目标：

```text
Conversation
+ direct Agent interaction
+ Task / Run Workbench
+ Runtime Inspector
```

包含：

- M8 Memory Foundation；
- M9 Conversation Runtime；
- M10 UI Foundation；
- M11 Direct Conversation；
- M12 Workbench and Runtime Inspector。

Exit Gate：

- direct Agent conversation persistent；
- Message does not automatically equal Run；
- Task can be created from Message；
- Run can be inspected and controlled；
- streaming reconnect works；
- Memory Context explainable；
- Approval rendered from trusted resource。

---

## 32. Release R4 — Multi-Agent Collaboration

目标：

```text
Group Conversation
+ Orchestrator
+ Workflow collaboration
+ review and comparison
```

包含：

- M13 Group Conversation；
- M14 Workflow Collaboration；
- M15 Provider Comparison；
- M16 Agent History and Search。

Exit Gate：

- group reply budget works；
- loop guard works；
- sequential and parallel modes work；
- provider comparison has common base；
- agent history is AgentOS history, not raw native log；
- workflow result can be reviewed and accepted。

---

## 33. Release R5 — Productization

目标：

```text
Reliable daily-use product
```

包含：

- M17 Performance and Accessibility；
- M18 Extension Foundation；
- M19 Backup / Import / Export；
- M20 Security Hardening；
- M21 Release Packaging for Web-local use。

Exit Gate：

- upgrade and rollback tested；
- backup restore tested；
- accessibility audit passed；
- large history performance passed；
- extension permission model enforced；
- default workflow no longer depends on v1 path。

---

## 34. Release R6 — Future Desktop Host

目标：

```text
Tauri Desktop
+ same Web UI
+ AgentOS Server Sidecar
```

包含：

- M22 Tauri Host；
- M23 Sidecar Packaging；
- M24 Native Platform Adapter；
- M25 Desktop Update and Recovery。

该 Release 是 P3。

进入条件：

- Web UI 稳定；
- API 稳定；
- Artifact Boundary 稳定；
- Runtime Server 可独立构建；
- Realtime Recovery 稳定；
- Platform Adapter 已经在 Web 中验证。

---

# Part VI — Milestone M1: Repository Audit and Test Baseline

## 35. Objective

在修改架构核心前，建立真实代码基线。

---

## 36. Scope

- Monorepo Tree；
- Package Ownership；
- Current APIs；
- Current Task Model；
- Current AgentRunner；
- Current CLIExecutor；
- Current Persistence；
- Current SSE；
- Current Process Launch；
- Current Git Integration；
- Current UI；
- Current Tests；
- Current Scripts；
- Current Environment Requirements。

---

## 37. Deliverables

```text
docs/implementation/current-state-audit.md
docs/implementation/v1-to-v2-map.md
docs/implementation/test-baseline.md
```

以及：

- Existing Test Report；
- Failing Test List；
- Runtime Smoke Test；
- Current API Inventory；
- Data Inventory；
- Migration Risk List。

---

## 38. Required Questions

1. Git Root 在哪里？
2. 哪些文件已受 Git 管理？
3. Server Entry 是什么？
4. Stable Dev Command 是什么？
5. Task JSON 存储在哪里？
6. SSE 是否与 Request 生命周期绑定？
7. AgentRunner 如何运行固定 Stage？
8. CLIExecutor 如何 Spawn？
9. CODEX_HOME / Kimi PATH 如何注入？
10. Cancel 如何处理 Process Tree？
11. Git Diff 当前在哪里生成？
12. UI 使用 Next.js 的哪些 Server 能力？
13. Test 中哪些是 Mock？
14. 当前 migration 数据量是多少？

---

## 39. Exit Gate

- 当前测试可重复运行；
- Stable Dev Mode 可启动；
- 已知 Failure 有记录；
- 无未解释的生成目录进入 Git；
- v1 到 v2 Component Mapping 已明确；
- 后续 Milestone 不依赖猜测。

Effort：

```text
M
```

Risk：

```text
Medium
```

---

# Part VII — Milestone M2: Storage and Domain Core

## 40. Objective

建立 SQLite Canonical Storage 和核心 Aggregate。

---

## 41. Scope

- SQLite Connection；
- PRAGMA；
- Migration Runner；
- Repository；
- Unit of Work；
- ID；
- Workspace；
- Agent Profile；
- Provider Configuration；
- Workflow Definition；
- Task；
- Run；
- Stage；
- Snapshot；
- Idempotency Record；
- Runtime Lock；
- Audit Foundation。

---

## 42. Package Target

```text
packages/storage
packages/runtime-core
packages/shared
```

---

## 43. Deliverables

- Initial Schema；
- Migration 0001；
- Repository Interfaces；
- SQLite Implementations；
- Aggregate Version；
- Soft Delete；
- Transaction Helper；
- Backup before Migration；
- Schema Integrity Command；
- Test Fixture Factory。

---

## 44. Compatibility

v1 JSON 仍可读。

Foundation 推荐：

```text
v1 JSON read
  ↓
compatibility mapper
  ↓
v2 DTO
```

不要长期 Dual Write。

---

## 45. Tests

- Migration；
- Foreign Key；
- Transaction Rollback；
- Optimistic Concurrency；
- Idempotency；
- Unique Constraint；
- Soft Delete；
- Backup；
- 100k Event-ready schema benchmark，初步。

---

## 46. Exit Gate

- Task 和 Run 分离；
- Retry 不能覆盖原 Run；
- Run Snapshot 可引用；
- Version Conflict 可检测；
- SQLite 重启后数据完整；
- v1 数据可以映射；
- Schema Migration 可重复验证。

Effort：

```text
XL
```

Risk：

```text
High
```

---

# Part VIII — Milestone M3: Lifecycle, Event and API Foundation

## 47. Objective

让 Run 成为持久状态机，并建立 Persist-then-publish Event Path。

---

## 48. Scope

- Run Engine；
- Workflow Executor Foundation；
- Stage Transition；
- Event Envelope；
- Sequence Allocator；
- Event Store；
- Outbox；
- SSE；
- Reconnect；
- API Problem；
- Operation Resource；
- ETag；
- Idempotency Middleware；
- Basic OpenAPI。

---

## 49. Event Path

```text
Runtime Transition
  ↓ transaction
Current State + Runtime Event + Outbox
  ↓ commit
Outbox Publisher
  ↓
SSE / WebSocket / Projection
```

---

## 50. Deliverables

- Create Task API；
- Create Run API；
- Start Run API；
- Get Run API；
- Cancel Run API；
- Run Events API；
- Run Stream；
- Operation API；
- Error Mapping；
- Event Fixture；
- Replay Foundation。

---

## 51. Compatibility

旧：

```text
POST execute task
```

映射为：

```text
create Run
→ start Run
→ compatibility response
```

旧 SSE：

```text
status
stage
thinking
done
```

映射到 v2 Event。

---

## 52. Tests

- Run Transition；
- Duplicate Start；
- Cancel vs Complete；
- Retry creates child；
- Event Ordering；
- Duplicate Event；
- SSE Reconnect；
- Browser Disconnect；
- Outbox Recovery；
- API Contract；
- ETag；
- Idempotency。

---

## 53. Exit Gate

- Browser Refresh 不取消 Run；
- Client Disconnect 只结束 Subscription；
- Event Sequence 严格递增；
- State 与 Event 同事务或 Outbox 保证；
- Error 使用稳定 Code；
- Run Start 返回异步结果；
- Retry 创建新 Run。

Effort：

```text
XL
```

Risk：

```text
High
```

---

# Part IX — Milestone M4: Process and Provider Runtime

## 54. Objective

将 OS Process 和 Provider CLI 从旧 Executor 中解耦。

---

## 55. Scope

- Process Runtime；
- Process Identity；
- Process Tree；
- stdout / stderr；
- Bounded Buffer；
- Raw Output Artifact；
- Idle Timeout；
- Cancellation；
- Windows Job Object / fallback；
- POSIX Process Group；
- Provider Registry；
- Provider Adapter；
- Provider Configuration；
- Validation；
- Authentication；
- KimiCode Direct；
- Codex；
- OpenCode；
- Custom CLI Foundation。

---

## 56. Refactor Mapping

```text
CLIExecutor
  ↓
ProcessManager
+ ProviderAdapter

AgentRunner
  ↓
RunEngine
+ WorkflowExecutor
```

---

## 57. KimiCode Requirement

必须直接调用：

```text
kimi.exe
```

不得默认：

```text
OpenCode wrapper + Kimi model
```

---

## 58. Process Environment

优先级：

```text
agent/provider config
  > explicit process environment
  > server environment
  > platform default resolution
```

Secret 只通过 Reference Resolve。

---

## 59. Deliverables

- `ProcessManager`；
- `ProcessRepository`；
- `ProcessEventNormalizer`；
- `ProviderRegistry`；
- `KimiCodeProviderAdapter`；
- `CodexProviderAdapter`；
- `OpenCodeProviderAdapter`；
- Provider Validation API；
- Provider Session API；
- Process Inspector API；
- Stable Cancel；
- Recovery Record。

---

## 60. Tests

- Direct executable；
- Missing executable；
- Auth required；
- PATH；
- CODEX_HOME；
- Kimi home；
- Process child tree；
- Graceful stop；
- Force stop；
- Timeout；
- Output backpressure；
- Windows restart recovery；
- Provider error normalization。

---

## 61. Exit Gate

- Run 不直接 Spawn；
- Provider Adapter 不直接绕过 Process Runtime；
- Process ID 不等于 PID；
- Cancel 处理整个 Process Tree；
- Raw Output 可追踪；
- KimiCode Direct 验证通过；
- Provider Auth Failure 有稳定 Error；
- Browser Disconnect 不影响 Process。

Effort：

```text
XL
```

Risk：

```text
Critical
```



# Part X — Milestone M5: Git, Worktree and Artifact

## 62. Objective

让修改型 Run 默认在隔离 Worktree 中执行，并建立可追踪 Artifact。

---

## 63. Scope

- Git Runtime；
- Repository Inspection；
- Base Commit；
- Worktree Create；
- Worktree Owner；
- Branch Naming；
- Process CWD；
- Status；
- Diff；
- Commit；
- Review；
- Merge；
- Conflict；
- Cleanup；
- Artifact Store；
- Checksum；
- Reference；
- Preview；
- Retention。

---

## 64. Default Isolation

修改型 Run：

```text
Main Workspace
  ↓ base commit
Run Worktree
  ↓
Provider Process cwd
```

只读 Run 可以选择无 Worktree。

---

## 65. Deliverables

- Git Client；
- Worktree Manager；
- Worktree Schema；
- Isolation Planner；
- Diff Artifact；
- Raw Output Artifact；
- Test Artifact；
- Review Package；
- Merge Operation；
- Cleanup Guard；
- Artifact API；
- Artifact Viewer Foundation。

---

## 66. Merge Boundary

```text
Run completed
  ≠ merged

Task accepted
  ≠ merged
```

Merge 是独立高风险 Action。

---

## 67. Tests

- Create；
- Existing branch；
- Invalid path；
- Base commit；
- Parallel worktrees；
- Dirty state；
- Diff；
- Commit；
- Expected head；
- Expected target；
- Conflict；
- Merge；
- Cleanup；
- Crash between Git and DB；
- Artifact checksum；
- Large artifact；
- Missing artifact file。

---

## 68. Exit Gate

- 修改型 Run 默认隔离；
- Main Workspace 不被并行 Agent 直接写入；
- Base Commit 不变；
- Diff 可查看；
- Artifact 有来源；
- Merge 使用 Expected Commit；
- Conflict 不静默覆盖；
- Dirty Worktree 不自动删除；
- Cleanup 幂等。

Effort：

```text
XL
```

Risk：

```text
High
```

---

# Part XI — Milestone M6: Policy and Approval

## 69. Objective

把安全约束从 Prompt Rule 提升为可执行 Runtime Policy。

---

## 70. Scope

- Principal；
- Action；
- Resource；
- Context；
- Policy Profile；
- Rule；
- Priority；
- Precedence；
- Risk；
- Allow；
- Deny；
- Require Approval；
- Approval Request；
- Grant；
- Exception；
- Unsafe Mode；
- Secret Reference；
- Audit。

---

## 71. Enforcement Points

必须覆盖：

- Process；
- Command；
- Filesystem；
- Network；
- Git；
- Worktree；
- Package；
- Secret；
- Provider；
- Artifact；
- Memory；
- Extension，未来。

---

## 72. Deliverables

- Policy Engine；
- Policy Snapshot；
- Policy Decision；
- Approval Service；
- Approval Queue API；
- Approval UI Foundation；
- Grant；
- Revoke；
- Unsafe Mode；
- Secret Reference Resolver Boundary；
- Policy Simulation；
- Audit Link。

---

## 73. Approval Contract

Approval 必须绑定：

- Decision；
- Action；
- Resource；
- Target；
- Request Hash；
- Version；
- Scope；
- Expiration。

修改 Action 后必须重新评估。

---

## 74. Tests

- Allow；
- Deny；
- Approval；
- Unknown high risk；
- Deny override；
- Grant scope；
- Expiration；
- Approve vs Reject；
- Modified request；
- Unsafe mode；
- Hard deny；
- Secret no-leak；
- Provider native approval bridge。

---

## 75. Exit Gate

- 高风险操作不依赖 Prompt；
- Unknown high risk 不默认 Allow；
- Approval 重启后仍存在；
- Approval 决策幂等；
- 最小 Scope 默认；
- Secret Value 不进入 Event；
- Unsafe Mode 明确；
- Agent 不能伪造 User Approval。

Effort：

```text
L
```

Risk：

```text
High
```

---

# Part XII — Milestone M7: Recovery Hardening

## 76. Objective

让 AgentOS 能在 Server、Provider、Process、Worktree 和 Projection 异常后稳定恢复或稳定失败。

---

## 77. Scope

- Graceful Shutdown；
- Startup Scan；
- Process Reattach；
- Missing Process；
- Orphan Process；
- Approval Restore；
- Queue Restore；
- Worktree Preserve；
- Projection Rebuild；
- Event Gap；
- Artifact Partial；
- Snapshot Corrupt；
- Lock Recovery；
- Outbox Recovery。

---

## 78. Deliverables

- Recovery Manager；
- Recovery Classification；
- Recovery Evidence；
- Recovery Action；
- System Recovery API；
- Recovery Event；
- Recovery Audit；
- Recovery Inspector Foundation；
- Restart Test Harness。

---

## 79. Recovery Rules

- 无法确认不得标记 Completed；
- 优先保留 Worktree；
- Reattach 不创建新 Run；
- Retry 才创建新 Run；
- Destructive Cleanup 需要 Policy；
- Recovery Action 幂等。

---

## 80. Tests

- Server killed at each lifecycle boundary；
- Process alive after server restart；
- Process missing；
- Worktree exists / missing；
- Approval pending；
- Outbox unpublished；
- Projection cursor stale；
- Artifact partial；
- Lock stale；
- unknown state；
- repeated recovery。

---

## 81. Exit Gate

- Server Restart 自动扫描；
- Active Run 有明确分类；
- Orphan 可检测；
- Worktree 被保护；
- Approval 恢复；
- Event Sequence 检查；
- Unknown 不猜测 Success；
- Recovery Result 有 Event 和 Audit。

Effort：

```text
L
```

Risk：

```text
Critical
```

---

# Part XIII — Milestone M8: Memory Foundation

## 82. Objective

建立结构化、可解释、受 Scope 控制的 Memory Runtime。

---

## 83. Scope

- Memory Entry；
- Scope；
- Category；
- Authority；
- Confidence；
- Importance；
- Source；
- Candidate；
- Dedup；
- Conflict；
- Supersession；
- Retrieval；
- FTS；
- Rank；
- Budget；
- Context Snapshot；
- Explanation；
- Extraction。

---

## 84. Foundation Strategy

先使用：

```text
SQLite + FTS5
```

暂不引入：

- Vector Database；
- Remote Embedding Service；
- Autonomous global memory promotion。

---

## 85. Deliverables

- Memory Repository；
- Memory Entry API；
- Candidate API；
- Retrieval Engine；
- Context Builder；
- Context Snapshot；
- Conflict Resolver；
- Inspector Query；
- Prompt Artifact；
- Secret Filter。

---

## 86. Tests

- Scope；
- Pinned；
- FTS；
- Rank；
- Budget；
- Duplicate；
- Conflict；
- Superseded；
- Restricted；
- Candidate accept；
- Import；
- Injection boundary；
- Snapshot reproducibility。

---

## 87. Exit Gate

- Memory 不等于 Conversation History；
- Run 使用 Context Snapshot；
- Selection Reasons 可查看；
- Budget 可验证；
- Imported Memory 标记 Untrusted；
- Secret 不进入 Memory；
- Provider 只收到当前选定 Context。

Effort：

```text
L
```

Risk：

```text
Medium
```

---

# Part XIV — Milestone M9: Conversation Runtime

## 88. Objective

建立持久 Direct Conversation 和 Runtime Projection。

---

## 89. Scope

- Conversation；
- Member；
- Message；
- Block；
- Revision；
- Attachment；
- Mention；
- Agent Turn；
- Read State；
- Summary；
- Search；
- Runtime Projection；
- Direct Agent；
- Task Bridge；
- Run Bridge；
- Streaming；
- Reconnect。

---

## 90. Deliverables

- Conversation Schema；
- Message API；
- Message Sequence；
- Conversation Stream；
- Agent Turn Manager；
- Runtime Projector；
- Run Card Projection；
- Approval Card Projection；
- Artifact Card Projection；
- Direct Agent History；
- Read State；
- Search Foundation。

---

## 91. Message Boundary

```text
Message
  ≠ Prompt
  ≠ Runtime Event
  ≠ Run
```

普通 Send 不自动创建修改型 Run。

---

## 92. Tests

- Create Conversation；
- Send Message；
- Client retry；
- Message sequence；
- Edit revision；
- Mention；
- Direct agent turn；
- Streaming；
- Reconnect；
- Projection duplicate；
- Task bridge；
- Run bridge；
- Read state；
- Archive；
- Recovery。

---

## 93. Exit Gate

- Direct Conversation 持久；
- Message 重试不重复；
- Streaming 可恢复；
- Runtime Card 可重建；
- Approval Card 来自 Approval Resource；
- Agent History 不读取 Native History 作为唯一来源；
- Conversation Archive 不删除 Run。

Effort：

```text
XL
```

Risk：

```text
High
```

---

# Part XV — Milestone M10: UI Foundation

## 94. Objective

建立 Web-first、Tauri-ready 的 Design System 和 App Shell。

---

## 95. Scope

- Design Token；
- Theme；
- Light / Dark；
- Typography；
- Spacing；
- Material；
- Motion；
- Reduced Motion；
- App Shell；
- Navigation Rail；
- Context Sidebar；
- Main Canvas；
- Inspector Panel；
- API Client；
- Runtime Transport；
- Browser Platform Adapter；
- Query Cache；
- Error Boundary；
- Realtime Status。

---

## 96. Framework Rule

现有 Next.js 可以保留，前提：

- Runtime-critical logic 在独立 Server；
- 核心 UI Client-side 可运行；
- API Base 可配置；
- 不依赖 Next API 执行 Runtime；
- 可适配未来静态 Host / Tauri WebView。

---

## 97. Deliverables

- `packages/ui`；
- `packages/api-client`；
- `packages/platform`；
- App Shell；
- Token Story / Preview；
- Primitive Components；
- Layout Components；
- Browser Adapter；
- Realtime Client；
- API Error Mapping；
- UI Preference。

---

## 98. Tests

- Light / Dark；
- Keyboard；
- Focus；
- Reduced Motion；
- Reduced Transparency；
- Responsive；
- Error；
- Reconnect；
- Token completeness；
- Visual regression；
- No direct fetch in Domain Component；
- No Tauri global branch。

---

## 99. Exit Gate

- App Shell 稳定；
- UI 只通过 API Client；
- Browser Disconnect 不取消 Run；
- Platform Adapter 已定义；
- Artifact 使用 ID；
- Glass 仅功能层；
- Keyboard 可用；
- Status 不只靠颜色；
- Foundation 可被 Conversation 和 Workbench 复用。

Effort：

```text
L
```

Risk：

```text
Medium
```

---

# Part XVI — Milestone M11: Direct Conversation UI

## 100. Objective

完成用户与单个 Agent 的主要协作入口。

---

## 101. Scope

- Agent List；
- Conversation List；
- Header；
- Message Timeline；
- Composer；
- Streaming Block；
- Tool Card；
- Command Card；
- File Card；
- Run Card；
- Approval Card；
- Artifact Card；
- Agent History Entry；
- Search；
- Draft。

---

## 102. Apple Interaction Requirements

- pointer-down 即时反馈；
- Panel 动画可打断；
- 默认无 Bounce；
- Streaming 不抢 Scroll；
- Source-anchored Popover；
- Reduced Motion；
- 克制 Material。

---

## 103. Tests

- 10k Message；
- Streaming；
- User scroll；
- Reconnect；
- Draft；
- Attachment；
- Mention；
- Create Task；
- Start Run；
- Approval；
- Error；
- Keyboard；
- XSS；
- Trusted system card。

---

## 104. Exit Gate

- Direct Agent 可用；
- Chat / Task / Run 模式明确；
- Tool 不拼纯文本；
- Agent 与 Provider 分离；
- Run Card 可进入 Workbench / Inspector；
- Approval 不可被 Markdown 伪造；
- 大历史性能通过。

Effort：

```text
L
```

Risk：

```text
Medium
```

---

# Part XVII — Milestone M12: Task/Run Workbench and Runtime Inspector

## 105. Objective

把 Task、Run、Stage、Worktree 和 Runtime Fact 变成完整工程工作台。

---

## 106. Scope

- Task List；
- Task Detail；
- Run Selector；
- Attempt Tree；
- Stage Graph；
- Runtime Timeline；
- Event Viewer；
- Process Tree；
- Provider Session；
- Worktree；
- Diff；
- Review；
- Result；
- Memory Context；
- Policy Trace；
- Artifact；
- Recovery；
- Audit。

---

## 107. Deliverables

- Workbench Route；
- Run Inspector Query；
- Overview；
- Stage Graph；
- Timeline；
- Event Cursor；
- Process Output；
- Worktree Diff；
- Merge Readiness；
- Approval Control；
- Recovery Inspector；
- Debug Bundle。

---

## 108. Tests

- Multi-run Task；
- Retry tree；
- 100k Event；
- Sequence gap；
- Process tree；
- Large output；
- Large diff；
- Memory explanation；
- Policy trace；
- Recovery；
- Partial query；
- Restricted section；
- Low-end Windows browser。

---

## 109. Exit Gate

- 用户可以回答 Run 正在做什么；
- 用户可以回答为什么；
- 用户可以找到执行时配置；
- 用户可以查看代码变化；
- 用户可以暂停、取消、重试；
- 用户可以安全批准；
- 用户可以恢复或稳定失败；
- Inspector 不直接执行 Runtime Action。

Effort：

```text
XL
```

Risk：

```text
High
```



# Part XVIII — Milestone M13: Group Conversation

## 110. Objective

建立受控的多 Agent 群聊，而不是无限自治循环。

---

## 111. Scope

- Group Conversation；
- Member Role；
- Reply Mode；
- Mention；
- Orchestrator Turn；
- Sequential；
- Parallel；
- Discussion；
- Reply Budget；
- Hop Limit；
- Loop Guard；
- Cancel；
- Summary；
- Group Memory Scope。

---

## 112. Deliverables

- Group Member API；
- Reply Policy；
- Orchestrator Service；
- Turn Budget；
- Parallel Turn Coordination；
- Group UI；
- Agent Status；
- Group History；
- Group Recovery。

---

## 113. Tests

- Mention one；
- Mention all；
- Sequential；
- Parallel；
- Agent failure；
- Cancel；
- Reply budget；
- Loop detection；
- Duplicate turn；
- Restart；
- Approval during group；
- Create workflow run。

---

## 114. Exit Gate

- Agent 不会无限互相回复；
- User 可以随时停止；
- Orchestrator Decision 可解释；
- Group Chat 不隐式修改代码；
- 修改型协作进入 Workflow Run；
- 每个 Agent 保持独立上下文；
- Group Memory 不自动提升 Global。

Effort：

```text
L
```

Risk：

```text
High
```

---

# Part XIX — Milestone M14: Workflow Collaboration

## 115. Objective

让多 Agent 协作通过 Workflow、Stage 和 Worktree 明确表达。

---

## 116. Scope

- Workflow Editor Foundation；
- DAG Validation；
- Role Assignment；
- Agent Selector；
- Provider Override；
- Parallel Stage；
- Join；
- Review Stage；
- Integration Worktree；
- Output Contract；
- Retry from Stage；
- Compare Runs。

---

## 117. Built-in Workflow

Foundation：

```text
Single Agent

Plan
→ Implement
→ Review

Parallel Provider Comparison

Security Gate
```

v1 固定四阶段转为 Template：

```text
codex_manager
kimi_worker
opencode_reviewer
codex_final_review
```

不再是核心类型。

---

## 118. Tests

- DAG；
- Invalid cycle；
- Parallel；
- Join；
- Failed stage；
- Retry stage；
- Worktree isolation；
- Integration；
- Output contract；
- Provider switch；
- Review changes requested。

---

## 119. Exit Gate

- Workflow 不等于 Runtime；
- Stage Key 不等于固定 Agent；
- 每个 Stage 使用 Snapshot；
- Parallel 修改有隔离；
- Join 有明确规则；
- Review Changes 创建 Child Run；
- Workflow 可通过 API 验证。

Effort：

```text
XL
```

Risk：

```text
High
```

---

# Part XX — Milestone M15: Provider Comparison

## 120. Objective

提供公平、可追踪的 Provider / Agent 执行比较。

---

## 121. Scope

- Common Task；
- Common Base Commit；
- Common Acceptance Criteria；
- Separate Runs；
- Provider Override；
- Usage；
- Duration；
- Result；
- Diff；
- Test；
- Review；
- Compare UI。

---

## 122. Fairness Rules

比较必须明确：

- 是否使用相同 Agent；
- 是否使用相同 Prompt Builder；
- 是否使用相同 Memory Context；
- 是否使用相同 Policy；
- 是否使用相同 Base Commit；
- 是否允许不同 Tool Capability。

---

## 123. Exit Gate

- 每个比较对象是独立 Run；
- 不共享可变 Worktree；
- 结果可追踪；
- 成本和 Usage 标明数据完整性；
- 用户可以选择接受某个 Run；
- 比较不覆盖历史。

Effort：

```text
M
```

Risk：

```text
Medium
```

---

# Part XXI — Milestone M16: Agent History and Search

## 124. Objective

让持久 Agent Profile 拥有统一的 AgentOS 历史。

---

## 125. Scope

- Direct Conversations；
- Group Membership；
- Messages；
- Tasks；
- Runs；
- Provider Sessions；
- Artifacts；
- Memory；
- Failures；
- Usage；
- Search；
- Filter；
- Saved View。

---

## 126. Exit Gate

- Agent History 不按 Provider 分裂身份；
- Native Session 只是 Reference；
- 历史可链接 Run 和 Artifact；
- Search 受 Workspace 与权限限制；
- 归档内容可查；
- Secret 不进入 Search Index。

Effort：

```text
M
```

Risk：

```text
Medium
```

---

# Part XXII — Milestone M17: Performance and Accessibility

## 127. Objective

让 AgentOS 在真实规模和低性能 Windows 设备上保持可用。

---

## 128. Scope

- Virtualization；
- Streaming Batch；
- Worker；
- Large Diff；
- Event Pagination；
- FTS；
- Lazy Artifact；
- Memory；
- CPU / RAM；
- Keyboard；
- Screen Reader；
- Contrast；
- Reduced Motion；
- Reduced Transparency；
- Zoom；
- Responsive。

---

## 129. Performance Dataset

至少：

- 100k Runtime Events；
- 10k Messages；
- 10k Memories；
- 10k Artifacts；
- Large Diff；
- 100 Processes；
- 20 Concurrent Runs；
- 20 Events/sec；
- 1 GB Raw Artifact，metadata-only path。

---

## 130. Exit Gate

- Inspector p95 达标；
- Conversation Scroll 稳定；
- Streaming 不逐 Token 全局 Render；
- Keyboard 主流程完整；
- 200% Zoom 可用；
- Dark / Light 对比通过；
- Reduced Motion 无大位移；
- Low-end 设备 Smoke 通过。

Effort：

```text
L
```

Risk：

```text
Medium
```

---

# Part XXIII — Milestone M18: Extension Foundation

## 131. Objective

建立可控的 Extension Runtime，而不是直接开放任意插件代码。

---

## 132. Scope

- Extension Manifest；
- Version；
- Installation；
- Trust；
- Permission；
- Policy；
- Provider Adapter Extension；
- Event Processor；
- Artifact Processor；
- UI Panel Boundary；
- Command；
- Enable / Disable；
- Upgrade。

---

## 133. Excluded

当前不做：

- 公共插件市场；
- 自动下载未知代码；
- 无审核 Native Binary；
- Extension 绕过 Policy；
- Extension 直接写数据库。

---

## 134. Exit Gate

- Extension Permission 可审查；
- 升级新增权限需重新批准；
- Extension 可禁用；
- Event Processor 幂等；
- UI Panel 被隔离；
- Extension 不拥有 Runtime Source of Truth。

Effort：

```text
L
```

Risk：

```text
High
```

---

# Part XXIV — Milestone M19: Backup, Import and Export

## 135. Objective

让本地长期数据可备份、恢复和迁移。

---

## 136. Scope

- SQLite Backup；
- Artifact Manifest；
- Artifact Files；
- Workspace Metadata；
- Policy；
- Memory；
- Conversation；
- Extension Metadata；
- Secret Store Separate；
- Integrity；
- Import；
- v1 Migration；
- Export Bundle。

---

## 137. Exit Gate

- Backup 在运行状态下安全；
- Restore 有版本检查；
- Artifact Checksum 验证；
- Secret 不混入普通 Bundle；
- v1 Import 幂等；
- Legacy ID Map 可追踪；
- Restore Drill 通过。

Effort：

```text
L
```

Risk：

```text
High
```

---

# Part XXV — Milestone M20: Security Hardening

## 138. Objective

对完整产品路径进行系统安全验收。

---

## 139. Scope

- Authentication；
- CSRF；
- CORS；
- Workspace Boundary；
- Path Traversal；
- Symlink / Junction；
- Shell Injection；
- SSRF；
- Markdown XSS；
- Secret Redaction；
- Approval Impersonation；
- Extension Permission；
- Audit；
- Dependency；
- Update；
- Debug Bundle。

---

## 140. Exit Gate

- 无认证模式仅 Loopback；
- Cookie 模式有 CSRF；
- Cross Workspace 被阻止；
- Path Escape 被阻止；
- Secret 不进入 Event / Log / UI；
- Agent Markdown 不能伪造系统控制；
- SSRF 防护通过；
- Security Test Suite 进入 CI。

Effort：

```text
L
```

Risk：

```text
Critical
```

---

# Part XXVI — Milestone M21: Web-local Release

## 141. Objective

提供可日常使用的本地 Web 版本。

---

## 142. Scope

- Stable Start Script；
- Stable Server；
- Browser Launch；
- Data Directory；
- Logging；
- Health；
- Ready；
- Upgrade；
- Backup Prompt；
- Release Notes；
- Diagnostics；
- Installer / Launcher，非 Tauri，可选；
- Documentation。

---

## 143. Exit Gate

- 新用户安装路径明确；
- Provider Setup 可完成；
- Stable Mode 不因 Watch 意外重启；
- Server Crash 可诊断；
- 数据目录明确；
- Upgrade 前备份；
- Foundation E2E 全通过；
- v1 Path 可关闭；
- Release Notes 完整。

Effort：

```text
M
```

Risk：

```text
Medium
```

---

# Part XXVII — Milestones M22–M25: Future Tauri Desktop

## 144. M22 — Tauri Host

- `apps/desktop`；
- Tauri Window；
- Load Web Build；
- Platform Capability；
- Native Menu；
- Window Lifecycle。

## 145. M23 — Sidecar Packaging

- AgentOS Server Executable；
- Start；
- Ready；
- Port；
- Session Token；
- Shutdown；
- Crash Recovery；
- Data Directory。

## 146. M24 — Native Platform Adapter

- File Dialog；
- Reveal；
- Open Native；
- Notification；
- Tray；
- Shortcut；
- Clipboard；
- Deep Link。

## 147. M25 — Desktop Update and Recovery

- Auto Update；
- Signature；
- Rollback；
- Schema Compatibility；
- Sidecar Update；
- Data Backup；
- Installer；
- Windows Validation。

### Desktop Exit Gate

- 不修改 Runtime Domain API；
- Web UI 直接复用；
- Browser Adapter 仍可用；
- Sidecar Token 不泄露；
- Update Failure 可回退；
- SQLite / Artifact 数据不丢失。

Overall Effort：

```text
XL
```

Risk：

```text
High
```

---

# Part XXVIII — Migration Plan

## 148. v1 to v2 Component Mapping

| v1 | v2 |
|---|---|
| Task execution | Task + Run |
| Fixed pipeline | Workflow Definition |
| AgentRunner | Run Engine + Workflow Executor |
| CLIExecutor | Provider Adapter + Process Manager |
| stdout status | Runtime Event + Raw Artifact |
| JSON persistence | SQLite Repository |
| Task outputs | Stage + Event + Artifact |
| Browser-owned SSE | Durable Run + resumable stream |
| Shared workspace | Run Worktree |
| Prompt rules | Policy Runtime |
| text history | Conversation + Message + Projection |
| ad-hoc memory | Memory Entry + Context Snapshot |

---

## 149. Compatibility Layer

Compatibility Layer 必须：

- 有明确 Owner；
- 有 Deprecation；
- 有 Metric；
- 有 Removal Gate；
- 不成为永久新架构。

---

## 150. Feature Flags

建议：

```text
storage.sqlite_v2
runtime.run_engine_v2
events.event_store_v2
process.process_runtime_v2
providers.provider_adapter_v2
worktree.isolation_v2
policy.runtime_v2
memory.runtime_v2
conversation.runtime_v2
ui.shell_v2
ui.workbench_v2
ui.inspector_v2
```

---

## 151. Cutover Strategy

每个 Domain：

```text
Implement new path
  ↓
Shadow read / compare
  ↓
Enable for test workspace
  ↓
Migrate data
  ↓
Enable default
  ↓
Observe
  ↓
Disable legacy write
  ↓
Remove legacy path
```

---

## 152. Dual Write

默认避免长期 Dual Write。

如果临时使用：

- 定义 Primary；
- 写入顺序；
- Failure；
- Reconciliation；
- Removal Date；
- Metrics。

---

## 153. Data Migration

迁移必须：

- 幂等；
- 可重试；
- 有 Legacy Map；
- 有 Checksum；
- 有 Backup；
- 有 Dry Run；
- 有 Report；
- 不静默丢字段。

---

## 154. API Migration

旧 Endpoint：

- 保留 Compatibility；
- 返回 Deprecation；
- 内部调用 v2 Service；
- 不维护第二套执行模型。

---

## 155. UI Migration

```text
Old Pipeline Page
  ↓
v2 API Client
  ↓
Run Card
  ↓
Workbench
  ↓
Inspector
```

新旧 UI 不应各自解释不同 Runtime State。

---

# Part XXIX — Multi-Agent Development Strategy

## 156. Worktree per Work Package

每个独立 Work Package 使用：

```text
branch
+ worktree
+ owner
+ plan
+ acceptance
```

---

## 157. Recommended Branch Names

```text
runtime/storage-foundation
runtime/event-store
runtime/process-manager
providers/kimicode-direct
git/worktree-foundation
security/policy-runtime
memory/memory-foundation
conversation/direct-runtime
ui/design-system
ui/runtime-inspector
migration/v1-task-run
```

---

## 158. Ownership Document

每个 Worktree 建议包含：

```text
WORKPLAN.md
```

内容：

- Goal；
- Files；
- Interfaces；
- Dependencies；
- Out of Scope；
- Tests；
- Exit Gate；
- Integration Notes。

---

## 159. Agent Roles

建议：

### Architect

- Contract；
- Boundary；
- Review；
- Integration Decision。

### Implementer

- Code；
- Unit Test；
- Migration；
- Local Verification。

### Reviewer

- Spec Conformance；
- Security；
- Concurrency；
- Error；
- Test Gap。

### Integrator

- Merge；
- Conflict；
- E2E；
- Release Gate。

角色不是 Provider 名称。

---

## 160. Parallel Work Rule

可并行条件：

- 文件所有权不同；
- API 已冻结；
- Fixture 已冻结；
- 无共享 Migration Number；
- 无共享 Export 修改；
- Integration Order 已定。

---

## 161. Integration Worktree

复杂多分支组合使用 Integration Worktree。

流程：

```text
feature worktrees
  ↓
review
  ↓
integration worktree
  ↓
combined tests
  ↓
target branch
```

---

## 162. No Direct Parallel Main Edits

多个修改型 Agent 不应直接共享 Main Workspace。

例外必须显式 Approval。



# Part XXX — Quality Gates

## 163. Gate A — Contract Ready

Required:

- Spec；
- DTO；
- Event；
- Error；
- Migration；
- Test Fixture；
- Owner；
- Out of Scope。

未通过 Gate A 不应启动大规模并行实现。

---

## 164. Gate B — Implementation Complete

Required:

- Code；
- Unit Test；
- Type Check；
- Lint；
- Migration；
- Local Smoke；
- No Known Critical TODO。

---

## 165. Gate C — Integration Verified

Required:

- Contract Test；
- Integration Test；
- Recovery Test；
- Security Test，按需；
- Cross-platform Test，按需；
- `git diff --check`；
- No unrelated changes。

---

## 166. Gate D — Product Acceptance

Required:

- User Flow；
- Error Recovery；
- UI；
- Accessibility；
- Performance；
- Documentation；
- Upgrade；
- Rollback；
- Acceptance Report。

---

## 167. Gate E — Default Cutover

Required:

- Feature Flag；
- Metrics；
- Migration Complete；
- Legacy Read Comparison；
- No Critical Regression；
- Rollback Path；
- User Data Backup。

---

## 168. Gate F — Legacy Retirement

Required:

- No active caller；
- Compatibility Metrics near zero；
- Data migrated；
- Documentation updated；
- Old tests removed or replaced；
- Release Note；
- Removal commit reviewed。

---

# Part XXXI — Testing Strategy

## 169. Test Pyramid

```text
Unit
  ↓
Contract
  ↓
Integration
  ↓
Recovery / Concurrency
  ↓
End-to-end
  ↓
Manual Product Review
```

---

## 170. Required Foundation E2E

```text
Workspace
→ Task
→ Run
→ Snapshot
→ Worktree
→ Memory Context
→ Provider Session
→ Process
→ Runtime Events
→ Artifact
→ Review
→ Merge
→ Task Acceptance
```

---

## 171. Required Failure E2E

- Provider Auth Required；
- Executable Missing；
- Process Crash；
- Idle Timeout；
- Cancel；
- Approval Required；
- Approval Reject；
- Server Restart；
- Process Orphan；
- Worktree Conflict；
- Artifact Failure；
- Event Gap；
- Migration Failure。

---

## 172. Required Concurrency E2E

- Cancel vs Complete；
- Approve vs Reject；
- Retry duplicate；
- Merge vs Cleanup；
- Two clients edit same Agent；
- Parallel Stage；
- Message sequence；
- Event sequence；
- Outbox duplicate；
- Recovery repeated。

---

## 173. Windows Priority

当前主要本地环境为 Windows 时，Foundation 必须优先验证：

- Job Object；
- `taskkill` fallback；
- Path；
- Junction；
- PowerShell；
- CLI Encoding；
- ANSI；
- Long Path；
- File Lock；
- Git Worktree；
- Process Reattach；
- Installer / Stable Start。

---

## 174. Cross-platform Timing

macOS / Linux 支持不应阻塞 Windows Foundation，但：

- 接口必须跨平台；
- 不把 Windows 命令写入 Domain；
- Platform Adapter 明确；
- POSIX Process Group 有测试计划；
- Path 通过抽象。

---

# Part XXXII — CI and Release

## 175. CI Stages

建议：

```text
format
lint
typecheck
unit
schema
contract
integration
security
build
e2e
artifact
```

---

## 176. Schema CI

每个 PR：

- Migration checksum；
- Clean DB migrate；
- Previous schema migrate；
- Foreign key；
- Integrity；
- Generated schema diff；
- No edited immutable migration。

---

## 177. OpenAPI CI

- Validate；
- Breaking change；
- Generate TS SDK；
- Compile SDK；
- Contract fixture；
- Error schema；
- Operation ID stability。

---

## 178. Event CI

- Event schema；
- Version；
- Payload size；
- Secret scan；
- Replay fixture；
- Unknown event fallback；
- Terminal fact coverage。

---

## 179. UI CI

- Component Test；
- Visual Regression；
- Accessibility；
- Bundle；
- Route；
- Static host compatibility；
- No forbidden direct Runtime import；
- No Tauri global in Domain UI。

---

## 180. Release Artifact

Web-local Release 应包含：

- Server Build；
- Web Build；
- Migration；
- Default Config；
- Provider Setup Guide；
- Start Script；
- Diagnostics；
- Release Note；
- Backup Guide；
- Checksums。

---

# Part XXXIII — Metrics and Success Criteria

## 181. Runtime Reliability

监控：

- Run success；
- Run failure；
- Recovery required；
- Recovery success；
- Cancel latency；
- Orphan count；
- Worktree cleanup；
- Event gap；
- Outbox lag；
- DB busy。

---

## 182. Provider Reliability

- Validation success；
- Auth required；
- Session start；
- Session crash；
- Error code；
- Process exit；
- Resume；
- Output parse fallback；
- Provider version。

---

## 183. Product Usability

- Task creation；
- Run start；
- Time to first event；
- Approval wait；
- Inspector open；
- Error recovery；
- Retry；
- Merge；
- Search；
- Conversation reconnect。

不得记录 Prompt 内容。

---

## 184. Performance

- API p95；
- Inspector p95；
- Event append；
- SSE delivery；
- Streaming render；
- Long task；
- Timeline frame；
- DB size；
- WAL；
- Artifact read；
- Memory FTS。

---

## 185. Migration Metrics

- Legacy endpoint calls；
- Legacy JSON reads；
- Compatibility adapter usage；
- Migration success；
- Migration failure；
- Reconciliation mismatch；
- Feature flag adoption。

---

# Part XXXIV — Risk Register

## 186. Risk: Architecture Scope Too Large

Impact：

```text
Critical
```

Mitigation：

- Release slices；
- Exit Gates；
- Foundation Non-goals；
- no Tauri；
- no plugin market；
- no vector DB。

---

## 187. Risk: Persistent Model and Runtime Diverge

Mitigation：

- Repository ownership；
- state transition tests；
- Event + State transaction；
- Inspector compare；
- recovery scan；
- no second truth。

---

## 188. Risk: Windows Process Cancellation

Mitigation：

- Job Object；
- Process Group abstraction；
- identity token；
- integration test；
- taskkill fallback；
- orphan scan。

---

## 189. Risk: Provider CLI Instability

Mitigation：

- Adapter boundary；
- validation；
- version recording；
- raw artifact；
- fallback parser；
- canonical error；
- capability detection。

---

## 190. Risk: Worktree Data Loss

Mitigation：

- preserve by default；
- base commit；
- expected commit；
- dirty guard；
- artifact diff；
- approval for force cleanup；
- recovery evidence。

---

## 191. Risk: Prompt-only Security

Mitigation：

- Policy Runtime；
- enforcement point；
- approval resource；
- secret reference；
- audit；
- hard deny。

---

## 192. Risk: UI Built Before Durable Runtime

Mitigation：

- Mock only for component development；
- no product completion claim；
- integrate against v2 API；
- Runtime gates before Workbench release。

---

## 193. Risk: Long Dual-write Migration

Mitigation：

- one primary；
- bounded compatibility；
- migration jobs；
- metrics；
- removal milestone。

---

## 194. Risk: Multi-Agent Merge Conflict

Mitigation：

- worktree ownership；
- contract freeze；
- integration worktree；
- no parallel shared-core edits；
- reviewer；
- combined tests。

---

## 195. Risk: Documentation Drift

Mitigation：

- Spec link in PR；
- code owner；
- contract test；
- ADR；
- roadmap status evidence；
- docs update in feature DoD。

---

# Part XXXV — Foundation Non-goals

## 196. Not in R1/R2

- Public Plugin Marketplace；
- Cloud Multi-tenancy；
- Distributed Scheduler；
- Mobile App；
- Tauri Desktop；
- Rust Runtime Rewrite；
- Autonomous Endless Group Chat；
- Advanced Vector Database；
- Billing；
- Team Organization RBAC；
- Remote Worker Fleet；
- Cross-device Sync；
- Marketplace Revenue System。

---

## 197. Why These Are Deferred

它们会显著扩大：

- Security；
- Distribution；
- Upgrade；
- Data Consistency；
- Support；
- Testing；
- Product Scope。

只有核心 Runtime 被真实使用和验证后，才应进入。

---

# Part XXXVI — Recommended Immediate Execution Order

## 198. First Work Package

```text
M1 Repository Audit and Test Baseline
```

原因：

- 规格已经足够；
- 代码真实状态需要确认；
- Roadmap 不应从猜测开始；
- 能防止重复开发已有能力。

---

## 199. Second Work Package

```text
M2 Storage and Domain Core
```

先完成：

1. Migration Runner；
2. Workspace；
3. Task；
4. Run；
5. Stage；
6. Snapshot；
7. Version；
8. Idempotency。

---

## 200. Third Work Package

```text
M3 Lifecycle and Event Foundation
```

先完成一条最小垂直链：

```text
Create Task
→ Create Run
→ Start Mock Stage
→ Append Event
→ SSE
→ Complete Run
→ Reload
```

---

## 201. Fourth Work Package

```text
M4 Process + one Provider
```

只先接：

```text
KimiCode Direct
```

或选择当前最稳定 Provider 作为 Vertical Slice。

但 KimiCode 的 Provider Identity 必须正确。

---

## 202. Fifth Work Package

```text
M5 one Worktree vertical slice
```

```text
Run
→ Worktree
→ Process cwd
→ file change
→ diff artifact
→ review
→ cleanup
```

---

## 203. Avoid Early Broad Provider Matrix

错误：

```text
Codex
Claude Code
KimiCode
OpenCode
Gemini
Custom
```

同时接入但没有稳定 Process Runtime。

正确：

```text
one provider end-to-end
  ↓
second provider proves adapter
  ↓
remaining providers
```

---

## 204. UI Parallel Start

在 M2/M3 Contract 冻结后，可以并行启动：

```text
M10 UI Foundation
```

但只完成：

- Tokens；
- Shell；
- Static Component；
- API Client Interface；
- Browser Adapter。

不要用 Mock 宣称 Workbench 完成。

---

# Part XXXVII — Roadmap Management

## 205. Milestone Record

每个 Milestone 建议维护：

```markdown
# Milestone Mx

Status:
Owner:
Branch:
Worktree:
Dependencies:
Started:
Verified:
Release:

## Scope
## Deliverables
## Tests
## Risks
## Decisions
## Exit Gate Evidence
```

---

## 206. Status Update Rule

状态变化必须附 Evidence：

```text
in_progress
  → branch + owner

implemented
  → commit + tests

verified
  → acceptance report

released
  → release version + default flag
```

---

## 207. Roadmap Change

重大变更需要 ADR：

- Change Domain Boundary；
- New Database；
- Replace Process Runtime；
- Replace REST；
- Rust Rewrite；
- Tauri becomes required；
- Cloud-first；
- Multi-tenant；
- Provider Identity change。

---

## 208. Scope Review

每个 Milestone 开始前检查：

1. 是否仍符合 Vision？
2. 是否有更低成本 Vertical Slice？
3. 是否依赖未完成 Contract？
4. 是否可以推迟？
5. 是否引入第二套真相？
6. 是否影响 Migration？
7. 是否有 Recovery？
8. 是否有 Test？

---

# Part XXXVIII — Definition of Done

## 209. Roadmap DoD

Roadmap 可执行必须满足：

1. 00–14 Specification 完整。
2. 每个 Release 有目标。
3. 每个 Milestone 有 Scope。
4. 每个 Milestone 有 Exit Gate。
5. Critical Path 明确。
6. Parallel Track 明确。
7. Shared-core Conflict Zone 明确。
8. v1 Migration 有映射。
9. Compatibility Layer 有退出策略。
10. Feature Flag 有命名。
11. Storage 在 Provider 前。
12. Event 在 UI Timeline 前。
13. Process Runtime 在多 Provider 前。
14. Worktree 在并行修改前。
15. Policy 在复杂自治前。
16. Recovery 在默认发布前。
17. Conversation 不阻塞 Foundation Runtime。
18. UI Foundation 可与 Runtime Contract 后并行。
19. Workbench 依赖 Durable Run。
20. Inspector 依赖 Event 和 Query Model。
21. Group Chat 在 Direct Conversation 后。
22. Extension 在 Core Product 后。
23. Tauri 在 Web 稳定后。
24. Rust Rewrite 不在当前 Roadmap。
25. 每个 Milestone 有测试要求。
26. 每个 Milestone 有风险。
27. 每个 Cutover 可回退。
28. Legacy Retirement 有 Gate。
29. 数据迁移幂等。
30. Secret 不进入普通迁移 Bundle。
31. Windows Process 是 Foundation 验证重点。
32. 多 Agent 开发使用 Worktree。
33. 共享核心不无协调并行修改。
34. Integration Worktree 有定义。
35. Release 有 Backup。
36. Release 有 Diagnostics。
37. Status 必须有 Evidence。
38. Mock 不等于 Verified。
39. 文档完成不等于实现完成。
40. Roadmap 不使用未经验证的日期承诺。

---

# Part XXXIX — Global Roadmap Invariants

## 210. Invariants

AgentOS v2 Roadmap 必须始终满足：

1. 不整仓推倒重写。
2. 不长期维护两个 Runtime。
3. 不把 Task 与 Run 重新合并。
4. 不把 Agent 与 Provider 重新合并。
5. 不把 Run 与 Process 重新合并。
6. 不让 Browser 拥有 Run。
7. 不用 stdout 作为唯一事实。
8. 不让 Retry 覆盖历史 Run。
9. 不让 Run Completion 自动 Merge。
10. 不让 Prompt Rule 替代 Policy。
11. 不在 Foundation 引入 Tauri。
12. 不在 Foundation 重写 Rust Runtime。
13. 不在 Worktree 前开放并行修改。
14. 不在 Policy 前开放高风险自治。
15. 不在 Recovery 前默认长期运行。
16. 不在 Durable Event 前构建权威 Inspector。
17. 不在 Direct Conversation 前构建复杂群聊。
18. 不在 API Contract 冻结前大规模并行。
19. 不把 Mock 标记为 Released。
20. 不无测试修改 State Machine。
21. 不无 Migration 修改 Schema。
22. 不无 Event 修改重大 Runtime 状态。
23. 不无 Audit 执行高风险 Admin Action。
24. 不无 Backup 执行破坏性数据迁移。
25. 不无 Expected Commit 执行 Merge。
26. 不自动删除未知 Worktree。
27. 不猜测 Recovery Success。
28. 不让 Extension 绕过 Policy。
29. 不让 Tauri Command 替代 Runtime API。
30. 不让 UI 直接执行 CLI。
31. 每个 Milestone 必须可独立验收。
32. 每个 Release 必须可回退。
33. 每个 Legacy Path 必须有退休条件。
34. 每个 Status 必须有证据。
35. 每个并行 Worktree 必须有 Owner。
36. 每个共享 Contract 必须先冻结。
37. 每个失败必须有稳定 Error。
38. 每个重要产物必须可追踪。
39. 每个 Roadmap 变更必须保持 Vision。
40. 先完成最小垂直链，再扩大矩阵。

---

# Part XL — Final Roadmap

## 211. Final Definition

AgentOS v2 的实施路线定义如下：

```text
R0 Architecture Baseline
  ↓
R1 Runtime Foundation
  ↓
R2 Safe Engineering Execution
  ↓
R3 Collaboration Workbench
  ↓
R4 Multi-Agent Collaboration
  ↓
R5 Productization
  ↓
R6 Future Tauri Desktop
```

最小 Critical Path：

```text
Repo Audit
  ↓
SQLite + Task / Run
  ↓
Event Store + Run Lifecycle
  ↓
Process Runtime + One Provider
  ↓
Worktree + Artifact
  ↓
Policy + Approval
  ↓
Recovery
  ↓
Conversation
  ↓
Web Workbench
  ↓
Runtime Inspector
```

实施原则：

> 先证明一条完整、持久、安全、可恢复的单 Agent 工程执行链，再扩展 Provider、群聊、插件和桌面客户端。

第一个真正的 v2 Vertical Slice 应是：

```text
User creates Task
  ↓
Run created
  ↓
Snapshot persisted
  ↓
Worktree created
  ↓
Memory Context selected
  ↓
Policy evaluated
  ↓
Provider Session started
  ↓
Process managed
  ↓
Runtime Events persisted
  ↓
Artifact produced
  ↓
User reviews
  ↓
Merge executed separately
  ↓
Task accepted
  ↓
Server restart still reconstructs history
```

本文件是 AgentOS v2 从现有 v1 系统迁移到统一 Runtime、Conversation Workbench、Runtime Inspector 和未来 Tauri Desktop 的总实施依据。
