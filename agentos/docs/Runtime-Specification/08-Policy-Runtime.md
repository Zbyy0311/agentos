# AgentOS Runtime Specification v2.0

## 08 — Policy Runtime

> Status: Draft  
> Version: 2.0  
> Last Updated: 2026-07-19  
> Scope: AgentOS v2 Runtime Policy, Authorization and Approval Decision Engine  
> Depends On:
> - `00-Vision.md`
> - `01-Core-Concepts.md`
> - `02-Runtime-Lifecycle.md`
> - `03-Event-Model.md`
> - `04-Provider-Specification.md`
> - `05-Process-Runtime.md`
> - `06-Worktree-Runtime.md`
> - `07-Memory-Runtime.md`
> Repository: `Zbyy0311/agentos`

---

## 1. Document Purpose

本文件定义 AgentOS v2 的 Policy Runtime。

Policy Runtime 是 AgentOS 中负责执行授权、风险判断、资源访问控制、审批决策、临时授权、策略快照、审计与运行时强制执行的安全控制层。

它规定：

- Policy 的定义和边界；
- Action Model；
- Resource Model；
- Principal；
- Policy Rule；
- Policy Profile；
- Policy Scope；
- Rule Priority；
- Rule Precedence；
- Allow；
- Deny；
- Require Approval；
- Risk Level；
- Policy Evaluation；
- Runtime Enforcement；
- Provider Native Approval Bridge；
- Approval Request；
- Grant；
- Exception；
- Unsafe Mode；
- Read-only Mode；
- Secret Access；
- Command；
- File；
- Network；
- Git；
- Worktree；
- Package Installation；
- Process；
- Extension；
- Memory；
- Artifact；
- Policy Snapshot；
- Policy Version；
- Cache；
- Audit；
- Simulation；
- Testing；
- SQLite Schema；
- API；
- Inspector；
- v1 迁移。

本文件的目标是确保：

> AgentOS 中的安全约束由 Runtime 强制执行，而不是仅依赖 Prompt 中的行为建议。

---

## 2. Policy Runtime Positioning

AgentOS v2 的执行控制链：

```text
Agent / Provider / User / Extension requests an action
        ↓
Action Normalizer
        ↓
Policy Context Builder
        ↓
Policy Engine
  ├── allow
  ├── deny
  └── require_approval
        ↓
Runtime Enforcement Point
        ↓
Process / File / Network / Git / Secret / Worktree / Artifact
        ↓
Runtime Event + Audit Record
```

Policy Runtime 位于所有高风险行为之前。

它不是事后日志分析器。

---

## 3. Core Principles

### 3.1 Policy Is Not Prompt Guidance

Prompt Guidance：

```text
不要删除重要文件。
```

Runtime Policy：

```text
action = file.delete
resource outside worktree
→ deny
```

Prompt 可以影响 Agent 决策。

Policy 必须控制 Runtime 能否执行。

### 3.2 Default Deny for Unknown High-Risk Actions

未知的高风险 Action 不应默认放行。

```text
unknown + high risk
→ require approval or deny
```

### 3.3 Deny Overrides Allow

如果同一 Action 同时命中 Allow 和 Deny：

```text
deny wins
```

除非存在明确、受限且版本化的 Exception Grant。

### 3.4 Specific Rule Beats General Rule

更具体的 Resource、Scope 和 Principal Rule 优先于宽泛 Rule。

### 3.5 Runtime Must Enforce

Policy Engine 只返回 Decision。

真正阻止或执行 Action 的是对应 Enforcement Point：

- Process Runtime；
- Worktree Runtime；
- Git Runtime；
- Secret Runtime；
- Network Runtime；
- Artifact Runtime；
- Extension Runtime。

### 3.6 Every Decision Is Auditable

每次关键 Policy Evaluation 必须可追踪：

- 谁请求；
- 请求什么；
- 作用于什么资源；
- 命中哪些 Rule；
- 为什么允许或拒绝；
- 是否需要 Approval；
- 最终是否执行。

### 3.7 Approval Is Not a Permanent Bypass

一次 Approval 不应自动变成永久全局 Allow。

授权范围必须明确：

- once；
- action；
- stage；
- run；
- workspace；
- time-limited。

### 3.8 Unsafe Mode Is Explicit

Unsafe Mode 必须：

- 明确开启；
- 显示风险；
- 限定 Scope；
- 写入 Snapshot；
- 产生 Event；
- 可撤销；
- 不作为默认。

### 3.9 Provider Sandbox Is Defense-in-Depth

Provider 自带 Sandbox、Approval 或 Permission 机制可以增强安全。

但它们不能替代 AgentOS Policy Runtime。

### 3.10 Enforcement Coverage Must Be Honest

Policy 只能可靠控制通过 AgentOS 受控接口执行的行为。

如果 Provider 在不可观察环境中绕过 AgentOS Runtime，系统必须明确降低安全保证，而不能声称完全受控。

### 3.11 Secrets Are References

Policy 可以允许访问 Secret Reference。

不得把 Secret Value 写入 Decision、Event、Log 或 Snapshot。

### 3.12 Local User Retains Final Authority

本地单用户版本中，用户最终可以选择 Unsafe Mode。

### 3.13 Future Platform Actions

当前 Web-first 阶段不需要增加 Tauri 专用 Action。

未来 Desktop 阶段可以引入以下 Action，但仅在真正实现 Tauri Host 时加入：

```text
platform.open_external
platform.open_native
platform.reveal_artifact
platform.select_directory
desktop.sidecar_restart
desktop.auto_update
```

这些 Action 不在当前 Foundation 范围，不应提前设计 Action Registry 条目。

但系统必须保留审计和风险提示。

---

# Part I — Domain Model

## 4. Policy

### 4.1 Definition

Policy 是对一个 Runtime Action 作出授权判断的规则集合和执行机制。

Policy 回答：

```text
某个 Principal
在某个 Context
对某个 Resource
请求某个 Action
是否允许？
```

---

## 5. Principal

### 5.1 Definition

Principal 是发起 Action 的逻辑主体。

```ts
type PolicyPrincipalType =
  | 'user'
  | 'agent'
  | 'provider'
  | 'provider-subagent'
  | 'workflow'
  | 'system'
  | 'extension'
  | 'api-client';
```

```ts
interface PolicyPrincipal {
  type: PolicyPrincipalType;

  id: string;

  displayName?: string;

  workspaceId?: string;

  agentId?: string;

  providerConfigId?: string;

  providerSessionId?: string;

  extensionId?: string;

  authenticatedUserId?: string;

  attributes: Record<string, string | number | boolean>;
}
```

### 5.2 Principal Examples

```text
User
Agent Profile: Backend Engineer
Provider Session: KimiCode
Provider Native Subagent
Workflow Stage
Extension: GitHub Integration
System Recovery Manager
```

### 5.3 Effective Principal

Provider 发起 Tool Call 时，Effective Principal 应同时保留：

- Agent；
- Provider；
- Provider Session；
- Native Subagent，可用时；
- Run；
- Stage。

不能只记录 `provider`。

---

## 6. Action

### 6.1 Definition

Action 是 Policy Runtime 评估的标准化执行意图。

```ts
interface PolicyAction {
  type: PolicyActionType;

  category: PolicyActionCategory;

  operation: string;

  parameters: Record<string, unknown>;

  normalizedSummary: string;

  reversible:
    | 'yes'
    | 'partial'
    | 'no'
    | 'unknown';

  sideEffect:
    | 'none'
    | 'local'
    | 'workspace'
    | 'external'
    | 'system';

  requestedAt: string;
}
```

---

## 7. Action Category

```ts
type PolicyActionCategory =
  | 'process'
  | 'command'
  | 'filesystem'
  | 'network'
  | 'git'
  | 'worktree'
  | 'package'
  | 'secret'
  | 'provider'
  | 'artifact'
  | 'memory'
  | 'extension'
  | 'database'
  | 'system'
  | 'custom';
```

---

## 8. Canonical Action Types

### 8.1 Process

```text
process.spawn
process.stop
process.force_kill
process.pause
process.resume
process.detach
process.elevate
```

### 8.2 Command

```text
command.execute
command.execute_shell
command.execute_script
command.execute_workspace_binary
```

### 8.3 Filesystem

```text
file.read
file.create
file.write
file.modify
file.delete
file.move
file.copy
file.chmod
file.execute
directory.create
directory.delete
directory.enumerate
```

### 8.4 Network

```text
network.connect
network.http_request
network.download
network.upload
network.listen
network.dns
```

### 8.5 Git

```text
git.status
git.diff
git.add
git.commit
git.checkout
git.branch_create
git.branch_delete
git.rebase
git.merge
git.cherry_pick
git.reset
git.clean
git.fetch
git.pull
git.push
git.force_push
git.tag_create
git.remote_modify
git.hook_execute
```

### 8.6 Worktree

```text
worktree.create
worktree.write
worktree.review
worktree.merge
worktree.abandon
worktree.cleanup
worktree.force_cleanup
worktree.adopt
```

### 8.7 Package

```text
package.install_local
package.install_global
package.remove
package.update
package.execute_postinstall
package.system_install
```

### 8.8 Secret

```text
secret.reference_read
secret.inject_process
secret.inject_provider
secret.export
secret.delete
```

### 8.9 Provider

```text
provider.validate
provider.start
provider.resume
provider.cancel
provider.native_approval
provider.unsafe_flag
provider.model_change
```

### 8.10 Artifact

```text
artifact.create
artifact.read
artifact.export
artifact.delete
artifact.publish
artifact.open_external
```

### 8.11 Memory

```text
memory.read_context
memory.create
memory.update
memory.promote_scope
memory.delete
memory.export
```

### 8.12 Extension

```text
extension.install
extension.enable
extension.disable
extension.execute
extension.network
extension.filesystem
extension.secret
```

### 8.13 System

```text
system.shutdown
system.restart
system.modify_environment
system.modify_registry
system.service_control
system.scheduler_create
system.firewall_modify
```

