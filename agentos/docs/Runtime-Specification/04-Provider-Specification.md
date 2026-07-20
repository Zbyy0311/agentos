# AgentOS Runtime Specification v2.0

## 04 — Provider Specification

> Status: Draft  
> Version: 2.0  
> Last Updated: 2026-07-19  
> Scope: AgentOS v2 Provider Runtime and Adapter Protocol  
> Depends On:
> - `00-Vision.md`
> - `01-Core-Concepts.md`
> - `02-Runtime-Lifecycle.md`
> - `03-Event-Model.md`
> Repository: `Zbyy0311/agentos`

---

## 1. Document Purpose

本文件定义 AgentOS v2 的 Provider Runtime Specification。

Provider Specification 是 AgentOS Runtime 与外部 AI Coding Agent 之间的统一接入协议。

它规定：

- Provider 的定义和边界；
- Provider Type；
- Provider Configuration；
- Provider Capability；
- Provider Adapter；
- Provider Registry；
- Provider Validation；
- Provider Session；
- Provider Process；
- Provider Input；
- Prompt 和 Context；
- Provider Output；
- Runtime Event 映射；
- Authentication；
- Environment；
- Secret；
- Session Resume；
- Pause、Cancel 和 Approval；
- Error Normalization；
- Version Compatibility；
- Provider Fallback；
- Provider-specific Requirements；
- Mock Provider；
- Testing；
- v1 迁移。

本文件的目标是确保：

> AgentOS Runtime Core 不需要知道 Codex、KimiCode、OpenCode、Claude Code 或其他 Provider 的具体调用细节。

所有 Provider 特定行为必须被限制在：

```text
Provider Adapter
Provider Package
Provider-specific Configuration
```

之内。

---

## 2. Provider Vision

AgentOS 不构建一个统一模型。

AgentOS 构建一个统一运行边界。

```text
AgentOS Runtime Request
        ↓
Provider Adapter
        ↓
Codex / KimiCode / OpenCode / Claude Code / Gemini / Custom CLI
        ↓
Provider Native Runtime
        ↓
Canonical Runtime Event
```

Provider 可以在以下方面完全不同：

- CLI；
- API；
- 登录方式；
- Session；
- Model；
- Prompt 协议；
- 输出格式；
- Tool；
- Subagent；
- Approval；
- Token Usage；
- Process 模型。

AgentOS 只要求它们通过 Adapter 对外表现出统一行为。

---

## 3. Core Principles

### 3.1 Agent Is Not Provider

Agent Profile 表示团队角色。

Provider 表示外部执行能力。

```text
Agent Profile:
  Backend Engineer

Provider:
  KimiCode
```

同一个 Agent 可以在不同 Run 中使用不同 Provider。

### 3.2 Provider Type Is Not Provider Configuration

`kimicode` 是 Provider Type。

“本机 KimiCode”是一个 Provider Configuration。

### 3.3 Provider Configuration Is Data

Provider Configuration 描述如何调用 Provider。

Provider Adapter 是实现调用逻辑的代码。

### 3.4 Runtime Core Is Provider-Agnostic

Run Engine 不得出现：

```ts
if (provider === 'kimicode') { ... }
```

Provider 分支必须由 Provider Registry 和 Adapter 处理。

### 3.5 Native Capability Must Not Be Invented

Provider 不支持某项能力时：

- 明确声明 `false`；
- 使用降级模式；
- 不伪造结构化事件。

### 3.6 Provider Output Must Be Normalized

Provider 原生输出不能直接成为 AgentOS 核心协议。

必须经过 Adapter 映射为 Runtime Event。

### 3.7 Provider Failure Must Be Normalized

用户应看到稳定错误：

```text
PROVIDER_AUTH_REQUIRED
```

而不是只看到不可读的底层堆栈。

### 3.8 Security Is Runtime-Controlled

Provider 自身权限设置不能替代 AgentOS Policy。

### 3.9 Direct Provider Invocation

Provider 必须调用其真实 Runtime。

特别规定：

> KimiCode Provider 必须直接调用 KimiCode CLI，不得默认通过 OpenCode CLI 间接加载 Kimi 模型。

---

# Part I — Provider Domain Model

## 4. Provider Type

### 4.1 Definition

Provider Type 是 AgentOS 支持的一类外部 AI Runtime。

```ts
type ProviderType =
  | 'codex'
  | 'claude-code'
  | 'kimicode'
  | 'opencode'
  | 'gemini-cli'
  | 'custom-cli'
  | 'remote';
```

未来可扩展：

```text
local-model
container-agent
ssh-agent
api-agent
mcp-agent
```

### 4.2 Provider Type Rules

1. 使用全小写 kebab-case；
2. 名称表示真实 Runtime；
3. 不使用模型名称代替 Provider；
4. 不使用 Agent Role 代替 Provider；
5. Provider Type 必须在 Provider Registry 注册；
6. Type 稳定后不得随意更改。

---

## 5. Provider Configuration

### 5.1 Definition

Provider Configuration 是某个 Provider 的具体可执行配置实例。

```ts
interface ProviderConfiguration {
  id: string;

  workspaceId?: string;

  name: string;

  providerType: ProviderType;

  adapterId: string;

  runtimeMode:
    | 'cli'
    | 'api'
    | 'ssh'
    | 'container';

  executable?: string;

  argsTemplate?: string[];

  model?: string;

  environmentProfileId?: string;

  secretProfileId?: string;

  workingDirectoryMode:
    | 'workspace'
    | 'worktree'
    | 'custom';

  customWorkingDirectory?: string;

  capabilities: ProviderCapabilities;

  timeoutPolicy?: ProviderTimeoutPolicy;

  approvalMode:
    | 'agentos'
    | 'native'
    | 'hybrid'
    | 'disabled';

  outputMode:
    | 'structured'
    | 'parsed-text'
    | 'raw-stream';

  enabled: boolean;

  version: number;

  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}
```

### 5.2 Global vs Workspace Configuration

Provider Configuration 可以：

- 全局存在；
- 只属于某个 Workspace。

优先级：

```text
Run Override
  > Workspace Provider Configuration
  > Global Provider Configuration
```

### 5.3 Configuration Examples

#### KimiCode

```json
{
  "name": "Local KimiCode",
  "providerType": "kimicode",
  "adapterId": "builtin.kimicode",
  "runtimeMode": "cli",
  "executable": "C:\\Users\\Administrator\\.kimi-code\\bin\\kimi.exe",
  "workingDirectoryMode": "worktree",
  "approvalMode": "agentos",
  "outputMode": "structured"
}
```

#### OpenCode

```json
{
  "name": "Local OpenCode",
  "providerType": "opencode",
  "adapterId": "builtin.opencode",
  "runtimeMode": "cli",
  "executable": "opencode",
  "workingDirectoryMode": "worktree"
}
```

### 5.4 Configuration Invariants

1. `providerType` 必须与 Adapter 支持的 Type 一致。
2. `adapterId` 必须在 Registry 中存在。
3. CLI Mode 必须有可解析 executable。
4. API Mode 必须有受控 Credential Reference。
5. Secret 不得直接写入 Configuration JSON。
6. Custom Working Directory 必须经过 Policy 验证。
7. 禁用 Configuration 不得用于新 Run。
8. 历史 Run 必须保留 Provider Snapshot。
9. Provider Configuration 修改时必须增加 version。
10. 删除应优先使用 Archive。

---

## 6. Provider Capabilities

### 6.1 Canonical Capability Model

```ts
interface ProviderCapabilities {
  sessionResume: boolean;

  structuredEvents: boolean;

  nativeApprovals: boolean;

  subagents: boolean;

  toolEvents: boolean;

  fileEvents: boolean;

  usageEvents: boolean;

  reasoningStream: boolean;

  interactiveInput: boolean;

  pause: boolean;

  cancellation: boolean;

  modelSelection: boolean;

  workspaceAwareness: boolean;

  nativeSandbox: boolean;

  outputContracts: boolean;
}
```

### 6.2 Capability Sources

Capability 可以来自：

1. Adapter 静态声明；
2. CLI Version Detection；
3. Provider Validation；
4. Runtime Negotiation；
5. User Override。

优先级：

```text
Runtime Negotiation
  > Version-specific Capability
  > Adapter Default
  > User Override only for disabling
```

用户不得强制把 Provider 不支持的能力设为 `true`。

### 6.3 Effective Capabilities

Run 使用：

```ts
interface EffectiveProviderCapabilities
  extends ProviderCapabilities {
  source: Record<keyof ProviderCapabilities, string>;
}
```

用于说明某项 Capability 的判断来源。

### 6.4 Capability Fidelity

Timeline 应标记：

- Native Structured；
- Adapter Parsed；
- Raw Fallback。

---

## 7. Provider Snapshot

Run 创建时必须冻结 Provider Snapshot。

```ts
interface ProviderConfigurationSnapshot {
  providerConfigId: string;

  configurationVersion: number;

  name: string;

  providerType: ProviderType;

  adapterId: string;

  adapterVersion: string;

  runtimeMode: string;

  executable?: string;

  argsTemplate?: string[];

  model?: string;

  environmentProfileId?: string;

  secretProfileId?: string;

  workingDirectoryMode: string;

  capabilities: ProviderCapabilities;

  timeoutPolicy: ProviderTimeoutPolicy;

  approvalMode: string;

  outputMode: string;

  validatedCliVersion?: string;

  validatedAt?: string;
}
```

Snapshot 不得包含：

- Secret 明文；
- Token；
- Cookie；
- Private Key；
- 完整 Environment；
- OAuth Session 内容。

---

# Part II — Provider Adapter

## 8. Adapter Definition

Provider Adapter 是 AgentOS Runtime 与真实 Provider 之间的唯一协议边界。

```text
Run Engine
  ↓
Provider Registry
  ↓
Provider Adapter
  ↓
Provider Native Runtime
```

Adapter 负责：

- Validation；
- Executable Discovery；
- Capability Detection；
- Launch Plan；
- Session Creation；
- Output Parsing；
- Event Mapping；
- Native Approval Bridge；
- Session Resume；
- Cancellation；
- Error Normalization；
- Finalization。

---

## 9. Adapter Interface

```ts
interface RuntimeProviderAdapter {
  readonly id: string;

  readonly version: string;

  readonly providerTypes: ProviderType[];

  getDefaultCapabilities(
    config: ProviderConfiguration
  ): ProviderCapabilities;

  discover(
    input: ProviderDiscoveryInput
  ): Promise<ProviderDiscoveryResult>;

  validate(
    input: ProviderValidationInput
  ): Promise<ProviderValidationResult>;

  buildLaunchPlan(
    input: ProviderStartInput
  ): Promise<ProviderLaunchPlan>;

  start(
    input: ProviderStartInput,
    context: ProviderRuntimeContext
  ): Promise<ProviderSessionHandle>;

  resume?(
    input: ProviderResumeInput,
    context: ProviderRuntimeContext
  ): Promise<ProviderSessionHandle>;

  sendInput?(
    session: ProviderSessionHandle,
    input: ProviderInteractiveInput
  ): Promise<void>;

  approve?(
    session: ProviderSessionHandle,
    decision: ProviderApprovalDecision
  ): Promise<void>;

  pause?(
    session: ProviderSessionHandle
  ): Promise<ProviderPauseResult>;

  cancel(
    session: ProviderSessionHandle,
    reason: ProviderCancelReason
  ): Promise<ProviderCancelResult>;

  parseChunk(
    chunk: ProviderOutputChunk,
    context: ProviderParseContext
  ): Promise<ProviderParsedOutput>;

  finalize(
    session: ProviderSessionHandle,
    context: ProviderFinalizeContext
  ): Promise<ProviderFinalResult>;

  normalizeError(
    error: unknown,
    context: ProviderErrorContext
  ): ProviderNormalizedError;

  dispose?(): Promise<void>;
}
```

### 9.1 Adapter Interface Rules

1. Adapter 不直接更新 Run 数据库。
2. Adapter 通过 Runtime Context 发出 Event Draft。
3. Adapter 不直接创建 Task。
4. Adapter 不直接决定 Task 是否完成。
5. Adapter 不直接 Merge Worktree。
6. Adapter 不得绕过 Policy Engine。
7. Adapter 不得持久化 Secret 到普通 Event。
8. Adapter 必须支持可靠 Cancel。
9. Adapter 必须返回稳定 Normalized Error。
10. Adapter 必须可被 Mock 替换。

---

## 10. Provider Registry

### 10.1 Definition

Provider Registry 保存所有已安装 Adapter。

```ts
interface ProviderRegistry {
  register(adapter: RuntimeProviderAdapter): void;

  unregister(adapterId: string): void;

  get(adapterId: string): RuntimeProviderAdapter;

  findByType(
    providerType: ProviderType
  ): RuntimeProviderAdapter[];

  list(): ProviderAdapterManifest[];
}
```

### 10.2 Adapter Manifest

```ts
interface ProviderAdapterManifest {
  id: string;
  name: string;
  version: string;
  providerTypes: ProviderType[];
  runtimeModes: Array<
    'cli' | 'api' | 'ssh' | 'container'
  >;
  builtIn: boolean;
  description?: string;
}
```

### 10.3 Registry Invariants

1. Adapter ID 必须唯一。
2. 同一 Provider Type 可以存在多个 Adapter。
3. Built-in Adapter 不得被普通 Extension 覆盖。
4. Adapter Version 必须进入 Snapshot。
5. Registry 不得在 Run 中途替换当前 Adapter 实例。
6. 未找到 Adapter 返回 `PROVIDER_ADAPTER_NOT_FOUND`。

---

## 11. Provider Runtime Context

```ts
interface ProviderRuntimeContext {
  workspace: WorkspaceSnapshot;

  task: TaskSnapshot;

  run: RunSnapshot;

  stage: RunStageSnapshot;

  agent: AgentSnapshot;

  provider: ProviderConfigurationSnapshot;

  worktree?: WorktreeSnapshot;

  memoryContext?: MemoryContext;

  policyContext: ProviderPolicyContext;

  processManager: ProviderProcessPort;

  eventSink: ProviderEventSink;

  artifactSink: ProviderArtifactSink;

  secretResolver: ProviderSecretResolver;

  logger: ProviderLogger;

  signal: AbortSignal;
}
```

Adapter 只能通过受控 Port 与 Runtime 交互。

---

## 12. Ports

### 12.1 Event Sink

```ts
interface ProviderEventSink {
  emit<T>(
    draft: ProviderEventDraft<T>
  ): Promise<RuntimeEvent<T>>;
}
```

### 12.2 Process Port

```ts
interface ProviderProcessPort {
  spawn(
    plan: ProviderLaunchPlan
  ): Promise<ManagedProcessHandle>;

  stop(
    processId: string,
    reason: string
  ): Promise<void>;
}
```

### 12.3 Artifact Sink

```ts
interface ProviderArtifactSink {
  create(
    input: CreateArtifactInput
  ): Promise<Artifact>;
}
```

### 12.4 Secret Resolver

```ts
interface ProviderSecretResolver {
  resolveReference(
    reference: string
  ): Promise<SecretValue>;

  withEphemeralEnvironment(
    references: string[]
  ): Promise<Record<string, string>>;
}
```

Adapter 不得直接读取全局 Secret Store。

---

# Part III — Discovery and Validation

## 13. Provider Discovery

### 13.1 Purpose

Discovery 用于查找 Provider Runtime。

```ts
interface ProviderDiscoveryInput {
  providerType: ProviderType;
  configuredExecutable?: string;
  environment: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homeDirectory: string;
}
```

### 13.2 Result

```ts
interface ProviderDiscoveryResult {
  found: boolean;

  candidates: Array<{
    executable: string;
    source:
      | 'configuration'
      | 'environment'
      | 'path'
      | 'default-location'
      | 'registry';
    confidence: number;
  }>;

  selected?: string;

  warnings: string[];
}
```

### 13.3 Discovery Order

推荐：

```text
Explicit Provider Configuration
  > Provider-specific Environment Variable
  > PATH
  > Known Default Installation Paths
  > Platform Registry / Package Manager Metadata
```

### 13.4 Discovery Must Not Mutate

Discovery 不得：

- 安装 Provider；
- 自动修改 PATH；
- 自动登录；
- 修改用户配置；
- 写入 Workspace。

---

## 14. Validation

### 14.1 Input

```ts
interface ProviderValidationInput {
  configuration: ProviderConfiguration;
  workspace?: WorkspaceSnapshot;
  forceRefresh?: boolean;
}
```

### 14.2 Result

```ts
interface ProviderValidationResult {
  valid: boolean;

  executableResolved?: string;

  cliVersion?: string;

  authenticated?: boolean;

  capabilities: ProviderCapabilities;

  outputMode: ProviderConfiguration['outputMode'];

  warnings: ProviderValidationWarning[];

  errors: ProviderValidationError[];

  checkedAt: string;
}
```

### 14.3 Validation Phases

```text
1. Validate Configuration Schema
2. Discover Executable
3. Check File / Command Availability
4. Read Version
5. Check Supported Version Range
6. Check Authentication
7. Detect Capabilities
8. Validate Workspace Access
9. Validate Output Mode
10. Return Result
```