---

## 9. Resource

### 9.1 Definition

Resource 是 Action 作用的目标。

```ts
interface PolicyResource {
  type: PolicyResourceType;

  id?: string;

  uri?: string;

  path?: string;

  canonicalPath?: string;

  workspaceId?: string;

  worktreeId?: string;

  branch?: string;

  remote?: string;

  host?: string;

  packageName?: string;

  secretReference?: string;

  extensionId?: string;

  attributes: Record<string, string | number | boolean>;
}
```

### 9.2 Resource Types

```ts
type PolicyResourceType =
  | 'workspace'
  | 'worktree'
  | 'file'
  | 'directory'
  | 'executable'
  | 'process'
  | 'network-host'
  | 'url'
  | 'git-repository'
  | 'git-branch'
  | 'git-remote'
  | 'package'
  | 'secret-reference'
  | 'artifact'
  | 'memory'
  | 'provider'
  | 'extension'
  | 'database'
  | 'system'
  | 'unknown';
```

### 9.3 Resource Must Be Normalized

Policy Evaluation 前必须标准化：

- 路径；
- Symlink；
- Junction；
- URL；
- Host；
- Branch；
- Package；
- Executable；
- Secret Reference。

---

## 10. Policy Context

```ts
interface PolicyContext {
  workspaceId: string;

  taskId?: string;

  runId?: string;

  stageId?: string;

  conversationId?: string;

  worktreeId?: string;

  providerSessionId?: string;

  processId?: string;

  principal: PolicyPrincipal;

  action: PolicyAction;

  resource: PolicyResource;

  environment: {
    platform: string;
    workspaceRoot?: string;
    worktreePath?: string;
    defaultBranch?: string;
    unsafeMode: boolean;
    interactiveUserAvailable: boolean;
    serverMode: string;
  };

  runtimeState: {
    runStatus?: string;
    stageStatus?: string;
    worktreeStatus?: string;
    providerAuthenticated?: boolean;
    activeProcessCount?: number;
  };

  history: {
    priorApprovalIds: string[];
    priorGrantIds: string[];
    priorDecisionIds: string[];
  };

  requestedAt: string;
}
```

---

# Part II — Policy Rule

## 11. Policy Rule

```ts
interface PolicyRule {
  id: string;

  policyProfileId: string;

  name: string;

  description?: string;

  enabled: boolean;

  effect:
    | 'allow'
    | 'deny'
    | 'require_approval';

  priority: number;

  principalSelector?: PolicyPrincipalSelector;

  actionSelector: PolicyActionSelector;

  resourceSelector?: PolicyResourceSelector;

  contextSelector?: PolicyContextSelector;

  riskLevel?:
    | 'low'
    | 'medium'
    | 'high'
    | 'critical';

  approvalScopeOptions?: ApprovalGrantScope[];

  reason: string;

  tags: string[];

  createdAt: string;
  updatedAt: string;

  version: number;
}
```

---

## 12. Principal Selector

```ts
interface PolicyPrincipalSelector {
  types?: PolicyPrincipalType[];

  ids?: string[];

  agentIds?: string[];

  providerConfigIds?: string[];

  extensionIds?: string[];

  attributes?: Record<
    string,
    string | number | boolean | string[]
  >;
}
```

---

## 13. Action Selector

```ts
interface PolicyActionSelector {
  types?: PolicyActionType[];

  categories?: PolicyActionCategory[];

  operations?: string[];

  sideEffects?: PolicyAction['sideEffect'][];

  reversible?: PolicyAction['reversible'][];

  parameterConditions?: PolicyCondition[];
}
```

---

## 14. Resource Selector

```ts
interface PolicyResourceSelector {
  types?: PolicyResourceType[];

  ids?: string[];

  workspaceIds?: string[];

  worktreeIds?: string[];

  pathPatterns?: string[];

  branchPatterns?: string[];

  hostPatterns?: string[];

  packagePatterns?: string[];

  secretReferencePatterns?: string[];

  extensionIds?: string[];

  attributeConditions?: PolicyCondition[];
}
```

---

## 15. Context Selector

```ts
interface PolicyContextSelector {
  runStatuses?: string[];

  stageStatuses?: string[];

  worktreeStatuses?: string[];

  unsafeMode?: boolean;

  interactiveUserAvailable?: boolean;

  timeWindow?: {
    start?: string;
    end?: string;
  };

  conditions?: PolicyCondition[];
}
```

---

## 16. Condition

```ts
interface PolicyCondition {
  field: string;

  operator:
    | 'eq'
    | 'neq'
    | 'in'
    | 'not_in'
    | 'contains'
    | 'starts_with'
    | 'ends_with'
    | 'matches'
    | 'lt'
    | 'lte'
    | 'gt'
    | 'gte'
    | 'exists';

  value?: unknown;
}
```

### 16.1 No Arbitrary Code

Policy Rule 不允许嵌入任意 JavaScript、Shell 或动态代码。

Rule 必须使用受限 DSL。

---

## 17. Rule Specificity

推荐 Specificity 计算考虑：

- Principal ID；
- Exact Action Type；
- Exact Resource ID；
- Exact Path；
- Worktree ID；
- Branch；
- Run；
- Stage；
- Condition 数量。

更具体 Rule 优先。

---

## 18. Rule Precedence

建议顺序：

```text
1. System Hard Deny
2. Explicit Resource Deny
3. Explicit Principal Deny
4. Time-limited Exception Grant
5. Require Approval
6. Explicit Allow
7. Profile Default
8. Global Default
```

### 18.1 Deny Overrides

一般规则：

```text
deny > require_approval > allow
```

受限 Exception Grant 可以覆盖部分非系统级 Deny，但不能覆盖 Hard Deny。

---

# Part III — Policy Profile

## 19. Policy Profile

### 19.1 Definition

Policy Profile 是一组可版本化的 Policy Rule 和默认行为。

```ts
interface PolicyProfile {
  id: string;

  workspaceId?: string;

  name: string;

  description?: string;

  mode:
    | 'safe'
    | 'standard'
    | 'trusted-local'
    | 'read-only'
    | 'review-only'
    | 'unsafe'
    | 'custom';

  defaultEffect:
    | 'allow'
    | 'deny'
    | 'require_approval';

  rules: PolicyRule[];

  protectedBranchPolicy?: ProtectedBranchPolicy;

  networkPolicy?: NetworkPolicy;

  secretPolicy?: SecretPolicy;

  extensionPolicy?: ExtensionPolicy;

  enabled: boolean;

  version: number;

  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}
```

---

## 20. Built-in Profiles

### 20.1 Safe

适合未知代码和高安全要求。

默认：

- Read Workspace；
- Write only Worktree；
- Command Require Approval；
- Network Require Approval；
- Package Install Require Approval；
- Git Commit Allow in Worktree；
- Merge Require Approval；
- Push Deny or Require Approval；
- Secret Access Deny by default；
- Unsafe Flag Deny；
- Extension Restricted。

### 20.2 Standard

适合日常本地开发。

默认：

- Worktree 内常见命令 Allow；
- Workspace Root Write Deny；
- Package Local Install Require Approval；
- Network Require Approval by Host；
- Commit Allow；
- Merge Require Approval；
- Push Require Approval；
- Secret Injection only explicit Provider References。

### 20.3 Trusted Local

适合用户信任的 Workspace。

默认：

- Worktree 内多数开发行为 Allow；
- Workspace Root 高风险写仍 Require Approval；
- Local Package Install Allow；
- External Network 受 Host Policy；
- Merge Require Approval；
- Push Require Approval；
- System Modification Deny。

### 20.4 Read-only

允许：

- Read；
- Search；
- Git Status；
- Diff；
- Test that does not modify，尽可能；
- Artifact Read。

拒绝：

- File Write；
- Commit；
- Merge；
- Install；
- Secret Injection；
- Network Upload。

### 20.5 Review-only

允许：

- Read；
- Diff；
- Test；
- Static Analysis；
- Review Artifact。

拒绝：

- 实现修改；
- Commit；
- Merge；
- Push。

### 20.6 Unsafe

减少 Approval，但不应关闭所有审计。

仍然保持 Hard Deny：

- Secret Export 未确认；
- 任意系统破坏；
- 未授权持久化服务；
- 破坏 AgentOS 自身数据；
- 无法验证 Ownership 的强制删除。

---

## 21. Profile Resolution

优先级：

```text
Run Override
  > Workflow Stage Override
  > Task Setting
  > Workspace Default
  > Global Default
```

### 21.1 Effective Policy Profile

Run 启动时创建：

```ts
interface EffectivePolicyProfile {
  profileId: string;

  profileVersion: number;

  mode: PolicyProfile['mode'];

  rules: PolicyRuleSnapshot[];

  inheritedFrom: string[];

  unsafeMode: boolean;

  compiledHash: string;

  createdAt: string;
}
```

---

## 22. Policy Snapshot

Run 开始前必须冻结：

- Profile ID；
- Version；
- Rules；
- Default Effect；
- Protected Branch；
- Network；
- Secret；
- Unsafe Mode；
- Exception Grants；
- Compiler Version。

Snapshot 不包含 Secret Value。

### 22.1 Mid-run Policy Change

Workspace Policy 在 Run 中途变化时：

默认不直接改变当前 Run。

可以：

- 继续使用 Snapshot；
- 对 Critical Emergency Deny 立即生效；
- 用户显式重新加载；
- Pause and Re-evaluate。

---

# Part IV — Decision Model

## 23. Policy Decision

```ts
type PolicyDecision =
  | PolicyAllowDecision
  | PolicyDenyDecision
  | PolicyApprovalDecision;
```

### 23.1 Allow

```ts
interface PolicyAllowDecision {
  id: string;

  action: 'allow';

  riskLevel:
    | 'low'
    | 'medium'
    | 'high'
    | 'critical';

  matchedRuleIds: string[];

  reason: string;

  constraints?: PolicyExecutionConstraint[];

  expiresAt?: string;

  createdAt: string;
}
```