### 14.4 Validation Must Be Side-Effect-Light

Validation 可以：

- 执行 version；
- 执行 auth status；
- 读取配置状态；
- 执行只读诊断。

Validation 不应：

- 创建 Session；
- 修改代码；
- 写 Provider 用户配置；
- 安装依赖；
- 启动长期进程。

### 14.5 Validation Cache

缓存键：

```text
providerConfigId
configurationVersion
executable mtime
environmentProfileVersion
adapterVersion
```

关键 Run 启动前可以复用短期缓存，但必须检查配置版本。

---

## 15. Authentication States

```ts
type ProviderAuthenticationState =
  | 'authenticated'
  | 'unauthenticated'
  | 'expired'
  | 'unknown'
  | 'not-required';
```

### 15.1 Auth Error

未登录必须归一化为：

```text
PROVIDER_AUTH_REQUIRED
```

### 15.2 Auth Responsibility

AgentOS 可以：

- 检测登录状态；
- 展示登录指导；
- 启动 Provider 官方登录流程；
- 重新验证。

AgentOS 不应：

- 保存用户密码；
- 模拟未授权登录；
- 绕过 OAuth；
- 从其他 Provider 复制 Credential。

---

# Part IV — Launch Plan and Input

## 16. Provider Start Input

```ts
interface ProviderStartInput {
  workspace: WorkspaceSnapshot;

  task: TaskSnapshot;

  run: RunSnapshot;

  stage: RunStageSnapshot;

  agent: AgentSnapshot;

  provider: ProviderConfigurationSnapshot;

  worktree?: WorktreeSnapshot;

  memoryContext?: MemoryContext;

  prompt: ProviderPrompt;

  outputContract?: OutputContract;

  timeoutPolicy: ProviderTimeoutPolicy;

  policyContext: ProviderPolicyContext;

  environmentOverrides?: Record<string, string>;

  signal: AbortSignal;
}
```

---

## 17. Provider Prompt

```ts
interface ProviderPrompt {
  format:
    | 'plain-text'
    | 'markdown'
    | 'json'
    | 'provider-native';

  content: string;

  sections: Array<{
    type:
      | 'system'
      | 'role'
      | 'task'
      | 'workflow'
      | 'memory'
      | 'previous-output'
      | 'policy-guidance'
      | 'worktree'
      | 'output-contract';
    contentHash: string;
    artifactId?: string;
  }>;

  promptArtifactId?: string;

  redacted: boolean;
}
```

### 17.1 Prompt Rules

1. Prompt 由 Runtime Prompt Builder 构建。
2. Adapter 可做 Provider-specific Formatting。
3. Adapter 不得随意删除 Policy Guidance。
4. Adapter 不得注入 Secret 明文到 Prompt Artifact。
5. Prompt 必须可审计。
6. Message 不等于 Prompt。
7. Memory 必须按 Memory Context 注入。
8. Previous Output 优先使用 Summary 和 Artifact。

---

## 18. Launch Plan

```ts
interface ProviderLaunchPlan {
  runtimeMode:
    | 'cli'
    | 'api'
    | 'ssh'
    | 'container';

  executable?: string;

  args: string[];

  cwd: string;

  environment: Record<string, string>;

  redactedEnvironmentKeys: string[];

  stdinMode:
    | 'none'
    | 'prompt'
    | 'interactive';

  promptDelivery:
    | 'argument'
    | 'stdin'
    | 'file'
    | 'api-body'
    | 'provider-native';

  structuredOutput:
    | 'jsonl'
    | 'json'
    | 'text'
    | 'provider-native';

  cleanupFiles: string[];

  metadata: Record<string, unknown>;
}
```

### 18.1 Launch Plan Audit

必须记录脱敏版本：

- executable；
- args；
- cwd；
- Environment Key Names；
- Prompt Delivery；
- Output Mode。

### 18.2 Shell Use

默认：

```text
shell = false
```

只有确实需要时允许 Shell，并必须经过 Policy。

### 18.3 Argument Safety

禁止将用户文本直接拼接成未转义 Shell 字符串。

---

## 19. Working Directory Resolution

优先级：

```text
Stage Worktree
  > Run Worktree
  > Workspace Root for Read-only Run
  > Validated Custom Directory
```

### 19.1 Modifying Run

修改型 Run 默认必须：

```text
cwd = worktree.path
```

### 19.2 Provider Override

Provider 不得自行切换到 Workspace Root 绕过 Worktree。

---

## 20. Environment Resolution

环境来源：

```text
System Safe Base Environment
  ↓
Workspace Environment Profile
  ↓
Provider Environment Profile
  ↓
Run Environment Override
  ↓
Ephemeral Secret Injection
```

### 20.1 Precedence

```text
Run Override
  > Provider Profile
  > Workspace Profile
  > Safe Base Environment
```

### 20.2 Denylist

默认不得直接继承：

- 不相关 Secret；
- 其他 Provider Token；
- Admin Credential；
- Cloud Credential；
- 私钥路径；
- Session Cookie。

### 20.3 Provider-specific Home

允许 Provider Adapter 注入：

```text
CODEX_HOME
KIMICODE_HOME
OPENCODE_HOME
```

但变量名称和目录必须由 Adapter 规范化。

---

# Part V — Session and Process

## 21. Provider Session

### 21.1 Definition

Provider Session 是 AgentOS 与 Provider 原生会话的绑定。

```ts
interface ProviderSessionHandle {
  id: string;

  providerType: ProviderType;

  providerConfigId: string;

  runId: string;

  stageId: string;

  nativeSessionId?: string;

  processId?: string;

  status:
    | 'starting'
    | 'active'
    | 'waiting'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled';

  startedAt: string;

  metadata: Record<string, unknown>;
}
```

### 21.2 Session Lifecycle

```text
created
  ↓
starting
  ↓
active
  ├── waiting
  ├── paused
  ├── completed
  ├── failed
  └── cancelled
```

### 21.3 Session Invariants

1. Session 必须属于 Run 和 Stage。
2. nativeSessionId 只由 Adapter 解释。
3. Session 不等于 Conversation。
4. Session 可以没有 Process。
5. Session 可以跨多个 Process。
6. Session Metadata 不得包含 Secret。
7. Session 状态变化必须产生 Event。

---

## 22. Runtime Process

CLI Provider 通常通过 Process Manager 启动。

Adapter 不得直接裸调用：

```ts
child_process.spawn()
```

而必须使用 Process Port。

原因：

- Process Tree；
- Heartbeat；
- Timeout；
- Cancel；
- Audit；
- Recovery；
- Redaction；
- Cross-platform 管理。

---

## 23. Process Input and Output

### 23.1 stdin

Adapter 必须声明：

- 是否需要 stdin；
- Prompt 是否通过 stdin；
- 是否持续交互；
- 是否支持 Approval 回传。

### 23.2 stdout / stderr

Adapter 收到 Chunk 后：

```text
Raw Chunk
  ↓
Decode
  ↓
Buffer Framing
  ↓
Parse Native Event
  ↓
Map Canonical Event
  ↓
Emit
```

### 23.3 Encoding

默认 UTF-8。

Adapter 必须处理：

- Chunk 边界；
- 多字节字符；
- JSONL 半包；
- CRLF；
- ANSI Escape；
- Windows Code Page fallback。

---

## 24. Output Chunk

```ts
interface ProviderOutputChunk {
  stream:
    | 'stdout'
    | 'stderr'
    | 'api'
    | 'socket';

  bytes: Uint8Array;

  receivedAt: string;

  processId?: string;

  nativeSequence?: number;
}
```

### 24.1 Parsed Output

```ts
interface ProviderParsedOutput {
  events: ProviderEventDraft[];

  incomplete: boolean;

  bufferedBytes: number;

  rawArtifactAppend?: Uint8Array;

  warnings: string[];
}
```

---

## 25. Interactive Input

Provider 支持时：

```ts
interface ProviderInteractiveInput {
  type:
    | 'user-message'
    | 'approval'
    | 'continue'
    | 'interrupt'
    | 'custom';

  content?: string;

  metadata?: Record<string, unknown>;
}
```

Interactive Input 必须：

- 记录 Event；
- 经过 Policy；
- 与 Conversation Message 区分；
- 不允许跨 Session 误发送。



# Part VI — Event Mapping and Finalization

## 26. Canonical Event Mapping

Provider Adapter 必须将原生行为映射为 `03-Event-Model.md` 中定义的 Canonical Event。

### 26.1 Mapping Layers

```text
Native Provider Data
  ↓
Native Decoder
  ↓
Provider Intermediate Event
  ↓
Canonical Mapper
  ↓
Runtime Event Draft
```

### 26.2 Required Minimum Events

所有 Provider 至少必须能够产生：

- `provider.validation_started`；
- `provider.validation_completed` 或 `provider.validation_failed`；
- `provider.session_started`；
- `process.started`，CLI 模式适用；
- `stream.text_delta`；
- `process.exited`，CLI 模式适用；
- `provider.session_completed` 或 `provider.session_failed`。

### 26.3 Optional Rich Events

Provider 支持时映射：

- Tool；
- Command；
- File；
- Patch；
- Git；
- Subagent；
- Usage；
- Public Reasoning；
- Native Approval；
- Artifact。

### 26.4 No Fabrication

无法可靠识别时：

- 发 `stream.text_delta`；
- 保留 Raw Output Artifact；
- 标记 Timeline Fidelity。

不得猜测：

- Tool Name；
- File Change；
- Subagent；
- Token Usage；
- Reasoning；
- Approval。

---

## 27. Provider Event Draft

```ts
interface ProviderEventDraft<T = unknown> {
  type: RuntimeEventType;

  severity?: EventSeverity;

  visibility?: EventVisibility;

  durability?: EventDurability;

  correlationId?: string;

  causationId?: string;

  parentEventId?: string;

  payload: T;

  metadata?: {
    nativeEventId?: string;
    nativeEventType?: string;
    inferred?: boolean;
    confidence?: number;
    adapterVersion?: string;
  };
}
```

Adapter 不设置：

- Event ID；
- Run Sequence；
- Persisted Timestamp。

这些由 Runtime Event Factory 统一生成。

---

## 28. Raw Output

### 28.1 Requirement

所有 Provider 必须支持保留原始输出。

### 28.2 Storage

```text
<workspace>/.agentos/artifacts/<artifactId>/provider-output.log
```

### 28.3 Raw Output Rules

- 默认作为 Restricted 或 Normal Artifact；
- 执行 Secret Scan；
- 设置大小上限；
- 支持分块追加；
- 不直接用作 Timeline；
- Finalize 时生成 Checksum。

---

## 29. Finalization

```ts
interface ProviderFinalizeContext {
  exitCode?: number;

  signal?: string;

  terminationReason?: string;

  outputContract?: OutputContract;

  rawOutputArtifactId?: string;

  parsedEventCount: number;

  sessionStartedAt: string;

  finishedAt: string;
}
```

### 29.1 Final Result

```ts
interface ProviderFinalResult {
  success: boolean;

  providerReportedSuccess?: boolean;

  summary?: string;

  structuredOutput?: unknown;

  outputContractSatisfied: boolean;

  artifactIds: string[];

  usage?: ProviderUsage;

  warnings: string[];

  nativeSessionId?: string;
}
```

### 29.2 Exit Code Is Not Enough

CLI Exit Code 0 不自动表示成功。

Adapter 还必须考虑：

- Provider Final Message；
- Output Contract；
- Parse Error；
- Required Artifact；
- Provider Native Failure Event；
- Cancellation State。

### 29.3 Finalize Events

Finalize 结果应映射：

```text
provider.session_completed
provider.session_failed
usage.finalized
stream.text_completed
artifact.finalized
```

---

# Part VII — Error Model

## 30. Normalized Provider Error

```ts
interface ProviderNormalizedError {
  code: ProviderErrorCode;

  message: string;

  providerType: ProviderType;

  phase:
    | 'discovery'
    | 'validation'
    | 'authentication'
    | 'startup'
    | 'runtime'
    | 'output-parse'
    | 'approval'
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'finalize';

  retryable: boolean;

  retryAfterMs?: number;

  suggestedAction?: string;

  nativeCode?: string;

  nativeMessageRedacted?: string;

  details?: Record<string, unknown>;
}
```

---

## 31. Provider Error Codes

```ts
type ProviderErrorCode =
  | 'PROVIDER_ADAPTER_NOT_FOUND'
  | 'PROVIDER_CONFIG_INVALID'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_EXECUTABLE_NOT_ACCESSIBLE'
  | 'PROVIDER_VERSION_UNSUPPORTED'
  | 'PROVIDER_AUTH_REQUIRED'
  | 'PROVIDER_AUTH_EXPIRED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_QUOTA_EXCEEDED'
  | 'PROVIDER_MODEL_UNAVAILABLE'
  | 'PROVIDER_CAPABILITY_UNAVAILABLE'
  | 'PROVIDER_START_FAILED'
  | 'PROVIDER_SESSION_FAILED'
  | 'PROVIDER_SESSION_NOT_RESUMABLE'
  | 'PROVIDER_OUTPUT_PARSE_FAILED'
  | 'PROVIDER_OUTPUT_INVALID'
  | 'PROVIDER_APPROVAL_FAILED'
  | 'PROVIDER_CANCEL_FAILED'
  | 'PROVIDER_PAUSE_UNSUPPORTED'
  | 'PROVIDER_RESUME_FAILED'
  | 'PROVIDER_NETWORK_ERROR'
  | 'PROVIDER_INTERNAL_ERROR'
  | 'PROVIDER_UNKNOWN_ERROR';
```

### 31.1 Authentication Mapping

以下原生错误统一映射：

```text
login_required
not logged in
OAuth required
token expired
401
unauthenticated
```

映射为：

```text
PROVIDER_AUTH_REQUIRED
```

或：

```text
PROVIDER_AUTH_EXPIRED
```

### 31.2 Rate Limit Mapping

原生 Rate Limit 映射：

```text
PROVIDER_RATE_LIMITED
```

并尽量提供：

```ts
retryAfterMs
```

### 31.3 Unknown Errors

Unknown Error 必须：

- 保留脱敏 Native Message；
- 创建 Debug Artifact；
- 标记是否可重试；
- 不只返回 Exit Code。

---

## 32. Error Retryability

### Retryable

通常包括：

- Rate Limit；
- Temporary Network；
- Provider Temporary Internal Error；
- Process Startup Race；
- Session Resume Temporary Failure。

### Not Retryable Without User Action

- Auth Required；
- Executable Not Found；
- Invalid Configuration；
- Unsupported Version；
- Policy Denied；
- Model Unavailable by configuration。

### 32.1 Suggested Action

示例：

```text
Log in to KimiCode CLI and validate the provider again.
```

```text
Set AGENTOS_KIMICODE_CLI or update the executable path.
```

---

# Part VIII — Cancellation, Pause and Resume

## 33. Cancellation

### 33.1 Requirement

所有 Adapter 必须实现 `cancel()`。

即使 Provider 没有原生 Cancel，也必须通过 Process Manager 终止。

### 33.2 Cancel Sequence

```text
Runtime requests cancel
  ↓
Adapter sends native interrupt if supported
  ↓
Wait graceful timeout
  ↓
Process Manager terminates process tree
  ↓
Adapter finalizes partial output
  ↓
Provider Session cancelled
```

### 33.3 Result

```ts
interface ProviderCancelResult {
  nativeCancelAttempted: boolean;

  nativeCancelSucceeded?: boolean;

  processTerminationRequired: boolean;

  processIdsTerminated: string[];

  warnings: string[];
}
```

### 33.4 Cancel Is Idempotent

Session 已终止时再次 Cancel：

- 返回当前状态；
- 不抛出非必要错误。

---

## 34. Pause

Adapter 支持 Pause 时实现：

```ts
interface ProviderPauseResult {
  paused: boolean;

  nativePause: boolean;

  resumable: boolean;

  nativeSessionId?: string;

  warnings: string[];
}
```

不支持 Pause 时：

```text
PROVIDER_PAUSE_UNSUPPORTED
```

Runtime 可以选择：

- 延迟暂停；
- Process Stop + Resume；
- Child Run Fallback。

---

## 35. Resume

### 35.1 Input

```ts
interface ProviderResumeInput {
  session: ProviderSessionSnapshot;

  provider: ProviderConfigurationSnapshot;

  worktree?: WorktreeSnapshot;

  prompt?: ProviderPrompt;

  reason:
    | 'user'
    | 'approval'
    | 'recovery'
    | 'process-restart';
}
```

### 35.2 Resume Requirements

Adapter 必须验证：

- Native Session ID；
- Provider Authentication；
- Worktree；
- CLI Version；
- Configuration Compatibility；
- Session Age；
- Provider Capability。

### 35.3 Resume Failure

无法 Resume 原 Session 时返回：

```text
PROVIDER_SESSION_NOT_RESUMABLE
```

Runtime 决定是否创建 Child Run。

---

# Part IX — Approval Bridge

## 36. Approval Modes