### 23.2 Deny

```ts
interface PolicyDenyDecision {
  id: string;

  action: 'deny';

  riskLevel:
    | 'low'
    | 'medium'
    | 'high'
    | 'critical';

  matchedRuleIds: string[];

  reason: string;

  errorCode: string;

  suggestedAction?: string;

  createdAt: string;
}
```

### 23.3 Require Approval

```ts
interface PolicyApprovalDecision {
  id: string;

  action: 'require_approval';

  riskLevel:
    | 'low'
    | 'medium'
    | 'high'
    | 'critical';

  matchedRuleIds: string[];

  reason: string;

  approvalCategory: ApprovalCategory;

  allowedScopes: ApprovalGrantScope[];

  requestSummary: Record<string, unknown>;

  createdAt: string;
}
```

---

## 24. Execution Constraint

Policy 可以允许，但附加约束。

```ts
type PolicyExecutionConstraint =
  | {
      type: 'path-boundary';
      allowedPaths: string[];
    }
  | {
      type: 'network-hosts';
      allowedHosts: string[];
    }
  | {
      type: 'timeout';
      maxDurationMs: number;
    }
  | {
      type: 'output-limit';
      maxBytes: number;
    }
  | {
      type: 'read-only';
    }
  | {
      type: 'no-shell';
    }
  | {
      type: 'no-child-process';
    }
  | {
      type: 'no-secret';
    }
  | {
      type: 'require-worktree';
    }
  | {
      type: 'expected-commit';
      commit: string;
    };
```

### 24.1 Constraint Enforcement

返回 Constraint 后，对应 Runtime 必须真正执行。

不能只写入 Event。

---

## 25. Risk Level

```ts
type PolicyRiskLevel =
  | 'low'
  | 'medium'
  | 'high'
  | 'critical';
```

### 25.1 Low

- Read file in worktree；
- Git status；
- Read artifact；
- List directory。

### 25.2 Medium

- Modify file in owned worktree；
- Run tests；
- Local package install；
- Create commit；
- Network download from allowed host。

### 25.3 High

- Delete many files；
- Merge protected branch；
- Push；
- Access Secret；
- Execute workspace binary；
- Global package install；
- Write outside Worktree。

### 25.4 Critical

- Force Push；
- System Registry；
- Service Control；
- Credential Export；
- Delete unmanaged directory；
- Privilege Elevation；
- Disable security controls；
- Destructive disk command。

---

## 26. Risk Scoring

可以使用分值辅助：

```ts
interface PolicyRiskAssessment {
  score: number;

  level: PolicyRiskLevel;

  factors: Array<{
    name: string;
    weight: number;
    explanation: string;
  }>;
}
```

因素：

- Reversibility；
- Resource Scope；
- External Side Effect；
- Secret；
- Protected Branch；
- Shell；
- Privilege；
- Unknown Executable；
- Network Destination；
- File Count；
- Force Flag；
- Workspace Root；
- Unsafe Mode；
- Prior Approval。

Risk Score 辅助 Rule，不替代 Rule。

---

# Part V — Evaluation Runtime

## 27. Policy Engine Interface

```ts
interface PolicyEngine {
  evaluate(
    context: PolicyContext
  ): Promise<PolicyEvaluationResult>;

  evaluateBatch(
    contexts: PolicyContext[]
  ): Promise<PolicyEvaluationResult[]>;

  simulate(
    input: PolicySimulationInput
  ): Promise<PolicySimulationResult>;

  compileProfile(
    profile: PolicyProfile
  ): Promise<CompiledPolicyProfile>;

  invalidateCache(
    profileId?: string
  ): Promise<void>;
}
```

---

## 28. Evaluation Result

```ts
interface PolicyEvaluationResult {
  decision: PolicyDecision;

  risk: PolicyRiskAssessment;

  matchedRules: Array<{
    ruleId: string;
    effect: PolicyRule['effect'];
    priority: number;
    specificity: number;
    matchedConditions: string[];
  }>;

  ignoredRules: Array<{
    ruleId: string;
    reason: string;
  }>;

  profileSnapshotId: string;

  evaluationDurationMs: number;

  cacheHit: boolean;
}
```

---

## 29. Evaluation Pipeline

```text
Receive Policy Context
  ↓
Validate Context
  ↓
Normalize Principal
  ↓
Normalize Action
  ↓
Normalize Resource
  ↓
Load Effective Profile Snapshot
  ↓
Load Active Grants
  ↓
Calculate Risk
  ↓
Match Rules
  ↓
Sort by Priority + Specificity
  ↓
Apply Precedence
  ↓
Attach Constraints
  ↓
Create Decision
  ↓
Persist Decision
  ↓
Emit policy.evaluated
```

---

## 30. Evaluation Idempotency

同一 Action Request 应有：

```text
policyRequestId
```

相同请求重复评估时：

- 可以返回原 Decision；
- 但如果 Resource、Policy Version 或 Grant 改变，必须重新评估。

---

## 31. Evaluation Cache

### 31.1 Cache Key

```text
compiledProfileHash
principalFingerprint
actionFingerprint
resourceFingerprint
contextRelevantState
activeGrantHash
```

### 31.2 Cache Safe Cases

适合缓存：

- Read file in owned worktree；
- Git status；
- Repeated allowed host request；
- Read artifact。

### 31.3 Do Not Cache Blindly

不应长期缓存：

- Secret Access；
- Merge；
- Push；
- Force Cleanup；
- Privilege；
- Time-sensitive Grant；
- Resource ownership changes。

---

## 32. Policy Compiler

```ts
interface CompiledPolicyProfile {
  profileId: string;

  profileVersion: number;

  compilerVersion: string;

  compiledHash: string;

  rulesByActionType: Map<string, CompiledPolicyRule[]>;

  wildcardRules: CompiledPolicyRule[];

  hardDenyRules: CompiledPolicyRule[];

  createdAt: string;
}
```

### 32.1 Compile Validation

检查：

- 无效 Selector；
- 无法匹配 Rule；
- Rule 冲突；
- 无效 Pattern；
- 危险默认 Allow；
- Unsupported Condition；
- Duplicate Rule；
- Shadowed Rule。

---

# Part VI — Enforcement Points

## 33. Enforcement Point Definition

Enforcement Point 是执行 Action 前必须调用 Policy Engine 的 Runtime 边界。

```ts
interface PolicyEnforcementPoint<TRequest, TResult> {
  execute(
    request: TRequest,
    context: PolicyContext
  ): Promise<TResult>;
}
```

### 33.1 Required Behavior

1. 构建标准 Action；
2. 构建 Resource；
3. Evaluate；
4. Allow → 执行；
5. Deny → 返回稳定错误；
6. Require Approval → 创建 Approval Request；
7. 记录结果；
8. 不允许绕过。

---

## 34. Process Runtime Enforcement

评估点：

- Spawn；
- Shell；
- Workspace Binary；
- Detached；
- Elevation；
- Force Kill；
- Environment Secret；
- Child Process。

### 34.1 Process Spawn

```text
process.spawn
```

Resource：

- executable；
- cwd；
- worktree；
- environment keys。

---

## 35. Command Runtime Enforcement

必须在命令执行前评估：

- executable；
- argsRedacted；
- shell；
- cwd；
- purpose；
- side effect；
- expected output。

### 35.1 Shell Limitation

Shell Command 的完整语义可能难以静态解析。

因此必须采用 Defense-in-Depth：

- Shell 默认关闭；
- 解析常见危险操作；
- 限制 cwd；
- 限制 Environment；
- Worktree；
- Sandbox；
- Provider Native Approval；
- Post-execution Audit。

Policy 文档不得声称能完美理解任意 Shell 语义。

---

## 36. Filesystem Enforcement

评估：

- Canonical Path；
- Operation；
- Worktree Ownership；
- Outside Workspace；
- Symlink；
- File Count；
- Recursive；
- Force；
- Sensitive Path。

### 36.1 Read

Workspace 内 Read 通常低风险。

### 36.2 Write

Worktree 内允许。

Workspace Root 默认拒绝或审批。

### 36.3 Delete

根据：

- 是否递归；
- 文件数量；
- 是否有 Diff；
- 是否受 Git 管理；
- 是否可恢复；
- 是否位于 Managed Root。

---

## 37. Network Enforcement

评估：

- Host；
- Port；
- Protocol；
- Method；
- Upload / Download；
- Content Type；
- Credential；
- Redirect；
- Private Network；
- DNS；
- Destination Policy。

### 37.1 Redirect

Redirect 后的最终 Host 也必须重新评估。

### 37.2 Upload

上传代码、Artifact、日志或 Memory 属于高风险。

默认 Require Approval 或 Deny。

---

## 38. Git Enforcement

评估点：

- Commit；
- Branch Delete；
- Rebase；
- Merge；
- Push；
- Force Push；
- Remote Modify；
- Hook；
- Reset；
- Clean。

### 38.1 Read-only Git

通常 Allow：

```text
git.status
git.diff
git.log
git.show
```

### 38.2 Protected Branch

Merge / Push 到受保护分支：

- Review；
- Tests；
- Expected Commit；
- Approval；
- Target Lock。

---

## 39. Worktree Enforcement

评估：

- Create；
- Write；
- Adopt；
- Merge；
- Cleanup；
- Force Cleanup；
- Workspace Root Fallback。

### 39.1 Required Mode

Worktree Required 创建失败时：

```text
deny fallback to workspace root
```

---

## 40. Package Enforcement

评估：

- Local / Global；
- Package Name；
- Version；
- Registry；
- Lockfile；
- Postinstall；
- Script；
- Native Build；
- Network；
- License，未来。

### 40.1 Local Install

Standard Profile 通常 Require Approval。

Trusted Local 可对已知 Package Allow。

### 40.2 Global/System Install

默认 High 或 Critical。

---