```ts
type ProviderApprovalMode =
  | 'agentos'
  | 'native'
  | 'hybrid'
  | 'disabled';
```

### AgentOS

AgentOS Policy 完全控制审批。

### Native

Provider 使用原生审批，AgentOS 监听和记录。

### Hybrid

Provider 原生请求映射为 AgentOS Approval Request，由 AgentOS UI 决策后回传 Provider。

### Disabled

不允许需要审批的操作，或 Provider 运行在只读模式。

---

## 37. Native Approval Mapping

Provider 原生 Approval：

```text
Native approval request
  ↓
Adapter parses
  ↓
policy.evaluated
  ↓
approval.required
  ↓
User decision
  ↓
Adapter.approve()
```

### 37.1 Decision

```ts
interface ProviderApprovalDecision {
  approvalRequestId: string;

  decision:
    | 'approve'
    | 'reject';

  scope:
    | 'once'
    | 'run'
    | 'workspace';

  modifiedRequest?: Record<string, unknown>;
}
```

### 37.2 Native Approval Safety

AgentOS 不得自动批准 Provider Native Request，除非：

- Policy 明确允许；
- Scope 有效；
- 请求与已批准内容一致；
- 审计记录存在。

---

# Part X — Timeout and Health

## 38. Provider Timeout Policy

```ts
interface ProviderTimeoutPolicy {
  discoveryTimeoutMs: number;

  validationTimeoutMs: number;

  startupTimeoutMs: number;

  idleTimeoutMs: number | null;

  totalTimeoutMs: number | null;

  cancelGracePeriodMs: number;

  approvalTimeoutMs: number | null;

  heartbeatIntervalMs?: number;
}
```

### 38.1 Recommended Defaults

```text
Discovery: 10 seconds
Validation: 30 seconds
Startup: 60 seconds
Idle: 10 minutes
Total: disabled
Cancel Grace: 5 seconds
Approval: disabled
```

### 38.2 Provider Override

Provider 可以建议更合理值，但 Workspace Policy 有最终限制权。

---

## 39. Health

```ts
interface ProviderHealth {
  status:
    | 'healthy'
    | 'degraded'
    | 'unavailable'
    | 'unknown';

  authenticated?: boolean;

  executableAvailable?: boolean;

  versionSupported?: boolean;

  latencyMs?: number;

  checkedAt: string;

  issues: Array<{
    code: string;
    message: string;
  }>;
}
```

Health Check 不得启动修改型任务。

---

# Part XI — Provider Selection and Fallback

## 40. Provider Selection

Provider 可以由：

- Agent 默认配置；
- Run Override；
- Workflow Stage；
- Planner；
- User；
- Fallback Policy；

选择。

### 40.1 Resolution Priority

```text
Run Stage Override
  > Run Override
  > Workflow Stage Provider
  > Agent Default Provider
  > Workspace Default Provider
```

---

## 41. Selection Criteria

Planner 或 Runtime 可以考虑：

- Required Capabilities；
- Authentication；
- Availability；
- Cost；
- Latency；
- Historical Success Rate；
- User Preference；
- Model Requirement；
- Session Resume；
- Worktree Support；
- Policy Compatibility。

### 41.1 Hard Constraints

Capability、Policy 和 Authentication 属于硬约束。

Cost 和 Historical Metrics 属于软约束。

---

## 42. Provider Fallback

```ts
interface ProviderFallbackPolicy {
  enabled: boolean;

  fallbackProviderConfigIds: string[];

  triggerErrorCodes: ProviderErrorCode[];

  maxFallbacks: number;

  requireUserApproval: boolean;
}
```

### 42.1 Fallback Rule

自动 Fallback 必须：

- 创建新的 Stage Attempt；
- 或创建新的 Run；
- 保留原 Provider Failure；
- 记录 Provider Switch Event；
- 不覆盖旧 Session。

### 42.2 No Silent Fallback

UI 必须显示：

```text
KimiCode failed
→ switched to Codex
```

---

## 43. Provider Comparison

Comparison Workflow 可以让多个 Provider 独立执行。

要求：

- 独立 Stage；
- 独立 Provider Session；
- 修改任务使用独立 Worktree；
- 独立 Usage；
- 独立 Artifact；
- 最终通过 Review Stage 比较。

---

# Part XII — Built-in Provider Specifications

## 44. Codex Provider

### 44.1 Type

```text
codex
```

### 44.2 Adapter

```text
builtin.codex
CodexProviderAdapter
```

### 44.3 Invocation

必须调用真实 Codex CLI 或正式 Codex API Adapter。

### 44.4 Configuration

建议环境变量：

```text
AGENTOS_CODEX_CLI
CODEX_HOME
```

### 44.5 Requirements

- 验证 CLI Version；
- 验证 Authentication；
- 识别 Native Session；
- 结构化输出优先；
- 支持取消；
- 危险 Flag 不得默认开启；
- Worktree 为默认 cwd；
- Provider Native Subagent 通过 `subagent.*` 映射。

### 44.6 Unsafe Flags

类似：

```text
--dangerously-bypass-approvals-and-sandbox
```

只能在：

- 显式 Unsafe Policy Profile；
- User 明确确认；
- Run Snapshot 标记；
- UI 显示风险；

的情况下使用。

不得作为默认参数。

---

## 45. KimiCode Provider

### 45.1 Type

```text
kimicode
```

### 45.2 Adapter

```text
builtin.kimicode
KimiCodeProviderAdapter
```

### 45.3 Mandatory Direct Invocation

KimiCode Provider 必须直接调用 KimiCode CLI。

禁止默认实现：

```text
opencode run --model kimi-for-coding/...
```

因为这属于 OpenCode Provider，而不是 KimiCode Provider。

### 45.4 Executable Discovery

优先级：

```text
Provider Configuration executable
  > AGENTOS_KIMICODE_CLI
  > PATH: kimi
  > Known installation path
```

Windows 已知路径模板：

```text
C:\Users\<USER>\.kimi-code\bin\kimi.exe
```

当前用户已知路径：

```text
C:\Users\Administrator\.kimi-code\bin\kimi.exe
```

### 45.5 Environment

可支持：

```text
AGENTOS_KIMICODE_CLI
KIMICODE_HOME
```

实际 Home 变量名称必须以 KimiCode CLI 官方支持为准；不支持时由 Adapter 仅管理 executable 和进程环境。

### 45.6 Validation

必须检查：

- `kimi --version` 或等价 Version Command；
- Authentication；
- Non-interactive Execution；
- Session Capability；
- Structured Output Capability；
- cwd；
- Windows 子进程稳定性。

### 45.7 Error Mapping

以下情况必须区分：

- CLI 不存在；
- PATH 未配置；
- Auth Required；
- OAuth Login Required；
- Process Assertion；
- Non-zero Exit；
- Session Resume Failure。

### 45.8 Windows Process Failure

遇到类似 Native Assertion 时：

- 保存 stderr Artifact；
- 映射 `PROVIDER_INTERNAL_ERROR` 或 `PROVIDER_SESSION_FAILED`；
- 清理完整 Process Tree；
- 提示检查登录与 CLI Version；
- 不误报为 OpenCode Error。

### 45.9 Acceptance Criteria

KimiCode Adapter 完成标准：

1. 不依赖 OpenCode；
2. 能发现 `kimi.exe`；
3. 能验证登录；
4. 能在 Worktree 中启动；
5. 能流式输出；
6. 能取消；
7. 能归一化错误；
8. 能保留 Raw Output；
9. 能通过 Mock 和 Integration Test；
10. UI 明确显示 Provider 为 KimiCode。

---

## 46. OpenCode Provider

### 46.1 Type

```text
opencode
```

### 46.2 Adapter

```text
builtin.opencode
OpenCodeProviderAdapter
```

### 46.3 Responsibilities

OpenCode Adapter 可以：

- 使用 OpenCode CLI；
- 选择 OpenCode 支持的 Model；
- 映射 OpenCode Session；
- 映射 Tool、File 和 Usage；
- 管理 OpenCode Environment。

### 46.4 Model Selection

Model 属于 OpenCode Provider Configuration。

示例：

```json
{
  "providerType": "opencode",
  "model": "some-provider/some-model"
}
```

此时 UI 应显示：

```text
Provider: OpenCode
Model: some-provider/some-model
```

不得显示为独立 KimiCode Provider。

---

## 47. Claude Code Provider

### 47.1 Type

```text
claude-code
```

### 47.2 Adapter

```text
builtin.claude-code
ClaudeCodeProviderAdapter
```

### 47.3 Requirements

- 真实 Claude Code Runtime；
- Session 检测；
- Native Tool Mapping；
- Native Subagent Mapping；
- Approval Bridge；
- Structured Output 优先；
- Worktree cwd；
- Token / Usage 支持时映射。

Provider-specific CLI 参数不得进入 Run Engine。

---

## 48. Gemini CLI Provider

### 48.1 Type

```text
gemini-cli
```

### 48.2 Adapter

```text
builtin.gemini-cli
GeminiCliProviderAdapter
```

### 48.3 Requirements

与其他 CLI Adapter 相同：

- Discovery；
- Validation；
- Auth；
- Session；
- Structured Output；
- Tool Event；
- Cancel；
- Error Normalization。

---

## 49. Custom CLI Provider

### 49.1 Type

```text
custom-cli
```

### 49.2 Purpose

允许接入没有 Built-in Adapter 的 CLI。

### 49.3 Configuration

```ts
interface CustomCliConfiguration {
  executable: string;

  argsTemplate: string[];

  promptDelivery:
    | 'argument'
    | 'stdin'
    | 'file';

  outputMode:
    | 'jsonl'
    | 'json'
    | 'text';

  sessionIdPattern?: string;

  successExitCodes: number[];

  environmentProfileId?: string;
}
```

### 49.4 Template Variables

允许：

```text
{{prompt}}
{{promptFile}}
{{workspacePath}}
{{worktreePath}}
{{taskId}}
{{runId}}
{{stageId}}
{{model}}
```

### 49.5 Security

- Template 必须参数化；
- 默认 `shell=false`；
- Custom CLI 必须经过 Policy；
- 不允许任意 JavaScript Expression；
- Secret 只能通过 Secret Reference；
- 用户必须明确承担兼容风险。

### 49.6 Limitations

Custom CLI 默认 Capability：

```text
structuredEvents = false
nativeApprovals = false
subagents = false
toolEvents = false
fileEvents = false
usageEvents = false
```

除非用户提供受验证的 Parser Extension。

---

## 50. Remote Provider

### 50.1 Type

```text
remote
```

### 50.2 Runtime Modes

- API；
- SSH；
- Remote Agent Service；
- Container Host。

### 50.3 Requirements

- Connection Validation；
- Credential Reference；
- Network Policy；
- Remote Workspace Mapping；
- Cancellation；
- Heartbeat；
- Event Ordering；
- Artifact Transfer；
- Secret Boundary；
- Remote Process Cleanup。

v2 Foundation 可以只保留接口，不要求完整实现。

---

# Part XIII — Package Architecture

## 51. Recommended Structure

```text
packages/
├── provider-core/
│   ├── adapter.ts
│   ├── registry.ts
│   ├── capabilities.ts
│   ├── configuration.ts
│   ├── errors.ts
│   ├── launch-plan.ts
│   └── testing.ts
│
├── providers/
│   ├── codex/
│   │   ├── adapter.ts
│   │   ├── discovery.ts
│   │   ├── parser.ts
│   │   ├── errors.ts
│   │   └── manifest.ts
│   ├── kimicode/
│   ├── opencode/
│   ├── claude-code/
│   ├── gemini-cli/
│   └── custom-cli/
│
├── process-runtime/
├── runtime-core/
├── policy-engine/
└── shared/
```

### 51.1 Provider Core

只包含：

- Interfaces；
- Registry；
- Common Validation；
- Common Error Types；
- Common Test Contract。

不包含具体 CLI 参数。

### 51.2 Provider Package

每个 Package 只负责一个真实 Provider。

---

## 52. Adapter Factory

```ts
interface ProviderAdapterFactory {
  create(
    configuration: ProviderConfigurationSnapshot
  ): RuntimeProviderAdapter;
}
```

Adapter 实例应按：

- Run；
- Provider Session；
- 或无状态 Singleton；

设计，但不得共享未隔离 Session State。

---

# Part XIV — APIs

## 53. Provider Configuration APIs

```text
GET    /api/providers
POST   /api/providers
GET    /api/providers/:id
PATCH  /api/providers/:id
DELETE /api/providers/:id
POST   /api/providers/:id/validate
GET    /api/providers/:id/capabilities
GET    /api/provider-adapters
```

### 53.1 Discovery

```text
POST /api/providers/discover
```

Input：

```json
{
  "providerType": "kimicode"
}
```

### 53.2 Validation Response

```ts
interface ProviderValidationResponse {
  configurationId: string;
  valid: boolean;
  health: ProviderHealth;
  discovery: ProviderDiscoveryResult;
  validation: ProviderValidationResult;
}
```

---

## 54. Authentication APIs

Provider 官方登录流程需要时：

```text
POST /api/providers/:id/auth/start
GET  /api/providers/:id/auth/status
POST /api/providers/:id/auth/revalidate
```

AgentOS 不自定义 Provider Credential Protocol。

---

## 55. Session Inspector APIs

```text
GET /api/provider-sessions/:id
GET /api/provider-sessions/:id/events
POST /api/provider-sessions/:id/cancel
POST /api/provider-sessions/:id/pause
POST /api/provider-sessions/:id/resume
```

这些操作最终仍通过 Run Lifecycle 执行状态检查。



# Part XV — Testing Specification

## 56. Provider Contract Test Suite

每个 Adapter 必须通过统一 Contract Test。

```ts
interface ProviderContractTestSuite {
  discovery(): Promise<void>;

  validation(): Promise<void>;

  start(): Promise<void>;

  stream(): Promise<void>;

  cancel(): Promise<void>;

  normalizeError(): Promise<void>;

  finalize(): Promise<void>;

  rawOutput(): Promise<void>;

  redaction(): Promise<void>;
}
```

### 56.1 Mandatory Contract Cases

每个 Adapter 必须测试：

1. 配置无效；
2. executable 不存在；
3. Provider 未登录；
4. Version 不支持；
5. 正常启动；
6. 文本流输出；
7. stderr 输出；
8. Non-zero Exit；
9. Cancel；
10. Idle Timeout；
11. Raw Output Artifact；
12. Secret Redaction；
13. Event Ordering；
14. Finalization；
15. 重复 Cancel；
16. Process Tree Cleanup。

### 56.2 Capability-specific Tests

声明 Capability 为 `true` 时必须增加测试：

- `sessionResume` → Resume Test；
- `structuredEvents` → Parser Test；
- `nativeApprovals` → Approval Bridge Test；
- `subagents` → Subagent Event Test；
- `usageEvents` → Usage Test；
- `pause` → Pause / Resume Test。

Adapter 不得声明未经测试的 Capability。

---

## 57. Mock Provider

### 57.1 Purpose

Mock Provider 用于：

- Runtime 开发；
- E2E；
- CI；
- Event Model；
- Approval；
- Failure；
- Recovery；
- UI Timeline。

### 57.2 Type

Mock Provider 不一定作为面向用户的 Provider Type。

推荐：

```text
builtin.mock
```

### 57.3 Scenarios

```ts
type MockProviderScenario =
  | 'success'
  | 'slow-stream'
  | 'tool-calls'
  | 'file-changes'
  | 'subagents'
  | 'approval'
  | 'auth-required'
  | 'rate-limit'
  | 'non-zero-exit'
  | 'idle-timeout'
  | 'parse-error'
  | 'cancel'
  | 'resume'
  | 'process-crash';
```

### 57.4 Determinism

Mock Provider 必须支持：

- 固定 Event 顺序；
- 固定 Delay；
- 固定 Error；
- Seed；
- 可控 Process；
- 可控 Artifact。

---

## 58. Parser Tests

Provider Parser 必须覆盖：

- JSONL 完整行；
- 半行；
- 多行 Chunk；
- UTF-8 多字节边界；
- ANSI；
- CRLF；
- 混合 stdout / stderr；
- Unknown Native Event；
- Malformed JSON；
- 大 Payload；
- Secret；
- Duplicate Native Event ID。

### 58.1 Golden Fixtures

每个 Provider Package 应保存脱敏 Fixture：

```text
fixtures/
├── validation-success.txt
├── auth-required.txt
├── tool-call.jsonl
├── subagent.jsonl
├── failure.txt
└── session-complete.jsonl
```

---

## 59. Integration Tests

至少包含：

### 59.1 KimiCode Direct Invocation

验证：

- 实际使用 `kimi.exe`；
- 不调用 `opencode`；
- cwd 为 Worktree；
- PATH 不存在时仍可使用显式路径；
- 未登录返回 `PROVIDER_AUTH_REQUIRED`；
- Cancel 清理进程树。

### 59.2 Provider Switching

```text
KimiCode fails
  ↓
New Stage Attempt or Run
  ↓
Codex succeeds
```

历史必须保留。