## 41. Secret Enforcement

评估：

- Secret Reference；
- Principal；
- Provider；
- Process；
- Scope；
- Purpose；
- Target Environment；
- Export；
- Duration。

### 41.1 Injection

允许 Secret 注入时返回：

```text
secret.inject_process
```

约束：

- 只注入指定 Process；
- 只存在于内存；
- 不进入 Event；
- 不进入 Artifact；
- Process Exit 后失效。

### 41.2 Secret Export

默认 Deny。

---

## 42. Provider Enforcement

评估：

- Provider Start；
- Unsafe Flag；
- Model Change；
- Native Approval；
- Session Resume；
- External Tool；
- Native Sandbox Disable。

### 42.1 Provider Unsafe Flags

必须：

- Unsafe Profile；
- User Approval；
- Snapshot；
- Warning；
- Event。

---

## 43. Artifact Enforcement

评估：

- Create；
- Read Restricted；
- Export；
- Publish；
- Delete；
- Open External。

### 43.1 Export

导出到 Workspace 外、网络或外部应用需要更高权限。

---

## 44. Memory Enforcement

评估：

- Read Context；
- Global Scope Promote；
- Restricted Memory；
- Export；
- Delete；
- Imported Content。

### 44.1 Provider Memory Access

Provider 只能访问当前 Memory Context。

不得直接调用：

```text
memory.read_all
```

---

## 45. Extension Enforcement

Extension 必须声明权限：

```ts
interface ExtensionPermissionManifest {
  actions: PolicyActionType[];

  filesystem?: {
    readPaths: string[];
    writePaths: string[];
  };

  networkHosts?: string[];

  secretReferences?: string[];

  processExecutables?: string[];
}
```

未声明权限默认拒绝。

---

# Part VII — Approval Runtime Integration

## 46. Approval Category

```ts
type ApprovalCategory =
  | 'command'
  | 'shell'
  | 'file-write'
  | 'file-delete'
  | 'network'
  | 'upload'
  | 'package-install'
  | 'git-merge'
  | 'git-push'
  | 'force-operation'
  | 'secret-access'
  | 'provider-unsafe'
  | 'worktree-cleanup'
  | 'extension'
  | 'system'
  | 'custom';
```

---

## 47. Approval Request

```ts
interface ApprovalRequest {
  id: string;

  workspaceId: string;

  taskId?: string;

  runId: string;

  stageId?: string;

  providerSessionId?: string;

  processId?: string;

  policyDecisionId: string;

  principalSnapshot: PolicyPrincipal;

  actionSnapshot: PolicyAction;

  resourceSnapshot: PolicyResource;

  category: ApprovalCategory;

  riskLevel: PolicyRiskLevel;

  title: string;

  description: string;

  requestSummary: Record<string, unknown>;

  allowedGrantScopes: ApprovalGrantScope[];

  status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'expired'
    | 'cancelled';

  expiresAt?: string;

  createdAt: string;

  decidedAt?: string;

  decidedBy?: string;

  decision?: ApprovalDecision;

  version: number;
}
```

---

## 48. Approval Decision

```ts
type ApprovalDecision =
  | {
      action: 'approve';
      scope: ApprovalGrantScope;
      modifiedRequest?: Record<string, unknown>;
      comment?: string;
    }
  | {
      action: 'reject';
      comment?: string;
    }
  | {
      action: 'cancel-run';
      comment?: string;
    };
```

---

## 49. Approval Grant Scope

```ts
type ApprovalGrantScope =
  | 'once'
  | 'action'
  | 'stage'
  | 'run'
  | 'workspace'
  | 'time-limited';
```

### 49.1 Once

仅本次 Request。

### 49.2 Action

相同标准化 Action 和 Resource。

### 49.3 Stage

当前 Stage 内匹配。

### 49.4 Run

当前 Run 内匹配。

### 49.5 Workspace

当前 Workspace。

高风险 Action 默认不提供 Workspace Scope。

### 49.6 Time-limited

限定：

- Principal；
- Action；
- Resource；
- Start；
- End。

---

## 50. Approval Grant

```ts
interface PolicyGrant {
  id: string;

  workspaceId: string;

  sourceApprovalRequestId: string;

  principalSelector: PolicyPrincipalSelector;

  actionSelector: PolicyActionSelector;

  resourceSelector?: PolicyResourceSelector;

  scope: ApprovalGrantScope;

  runId?: string;

  stageId?: string;

  expiresAt?: string;

  createdBy: string;

  createdAt: string;

  revokedAt?: string;

  revokedBy?: string;

  version: number;
}
```

### 50.1 Grant Is Not Rule

Grant 是运行时临时授权。

Policy Rule 是长期配置。

---

## 51. Approval Lifecycle

```text
Policy requires approval
  ↓
Create Approval Request
  ↓
Persist
  ↓
Emit approval.required
  ↓
Run / Stage waiting_approval
  ↓
User decides
  ├── reject
  ├── approve
  └── cancel run
        ↓
Persist decision
  ↓
Create scoped Grant if approved
  ↓
Re-evaluate original Action
  ↓
Execute or stop
```

### 51.1 Re-evaluation Required

Approval 后必须重新验证：

- Action 未变化；
- Resource 未变化；
- Run 仍活动；
- Worktree Ownership；
- Expected Commit；
- Request 未过期；
- Grant 匹配。

不能直接跳过 Policy Engine。

---

## 52. Modified Approval

用户修改请求后批准：

- 原 Action 不应被视为已批准；
- 创建 Modified Action；
- 重新评估；
- 记录差异；
- 产生新 Decision 或复用受限 Grant。

---

## 53. Approval Idempotency

同一个 Approval Request 只能成功决策一次。

Approve 与 Reject 并发时：

- Version Check；
- 只有一个提交；
- 其他返回现有结果。

---

## 54. Provider Native Approval Bridge

```text
Provider native request
  ↓
Adapter normalizes Action
  ↓
AgentOS Policy Engine
  ↓
Approval Request
  ↓
User decision
  ↓
Re-evaluation
  ↓
Adapter sends native approval / rejection
```

Provider Native Approval 不得绕过 AgentOS Policy。

---

# Part VIII — Exceptions and Grants

## 55. Policy Exception

Policy Exception 是明确、受限的 Rule Override。

```ts
interface PolicyException {
  id: string;

  workspaceId?: string;

  name: string;

  principalSelector?: PolicyPrincipalSelector;

  actionSelector: PolicyActionSelector;

  resourceSelector?: PolicyResourceSelector;

  overrideEffect:
    | 'allow'
    | 'require_approval';

  overridesRuleIds: string[];

  reason: string;

  createdBy: string;

  approvedBy?: string;

  expiresAt?: string;

  enabled: boolean;

  createdAt: string;
  updatedAt: string;

  version: number;
}
```

### 55.1 Exception Limits

Exception 不能覆盖：

- System Hard Deny；
- Secret Export Hard Deny，除非专门安全流程；
- Unmanaged Path Force Delete；
- AgentOS Data Corruption；
- Unsupported Privilege Bypass。

---

## 56. Grant Revocation

Grant 可以：

- User 撤销；
- Run 结束自动失效；
- Stage 结束自动失效；
- Time 到期；
- Policy Version 变化；
- Resource Ownership 变化；
- Action Fingerprint 变化。

---

## 57. Grant Matching

必须匹配：

- Principal；
- Action；
- Resource；
- Scope；
- Run / Stage；
- Expiration；
- Policy Snapshot；
- Request Fingerprint。

---

# Part IX — Unsafe Mode

## 58. Unsafe Mode Definition

Unsafe Mode 是减少 Runtime 审批和限制的显式 Policy Mode。

它不是：

```text
disable all security
```

### 58.1 Unsafe Mode Enable Request

```ts
interface EnableUnsafeModeRequest {
  scope:
    | 'run'
    | 'workspace';

  workspaceId: string;

  runId?: string;

  reason: string;

  expiresAt?: string;

  enabledBy: string;
}
```

---

## 59. Unsafe Mode Requirements

必须：

- 用户显式操作；
- 风险确认；
- Reason；
- Scope；
- Expiration，可选；
- Event；
- Snapshot；
- UI 常驻标识；
- Audit。

### 59.1 Not Allowed by Agent

Agent、Provider 或 Extension 不得自行开启 Unsafe Mode。

---

## 60. Unsafe Mode Still Enforces

仍然必须控制：

- Secret Export；
- Unmanaged Directory Delete；
- System Disk；
- Privilege Elevation；
- AgentOS Database Destruction；
- Unknown Extension Secret Access；
- Force Push without explicit decision；
- External Upload；
- Persistent System Modification。

---

## 61. Unsafe Mode Expiration

Run Scope：

```text
Run terminal
→ expires
```

Workspace Scope：

- 用户关闭；
- 到期；
- Policy Reset；
- 安全事件触发。

---

# Part X — Built-in Policy Rules

## 62. Core Hard Deny Rules

建议内置：

### 62.1 AgentOS Data Destruction

拒绝未授权删除：

```text
.agentos database
event store
artifact index
secret store
```

### 62.2 Secret Value Export

拒绝 Provider 或 Extension 导出 Secret Value。

### 62.3 Unmanaged Recursive Delete

拒绝对 Ownership 无法验证目录执行递归强制删除。

### 62.4 Privilege Escalation

默认拒绝自动 UAC、sudo、root。

### 62.5 Workspace Root Concurrent Mutation

多个活动修改 Run 时拒绝主 Workspace Root Write。

### 62.6 Direct Protected Branch Mutation

Provider 直接修改受保护 Branch 的主 Checkout 时拒绝。

---

## 63. Standard Worktree Rules

### Allow

- Read Worktree；
- Write Owned Worktree；
- Run Known Test；
- Git Status / Diff；
- Create Artifact；
- Provider Start with validated config。

### Require Approval

- Package Install；
- Unknown Executable；
- Network New Host；
- Git Commit，可按配置；
- Merge；
- Push；
- Delete many files；
- Secret Injection；
- Workspace Root Write。