### 59.3 Browser Disconnect

Provider 继续运行，Event 继续持久化。

### 59.4 Server Recovery

恢复 Provider Session 或生成稳定失败。

---

## 60. End-to-End Acceptance Test

```text
Create Workspace
  ↓
Discover KimiCode
  ↓
Create Provider Configuration
  ↓
Validate
  ↓
Create Backend Agent
  ↓
Create Task
  ↓
Create Run
  ↓
Worktree
  ↓
Start KimiCode Session
  ↓
Stream Canonical Events
  ↓
Modify File
  ↓
Run Test
  ↓
Finalize Artifact
  ↓
Complete Run
  ↓
Review Diff
```

---

# Part XVI — Observability

## 61. Provider Metrics

每个 Provider 应记录：

- Discovery Success Rate；
- Validation Success Rate；
- Authentication Failure Rate；
- Startup Latency；
- Time to First Event；
- Session Duration；
- Success Rate；
- Cancel Success Rate；
- Resume Success Rate；
- Parse Error Rate；
- Raw Fallback Rate；
- Event Count；
- Token / Cost；
- Process Crash Rate。

### 61.1 Metric Dimensions

```text
providerType
providerConfigId
adapterId
adapterVersion
cliVersion
workspaceId
```

不得把 Secret 作为 Metric Label。

---

## 62. Provider Inspector

Runtime Inspector 的 Provider 区域应显示：

- Provider Type；
- Provider Configuration；
- Adapter ID / Version；
- CLI Version；
- Model；
- Capability；
- Output Fidelity；
- Native Session ID；
- Process；
- executable；
- argsRedacted；
- cwd；
- Environment Key Names；
- Auth State；
- Validation Time；
- Errors；
- Usage；
- Raw Output Artifact。

---

## 63. Debug Bundle

Provider Debug Bundle：

```text
provider/
├── manifest.json
├── configuration-snapshot.json
├── validation.json
├── capabilities.json
├── launch-plan-redacted.json
├── session.json
├── process.json
├── events.jsonl
├── stdout.log
├── stderr.log
└── error.json
```

Bundle 必须经过 Secret Redaction。

---

# Part XVII — Security Requirements

## 64. Provider Trust Boundary

所有 Provider 输出都视为 Untrusted。

包括：

- Tool Request；
- File Path；
- Command；
- Approval；
- Artifact Name；
- URL；
- Native Event；
- Error Message。

### 64.1 Validation

必须进行：

- Path Normalization；
- Command Policy；
- Event Schema；
- Payload Size；
- Secret Scan；
- URL Policy；
- Artifact Path Validation。

---

## 65. Executable Trust

Provider executable 必须：

- 路径可访问；
- 是文件或可执行命令；
- 来源可识别；
- 不位于 Workspace 可修改目录，除非显式允许；
- 不使用用户输入拼接路径；
- Validation 时记录版本。

### 65.1 Changed Executable

如果 executable 文件发生变化：

- Validation Cache 失效；
- 下次 Run 重新验证；
- 可产生 Security Warning。

---

## 66. Secret Isolation

不同 Provider 的 Secret 必须隔离。

KimiCode Adapter 不应自动获得：

- Codex Token；
- Claude Credential；
- GitHub Token；
- Cloud Key。

只注入 Provider 明确声明所需的 Secret Reference。

---

## 67. Network Policy

API 和 Remote Provider 必须声明：

```ts
interface ProviderNetworkRequirement {
  hosts: string[];
  protocols: string[];
  required: boolean;
}
```

Network 请求经过 Policy。

---

## 68. Unsafe Mode

Unsafe Mode 必须：

- 显式选择；
- 显示风险；
- 写入 Run Snapshot；
- 产生 `policy.profile_snapshot_created`；
- 不作为默认；
- 可按 Run 限定；
- 不隐藏危险参数。

---

# Part XVIII — Version Compatibility

## 69. Adapter Versioning

Adapter 使用 Semantic Versioning。

```text
MAJOR.MINOR.PATCH
```

### Major

- 接口不兼容；
- Event 语义改变；
- Snapshot 不兼容。

### Minor

- 新 Capability；
- 新 Parser；
- 新 Optional Event。

### Patch

- Bug Fix；
- Error Mapping；
- Discovery Fix。

---

## 70. CLI Version Support

每个 Adapter 应声明：

```ts
interface ProviderVersionSupport {
  minimum?: string;
  maximumExclusive?: string;
  testedVersions: string[];
  unknownVersionPolicy:
    | 'allow-with-warning'
    | 'deny'
    | 'raw-fallback';
}
```

### 70.1 Unknown Version

默认建议：

- Validation Warning；
- Structured Parser 可降级；
- 保留 Raw Stream；
- 不静默假设完全兼容。

---

## 71. Snapshot Compatibility

恢复旧 Run 时必须使用：

- Provider Snapshot；
- Adapter Version；
- CLI Version；
- Output Mode。

当前 Adapter 无法解析旧 Snapshot 时：

```text
PROVIDER_SNAPSHOT_INCOMPATIBLE
```

可以：

- 只读 Replay；
- 创建新 Run；
- 不直接修改旧 Run。

---

# Part XIX — v1 Migration

## 72. Current v1 Model

当前 v1 Provider 实际表示为：

```text
Agent Role
  + cliCommand
  + cliArgs
  + model
```

并由通用 `CLIExecutor` 直接 Spawn。

主要问题：

- Agent 与 Provider 混合；
- KimiCode 通过 OpenCode 调用；
- Provider Type 不明确；
- 无 Adapter；
- 无 Capability；
- 无 Session；
- 无 Validation Contract；
- 无 Error Normalization；
- 无 Provider Snapshot；
- 无 Output Fidelity；
- Process 与 Provider 逻辑混合。

---

## 73. Migration Target

```text
Agent Profile
  ↓ references
Provider Configuration
  ↓ resolved by
Provider Registry
  ↓ creates
Provider Adapter
  ↓ uses
Process Manager
  ↓ emits
Runtime Events
```

---

## 74. Migration Step 1 — Introduce Provider Type

新增：

```ts
type ProviderType =
  | 'codex'
  | 'kimicode'
  | 'opencode'
  | 'custom-cli';
```

迁移现有配置。

---

## 75. Migration Step 2 — Fix KimiCode

将：

```text
role: kimi_worker
cliCommand: opencode
model: kimi-for-coding/...
```

拆分为：

```text
Agent Profile:
  role: implementer

Provider Configuration:
  type: kimicode
  executable: kimi.exe
```

原 OpenCode + Kimi Model 配置可保留为另一个明确的 OpenCode Provider Configuration，但不得命名为 KimiCode。

---

## 76. Migration Step 3 — Wrap CLIExecutor

第一阶段可以：

```text
Provider Adapter
  ↓
Existing CLIExecutor
```

保持已有 Process 能力。

随后拆分：

```text
Provider Adapter
Process Manager
Output Parser
Event Sink
```

---

## 77. Migration Step 4 — Provider Registry

将固定 Config Map 替换为 Registry。

旧配置通过 Compatibility Mapper 转换。

---

## 78. Migration Step 5 — Event Mapping

旧 `onOutput(string)`：

```text
stream.text_delta
```

Provider Parser 稳定后逐步增加：

- Tool；
- Command；
- File；
- Usage；
- Subagent。

---

## 79. Migration Step 6 — Validation API

新增：

```text
POST /api/providers/:id/validate
```

Workspace 创建时不再假设所有 Provider 可用。

---

## 80. Migration Step 7 — Remove Hard-coded Provider Logic

Run Engine 中不得保留：

- Codex Prompt Branch；
- Kimi Prompt Branch；
- OpenCode Prompt Branch；
- 固定 CLI Args。

这些进入对应 Adapter 或 Workflow Stage Prompt Template。

---

# Part XX — Implementation Plan

## 81. Phase 1 Built-in Adapters

必须实现：

1. Custom CLI Adapter；
2. Codex Adapter；
3. KimiCode Adapter；
4. OpenCode Adapter；
5. Mock Adapter。

原因：

- Custom CLI 提供通用降级；
- Codex 保留当前 Manager 能力；
- KimiCode 修正当前错误；
- OpenCode 保留独立 Provider；
- Mock 支持测试。

---

## 82. Phase 2 Adapters

- Claude Code；
- Gemini CLI；
- Remote SSH。

---

## 83. Development Order

```text
Provider Core Types
  ↓
Provider Registry
  ↓
Discovery + Validation
  ↓
Custom CLI Adapter
  ↓
Process Port
  ↓
Event Sink
  ↓
Codex Adapter
  ↓
KimiCode Adapter
  ↓
OpenCode Adapter
  ↓
Contract Tests
  ↓
UI Provider Settings
```

---

## 84. Definition of Done — Provider Foundation

Provider Foundation 完成时必须满足：

- Agent 与 Provider 分离；
- Provider Configuration 持久化；
- Provider Registry 可工作；
- Adapter Contract 稳定；
- Codex、KimiCode、OpenCode 独立；
- KimiCode 直接调用 `kimi.exe`；
- Provider 可验证；
- Auth Error 可识别；
- Run 保存 Provider Snapshot；
- CLI 通过 Process Manager 启动；
- Provider 输出转换成 Runtime Event；
- Raw Output 可保留；
- Cancel 可靠；
- Secret 已脱敏；
- Mock Adapter 覆盖主要场景；
- v1 工作流通过兼容层仍可运行。

---

# Part XXI — Canonical Examples

## 85. Provider Configuration Example

```json
{
  "id": "provider_kimicode_local",
  "workspaceId": "ws_agentos",
  "name": "KimiCode Local",
  "providerType": "kimicode",
  "adapterId": "builtin.kimicode",
  "runtimeMode": "cli",
  "executable": "C:\\Users\\Administrator\\.kimi-code\\bin\\kimi.exe",
  "argsTemplate": [],
  "workingDirectoryMode": "worktree",
  "environmentProfileId": "env_kimicode",
  "approvalMode": "agentos",
  "outputMode": "structured",
  "enabled": true,
  "version": 1
}
```

---

## 86. Validation Result Example

```json
{
  "valid": true,
  "executableResolved": "C:\\Users\\Administrator\\.kimi-code\\bin\\kimi.exe",
  "cliVersion": "detected-version",
  "authenticated": true,
  "capabilities": {
    "sessionResume": true,
    "structuredEvents": true,
    "nativeApprovals": false,
    "subagents": false,
    "toolEvents": true,
    "fileEvents": true,
    "usageEvents": true,
    "reasoningStream": false,
    "interactiveInput": true,
    "pause": false,
    "cancellation": true,
    "modelSelection": false,
    "workspaceAwareness": true,
    "nativeSandbox": false,
    "outputContracts": false
  },
  "outputMode": "structured",
  "warnings": [],
  "errors": [],
  "checkedAt": "2026-07-19T12:00:00.000Z"
}
```

---

## 87. Launch Plan Example

```json
{
  "runtimeMode": "cli",
  "executable": "C:\\Users\\Administrator\\.kimi-code\\bin\\kimi.exe",
  "args": ["<provider-specific-non-interactive-args>"],
  "cwd": "E:\\workspace\\agentos\\.agentos\\worktrees\\run_123",
  "environment": {
    "AGENTOS_TASK_ID": "task_123",
    "AGENTOS_RUN_ID": "run_123"
  },
  "redactedEnvironmentKeys": ["KIMI_CREDENTIAL_REFERENCE"],
  "stdinMode": "prompt",
  "promptDelivery": "stdin",
  "structuredOutput": "provider-native",
  "cleanupFiles": [],
  "metadata": {
    "adapterId": "builtin.kimicode"
  }
}
```

具体 CLI 参数由 Adapter 根据已验证版本生成，不写死在 Runtime Core。

---

## 88. Normalized Error Example

```json
{
  "code": "PROVIDER_AUTH_REQUIRED",
  "message": "KimiCode requires authentication before it can start.",
  "providerType": "kimicode",
  "phase": "authentication",
  "retryable": false,
  "suggestedAction": "Complete KimiCode CLI login and validate this provider again.",
  "nativeCode": "auth.login_required"
}
```

---

## 89. Fallback Example

```text
Stage Attempt 1
  Agent: Backend Engineer
  Provider: KimiCode
  Result: PROVIDER_RATE_LIMITED
        ↓ fallback policy
Stage Attempt 2
  Agent: Backend Engineer
  Provider: Codex
  Result: completed
```

两个 Attempt 必须拥有独立：

- Provider Session；
- Process；
- Event；
- Usage；
- Error / Result。

---

# Part XXII — Anti-Patterns

## 90. Provider Equals Agent

错误：

```ts
role: 'kimi'
```

正确：

```text
Agent Role: backend-engineer
Provider Type: kimicode
```

---

## 91. KimiCode Through OpenCode

错误：

```text
KimiCode Agent
  ↓
opencode run --model kimi...
```

正确：

```text
KimiCode Provider
  ↓
kimi.exe
```

使用 OpenCode 加载 Kimi 模型时，Provider 应明确显示为 OpenCode。

---

## 92. Provider Logic in Run Engine

错误：

```ts
switch (providerType) {
  case 'codex':
    return spawnCodex();
  case 'kimicode':
    return spawnKimi();
}
```

正确：

```ts
const adapter = registry.get(provider.adapterId);
await adapter.start(input, context);
```

---

## 93. Secret in Configuration

错误：

```json
{
  "apiKey": "secret"
}
```

正确：

```json
{
  "secretProfileId": "secret_profile_123"
}
```

---

## 94. Exit Code Equals Success

错误：

```ts
success = exitCode === 0;
```

正确：

```text
Exit
  + Provider Final Result
  + Output Contract
  + Runtime State
  → Stage Result
```

---

## 95. Capability Guessing

错误：

```text
Provider printed "agent"
→ emit subagent.spawned
```

正确：

只有原生事件或高可信 Parser 才能映射 Subagent。

---

## 96. Browser Owns Provider Session

错误：

```text
SSE closes
→ kill provider
```

正确：

```text
Run owns Provider Session
Client only subscribes
```

---

# Part XXIII — Global Invariants

## 97. Provider Invariants

AgentOS v2 必须始终满足：

1. Agent Profile 不等于 Provider。
2. Provider Type 不等于 Provider Configuration。
3. Provider Configuration 是数据，Adapter 是代码。
4. Runtime Core 不包含 Provider 特定分支。
5. 所有 Adapter 必须注册。
6. 所有 Run 必须保存 Provider Snapshot。
7. Provider Secret 不得进入普通配置、Event 或 Snapshot。
8. Provider Output 必须经过 Adapter。
9. 不支持的 Capability 不得伪造。
10. 所有 Provider 必须支持 Cancel。
11. CLI Provider 必须通过 Process Manager。
12. Provider Session 不等于 Conversation。
13. Process Exit 不等于 Provider Success。
14. Provider Success 不等于 Stage 自动成功。
15. Provider Error 必须归一化。
16. Auth Required 必须与普通 Runtime Failure 区分。
17. Provider executable 必须可发现和验证。
18. 修改型 Run 的 cwd 默认是 Worktree。
19. Provider 不得绕过 Policy。
20. Native Approval 必须映射 AgentOS Approval。
21. Native Subagent 不等于 Agent Profile。
22. Raw Output 必须可保留。
23. Event 必须先持久化再广播。
24. Adapter 必须通过 Contract Test。
25. Adapter Version 必须进入 Snapshot。
26. Unknown CLI Version 必须警告或降级。
27. Fallback 不得静默。
28. Retry 不得覆盖旧 Provider Session。
29. Dangerous Flags 不得默认开启。
30. KimiCode 必须直接调用 KimiCode CLI。

---

# Part XXIV — Final Definition

## 98. Final Definition

AgentOS v2 Provider 定义如下：

> Provider 是为 AgentOS 提供 AI 工程执行能力的外部 Runtime 类型。Provider Configuration 描述某个 Runtime 的具体可执行配置，Provider Adapter 则负责发现、验证、启动、恢复、暂停、取消该 Runtime，将 AgentOS 的统一输入转换为 Provider 原生调用，并将 Provider 原生输出、错误、工具、子 Agent、使用量与审批转换为 Canonical Runtime Event。AgentOS Runtime Core 只依赖统一 Adapter Protocol，不依赖任何具体 Provider 的 CLI 参数、输出格式或 Session 实现。

简化表达：

```text
Agent Profile
  ↓ selects
Provider Configuration
  ↓ resolved by
Provider Registry
  ↓ implemented by
Provider Adapter
  ↓ starts
Provider Session
  ↓ managed through
Process Manager
  ↓ produces
Canonical Runtime Events
```

KimiCode 的最终边界定义：

```text
Provider Type:
  kimicode

Adapter:
  KimiCodeProviderAdapter

Runtime:
  KimiCode CLI

Executable:
  kimi / kimi.exe

Not:
  OpenCode CLI + Kimi Model
```

本文件定义的 Provider Specification 是 AgentOS v2 实现跨 Provider Runtime、持久 Agent Team、统一 Timeline、可靠 Process Lifecycle 和 Provider Extension 的协议基础。