### Deny

- Force Push by default；
- System Modification；
- Secret Export；
- Unmanaged Force Cleanup。

---

## 64. Read-only Rules

```text
file.read → allow
git.status → allow
git.diff → allow
test.read_only → allow
file.write → deny
git.commit → deny
worktree.merge → deny
package.install → deny
secret.inject → deny
```

---

## 65. Review-only Rules

Review Stage：

- Read Diff；
- Run Test；
- Create Review Artifact；
- Add Comment；
- No File Modification；
- No Commit；
- No Merge；
- No Package Install unless explicitly approved。

---

# Part XI — Command Policy

## 66. Command Normalization

```ts
interface NormalizedCommandAction {
  executable: string;

  executableResolved?: string;

  argsRedacted: string[];

  cwd: string;

  shell: boolean;

  commandFamily?: string;

  detectedOperations: string[];

  fileTargets: string[];

  networkTargets: string[];

  packageTargets: string[];

  gitOperation?: string;

  confidence: number;
}
```

### 66.1 Command Family

示例：

- git；
- npm；
- pnpm；
- yarn；
- pip；
- python；
- node；
- powershell；
- cmd；
- bash；
- test-runner；
- compiler。

---

## 67. Static Command Inspection

可以识别：

- `git push`；
- `rm -rf`；
- `del /s`；
- `npm install`；
- `pip install`；
- `curl`；
- `wget`；
- `powershell -Command`；
- `chmod`；
- `sudo`；
- `taskkill`。

但必须标记 Confidence。

---

## 68. Shell Command Boundary

任意 Shell 可以通过：

- Pipe；
- Redirect；
- Substitution；
- Alias；
- Script；
- Environment Expansion；

改变语义。

因此对 Shell：

- 更高 Risk；
- 更严格 Policy；
- 限制 Worktree；
- 限制 Network；
- 使用 Sandbox；
- 记录 Raw Command；
- 不声称完全静态安全。

---

## 69. Script Execution

执行 Workspace 中脚本时评估：

- Script Path；
- Hash；
- Git Tracked；
- Modified by current Run；
- Interpreter；
- Permissions；
- Network；
- Secret；
- Postinstall。

新生成脚本默认 Medium/High Risk。

---

# Part XII — Filesystem Policy

## 70. Path Classes

```ts
type PolicyPathClass =
  | 'owned-worktree'
  | 'workspace-root'
  | 'workspace-readonly'
  | 'agentos-data'
  | 'artifact-store'
  | 'temp'
  | 'user-home'
  | 'system'
  | 'network-share'
  | 'unknown';
```

### 70.1 Classification

必须基于 Canonical Path 和 Ownership，而不是字符串前缀。

---

## 71. File Read Policy

默认：

- Owned Worktree → Allow；
- Workspace → Allow；
- User Home → Require Approval or Deny；
- Secret Files → Deny；
- System → Deny；
- Artifact Restricted → permission check。

---

## 72. File Write Policy

默认：

- Owned Worktree → Allow；
- Workspace Root → Require Approval or Deny；
- AgentOS Data → Deny except owning service；
- User Home → Deny；
- System → Deny；
- Temp → Allow with constraints。

---

## 73. File Delete Policy

风险因素：

- Recursive；
- Count；
- Git Tracked；
- Outside Worktree；
- Recoverable；
- Artifact Archived；
- Force；
- Ownership；
- Protected Path。

### 73.1 Thresholds

可配置：

```ts
interface DeleteThresholdPolicy {
  maxFilesWithoutApproval: number;

  maxBytesWithoutApproval: number;

  recursiveRequiresApproval: boolean;

  outsideWorktreeDeny: boolean;
}
```

---

## 74. Symlink and Junction

Policy Evaluation 必须使用最终真实目标。

创建 Symlink 也属于独立 Action：

```text
file.symlink_create
```

因为可能绕过 Path Boundary。

---

# Part XIII — Network Policy

## 75. Network Policy

```ts
interface NetworkPolicy {
  defaultEffect:
    | 'allow'
    | 'deny'
    | 'require_approval';

  allowedHosts: string[];

  deniedHosts: string[];

  allowedPorts?: number[];

  deniedPorts?: number[];

  allowPrivateNetwork: boolean;

  allowLoopback: boolean;

  allowUploads: boolean;

  requireApprovalForNewHost: boolean;

  followRedirects: boolean;

  maxDownloadBytes?: number;

  maxUploadBytes?: number;
}
```

---

## 76. Host Matching

支持：

- Exact Host；
- Subdomain Pattern；
- IP；
- CIDR；
- Port；
- Protocol。

禁止模糊字符串包含匹配。

---

## 77. Private Network

以下通常更高风险：

- localhost；
- 127.0.0.1；
- RFC1918；
- Link-local；
- Cloud Metadata；
- Internal DNS。

Cloud Metadata 地址应 Hard Deny，除非专门配置。

---

## 78. Download Policy

评估：

- Host；
- File Type；
- Size；
- Executable；
- Archive；
- Checksum；
- Destination；
- 是否后续执行。

“Download and Execute”应视为组合高风险 Action。

---

## 79. Upload Policy

上传：

- Source Code；
- Artifact；
- Log；
- Memory；
- Screenshot；
- Secret；

必须明确 Resource Classification。

Restricted / Secret 默认 Deny。

---

# Part XIV — Git and Worktree Policy

## 80. Protected Branch Policy

```ts
interface ProtectedBranchPolicy {
  patterns: string[];

  requireApproval: boolean;

  requireReview: boolean;

  requireTests: boolean;

  denyForcePush: boolean;

  denyDirectProviderWrite: boolean;

  requireExpectedCommit: boolean;
}
```

---

## 81. Commit Policy

Commit 可以 Allow，但需检查：

- Worktree Owner；
- Secret Scan；
- Files；
- Commit Message；
- Hooks；
- Author；
- Current Branch。

---

## 82. Merge Policy

Merge 必须考虑：

- Review；
- Tests；
- Expected Source Head；
- Expected Target；
- Protected Branch；
- Conflict；
- Strategy；
- Approval；
- Integration Worktree。

---

## 83. Push Policy

默认 Require Approval。

Force Push 默认 Deny。

`--force-with-lease` 也不是普通 Push，仍需高风险评估。

---

## 84. Cleanup Policy

Worktree Cleanup 必须检查：

- Dirty；
- Active Process；
- Artifact；
- Ownership；
- Conflict；
- Merge；
- Retain Flag。

Force Cleanup 需要 Approval。

---

# Part XV — Secret Policy

## 85. Secret Policy

```ts
interface SecretPolicy {
  defaultEffect:
    | 'deny'
    | 'require_approval';

  allowedProviderReferences: Record<
    string,
    string[]
  >;

  allowProcessInjection: boolean;

  allowPromptInjection: boolean;

  allowArtifactExport: boolean;

  maxLifetimeMs?: number;
}
```

### 85.1 Prompt Injection

默认：

```text
allowPromptInjection = false
```

Provider Credential 应通过 Environment 或官方 Credential Store，不进入 Prompt。

---

## 86. Secret Access Request

```ts
interface SecretAccessRequest {
  secretReference: string;

  purpose: string;

  targetType:
    | 'provider'
    | 'process'
    | 'network'
    | 'extension';

  targetId: string;

  requestedLifetimeMs?: number;
}
```

---

## 87. Secret Decision Audit

Audit 只能记录：

- Reference ID；
- Principal；
- Purpose；
- Target；
- Decision；
- Time。

不得记录 Value。

---

# Part XVI — Extension Policy

## 88. Extension Trust Levels

```ts
type ExtensionTrustLevel =
  | 'builtin'
  | 'trusted'
  | 'reviewed'
  | 'untrusted';
```

### 88.1 Built-in

AgentOS 内置。

### 88.2 Trusted

用户显式信任。

### 88.3 Reviewed

通过权限审查。

### 88.4 Untrusted

最小权限，默认隔离。

---

## 89. Extension Permission Grant

Extension 安装时：

- 读取 Manifest；
- 展示权限；
- 用户批准；
- 创建 Policy Rule 或 Grant；
- 保存版本；
- 版本升级重新评估权限变化。

---

## 90. Extension Upgrade

新增权限时必须重新批准。

不能沿用旧版本 Grant 自动获得新权限。

---

# Part XVII — Audit Runtime

## 91. Policy Decision Record

```ts
interface PolicyDecisionRecord {
  id: string;

  workspaceId: string;

  taskId?: string;

  runId?: string;

  stageId?: string;

  providerSessionId?: string;

  processId?: string;

  profileSnapshotId: string;

  principalJson: string;

  actionJson: string;

  resourceJson: string;

  decision: string;

  riskLevel: string;

  matchedRuleIdsJson: string;

  reason: string;

  approvalRequestId?: string;

  executed?: boolean;

  executionEventId?: string;

  createdAt: string;
}
```

---

## 92. Decision and Execution Link

Policy Allow 之后还需要知道是否真正执行。

```text
policy.evaluated
  ↓
policy.allowed
  ↓
command.started
```

如果 Allow 后未执行，也应可解释：

- Run Cancelled；
- Provider changed plan；
- Process failed；
- Approval revoked。

---

## 93. Audit Retention

默认永久保留：

- Deny；
- Approval；
- Secret；
- Merge；
- Push；
- Force；
- Unsafe Mode；
- System Action；
- Extension Permission。

高频低风险 Read Decision 可以采样或聚合，但不能影响安全审计要求。

---

## 94. Audit Redaction

Audit 记录必须：

- Args Redacted；
- Secret Reference only；
- Path 可按 Restricted；
- URL Query Redacted；
- Request Body 不默认保存；
- Artifact 引用而非内容。

---

# Part XVIII — Policy Events

## 95. Event Types

`03-Event-Model.md` 已定义基础事件。

Policy Runtime 补充：

```text
policy.profile_created
policy.profile_updated
policy.profile_archived
policy.profile_snapshot_created
policy.compilation_started
policy.compilation_completed
policy.compilation_failed
policy.evaluation_started
policy.evaluated
policy.allowed
policy.denied
policy.approval_required
policy.constraint_attached
policy.grant_created
policy.grant_revoked
policy.exception_created
policy.exception_expired
policy.unsafe_mode_enabled
policy.unsafe_mode_disabled
policy.violation_detected
policy.enforcement_failed
policy.simulation_completed
```

---

## 96. `policy.evaluation_started`

```ts
interface PolicyEvaluationStartedPayload {
  policyRequestId: string;

  principalType: PolicyPrincipalType;

  actionType: PolicyActionType;

  resourceType: PolicyResourceType;

  profileSnapshotId: string;
}
```

---

## 97. `policy.evaluated`

```ts
interface PolicyEvaluatedPayload {
  policyDecisionId: string;

  actionType: PolicyActionType;

  resourceType: PolicyResourceType;

  decision:
    | 'allow'
    | 'deny'
    | 'require_approval';

  riskLevel: PolicyRiskLevel;

  matchedRuleIds: string[];

  reason: string;

  constraints?: PolicyExecutionConstraint[];

  evaluationDurationMs: number;
}
```

---

## 98. `policy.violation_detected`

用于发现已执行行为与 Policy 不一致。

```ts
interface PolicyViolationDetectedPayload {
  actionType: string;

  resourceSummary: string;

  expectedDecision: string;

  detectedBehavior: string;

  source:
    | 'runtime'
    | 'audit'
    | 'recovery'
    | 'provider'
    | 'extension';

  severity: PolicyRiskLevel;

  containmentAction?: string;
}
```

---

## 99. Enforcement Failure

```ts
interface PolicyEnforcementFailedPayload {
  enforcementPoint: string;

  actionType: string;

  decisionId: string;

  errorCode: string;

  message: string;

  actionMayHaveExecuted: boolean;
}
```

如果无法确定 Action 是否执行，必须显示不确定性。

---

# Part XIX — Persistence

## 100. Policy Profile Schema

```sql
CREATE TABLE policy_profiles (
  id TEXT PRIMARY KEY,

  workspace_id TEXT,

  name TEXT NOT NULL,
  description TEXT,

  mode TEXT NOT NULL,
  default_effect TEXT NOT NULL,

  protected_branch_policy_json TEXT,
  network_policy_json TEXT,
  secret_policy_json TEXT,
  extension_policy_json TEXT,

  enabled INTEGER NOT NULL,

  version INTEGER NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
```

---

## 101. Policy Rule Schema

```sql
CREATE TABLE policy_rules (
  id TEXT PRIMARY KEY,

  policy_profile_id TEXT NOT NULL,

  name TEXT NOT NULL,
  description TEXT,

  enabled INTEGER NOT NULL,

  effect TEXT NOT NULL,
  priority INTEGER NOT NULL,

  principal_selector_json TEXT,
  action_selector_json TEXT NOT NULL,
  resource_selector_json TEXT,
  context_selector_json TEXT,

  risk_level TEXT,
  approval_scope_options_json TEXT,

  reason TEXT NOT NULL,
  tags_json TEXT NOT NULL,

  version INTEGER NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## 102. Policy Snapshot Schema

```sql
CREATE TABLE policy_profile_snapshots (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,

  policy_profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,

  mode TEXT NOT NULL,
  default_effect TEXT NOT NULL,

  compiled_hash TEXT NOT NULL,
  compiler_version TEXT NOT NULL,

  snapshot_json TEXT NOT NULL,

  unsafe_mode INTEGER NOT NULL,

  created_at TEXT NOT NULL
);
```

---

## 103. Policy Decision Schema

```sql
CREATE TABLE policy_decisions (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  stage_id TEXT,
  provider_session_id TEXT,
  process_id TEXT,

  policy_request_id TEXT NOT NULL,
  profile_snapshot_id TEXT NOT NULL,

  principal_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  resource_json TEXT NOT NULL,

  decision TEXT NOT NULL,
  risk_level TEXT NOT NULL,

  matched_rule_ids_json TEXT NOT NULL,
  constraints_json TEXT,

  reason TEXT NOT NULL,
  error_code TEXT,

  approval_request_id TEXT,

  executed INTEGER,
  execution_event_id TEXT,

  created_at TEXT NOT NULL,

  UNIQUE(policy_request_id, profile_snapshot_id)
);
```

---

## 104. Approval Request Schema

```sql
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  provider_session_id TEXT,
  process_id TEXT,

  policy_decision_id TEXT NOT NULL,

  principal_snapshot_json TEXT NOT NULL,
  action_snapshot_json TEXT NOT NULL,
  resource_snapshot_json TEXT NOT NULL,

  category TEXT NOT NULL,
  risk_level TEXT NOT NULL,

  title TEXT NOT NULL,
  description TEXT NOT NULL,
  request_summary_json TEXT NOT NULL,

  allowed_grant_scopes_json TEXT NOT NULL,

  status TEXT NOT NULL,

  expires_at TEXT,

  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_json TEXT,

  version INTEGER NOT NULL
);
```

---

## 105. Grant Schema

```sql
CREATE TABLE policy_grants (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  source_approval_request_id TEXT NOT NULL,

  principal_selector_json TEXT NOT NULL,
  action_selector_json TEXT NOT NULL,
  resource_selector_json TEXT,

  scope TEXT NOT NULL,

  run_id TEXT,
  stage_id TEXT,

  expires_at TEXT,

  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,

  revoked_at TEXT,
  revoked_by TEXT,

  version INTEGER NOT NULL
);
```

---

## 106. Exception Schema

```sql
CREATE TABLE policy_exceptions (
  id TEXT PRIMARY KEY,

  workspace_id TEXT,

  name TEXT NOT NULL,

  principal_selector_json TEXT,
  action_selector_json TEXT NOT NULL,
  resource_selector_json TEXT,

  override_effect TEXT NOT NULL,
  overrides_rule_ids_json TEXT NOT NULL,

  reason TEXT NOT NULL,

  created_by TEXT NOT NULL,
  approved_by TEXT,

  expires_at TEXT,

  enabled INTEGER NOT NULL,

  version INTEGER NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## 107. Indexes

```sql
CREATE INDEX idx_policy_profiles_workspace
ON policy_profiles(workspace_id, enabled);

CREATE INDEX idx_policy_rules_profile
ON policy_rules(policy_profile_id, enabled, priority);

CREATE INDEX idx_policy_decisions_run
ON policy_decisions(run_id, created_at);

CREATE INDEX idx_policy_decisions_action
ON policy_decisions(decision, risk_level, created_at);

CREATE INDEX idx_approval_requests_status
ON approval_requests(status, created_at);

CREATE INDEX idx_approval_requests_run
ON approval_requests(run_id, status);

CREATE INDEX idx_policy_grants_workspace
ON policy_grants(workspace_id, expires_at);

CREATE INDEX idx_policy_grants_run
ON policy_grants(run_id, stage_id);

CREATE INDEX idx_policy_exceptions_workspace
ON policy_exceptions(workspace_id, enabled, expires_at);
```

---

## 108. Transaction Requirements

必须事务化：

- Profile Update + Version；
- Run Policy Snapshot；
- Decision Persist + Approval Create；
- Approval Resolve + Grant Create；
- Grant Revoke；
- Unsafe Mode Enable；
- Exception Create；
- Decision Executed Link；
- Profile Archive。

---

# Part XX — APIs

## 109. Policy Profile APIs

```text
GET    /api/policies
POST   /api/policies
GET    /api/policies/:id
PATCH  /api/policies/:id
DELETE /api/policies/:id
POST   /api/policies/:id/validate
POST   /api/policies/:id/clone
POST   /api/policies/:id/simulate
GET    /api/policies/:id/effective
```

---

## 110. Rule APIs

```text
GET    /api/policies/:id/rules
POST   /api/policies/:id/rules
PATCH  /api/policy-rules/:id
DELETE /api/policy-rules/:id
POST   /api/policy-rules/:id/enable
POST   /api/policy-rules/:id/disable
```

---

## 111. Evaluation API

内部：

```text
POST /internal/policy/evaluate
```

Request：

```ts
interface EvaluatePolicyRequest {
  policyRequestId: string;
  context: PolicyContext;
}
```

普通外部 API 不应允许客户端伪造受信 Principal。

---

## 112. Approval APIs

```text
GET  /api/approvals
GET  /api/approvals/:id
POST /api/approvals/:id/approve
POST /api/approvals/:id/reject
POST /api/approvals/:id/cancel-run
POST /api/approvals/:id/expire
```

### 112.1 Filters

```text
workspaceId
runId
stageId
status
riskLevel
category
provider
createdAfter
```

---

## 113. Grant APIs

```text
GET    /api/policy-grants
GET    /api/policy-grants/:id
POST   /api/policy-grants/:id/revoke
```

用户通常通过 Approval 创建 Grant，不直接创建任意 Grant。

---

## 114. Unsafe Mode APIs

```text
POST /api/workspaces/:id/unsafe-mode/enable
POST /api/workspaces/:id/unsafe-mode/disable
POST /api/runs/:id/unsafe-mode/enable
```

---

## 115. Simulation API

```text
POST /api/policy/simulate
```

```ts
interface PolicySimulationInput {
  policyProfileId: string;

  principal: PolicyPrincipal;

  action: PolicyAction;

  resource: PolicyResource;

  contextOverrides?: Partial<PolicyContext>;
}
```

返回：

- Decision；
- Matched Rules；
- Precedence；
- Risk；
- Explanation；
- No Action Executed。

---

# Part XXI — Policy Inspector

## 116. Policy Inspector View

```ts
interface PolicyInspectorView {
  decision: PolicyDecisionRecord;

  profileSnapshot: EffectivePolicyProfile;

  matchedRules: PolicyRuleSnapshot[];

  precedenceTrace: Array<{
    ruleId: string;
    effect: string;
    priority: number;
    specificity: number;
    selected: boolean;
    reason: string;
  }>;

  risk: PolicyRiskAssessment;

  approval?: ApprovalRequest;

  grant?: PolicyGrant;

  execution?: {
    executed: boolean;
    eventId?: string;
    result?: string;
  };

  warnings: string[];
}
```

---

## 117. Approval Center View

应展示：

- Agent；
- Provider；
- Run；
- Stage；
- Action；
- Resource；
- Risk；
- Exact Command，脱敏；
- Diff / File Count；
- Network Host；
- Secret Reference；
- Matched Rule；
- Reason；
- Allowed Approval Scope；
- Approve；
- Edit and Approve；
- Reject；
- Cancel Run。

### 117.1 No Dark Patterns

高风险 Approval 不得：

- 默认选中长期 Scope；
- 隐藏 Force；
- 隐藏 Target Branch；
- 隐藏 Upload；
- 隐藏 Secret；
- 使用模糊“继续”代替清晰行为。

---

## 118. Rule Inspector

显示：

- Rule；
- Selector；
- Priority；
- Specificity；
- Shadowed Rules；
- Conflicts；
- Recent Matches；
- Recent Denials；
- Approval Count；
- Last Modified。

---

# Part XXII — Simulation and Testing

## 119. Policy Simulation

Simulation 不执行 Action。

用途：

- 编辑 Rule；
- 检查 Profile；
- Debug Deny；
- 测试 Provider；
- 查看 Unsafe Mode 影响；
- 比较 Profiles。

---

## 120. Policy Test Case

```ts
interface PolicyTestCase {
  id: string;

  name: string;

  profileId: string;

  principal: PolicyPrincipal;

  action: PolicyAction;

  resource: PolicyResource;

  expected:
    | 'allow'
    | 'deny'
    | 'require_approval';

  expectedRuleIds?: string[];

  expectedRiskLevel?: PolicyRiskLevel;
}
```

---

## 121. Built-in Test Cases

必须包含：

1. Read file in Worktree → Allow；
2. Write file in Worktree → Allow；
3. Write Workspace Root → Approval/Deny；
4. Delete unmanaged directory → Deny；
5. Git Status → Allow；
6. Git Merge Default Branch → Approval；
7. Git Force Push → Deny；
8. Local Package Install → Approval；
9. Global Install → Approval/Deny；
10. New Network Host → Approval；
11. Upload Source Code → Approval/Deny；
12. Secret Injection to matching Provider → Approval/Allow；
13. Secret Export → Deny；
14. Provider Unsafe Flag → Approval；
15. Workspace Binary Execute → Approval；
16. Review Agent Write → Deny；
17. Orphan Worktree Force Cleanup → Approval；
18. Agent enables Unsafe Mode → Deny；
19. User enables Run Unsafe Mode → Approval/Allow；
20. Extension undeclared Network → Deny。

---

## 122. Regression Tests

每次 Policy 修改必须运行：

- Core Hard Deny；
- Protected Branch；
- Secret；
- Unsafe Mode；
- Path Boundary；
- Extension Permission；
- Approval Scope；
- Grant Expiration。

---

# Part XXIII — Operational Requirements

## 123. Metrics

必须监控：

- Evaluations per Second；
- Decision Latency；
- Allow / Deny / Approval Rate；
- Risk Distribution；
- Cache Hit；
- Rule Match Count；
- Unmatched Action Count；
- Approval Wait Time；
- Approval Accept / Reject；
- Grant Count；
- Grant Expiration；
- Unsafe Mode Duration；
- Enforcement Failure；
- Violation；
- Decision-to-Execution Gap。

---

## 124. Policy Engine Failure

Policy Engine 不可用时：

### Low-risk Read

可以按 Profile 配置有限降级。

### Mutating / High-risk

默认 Fail Closed：

```text
deny or pause
```

不得因为 Policy Service Error 自动 Allow。

---

## 125. Degraded Mode

```ts
interface PolicyDegradedMode {
  allowReadOnly: boolean;

  allowKnownWorktreeCommands: boolean;

  denyNetwork: boolean;

  denySecret: boolean;

  denyMerge: boolean;

  denyPush: boolean;

  denySystem: boolean;
}
```

---

## 126. Backpressure

高频 Read Event 不应对每个字节评估。

Policy 应在语义 Action 边界评估：

- File Open；
- Command Start；
- Network Request；
- Secret Resolve；
- Git Operation。

---

# Part XXIV — Error Model

## 127. Policy Runtime Error

```ts
interface PolicyRuntimeError {
  code: PolicyErrorCode;

  message: string;

  phase:
    | 'validation'
    | 'compilation'
    | 'snapshot'
    | 'normalization'
    | 'evaluation'
    | 'approval'
    | 'grant'
    | 'exception'
    | 'enforcement'
    | 'audit'
    | 'simulation';

  policyProfileId?: string;

  policyDecisionId?: string;

  approvalRequestId?: string;

  retryable: boolean;

  failClosed: boolean;

  suggestedAction?: string;

  details?: Record<string, unknown>;
}
```

---

## 128. Error Codes

```ts
type PolicyErrorCode =
  | 'POLICY_PROFILE_NOT_FOUND'
  | 'POLICY_PROFILE_DISABLED'
  | 'POLICY_PROFILE_INVALID'
  | 'POLICY_RULE_INVALID'
  | 'POLICY_RULE_CONFLICT'
  | 'POLICY_COMPILE_FAILED'
  | 'POLICY_SNAPSHOT_FAILED'
  | 'POLICY_CONTEXT_INVALID'
  | 'POLICY_ACTION_UNKNOWN'
  | 'POLICY_RESOURCE_UNKNOWN'
  | 'POLICY_EVALUATION_FAILED'
  | 'POLICY_DENIED'
  | 'POLICY_APPROVAL_REQUIRED'
  | 'POLICY_APPROVAL_NOT_FOUND'
  | 'POLICY_APPROVAL_ALREADY_RESOLVED'
  | 'POLICY_APPROVAL_EXPIRED'
  | 'POLICY_GRANT_INVALID'
  | 'POLICY_GRANT_EXPIRED'
  | 'POLICY_EXCEPTION_INVALID'
  | 'POLICY_UNSAFE_MODE_FORBIDDEN'
  | 'POLICY_ENFORCEMENT_FAILED'
  | 'POLICY_VIOLATION_DETECTED'
  | 'POLICY_AUDIT_FAILED'
  | 'POLICY_ACCESS_DENIED'
  | 'POLICY_VERSION_CONFLICT'
  | 'POLICY_UNKNOWN_ERROR';
```

---

# Part XXV — v1 Migration

## 129. Current v1 Model

当前 v1 安全控制主要依赖：

- Prompt；
- Provider CLI Flags；
- AbortController；
- 固定参数；
- 少量命令限制；
- 用户手动观察。

问题：

- 无统一 Action；
- 无 Resource；
- 无 Principal；
- 无 Policy Profile；
- 无 Rule；
- 无 Decision；
- 无 Approval Object；
- 无 Grant；
- 无 Snapshot；
- 无 Audit；
- Provider 之间行为不一致；
- Prompt 无法强制执行；
- 危险 Flag 可能成为默认；
- Workspace Root 修改缺少隔离策略。

---

## 130. Migration Target

```text
Runtime Action
  ↓
Policy Context
  ↓
Effective Policy Snapshot
  ↓
Decision
  ├── Allow
  ├── Deny
  └── Approval
        ↓
Runtime Enforcement Point
```

---

## 131. Migration Step 1 — Introduce Policy Port

Process、Git、Worktree、Secret 先接入：

```ts
policy.evaluate(context)
```

最初可以使用简单内置 Rule。

---

## 132. Migration Step 2 — Built-in Standard Profile

定义：

- Worktree Write Allow；
- Workspace Root Write Approval；
- Network Approval；
- Package Install Approval；
- Merge Approval；
- Push Approval；
- Secret Deny/Approval；
- System Deny。

---

## 133. Migration Step 3 — Approval Object

把 Provider 或 CLI 的交互式确认映射为持久 Approval Request。

---

## 134. Migration Step 4 — Policy Snapshot

每个新 Run 保存 Policy Snapshot。

---

## 135. Migration Step 5 — Remove Prompt-only Safety

Prompt 保留为 Guidance。

所有关键行为接入 Enforcement Point。

---

## 136. Migration Step 6 — Unsafe Flag Cleanup

检查当前 Provider 默认参数。

移除默认危险 Flag。

Unsafe Flag 仅由 Unsafe Profile + Approval 启用。

---

## 137. Migration Step 7 — Audit and Inspector

增加：

- Decision Table；
- Event；
- Approval Center；
- Policy Inspector；
- Simulation。

---

# Part XXVI — Implementation Structure

## 138. Recommended Package

```text
packages/policy-runtime/
├── src/
│   ├── policy-engine.ts
│   ├── policy-compiler.ts
│   ├── policy-registry.ts
│   ├── policy-repository.ts
│   ├── rule-matcher.ts
│   ├── precedence.ts
│   ├── specificity.ts
│   ├── risk-assessor.ts
│   ├── context-builder.ts
│   ├── action-normalizer.ts
│   ├── resource-normalizer.ts
│   ├── decision-repository.ts
│   ├── approval/
│   │   ├── approval-service.ts
│   │   ├── approval-repository.ts
│   │   ├── grant-service.ts
│   │   └── grant-repository.ts
│   ├── exception/
│   │   ├── exception-service.ts
│   │   └── exception-repository.ts
│   ├── builtin/
│   │   ├── safe.ts
│   │   ├── standard.ts
│   │   ├── trusted-local.ts
│   │   ├── read-only.ts
│   │   ├── review-only.ts
│   │   └── unsafe.ts
│   ├── enforcement/
│   │   ├── process-policy-port.ts
│   │   ├── file-policy-port.ts
│   │   ├── network-policy-port.ts
│   │   ├── git-policy-port.ts
│   │   ├── secret-policy-port.ts
│   │   └── extension-policy-port.ts
│   ├── audit.ts
│   ├── simulation.ts
│   ├── errors.ts
│   ├── events.ts
│   └── testing/
└── package.json
```

---

## 139. Dependencies

Policy Runtime 可以依赖：

- Storage；
- Event Sink；
- Clock；
- Task / Run Snapshot Ports；
- Workspace Metadata；
- Worktree Metadata；
- Provider Metadata；
- Secret Reference Metadata。

不得依赖：

- Web UI；
- 具体 Provider Adapter；
- Model；
- Prompt；
- Raw Secret Value；
- 具体 Process Driver。

---

# Part XXVII — Implementation Phases

## 140. Phase 1 — Foundation

- Principal；
- Action；
- Resource；
- Context；
- Rule；
- Profile；
- Standard Built-in Profile；
- Evaluation；
- Decision；
- Process / Worktree / Git Enforcement；
- Event；
- SQLite；
- Unit Tests。

---

## 141. Phase 2 — Approval

- Approval Request；
- Waiting State；
- Approval UI API；
- Grant；
- Re-evaluation；
- Provider Native Approval Bridge；
- Idempotency。

---

## 142. Phase 3 — Security Domains

- Network；
- Secret；
- Package；
- Extension；
- Artifact；
- Memory；
- Protected Branch；
- Unsafe Mode。

---

## 143. Phase 4 — Inspector and Advanced Policy

- Simulation；
- Rule Inspector；
- Conflict Detection；
- Exception；
- Metrics；
- Policy Templates；
- Policy Import / Export；
- OpenTelemetry Integration。

---

# Part XXVIII — Definition of Done

## 144. Policy Runtime Foundation DoD

Foundation 完成必须满足：

1. Policy 不再只是 Prompt Guidance。
2. Principal、Action、Resource 和 Context 有统一模型。
3. Policy Profile 可持久化和版本化。
4. Run 保存 Policy Snapshot。
5. Rule 支持 Allow、Deny、Require Approval。
6. Deny 默认覆盖 Allow。
7. Specific Rule 优先于 General Rule。
8. Unknown High-risk Action 不默认放行。
9. Process Spawn 接入 Policy。
10. Shell Execution 接入 Policy。
11. File Write/Delete 接入 Policy。
12. Worktree Create/Cleanup 接入 Policy。
13. Git Merge/Push 接入 Policy。
14. Secret Access 接入 Policy。
15. Provider Unsafe Flag 接入 Policy。
16. Approval Request 持久化。
17. Approval 决策幂等。
18. Approval 后重新评估 Action。
19. Grant 有明确 Scope 和 Expiration。
20. Unsafe Mode 只能由 User 显式开启。
21. Unsafe Mode 写入 Snapshot 和 Event。
22. Secret Value 不进入 Decision/Event。
23. 每次关键 Decision 可审计。
24. Decision 与实际 Execution 可关联。
25. Policy Engine 故障对高风险 Action Fail Closed。
26. Browser Disconnect 不自动批准或拒绝。
27. Provider Native Approval 被统一桥接。
28. Built-in Safe、Standard、Read-only Profile 可用。
29. Policy Simulation 可解释匹配 Rule。
30. Core Hard Deny Tests 通过。
31. Enforcement Point 不允许绕过。
32. v1 流程通过 Standard Profile 可继续运行。

---

# Part XXIX — Anti-Patterns

## 145. Prompt-only Security

错误：

```text
Prompt:
  Do not run dangerous commands.
```

正确：

```text
command.execute
  ↓
Policy Engine
  ↓
Allow / Deny / Approval
```

---

## 146. Provider Decides Everything

错误：

```text
Provider native approval says yes
→ execute
```

正确：

```text
Provider request
  ↓
AgentOS Policy
  ↓
User Approval
  ↓
Re-evaluate
```

---

## 147. Global Approval

错误：

```text
User approved once
→ allow all commands forever
```

正确：

```text
Scoped Grant
+ Expiration
+ Principal
+ Resource
```

---

## 148. Rule in Runtime Code

错误：

```ts
if (command.includes('git push')) {
  askUser();
}
```

正确：

```text
Normalized Action
  ↓
Policy Rule
```

---

## 149. Deny after Execution

错误：

```text
Command runs
  ↓
Audit finds violation
```

正确：

```text
Evaluate before execution
```

事后检测只能作为补充。

---

## 150. Secret in Approval

错误：

```text
Approve token sk-...
```

正确：

```text
Approve secret reference provider_kimi_oauth
```

---

## 151. Silent Unsafe Mode

错误：

```text
Provider config contains dangerous flag by default
```

正确：

```text
Unsafe Profile
+ User Decision
+ Snapshot
+ Event
```

---

## 152. Exact Shell Safety Claim

错误：

```text
Policy parser fully understands arbitrary shell.
```

正确：

```text
Static inspection
+ Worktree
+ Sandbox
+ Restricted shell
+ Audit
```

---

## 153. Grant without Resource

错误：

```text
approve command.execute for workspace
```

正确：

```text
approve npm install package X
for this run
in owned worktree
```

---

## 154. Policy Reads Secret Value

错误：

```text
Policy logs and compares token value
```

正确：

```text
Policy evaluates secret reference metadata
```

---

# Part XXX — Global Invariants

## 155. Policy Runtime Invariants

AgentOS v2 必须始终满足：

1. Policy 不等于 Prompt Guidance。
2. Policy Decision 必须在 Action 执行前产生。
3. 所有高风险 Action 必须经过 Policy。
4. Principal、Action、Resource 必须标准化。
5. Policy Rule 不允许任意代码。
6. Policy Profile 必须版本化。
7. Run 必须保存 Policy Snapshot。
8. Deny 默认覆盖 Require Approval 和 Allow。
9. Specific Rule 优先于 General Rule。
10. System Hard Deny 不得被普通 Grant 覆盖。
11. Unknown High-risk Action 不默认 Allow。
12. Allow 可以附带 Execution Constraint。
13. Constraint 必须由 Runtime 真正执行。
14. Decision 必须可审计。
15. Decision 必须能关联实际 Execution。
16. Approval Request 必须持久化。
17. Approval 决策必须幂等。
18. Approval 后必须重新评估 Action。
19. Grant 必须有 Scope。
20. Grant 必须可过期和撤销。
21. Approval Once 不得扩大为 Workspace Allow。
22. Unsafe Mode 必须由 User 显式开启。
23. Agent、Provider 和 Extension 不得开启 Unsafe Mode。
24. Unsafe Mode 不关闭 Hard Deny。
25. Secret Value 不得进入 Policy Store。
26. Provider Native Approval 不得绕过 AgentOS。
27. Process Runtime 必须是 Process Action Enforcement Point。
28. Worktree Runtime 必须是 Worktree Action Enforcement Point。
29. Git Merge 和 Push 必须独立评估。
30. Workspace Root Write 默认高于 Worktree Write 风险。
31. Shell 默认关闭。
32. Shell 安全不得被夸大。
33. Network Redirect 必须重新评估。
34. Upload 必须独立评估。
35. Secret Injection 必须绑定 Target。
36. Extension 权限必须声明。
37. Extension 新权限必须重新批准。
38. Policy Engine 高风险故障必须 Fail Closed。
39. Low-risk Degraded Mode 必须受限。
40. Policy Cache 不得绕过动态 Ownership。
41. Policy Exception 必须受限、可审计、可过期。
42. Protected Branch 必须有独立规则。
43. Force Push 默认 Deny。
44. Unmanaged Recursive Delete 默认 Deny。
45. Privilege Elevation 默认 Deny。
46. Review-only Agent 默认不可修改。
47. Memory Scope Promotion 必须可审计。
48. Artifact Export 必须考虑敏感等级。
49. v1 Prompt-only Safety 必须最终废弃。
50. Policy Runtime 必须通过 Core Hard Deny Regression Tests。

---

# Part XXXI — Final Definition

## 156. Final Definition

AgentOS v2 Policy Runtime 定义如下：

> Policy Runtime 是 AgentOS 对所有受控 Runtime 行为实施授权与风险控制的统一安全层。任何 Agent、Provider、Provider Native Subagent、Workflow、Extension、API Client 或 System Component 发起 Process、Command、File、Network、Git、Worktree、Package、Secret、Artifact、Memory、Extension 或 System Action 时，都必须先被标准化为 Principal、Action、Resource 和 Policy Context，再由冻结的 Effective Policy Profile 进行 Rule Matching、Risk Assessment 和 Precedence Resolution，最终返回 Allow、Deny 或 Require Approval。Require Approval 会创建持久 Approval Request，用户决策后生成受限 Grant，并重新评估原 Action。对应 Runtime Enforcement Point 负责真正执行或阻止行为，并将 Decision、Approval、Grant、Execution 和 Violation 全部记录为 Runtime Event 与 Audit Record。

简化表达：

```text
Principal requests Action on Resource
  ↓
Normalize
  ↓
Effective Policy Snapshot
  ↓
Rule Match + Risk
  ↓
Decision
  ├── Allow + Constraints
  ├── Deny
  └── Require Approval
        ↓
      User Decision
        ↓
      Scoped Grant
        ↓
      Re-evaluate
        ↓
Runtime Enforcement
  ↓
Execution Event + Audit
```

核心安全边界：

```text
Prompt Guidance
  = behavior suggestion

Provider Sandbox
  = provider-side defense

AgentOS Policy Runtime
  = authoritative runtime decision

Runtime Enforcement Point
  = actual execution control
```

本文件定义的 Policy Runtime 是 AgentOS v2 Human-in-the-Loop、Approval Center、Safe Execution、Secret Isolation、Protected Branch、Extension Permission、Unsafe Mode 和可审计自主执行能力的安全基础。
