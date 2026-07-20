# AgentOS Runtime Specification v2.0

## 05 — Process Runtime

> Status: Draft  
> Version: 2.0  
> Last Updated: 2026-07-19  
> Scope: AgentOS v2 Operating-System Process Runtime  
> Depends On:
> - `00-Vision.md`
> - `01-Core-Concepts.md`
> - `02-Runtime-Lifecycle.md`
> - `03-Event-Model.md`
> - `04-Provider-Specification.md`
> Repository: `Zbyy0311/agentos`

---

## 1. Document Purpose

本文件定义 AgentOS v2 的 Process Runtime。

Process Runtime 是 AgentOS 与本地或远程操作系统执行环境之间的统一管理层。

它负责：

- 启动 Provider CLI；
- 启动 Tool、Command、Git 和 Test Process；
- 管理 PID 与 Process Tree；
- 管理 stdin、stdout 和 stderr；
- 处理 UTF-8、ANSI、JSONL 和 Chunk Boundary；
- 记录活动时间；
- 实现 Startup、Idle、Total 和 Tool Timeout；
- 实现 Pause、Resume、Cancel 和 Forced Termination；
- 在 Windows 中管理 Job Object 或完整进程树；
- 在 Linux/macOS 中管理 Process Group 和 Signal；
- 防止 Browser Disconnect 误杀进程；
- 支持 Server Shutdown；
- 支持 Server Restart Recovery；
- 识别 Orphan Process；
- 清理残留进程；
- 归一化 Process Error；
- 生成 Process Runtime Event；
- 生成 Raw Output Artifact；
- 执行 Command 和 Environment 安全策略；
- 提供 Process Inspector；
- 支持资源限制和运行统计。

本文件是以下模块的实现规范：

- Process Manager；
- Platform Process Driver；
- Provider Adapter Process Port；
- Command Runtime；
- Process Recovery Manager；
- Process Tree Terminator；
- Stream Decoder；
- Output Buffer；
- Timeout Controller；
- Process Event Projector；
- Process Inspector。

---

## 2. Process Runtime Positioning

AgentOS v2 的进程执行链如下：

```text
Run Engine
  ↓
Stage Executor
  ↓
Provider Adapter / Tool Runtime / Git Runtime
  ↓
Process Manager
  ↓
Platform Process Driver
  ├── Windows Process Driver
  ├── POSIX Process Driver
  ├── Container Process Driver
  └── Remote Process Driver
        ↓
Operating System Process
```

Process Manager 是所有本地 CLI 执行的唯一入口。

禁止核心模块直接使用：

```ts
child_process.spawn()
child_process.exec()
child_process.execFile()
```

所有进程都必须通过 Process Runtime，以确保：

- 可取消；
- 可恢复；
- 可观察；
- 可审计；
- 可脱敏；
- 可限制；
- 可清理。

---

## 3. Core Principles

### 3.1 Run Owns Process

Process 属于 Run，而不是 Browser Connection。

```text
Browser disconnect
  ≠
Process cancellation
```

### 3.2 Process Is Not Run

Run 是业务执行尝试。

Process 是操作系统执行单元。

一个 Run 可以拥有多个 Process。

### 3.3 Process Is Not Provider Session

Provider Session 表示 Provider 原生会话。

Process 表示操作系统进程。

API Provider 可以有 Session，但没有 PID。

CLI Provider 可以在一个 Session 中启动多个 Process。

### 3.4 Process Tree Must Be Managed

只终止父 PID 不足以完成可靠取消。

必须处理：

- Child Process；
- Grandchild Process；
- Shell Wrapper；
- Tool Process；
- Detached Process；
- Windows Console Child；
- Node/Python 子进程。

### 3.5 Shell Disabled by Default

默认：

```text
shell = false
```

只有明确需求并经过 Policy 时才允许 Shell。

### 3.6 Output Is Untrusted

stdout 和 stderr 都是 Untrusted Input。

必须进行：

- 解码；
- 长度限制；
- ANSI 处理；
- Secret Scan；
- Event 映射；
- Artifact 存储；
- Backpressure。

### 3.7 Timeout Is Activity-Based First

AI Coding Agent 的任务时长不可预测。

默认使用 Idle Timeout，而不是固定总时长。

### 3.8 Cancellation Must Be Idempotent

重复取消不能导致状态冲突或异常。

### 3.9 Recovery Must Not Guess

Server 重启后，无法确认的 Process 不得直接判定成功。

### 3.10 Cross-Platform Semantics

Windows、Linux 和 macOS 的实现不同，但对 Runtime Core 暴露一致语义。

---

# Part I — Domain Model

## 4. Runtime Process

### 4.1 Definition

Runtime Process 是 AgentOS 管理的一个操作系统执行单元记录。

```ts
interface RuntimeProcess {
  id: string;

  workspaceId: string;

  taskId?: string;

  runId: string;

  stageId?: string;

  providerSessionId?: string;

  parentProcessId?: string;

  nativePid?: number;

  nativeParentPid?: number;

  processType:
    | 'provider'
    | 'tool'
    | 'command'
    | 'git'
    | 'test'
    | 'system'
    | 'extension';

  platform:
    | 'win32'
    | 'linux'
    | 'darwin'
    | 'remote'
    | 'container';

  status:
    | 'created'
    | 'starting'
    | 'running'
    | 'waiting'
    | 'stopping'
    | 'exited'
    | 'failed'
    | 'orphaned'
    | 'unknown';

  executable: string;

  argsRedacted: string[];

  cwd: string;

  shell: boolean;

  detached: boolean;

  stdinMode:
    | 'none'
    | 'pipe'
    | 'inherit'
    | 'interactive';

  stdoutMode:
    | 'pipe'
    | 'inherit'
    | 'ignore';

  stderrMode:
    | 'pipe'
    | 'inherit'
    | 'ignore';

  startedAt?: string;

  readyAt?: string;

  lastActivityAt?: string;

  stoppingAt?: string;

  exitedAt?: string;

  exitCode?: number;

  exitSignal?: string;

  terminationReason?: ProcessTerminationReason;

  processGroupId?: number;

  platformHandleId?: string;

  recoveryToken?: string;

  version: number;

  createdAt: string;
  updatedAt: string;
}
```

### 4.2 Process Invariants

1. Runtime Process 必须属于 Run。
2. Provider 主进程应关联 Provider Session。
3. Process 创建后必须先持久化再 Spawn，或使用可恢复的 Reservation。
4. nativePid 只有 Spawn 成功后存在。
5. Process 状态变化必须产生 Runtime Event。
6. 退出后的 Process 记录不可删除，只可归档。
7. Secret 不得进入 `argsRedacted`。
8. Process 取消必须处理完整 Tree。
9. Process 不因 SSE 断开而停止。
10. Process Exit 不自动表示 Stage Success。

---

## 5. Managed Process Handle

运行中内存对象：

```ts
interface ManagedProcessHandle {
  processId: string;

  nativePid?: number;

  platformHandleId?: string;

  stdin?: WritableStream;

  stdout?: ReadableStream;

  stderr?: ReadableStream;

  startedAt: string;

  ready: Promise<void>;

  exit: Promise<ProcessExitResult>;

  write(input: Uint8Array | string): Promise<void>;

  closeStdin(): Promise<void>;

  requestStop(
    request: ProcessStopRequest
  ): Promise<ProcessStopResult>;
}
```

Handle 不作为数据库实体。

Server 重启后需要重新创建或转换为 Recovered Handle。

---

## 6. Process Launch Request

```ts
interface ProcessLaunchRequest {
  workspaceId: string;

  taskId?: string;

  runId: string;

  stageId?: string;

  providerSessionId?: string;

  parentProcessId?: string;

  processType: RuntimeProcess['processType'];

  executable: string;

  args: string[];

  cwd: string;

  environment: Record<string, string>;

  redactedEnvironmentKeys: string[];

  shell?: boolean;

  detached?: boolean;

  stdinMode?: RuntimeProcess['stdinMode'];

  stdoutMode?: RuntimeProcess['stdoutMode'];

  stderrMode?: RuntimeProcess['stderrMode'];

  encoding?: string;

  timeoutPolicy: ProcessTimeoutPolicy;

  resourcePolicy?: ProcessResourcePolicy;

  securityContext: ProcessSecurityContext;

  metadata?: Record<string, unknown>;

  idempotencyKey?: string;
}
```

### 6.1 Launch Request Validation

必须验证：

- Run 和 Stage 存在；
- executable 合法；
- cwd 合法；
- Path Boundary；
- Worktree Boundary；
- Policy；
- Args；
- Environment；
- Shell；
- Detached；
- Timeout；
- Resource Limit；
- Idempotency Key。

---

## 7. Process Exit Result

```ts
interface ProcessExitResult {
  processId: string;

  nativePid?: number;

  exitCode?: number;

  signal?: string;

  terminationReason: ProcessTerminationReason;

  startedAt?: string;

  exitedAt: string;

  durationMs?: number;

  graceful: boolean;

  stdoutArtifactId?: string;

  stderrArtifactId?: string;

  processTreeCleanup?: ProcessTreeCleanupResult;

  warnings: string[];
}
```

---

## 8. Termination Reason

```ts
type ProcessTerminationReason =
  | 'normal'
  | 'non-zero'
  | 'spawn-error'
  | 'startup-timeout'
  | 'idle-timeout'
  | 'total-timeout'
  | 'tool-timeout'
  | 'cancelled'
  | 'policy'
  | 'approval-rejected'
  | 'server-shutdown'
  | 'recovery-failed'
  | 'orphan-cleanup'
  | 'resource-limit'
  | 'signal'
  | 'unknown';
```

Termination Reason 比 Exit Code 更重要。

---

# Part II — Process Manager Architecture

## 9. Process Manager

```ts
interface ProcessManager {
  launch(
    request: ProcessLaunchRequest
  ): Promise<ManagedProcessHandle>;

  get(
    processId: string
  ): ManagedProcessHandle | undefined;

  inspect(
    processId: string
  ): Promise<RuntimeProcessSnapshot>;

  listByRun(
    runId: string
  ): Promise<RuntimeProcessSnapshot[]>;

  write(
    processId: string,
    input: Uint8Array | string
  ): Promise<void>;

  closeStdin(
    processId: string
  ): Promise<void>;

  stop(
    processId: string,
    request: ProcessStopRequest
  ): Promise<ProcessStopResult>;

  stopRunProcesses(
    runId: string,
    request: ProcessStopRequest
  ): Promise<ProcessTreeCleanupResult>;

  recoverAll(): Promise<ProcessRecoveryReport>;

  cleanupOrphans(): Promise<ProcessTreeCleanupResult>;

  shutdown(
    mode: ProcessManagerShutdownMode
  ): Promise<void>;
}
```

### 9.1 Responsibilities

Process Manager 负责：

- 数据库记录；
- Idempotency；
- Spawn；
- Handle Registry；
- Stream Wiring；
- Timeout；
- Activity；
- Stop；
- Process Tree；
- Recovery；
- Cleanup；
- Event；
- Artifact；
- Metrics。

### 9.2 Non-Responsibilities

Process Manager 不负责：

- Provider Prompt；
- Stage Completion；
- Task Completion；
- Workflow；
- Git Merge；
- Memory；
- Provider-specific Output Parsing。

---

## 10. Platform Process Driver

```ts
interface PlatformProcessDriver {
  readonly platform: string;

  spawn(
    input: PlatformSpawnInput
  ): Promise<PlatformProcessHandle>;

  isAlive(
    nativePid: number
  ): Promise<boolean>;

  inspectTree(
    nativePid: number
  ): Promise<NativeProcessTree>;

  requestGracefulStop(
    handle: PlatformProcessHandle,
    signal?: string
  ): Promise<void>;

  forceTerminateTree(
    handle: PlatformProcessHandle
  ): Promise<NativeTreeTerminationResult>;

  suspend?(
    handle: PlatformProcessHandle
  ): Promise<void>;

  resume?(
    handle: PlatformProcessHandle
  ): Promise<void>;

  collectUsage?(
    handle: PlatformProcessHandle
  ): Promise<NativeProcessUsage>;

  disposeHandle(
    handle: PlatformProcessHandle
  ): Promise<void>;
}
```

### 10.1 Drivers

v2 Foundation：

- Windows Driver；
- POSIX Driver。

未来：

- Container Driver；
- SSH Driver；
- Remote Agent Driver。

---

## 11. Process Repository

```ts
interface RuntimeProcessRepository {
  create(
    process: RuntimeProcess
  ): Promise<void>;

  updateStatus(
    processId: string,
    expectedVersion: number,
    update: RuntimeProcessStatusUpdate
  ): Promise<RuntimeProcess>;

  getById(
    processId: string
  ): Promise<RuntimeProcess | undefined>;

  listActive(): Promise<RuntimeProcess[]>;

  listByRun(
    runId: string
  ): Promise<RuntimeProcess[]>;

  markOrphaned(
    processId: string,
    reason: string
  ): Promise<void>;
}
```

Process Repository 不负责执行 OS 操作。

---

## 12. Handle Registry

内存 Registry：

```ts
interface ProcessHandleRegistry {
  register(
    handle: ManagedProcessHandle
  ): void;

  get(
    processId: string
  ): ManagedProcessHandle | undefined;

  remove(
    processId: string
  ): void;

  list(): ManagedProcessHandle[];
}
```

### 12.1 Registry Invariants

- 仅保存当前 Server 实例可控制的 Handle；
- Server 重启后 Registry 为空；
- 数据库是 Durable Source；
- Handle 丢失不等于 Process 已退出。

---

# Part III — Launch Lifecycle

## 13. Launch State Machine

```text
created
  ↓
starting
  ├── running
  └── failed
```

### 13.1 Launch Sequence

```text
Receive Launch Request
  ↓
Validate Schema
  ↓
Validate Run / Stage
  ↓
Evaluate Policy
  ↓
Normalize executable and cwd
  ↓
Resolve Environment
  ↓
Create Process Reservation
  ↓
Emit process.launch_requested
  ↓
Platform Driver Spawn
  ↓
Record PID and Platform Handle
  ↓
Wire stdout / stderr / exit
  ↓
Start Timeout Controllers
  ↓
Register Handle
  ↓
Set status=running
  ↓
Emit process.started
```

### 13.2 Process Reservation

Spawn 前先创建记录：

```text
status = created
nativePid = null
```

目的：

- 可审计；
- Spawn Error 可追踪；
- Idempotency；
- 避免重复启动。

### 13.3 Atomicity

无法让数据库事务与 OS Spawn 完全原子化。

采用 Saga：

```text
Persist Reservation
  ↓
Spawn
  ├── success → update PID
  └── failure → mark failed
```

如果 Spawn 成功但数据库更新失败：

- 立即终止 Process；
- 生成系统审计；
- 返回 `PROCESS_REGISTRATION_FAILED`。

---

## 14. Executable Resolution

### 14.1 Accepted Forms

- 绝对路径；
- PATH 命令；
- Provider Discovery 已验证路径。

### 14.2 Resolution Order

```text
Validated absolute path
  > Explicit configuration
  > Process-safe PATH lookup
```

### 14.3 Prohibited

- 用户输入直接拼接 executable；
- 未验证 Workspace 内二进制；
- 隐式 Shell Alias；
- PowerShell Function；
- 当前目录优先搜索；
- 模糊扩展名执行。

### 14.4 Windows Extensions

Windows 可解析：

```text
.exe
.cmd
.bat
.com
```

`.cmd` 和 `.bat` 可能需要 Shell Wrapper，必须显式标记并经过 Policy。

---

## 15. Working Directory

### 15.1 Resolution

```text
Stage Worktree
  > Run Worktree
  > Workspace Root for Read-only
  > Validated Custom Directory
```

### 15.2 Validation

必须检查：

- 路径存在；
- 真实路径；
- Symlink；
- Workspace Boundary；
- Worktree Ownership；
- Read/Write 权限；
- 不允许 Path Traversal。

### 15.3 Runtime Change

Provider 子进程可以内部 `cd`，但 Process Runtime 记录初始 cwd。

Tool Runtime 应尽量记录实际命令 cwd。

---

## 16. Arguments

### 16.1 Argument Array

必须使用参数数组：

```ts
args: string[]
```

不得使用未转义单字符串。

### 16.2 Redaction

持久化：

```ts
argsRedacted: string[]
```

原始 Args 只存在于短生命周期内存中。

### 16.3 Maximum Size

必须限制：

- 单 Arg 长度；
- 总 Arg 长度；
- Windows Command Line Limit；
- Platform Limit。

大 Prompt 应通过：

- stdin；
- Prompt File；
- API Body；

传递，而不是 CLI Argument。

---

## 17. Environment

### 17.1 Environment Construction

```text
Safe Base Environment
  ↓
Workspace Profile
  ↓
Provider Profile
  ↓
Run Override
  ↓
Ephemeral Secret Injection
```

### 17.2 Safe Base

允许：

- PATH；
- HOME / USERPROFILE；
- TEMP；
- LANG；
- SystemRoot；
- 必要平台变量。

### 17.3 Secret Isolation

每个 Process 只获得明确声明需要的 Secret。

### 17.4 Environment Audit

Event 只记录：

- Key 名；
- 来源；
- 是否 Secret；
- 是否 Redacted。

不记录 Secret Value。

### 17.5 Environment Lifetime

Ephemeral Secret 在：

- Spawn 后立即从临时对象释放；
- 不写 Artifact；
- 不写 Event；
- 不写 Debug Bundle。

---

## 18. Shell

### 18.1 Default

```text
shell = false
```

### 18.2 Shell Required Cases

- `.cmd` / `.bat`；
- 复杂管道；
- Shell Built-in；
- 用户显式 Shell Tool。

### 18.3 Policy

Shell 执行必须评估：

- Command String；
- Metacharacter；
- Redirection；
- Pipe；
- Environment Expansion；
- Substitution；
- Wildcard；
- Background Execution。

### 18.4 Prefer Direct Process

错误：

```text
cmd.exe /c "kimi ..."
```

优先：

```text
spawn kimi.exe with args[]
```

---

# Part IV — Standard I/O Runtime

## 19. stdio Modes

```ts
interface ProcessStdioConfiguration {
  stdin:
    | 'ignore'
    | 'pipe'
    | 'inherit';

  stdout:
    | 'ignore'
    | 'pipe'
    | 'inherit';

  stderr:
    | 'ignore'
    | 'pipe'
    | 'inherit';
}
```

Provider CLI 默认：

```text
stdin = pipe
stdout = pipe
stderr = pipe
```

---

## 20. Stream Pipeline

```text
Native Stream
  ↓
Byte Buffer
  ↓
Decoder
  ↓
ANSI Processor
  ↓
Framer
  ↓
Secret Scanner
  ↓
Raw Artifact Appender
  ↓
Provider Parser / Command Projector
  ↓
Runtime Event
```

### 20.1 Independent Streams

stdout 和 stderr 必须独立处理。

不得假设跨 Stream 的顺序严格可知。

每个 Chunk 记录接收时间和本地 Stream Sequence。

---

## 21. Decoder

```ts
interface StreamDecoder {
  push(
    bytes: Uint8Array
  ): DecodedStreamChunk[];

  flush(): DecodedStreamChunk[];
}
```

### 21.1 Requirements

必须处理：

- UTF-8 多字节跨 Chunk；
- BOM；
- CRLF；
- 单独 CR；
- Invalid Byte；
- Windows Code Page Fallback；
- Binary Detection。

### 21.2 Invalid Text

检测到 Binary：

- 不尝试文本解析；
- 写 Binary Artifact；
- 发 Warning Event；
- 避免污染 Timeline。

---

## 22. ANSI Processing

模式：

```ts
type AnsiMode =
  | 'preserve'
  | 'strip'
  | 'parse';
```

### 22.1 UI

普通 Timeline 默认 Strip 或 Parse。

Raw Artifact 可 Preserve。

### 22.2 Security

必须过滤危险 Terminal Control Sequence：

- 改标题；
- OSC 链接；
- Clipboard；
- Cursor 欺骗；
- 隐藏文本。

---

## 23. Framing

### 23.1 Text Line Framing

用于普通 CLI。

### 23.2 JSONL Framing

必须缓存半行。

```text
Chunk 1: {"type":"tool
Chunk 2: _call"}
```

合并后解析。

### 23.3 Length Prefix / Native Protocol

由 Provider Adapter 提供 Framer。

### 23.4 Maximum Frame

默认：

```text
1 MB
```

超出：

- 写 Raw Artifact；
- 发 Parse Warning；
- 防止内存攻击。

---

## 24. Backpressure

### 24.1 Problem

Provider 可能高频输出，Event Store 和客户端无法同步消费。

### 24.2 Strategy

- Bounded Buffer；
- Chunk Aggregation；
- Pause Read Stream；
- Batch Event Persistence；
- Raw Artifact Streaming；
- Drop only Ephemeral Progress；
- Never Drop Terminal Event。

### 24.3 Buffer Limits

建议：

```text
Per Stream Memory Buffer: 4–16 MB
Event Pending Queue: bounded
Raw Artifact: streamed to disk
```

### 24.4 Overflow

发生 Overflow：

- 发 `process.output_backpressure`；
- 降级高频 Delta；
- 保留完整 Raw Artifact；
- 不直接崩溃。

---

## 25. stdin

### 25.1 Write

```ts
interface ProcessInputWrite {
  processId: string;
  type:
    | 'prompt'
    | 'user'
    | 'approval'
    | 'interrupt'
    | 'custom';
  data: Uint8Array | string;
  closeAfterWrite?: boolean;
}
```

### 25.2 Policy

用户输入和 Approval Input 必须：

- 验证 Process；
- 验证 Session；
- 记录 Event；
- 防止跨 Run；
- 防止重复审批。

### 25.3 Closed stdin

写入关闭 stdin：

```text
PROCESS_STDIN_CLOSED
```

---

# Part V — Activity and Readiness

## 26. Activity

以下行为更新 `lastActivityAt`：

- stdout bytes；
- stderr bytes；
- stdin accepted；
- Provider Native Event；
- Process Heartbeat；
- Tool Progress；
- Approval Resume；
- Child Process detected；
- Resource Usage sample。

### 26.1 Non-Activity

以下不算 Provider Activity：

- UI Keepalive；
- SSE Keepalive；
- Metrics Query；
- Timeline Read；
- Browser Reconnect。

---

## 27. Readiness

Process Started 与 Provider Ready 不完全相同。

```text
OS Process spawned
  ↓
process.started
  ↓
Provider initialization
  ↓
provider.session_started / process.ready
```

### 27.1 Readiness Detection

可来自：

- Native Ready Event；
- stdout Pattern；
- Socket Open；
- API Response；
- Adapter Callback。

### 27.2 Readiness Timeout

Startup Timeout 从 Spawn 开始，到 Provider Ready 为止。

---

## 28. Heartbeat

### 28.1 Sources

- Provider Native Heartbeat；
- Process Usage Sampling；
- Output Activity；
- Remote Ping。

### 28.2 Heartbeat Event

`process.heartbeat` 可以 Ephemeral。

重要恢复 Checkpoint 应 Durable。

### 28.3 Heartbeat Is Not Output

没有 stdout 不表示 Process 无活动。

---

# Part VI — Timeout Runtime

## 29. Process Timeout Policy

```ts
interface ProcessTimeoutPolicy {
  startupTimeoutMs: number;

  idleTimeoutMs: number | null;

  totalTimeoutMs: number | null;

  toolTimeoutMs?: number | null;

  approvalTimeoutMs?: number | null;

  cancelGracePeriodMs: number;

  forceKillWaitMs: number;

  heartbeatIntervalMs?: number;
}
```

---

## 30. Startup Timeout

触发条件：

```text
Process spawned
Provider not ready before deadline
```

结果：

- `process.startup_timeout`；
- Graceful Stop；
- Force Kill；
- Provider Validation / Startup Failure。

---

## 31. Idle Timeout

触发条件：

```text
now - lastActivityAt > idleTimeoutMs
```

### 31.1 Exclusions

以下状态暂停 Idle Timer：

- waiting_approval；
- paused；
- Scheduler Suspended；
- System Maintenance。

### 31.2 Warning

建议在真正终止前发：

```text
process.idle_timeout_warning
```

允许 Provider 或 User 产生有效活动。

---

## 32. Total Timeout

从 `startedAt` 计算。

复杂任务默认：

```text
null
```

启用时必须在 Run Snapshot 中记录。

---

## 33. Tool Timeout

Tool Process 可以比 Provider Session 有更短 Timeout。

Tool Timeout 不一定终止整个 Provider Session。

Workflow 和 Provider Adapter 决定后续。

---

## 34. Timeout State Machine

```text
Timer detects deadline
  ↓
Acquire Process Transition Lock
  ↓
Verify deadline still valid
  ↓
Emit timeout Event
  ↓
Request Graceful Stop
  ↓
Wait cancelGracePeriodMs
  ↓
Force Terminate Tree
  ↓
Wait forceKillWaitMs
  ↓
Inspect Survivors
  ↓
Persist Exit
```

### 34.1 Race Safety

Timeout 与正常 Exit 同时发生时：

- 只允许一个 Terminal Transition；
- 使用 version check；
- Event 中记录最终原因。



# Part VII — Cancellation and Process Tree

## 35. Stop Request

```ts
interface ProcessStopRequest {
  reason:
    | 'user-cancel'
    | 'run-cancel'
    | 'stage-cancel'
    | 'timeout'
    | 'policy'
    | 'approval-rejected'
    | 'server-shutdown'
    | 'recovery'
    | 'cleanup';

  requestedBy?: string;

  gracefulFirst: boolean;

  gracePeriodMs?: number;

  forceAfterGrace: boolean;

  preserveOutput: boolean;

  idempotencyKey?: string;
}
```

---

## 36. Stop Result

```ts
interface ProcessStopResult {
  processId: string;

  alreadyTerminal: boolean;

  gracefulAttempted: boolean;

  gracefulSucceeded: boolean;

  forceAttempted: boolean;

  forceSucceeded: boolean;

  treeResult?: ProcessTreeCleanupResult;

  finalStatus: RuntimeProcess['status'];

  warnings: string[];
}
```

---

## 37. Cancellation Sequence

```text
Stop requested
  ↓
Validate ownership and state
  ↓
Acquire transition lock
  ↓
Mark status=stopping
  ↓
Emit process.stopping
  ↓
Stop accepting new stdin
  ↓
Send provider/native interrupt if available
  ↓
Send platform graceful signal
  ↓
Wait grace period
  ├── process exits → finalize
  └── still alive
        ↓
      Force terminate process tree
        ↓
      Inspect survivors
        ↓
      Persist terminal state
```

### 37.1 Idempotency

如果 Process 已终止：

- 返回现有 Exit Result；
- 不重复发 Terminal Event；
- 可再次执行孤儿清理检查。

### 37.2 Run Cancellation

Run 取消时：

1. 停止调度新 Stage；
2. 找到所有 Active Process；
3. 先终止子 Tool / Command；
4. 再终止 Provider 主进程；
5. 清理 Process Tree；
6. Finalize Raw Artifact；
7. 更新 Stage 和 Run。

---

## 38. Process Tree Model

```ts
interface NativeProcessTree {
  rootPid: number;

  nodes: Array<{
    pid: number;
    parentPid?: number;
    executable?: string;
    startedAt?: string;
  }>;

  capturedAt: string;

  complete: boolean;
}
```

### 38.1 Tree Ownership

AgentOS Process Tree 包括：

- Root Process；
- 由 Root 创建的子进程；
- Shell Wrapper；
- Provider Tool；
- Test Runner；
- Compiler；
- Package Manager；
- Provider Native Subagent Process。

### 38.2 Escaped Child

子进程可能通过 Detached、Daemon 或重新挂接逃离 Tree。

Process Runtime 必须：

- 尽可能使用平台级 Group / Job；
- 检测 Survivor；
- 标记 Orphan；
- 不声称全部清理成功，除非验证。

---

# Part VIII — Windows Runtime

## 39. Windows Process Semantics

Windows 不提供与 POSIX 完全相同的 Signal 和 Process Group 语义。

必须专门处理：

- Job Object；
- Console Process Group；
- `.cmd` / `.bat`；
- `cmd.exe`；
- PowerShell；
- Child Process Tree；
- Native Assertion；
- Handle Inheritance；
- Ctrl+C / Ctrl+Break；
- `taskkill` Fallback。

---

## 40. Windows Job Object

### 40.1 Preferred Mechanism

每个受管理 Root Process 应尽量加入 Windows Job Object。

目标：

```text
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
```

使 AgentOS 能在关闭 Job Handle 时终止完整 Tree。

### 40.2 Job Object Record

```ts
interface WindowsJobObjectHandle {
  id: string;
  processId: string;
  nativeHandleReference: unknown;
  killOnClose: boolean;
  assignedPid: number;
}
```

原生 Handle 只存在于内存，不进入数据库。

数据库保存：

```text
platformHandleId
```

用于诊断，不用于重启后直接恢复 Native Handle。

### 40.3 Assignment Failure

如果 Process 无法加入 Job：

- 发 Warning；
- 启用 Process Tree Fallback；
- 标记取消可靠性降低；
- 不静默忽略。

### 40.4 Nested Job Restrictions

某些环境可能已在 Job 中。

Driver 必须检测并采用兼容策略。

---

## 41. Windows Graceful Stop

优先级可根据进程能力调整：

1. Provider Native Interrupt；
2. Ctrl+Break；
3. Ctrl+C；
4. 关闭 stdin；
5. Graceful Provider Command；
6. 等待；
7. Job Object Termination；
8. `taskkill /T /F` Fallback。

### 41.1 Console Group

需要 Ctrl Event 时，Process 可能需要独立 Console Process Group。

这必须由 Windows Driver 控制，而不是 Provider Adapter 自行实现。

---

## 42. Windows Force Termination

### 42.1 Job Object

首选关闭或终止 Job。

### 42.2 Fallback

```text
taskkill /PID <pid> /T /F
```

### 42.3 Verification

执行后必须检查：

- Root PID；
- 已知 Child PID；
- 新发现 Child PID；
- Survivor。

### 42.4 Failure

如果仍有 Survivor：

- 标记 `process.orphaned`；
- 发 `process.cleanup_required`；
- 提供 PID；
- 不把 Cancel 显示为完全成功。

---

## 43. Windows Shell Wrapper

`.cmd` 和 `.bat` 通常需要：

```text
cmd.exe /d /s /c
```

要求：

- 明确记录实际 executable；
- 参数安全转义；
- `shell=true`；
- Policy Approval；
- Process Tree 仍由 Job Object 管理。

PowerShell 脚本应优先：

```text
powershell.exe -NoProfile -NonInteractive -File ...
```

或现代 PowerShell：

```text
pwsh
```

不得使用未经转义的 `-Command` 拼接用户输入。

---

## 44. Windows Known Failure Handling

遇到 Native 错误，例如：

```text
Assertion failed
UV_HANDLE_CLOSING
Access violation
Exit code 3221226505
```

Process Runtime 必须：

- 保存 stderr；
- 记录 Unsigned Exit Code 和 Hex；
- 检查 Child Tree；
- 终止残留进程；
- 发 `process.exited`；
- 由 Provider Adapter 映射 Provider Error；
- 不误判为认证成功或普通完成。

---

# Part IX — POSIX Runtime

## 45. POSIX Process Group

Linux/macOS 中，Root Process 应创建独立 Process Group 或 Session。

推荐：

```text
detached = true
```

或等价 `setsid()`。

### 45.1 Group ID

保存：

```text
processGroupId
```

### 45.2 Tree Termination

向 Process Group 发送 Signal：

```text
SIGINT
SIGTERM
SIGKILL
```

而不是只发送给 Root PID。

---

## 46. POSIX Graceful Stop

推荐顺序：

1. Provider Native Interrupt；
2. SIGINT；
3. Wait；
4. SIGTERM；
5. Wait；
6. SIGKILL；
7. Inspect Process Group。

### 46.1 Signal Configuration

Provider Adapter 可以建议 Graceful Signal，但 Runtime Policy 决定允许范围。

---

## 47. POSIX Orphans and Zombies

Process Runtime 必须：

- 监听 Child Exit；
- 回收直接 Child；
- 检查 Process Group；
- 避免 Zombie；
- 标记重新挂接到 init 的逃逸进程。

---

## 48. macOS Notes

macOS 仍采用 POSIX Driver，但资源统计、Process Tree 查询和 Sandbox 能力可能不同。

Capability 必须由 Driver 声明。

---

# Part X — Pause and Resume

## 49. Pause Semantics

Process Pause 与 Run Pause 不完全相同。

Process Pause 表示 OS 执行暂停。

### 49.1 Supported Modes

- Provider Native Pause；
- POSIX SIGSTOP / SIGCONT；
- Windows Suspend Process；
- Cooperative Pause；
- Stop-and-Resume Session。

### 49.2 Safety

直接 Suspend 可能导致：

- Lock 持有；
- Pipe Block；
- Child 不一致；
- Network Timeout；
- Provider Session 失效。

因此默认优先 Provider Native Pause 或 Cooperative Pause。

---

## 50. Process Suspend Interface

```ts
interface ProcessSuspendResult {
  processId: string;

  supported: boolean;

  suspended: boolean;

  mode:
    | 'provider-native'
    | 'posix-signal'
    | 'windows-native'
    | 'cooperative'
    | 'unsupported';

  warnings: string[];
}
```

### 50.1 Run Pause Policy

如果所有 Active Process 无法安全暂停：

- Run 可以进入 `pause_requested`；
- 等待安全点；
- 或停止 Process 并依赖 Provider Session Resume；
- UI 必须显示真实语义。

---

## 51. Resume

Resume 前检查：

- Process 仍存活；
- Pipe 可用；
- Provider Session 可用；
- Worktree 存在；
- Timeout Controller 重置；
- Policy 仍允许。

恢复必须发：

```text
process.resumed
```

---

# Part XI — Resource Runtime

## 52. Resource Policy

```ts
interface ProcessResourcePolicy {
  maxMemoryBytes?: number;

  maxCpuPercent?: number;

  maxProcessCount?: number;

  maxOpenFiles?: number;

  maxOutputBytes?: number;

  maxArtifactBytes?: number;

  priority?:
    | 'low'
    | 'normal'
    | 'high';

  enforce:
    | 'observe'
    | 'warn'
    | 'terminate';
}
```

### 52.1 v2 Foundation

Foundation 可以先实现：

- Output Limit；
- Process Count；
- Usage Observation；
- Disk Space Warning。

内存和 CPU 强限制可由平台能力逐步实现。

---

## 53. Process Usage

```ts
interface NativeProcessUsage {
  processId: string;

  sampledAt: string;

  cpuPercent?: number;

  memoryRssBytes?: number;

  memoryVirtualBytes?: number;

  childProcessCount?: number;

  readBytes?: number;

  writeBytes?: number;

  outputBytes?: number;
}
```

### 53.1 Aggregation

Run Metrics 可聚合：

- Peak Memory；
- CPU Time；
- Process Count；
- Output Size；
- Duration。

---

## 54. Resource Violation

流程：

```text
Sample exceeds policy
  ↓
Emit process.resource_warning
  ↓
Policy action
  ├── observe
  ├── warn
  └── terminate
```

终止原因：

```text
resource-limit
```

---

# Part XII — Output Artifacts

## 55. Raw Output Artifact

每个重要 Process 建议生成：

- stdout Artifact；
- stderr Artifact；
- combined summary Artifact，可选。

### 55.1 Append Model

```ts
interface ProcessOutputArtifactWriter {
  appendStdout(
    bytes: Uint8Array
  ): Promise<void>;

  appendStderr(
    bytes: Uint8Array
  ): Promise<void>;

  finalize(): Promise<{
    stdoutArtifactId?: string;
    stderrArtifactId?: string;
  }>;
}
```

### 55.2 Crash Safety

采用：

- Append-only Temporary File；
- 定期 Flush；
- Finalize Rename；
- Checksum；
- Server Recovery Scan。

### 55.3 Redaction Modes

```ts
type RawOutputRedactionMode =
  | 'none'
  | 'scan'
  | 'strict';
```

普通 Provider 默认 `scan`。

高风险 Provider 使用 `strict`。

---

## 56. Output Limits

达到 `maxOutputBytes` 时：

- 不应立即丢弃 Process；
- 发 Warning；
- Timeline 停止高频 Delta；
- Raw Artifact 可截断或滚动；
- 记录 Truncation；
- Policy 可选择终止。

### 56.1 Rolling Artifact

可按大小分段：

```text
stdout.part-001.log
stdout.part-002.log
```

Artifact Index 记录顺序。

---

# Part XIII — Event Model

## 57. Process Events

除 `03-Event-Model.md` 已定义事件外，Process Runtime 增加或细化：

```text
process.launch_requested
process.started
process.ready
process.heartbeat
process.stdin_written
process.stdin_closed
process.output_backpressure
process.output_truncated
process.idle_timeout_warning
process.startup_timeout
process.idle_timeout
process.total_timeout
process.resource_warning
process.pause_requested
process.paused
process.resumed
process.stopping
process.exited
process.orphaned
process.cleanup_required
process.cleanup_completed
process.recovered
process.recovery_failed
```

---

## 58. `process.launch_requested`

```ts
interface ProcessLaunchRequestedPayload {
  processType: RuntimeProcess['processType'];

  executable: string;

  argsRedacted: string[];

  cwd: string;

  shell: boolean;

  timeoutPolicy: ProcessTimeoutPolicy;
}
```

---

## 59. `process.ready`

```ts
interface ProcessReadyPayload {
  readinessSource:
    | 'native-event'
    | 'output-pattern'
    | 'socket'
    | 'api'
    | 'adapter';

  startupDurationMs: number;
}
```

---

## 60. Timeout Events

```ts
interface ProcessTimeoutPayload {
  timeoutType:
    | 'startup'
    | 'idle'
    | 'total'
    | 'tool';

  limitMs: number;

  lastActivityAt?: string;

  gracefulStopRequested: boolean;
}
```

---

## 61. Output Events

### `process.output_backpressure`

```ts
interface ProcessOutputBackpressurePayload {
  stream: 'stdout' | 'stderr';

  bufferedBytes: number;

  limitBytes: number;

  action:
    | 'pause-stream'
    | 'aggregate'
    | 'artifact-only'
    | 'drop-ephemeral';
}
```

### `process.output_truncated`

```ts
interface ProcessOutputTruncatedPayload {
  stream: 'stdout' | 'stderr';

  totalBytes: number;

  retainedBytes: number;

  artifactId?: string;

  reason: string;
}
```

---

## 62. Process Event Source

所有 OS 层 Process Event：

```text
source = process-manager
```

Provider Adapter 解释后的 Provider Event：

```text
source = provider-adapter
```

不得混淆。

---

# Part XIV — Recovery Runtime

## 63. Recovery Goals

Server 启动后必须判断：

- 数据库记录为 Active 的 Process 是否还存活；
- 是否属于当前 AgentOS 实例；
- 能否重新控制；
- 是否应终止；
- Provider Session 能否恢复；
- Raw Artifact 是否完整；
- Worktree 是否保留。

---

## 64. Recovery Token

启动 Process 时可注入：

```text
AGENTOS_PROCESS_ID
AGENTOS_RUN_ID
AGENTOS_RECOVERY_TOKEN
```

Recovery Token：

- 随机；
- 不作为 Secret 长期暴露；
- 可用于确认归属；
- 不应显示在普通 Event。

### 64.1 Command Line Visibility

Recovery Token 不应放入命令行参数。

优先 Environment 或受控 Metadata。

---

## 65. Recovery Scan

```text
Load active RuntimeProcess records
  ↓
For each record:
  inspect nativePid
  ↓
alive?
  ├── no → mark exited/failed
  └── yes
       ↓
     verify identity
       ├── verified → reattach or monitor
       └── unverified → orphan policy
```

### 65.1 Identity Verification

可使用：

- PID；
- Process Start Time；
- Executable Path；
- Recovery Token；
- Parent / Group；
- Platform Metadata。

只用 PID 不足够，因为 PID 可能复用。

---

## 66. Recovery Classification

```ts
type ProcessRecoveryClassification =
  | 'reattachable'
  | 'alive-uncontrollable'
  | 'missing'
  | 'pid-reused'
  | 'orphaned'
  | 'already-exited'
  | 'unknown';
```

### 66.1 Reattachable

重新建立：

- Exit Watch；
- Usage Sampling；
- Provider Session；
- Event Stream，若支持。

### 66.2 Alive but Uncontrollable

Process 存活但 Native Handle 丢失。

策略：

- 监控 PID；
- 尝试 Provider Session Resume；
- 提示用户；
- 或终止并创建 Child Run。

### 66.3 Missing

根据 Run 和 Provider 状态标记失败或可恢复。

### 66.4 PID Reused

绝不能将新进程误认为旧进程。

---

## 67. Recovery Report

```ts
interface ProcessRecoveryReport {
  scanned: number;

  reattached: string[];

  aliveUncontrollable: string[];

  missing: string[];

  pidReused: string[];

  orphaned: string[];

  failed: Array<{
    processId: string;
    errorCode: string;
    message: string;
  }>;
}
```

---

## 68. Recovery Events

```text
process.recovery_started
process.recovered
process.recovery_failed
process.orphaned
process.cleanup_required
```

Recovery 不得修改历史 Event。

---

# Part XV — Orphan Runtime

## 69. Orphan Definition

Orphan Process 是：

- 与 AgentOS Run 相关；
- 但不再被有效 Handle 控制；
- 或数据库关系缺失；
- 或 Run 已终止但 Process 仍存活。

### 69.1 Orphan Sources

- Server Crash；
- Spawn 后数据库失败；
- Job Assignment 失败；
- Detached Child；
- Provider Daemon；
- Platform Driver Failure；
- Manual Process Manipulation。

---

## 70. Orphan Policy

```ts
interface OrphanProcessPolicy {
  action:
    | 'notify'
    | 'terminate'
    | 'adopt-if-verifiable'
    | 'ignore';

  gracePeriodMs: number;

  requireUserApproval: boolean;
}
```

默认建议：

- 可验证属于已取消/失败 Run → terminate；
- 属于可能可恢复 Run → notify / adopt；
- 无法验证 → 不盲目终止，标记风险。

---

## 71. Orphan Cleanup

```text
Orphan detected
  ↓
Verify ownership
  ↓
Evaluate policy
  ↓
Optional approval
  ↓
Terminate tree
  ↓
Verify survivors
  ↓
Emit cleanup result
```

---

# Part XVI — Server Shutdown

## 72. Shutdown Modes

```ts
type ProcessManagerShutdownMode =
  | 'graceful'
  | 'preserve-processes'
  | 'terminate'
  | 'immediate';
```

### 72.1 Graceful

- 停止新 Launch；
- 通知 Provider；
- 等待安全点；
- 停止或保存 Session；
- Flush Output；
- 关闭数据库。

### 72.2 Preserve Processes

用于可恢复的长任务。

要求：

- Process Identity 可恢复；
- Output 不依赖当前 Pipe；
- Provider 支持 Reattach；
- 明确风险。

v2 Foundation 默认不建议广泛启用。

### 72.3 Terminate

取消所有 Active Process。

### 72.4 Immediate

系统紧急退出，尽最大努力关闭 Job / Process Group。

---

## 73. Shutdown Sequence

```text
Process Manager enters shutting-down
  ↓
Reject new launches
  ↓
Freeze timeout transitions
  ↓
For each active process:
  apply shutdown mode
  ↓
Finalize output
  ↓
Persist checkpoint
  ↓
Dispose handles
```

### 73.1 Development Watch Restart

开发环境文件 Watch 引起的 Server Restart 不应被误判为用户取消。

Stable Development Mode 应避免 Watch 影响长 Run。

---

# Part XVII — Security Runtime

## 74. Process Security Context

```ts
interface ProcessSecurityContext {
  workspaceRoot: string;

  worktreePath?: string;

  allowedReadPaths: string[];

  allowedWritePaths: string[];

  allowedExecutables?: string[];

  deniedExecutables?: string[];

  networkPolicyId?: string;

  secretReferences: string[];

  policyProfileId: string;

  unsafeMode: boolean;
}
```

---

## 75. Path Security

必须检查：

- Canonical Path；
- Symlink；
- Junction；
- UNC Path；
- Windows Drive；
- Device Path；
- Relative Traversal；
- Case Normalization；
- Worktree Escape。

### 75.1 Windows Special Paths

需要警惕：

```text
\\?\
\\.\ 
UNC
Alternate Data Streams
```

### 75.2 Symlink Race

高风险写操作应在执行前后检查路径归属。

---

## 76. Executable Policy

可按：

- Absolute Path；
- Hash；
- Publisher；
- Directory；
- Provider Adapter；
- Workspace；

允许。

### 76.1 Workspace Executable

运行 Workspace 中生成的二进制默认需要 Approval。

---

## 77. Command Policy

Policy 输入：

```ts
interface CommandPolicyInput {
  executable: string;

  argsRedacted: string[];

  cwd: string;

  shell: boolean;

  processType: RuntimeProcess['processType'];

  workspaceId: string;

  runId: string;

  stageId?: string;
}
```

### 77.1 High-risk Examples

- `rm -rf`；
- `del /s`；
- `format`；
- `git push --force`；
- System Package Install；
- Registry Modification；
- Service Control；
- Firewall；
- Credential Access；
- Download and Execute。

---

## 78. Privilege

Process Runtime 默认不提升权限。

禁止自动：

- UAC Elevation；
- `sudo`；
- Administrator Shell；
- Root Container。

需要提升时：

- Policy；
- Approval；
- 明确 UI；
- 独立 Process；
- 审计；
- 尽可能限制作用域。

---

## 79. Detached and Daemon

Provider 不得未经允许创建长期 Daemon。

检测到：

- Detached Child；
- Background Service；
- Scheduled Task；

必须产生 Policy Event。

---

# Part XVIII — Error Model

## 80. Process Error

```ts
interface ProcessRuntimeError {
  code: ProcessErrorCode;

  message: string;

  phase:
    | 'validation'
    | 'reservation'
    | 'spawn'
    | 'stdio'
    | 'runtime'
    | 'timeout'
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'tree-cleanup'
    | 'recovery'
    | 'artifact'
    | 'shutdown';

  processId?: string;

  nativePid?: number;

  retryable: boolean;

  suggestedAction?: string;

  nativeCode?: string;

  details?: Record<string, unknown>;
}
```

---

## 81. Process Error Codes

```ts
type ProcessErrorCode =
  | 'PROCESS_REQUEST_INVALID'
  | 'PROCESS_POLICY_DENIED'
  | 'PROCESS_EXECUTABLE_NOT_FOUND'
  | 'PROCESS_EXECUTABLE_NOT_ACCESSIBLE'
  | 'PROCESS_CWD_INVALID'
  | 'PROCESS_ENVIRONMENT_INVALID'
  | 'PROCESS_REGISTRATION_FAILED'
  | 'PROCESS_SPAWN_FAILED'
  | 'PROCESS_STDIN_CLOSED'
  | 'PROCESS_STDIN_WRITE_FAILED'
  | 'PROCESS_OUTPUT_DECODE_FAILED'
  | 'PROCESS_OUTPUT_LIMIT_EXCEEDED'
  | 'PROCESS_STARTUP_TIMEOUT'
  | 'PROCESS_IDLE_TIMEOUT'
  | 'PROCESS_TOTAL_TIMEOUT'
  | 'PROCESS_TOOL_TIMEOUT'
  | 'PROCESS_PAUSE_UNSUPPORTED'
  | 'PROCESS_PAUSE_FAILED'
  | 'PROCESS_RESUME_FAILED'
  | 'PROCESS_CANCEL_FAILED'
  | 'PROCESS_TREE_TERMINATION_FAILED'
  | 'PROCESS_SURVIVORS_DETECTED'
  | 'PROCESS_EXIT_UNKNOWN'
  | 'PROCESS_PID_REUSED'
  | 'PROCESS_RECOVERY_FAILED'
  | 'PROCESS_ORPHANED'
  | 'PROCESS_RESOURCE_LIMIT'
  | 'PROCESS_ARTIFACT_WRITE_FAILED'
  | 'PROCESS_MANAGER_SHUTTING_DOWN'
  | 'PROCESS_UNKNOWN_ERROR';
```

---

## 82. Error Mapping

Node.js 常见错误：

```text
ENOENT
  → PROCESS_EXECUTABLE_NOT_FOUND

EACCES / EPERM
  → PROCESS_EXECUTABLE_NOT_ACCESSIBLE

spawn error
  → PROCESS_SPAWN_FAILED

stdin EPIPE
  → PROCESS_STDIN_CLOSED or WRITE_FAILED
```

Windows Native Exit 不应只显示 Decimal。

应同时记录：

- Signed Decimal；
- Unsigned Decimal；
- Hex；
- Provider Normalization。

---

# Part XIX — Persistence

## 83. SQLite Schema

```sql
CREATE TABLE runtime_processes (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  provider_session_id TEXT,
  parent_process_id TEXT,

  native_pid INTEGER,
  native_parent_pid INTEGER,

  process_type TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,

  executable TEXT NOT NULL,
  args_redacted_json TEXT NOT NULL,
  cwd TEXT NOT NULL,

  shell INTEGER NOT NULL,
  detached INTEGER NOT NULL,

  stdin_mode TEXT NOT NULL,
  stdout_mode TEXT NOT NULL,
  stderr_mode TEXT NOT NULL,

  process_group_id INTEGER,
  platform_handle_id TEXT,
  recovery_token_hash TEXT,

  started_at TEXT,
  ready_at TEXT,
  last_activity_at TEXT,
  stopping_at TEXT,
  exited_at TEXT,

  exit_code INTEGER,
  exit_signal TEXT,
  termination_reason TEXT,

  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## 84. Indexes

```sql
CREATE INDEX idx_runtime_processes_run
ON runtime_processes(run_id);

CREATE INDEX idx_runtime_processes_stage
ON runtime_processes(stage_id);

CREATE INDEX idx_runtime_processes_session
ON runtime_processes(provider_session_id);

CREATE INDEX idx_runtime_processes_status
ON runtime_processes(status);

CREATE INDEX idx_runtime_processes_native_pid
ON runtime_processes(native_pid);
```

---

## 85. Transition Transaction

Terminal Transition 必须使用：

```text
expected version
current non-terminal status
```

防止：

- Exit 与 Cancel 冲突；
- Timeout 与正常完成冲突；
- Recovery 与 Cleanup 冲突。

---

# Part XX — APIs

## 86. Process Query APIs

```text
GET /api/runs/:runId/processes
GET /api/processes/:processId
GET /api/processes/:processId/tree
GET /api/processes/:processId/events
GET /api/processes/:processId/output
```

---

## 87. Control APIs

普通用户控制应优先通过 Run API。

内部或 Inspector 可提供：

```text
POST /api/processes/:processId/stop
POST /api/processes/:processId/pause
POST /api/processes/:processId/resume
POST /api/processes/:processId/cleanup
```

必须验证：

- Run 状态；
- Policy；
- Ownership；
- Idempotency。

---

## 88. Process Inspector Response

```ts
interface ProcessInspectorView {
  process: RuntimeProcessSnapshot;

  tree?: NativeProcessTree;

  usage?: NativeProcessUsage;

  timeoutState: {
    startupDeadline?: string;
    idleDeadline?: string;
    totalDeadline?: string;
  };

  stdoutArtifactId?: string;

  stderrArtifactId?: string;

  recentEvents: RuntimeEvent[];

  platformCapabilities: PlatformProcessCapabilities;

  warnings: string[];
}
```

---

# Part XXI — Platform Capabilities

## 89. Platform Capabilities

```ts
interface PlatformProcessCapabilities {
  processGroups: boolean;

  jobObjects: boolean;

  gracefulSignals: string[];

  forceTreeTermination: boolean;

  suspendResume: boolean;

  resourceUsage: boolean;

  processTreeInspection: boolean;

  reattach: boolean;
}
```

UI 和 Runtime 必须根据 Capability 显示真实能力。

---

# Part XXII — Testing

## 90. Unit Tests

必须覆盖：

- Launch Request Validation；
- Argument Redaction；
- Environment Merge；
- Path Boundary；
- Timeout Calculation；
- Activity Update；
- State Transition；
- Idempotent Cancel；
- Error Mapping；
- Output Framing；
- UTF-8 Boundary；
- ANSI；
- Backpressure；
- Recovery Classification；
- PID Reuse Detection。

---

## 91. Platform Contract Tests

每个 Platform Driver 必须通过：

1. Spawn；
2. stdout；
3. stderr；
4. stdin；
5. Normal Exit；
6. Non-zero Exit；
7. Child Process；
8. Grandchild Process；
9. Graceful Stop；
10. Force Tree Termination；
11. Process Tree Inspection；
12. Survivor Detection；
13. Startup Timeout；
14. Idle Timeout；
15. Total Timeout；
16. Server Recovery Classification；
17. Orphan Cleanup。

---

## 92. Windows Tests

必须覆盖：

- `.exe`；
- `.cmd`；
- PowerShell；
- Job Object；
- Ctrl+Break；
- `taskkill /T /F`；
- Child Node Process；
- Child Python Process；
- Detached Child；
- Native Assertion；
- Exit Code 3221226505；
- Path with Spaces；
- Unicode Path；
- Long Command Line；
- Handle Cleanup。

---

## 93. POSIX Tests

必须覆盖：

- Process Group；
- SIGINT；
- SIGTERM；
- SIGKILL；
- Child and Grandchild；
- Detached Session；
- Zombie Reaping；
- PID Reuse；
- Shell Disabled；
- Unicode Path。

---

## 94. Integration Tests

### 94.1 Provider Cancel

```text
KimiCode starts
  ↓
KimiCode launches child tool
  ↓
User cancels Run
  ↓
Root and child exit
  ↓
No survivor
```

### 94.2 Browser Disconnect

```text
Process running
  ↓
SSE disconnects
  ↓
Process continues
  ↓
Event persists
```

### 94.3 Server Restart

```text
Process active
  ↓
Server restart
  ↓
Recovery scan
  ↓
Correct classification
```

### 94.4 Timeout

Approval waiting 不触发 Idle Timeout。

### 94.5 Backpressure

高频输出不导致内存无限增长。

---

## 95. Mock Process Driver

Mock Driver 必须支持：

```ts
type MockProcessScenario =
  | 'normal'
  | 'non-zero'
  | 'spawn-error'
  | 'slow-start'
  | 'silent'
  | 'high-output'
  | 'child-tree'
  | 'escaped-child'
  | 'stdin'
  | 'cancel'
  | 'cancel-failure'
  | 'idle-timeout'
  | 'total-timeout'
  | 'pid-reuse'
  | 'recovery';
```

---

# Part XXIII — v1 Migration

## 96. Current v1 Process Model

当前 v1 通常是：

```text
CLIExecutor
  ↓
child_process.spawn
  ↓
stdout callback
  ↓
AbortController
```

主要问题：

- Browser Request 绑定 Process；
- Provider 和 Process 混合；
- 无 Durable Process Record；
- 无 Process Tree；
- 无 Recovery；
- 无 Platform Driver；
- Cancel 可能只杀父进程；
- stdout 无统一 Backpressure；
- Timeout 与活动语义不完整；
- Watch Restart 会误杀任务；
- 错误只靠 Exit Code 和字符串。

---

## 97. Migration Step 1 — Wrap Existing Spawn

先建立：

```text
ProcessManager.launch()
  ↓
Existing spawn implementation
```

所有新调用经过 Process Manager。

---

## 98. Migration Step 2 — Durable Process Record

Spawn 前创建 RuntimeProcess。

记录：

- Process ID；
- Run ID；
- Stage ID；
- PID；
- cwd；
- argsRedacted；
- lastActivityAt；
- Exit。

---

## 99. Migration Step 3 — Decouple HTTP

删除：

```text
request close
  → abort process
```

改为：

```text
Run Cancel API
  → Process Manager stop
```

---

## 100. Migration Step 4 — Process Tree

Windows：

- Job Object；
- taskkill Fallback。

POSIX：

- Process Group；
- Group Signal。

---

## 101. Migration Step 5 — Output Pipeline

从：

```text
stdout string callback
```

升级为：

```text
Bytes
  → Decoder
  → Framer
  → Raw Artifact
  → Provider Parser
  → Runtime Event
```

---

## 102. Migration Step 6 — Recovery

Server Startup 扫描 Active Process。

---

## 103. Migration Step 7 — Remove Direct Spawn

加入代码规则或 ESLint：

- Runtime Core 禁止直接 import `child_process`；
- 只允许 Process Runtime Package；
- Provider Adapter 只能使用 Process Port。

---

# Part XXIV — Implementation Structure

## 104. Recommended Package

```text
packages/process-runtime/
├── src/
│   ├── process-manager.ts
│   ├── process-repository.ts
│   ├── handle-registry.ts
│   ├── launch-validator.ts
│   ├── environment-builder.ts
│   ├── argument-redactor.ts
│   ├── stream/
│   │   ├── decoder.ts
│   │   ├── ansi.ts
│   │   ├── framer.ts
│   │   ├── backpressure.ts
│   │   └── artifact-writer.ts
│   ├── timeout/
│   │   ├── timeout-controller.ts
│   │   └── activity-tracker.ts
│   ├── recovery/
│   │   ├── recovery-manager.ts
│   │   └── orphan-manager.ts
│   ├── platform/
│   │   ├── driver.ts
│   │   ├── windows-driver.ts
│   │   └── posix-driver.ts
│   ├── errors.ts
│   ├── events.ts
│   └── testing/
└── package.json
```

---

## 105. Service Dependencies

Process Runtime 可以依赖：

- Storage；
- Event Sink；
- Artifact Sink；
- Policy Port；
- Secret Redactor；
- Clock；
- Platform Driver。

不得依赖：

- Web UI；
- Conversation Service；
- Provider-specific Package；
- Workflow Definition；
- Memory Engine。

---

# Part XXV — Implementation Phases

## 106. Phase 1 — Foundation

- RuntimeProcess Schema；
- Process Manager；
- Direct Spawn；
- stdout / stderr；
- Exit；
- Idle Timeout；
- Cancel；
- Event；
- Artifact；
- Existing Provider Adapter Integration。

---

## 107. Phase 2 — Tree and Platform

- Windows Job Object；
- POSIX Process Group；
- Tree Inspection；
- Survivor Detection；
- Reliable Run Cancel。

---

## 108. Phase 3 — Recovery

- Recovery Token；
- Startup Scan；
- PID Reuse；
- Orphan Manager；
- Shutdown Mode。

---

## 109. Phase 4 — Resource and Inspector

- Usage Sampling；
- Output Backpressure；
- Resource Policy；
- Process Inspector；
- Debug Bundle。

---

# Part XXVI — Definition of Done

## 110. Process Runtime Foundation DoD

Foundation 完成必须满足：

1. 所有 CLI 通过 Process Manager 启动。
2. Process 有 Durable Record。
3. Run、Stage、Provider Session 与 Process 可关联。
4. stdout / stderr 可流式读取。
5. 原始输出生成 Artifact。
6. UTF-8 Chunk 可正确处理。
7. Secret 不进入普通 Event。
8. Idle Timeout 工作。
9. Approval 等待暂停 Idle Timer。
10. Browser Disconnect 不终止 Process。
11. Cancel 幂等。
12. Windows 能清理完整 Process Tree。
13. POSIX 能终止 Process Group。
14. Process Exit 产生 Canonical Event。
15. Process Error 有稳定 Error Code。
16. Server Startup 能扫描 Active Process。
17. Orphan 可识别。
18. PID Reuse 不会误恢复。
19. 高频输出有 Backpressure。
20. Provider Adapter 不直接调用 child_process。
21. v1 工作流仍可通过兼容层运行。
22. Contract Test 和 Platform Test 通过。

---

# Part XXVII — Anti-Patterns

## 111. Browser-owned Process

错误：

```text
HTTP request closes
  ↓
AbortController
  ↓
Process killed
```

正确：

```text
Run owns Process
Client only subscribes
```

---

## 112. Kill Parent PID Only

错误：

```ts
child.kill();
```

正确：

```text
Graceful Provider Stop
  ↓
Platform Tree Termination
  ↓
Survivor Verification
```

---

## 113. Direct Shell String

错误：

```ts
exec(`kimi ${userPrompt}`);
```

正确：

```ts
spawn(executable, args, {
  shell: false
});
```

Prompt 使用 stdin 或文件。

---

## 114. Full Environment Inheritance

错误：

```ts
env: process.env
```

正确：

```text
Safe Base
+ Explicit Profiles
+ Required Secrets
```

---

## 115. Exit Code Equals Run Success

错误：

```ts
if (exitCode === 0) {
  run.complete();
}
```

正确：

```text
Process Exit
  ↓
Provider Finalize
  ↓
Stage Output Contract
  ↓
Workflow Completion
```

---

## 116. Unbounded Output Buffer

错误：

```ts
stdout += chunk;
```

正确：

```text
Stream
  ↓
Bounded Buffer
  ↓
Artifact Append
  ↓
Event Aggregation
```

---

## 117. PID-only Recovery

错误：

```text
PID exists
→ same process
```

正确：

```text
PID
+ Start Time
+ Executable
+ Recovery Token
→ identity
```

---

## 118. Process Runtime Parses Provider Semantics

错误：

```text
Process Manager recognizes Codex tool event
```

正确：

```text
Process Manager handles bytes
Provider Adapter handles semantics
```

---

# Part XXVIII — Global Invariants

## 119. Process Runtime Invariants

AgentOS v2 必须始终满足：

1. 所有本地进程通过 Process Manager。
2. Runtime Core 和 Provider Adapter 不直接裸 Spawn。
3. Process 必须属于 Run。
4. Process 与 Provider Session 分离。
5. Browser Disconnect 不影响 Process。
6. Cancel 必须幂等。
7. Cancel 必须处理 Process Tree。
8. Windows 优先使用 Job Object。
9. POSIX 优先使用 Process Group。
10. Shell 默认关闭。
11. 参数必须使用数组。
12. Prompt 不应通过未转义 Shell 字符串。
13. Environment 必须最小化。
14. Secret 不得进入 Event、Log、Snapshot。
15. stdout / stderr 视为不可信。
16. 输出必须有 Backpressure。
17. Raw Output 必须可保存。
18. Idle Timeout 优先于固定 Total Timeout。
19. Approval 等待不计入 Idle Timeout。
20. Process Exit 不等于 Stage Success。
21. Exit Code 0 不等于 Provider Success。
22. Terminal Transition 必须并发安全。
23. Recovery 不得只依赖 PID。
24. 无法确认的 Process 不得猜测完成。
25. Orphan 必须可检测。
26. Survivor 必须明确报告。
27. Spawn 与数据库采用可补偿 Saga。
28. Process Event 必须持久化。
29. Platform 差异必须封装在 Driver。
30. Provider 语义不得进入 Process Manager。
31. Worktree 应作为修改进程 cwd。
32. 资源限制必须可观察。
33. Server Shutdown 必须有明确模式。
34. v1 HTTP Abort 所有权必须废弃。
35. Process Runtime 必须可通过 Mock Driver 测试。

---

# Part XXIX — Final Definition

## 120. Final Definition

AgentOS v2 Process Runtime 定义如下：

> Process Runtime 是 AgentOS 管理操作系统执行单元的统一底座。所有 Provider CLI、Tool、Command、Git 和 Test Process 都必须通过 Process Manager 启动。Process Manager 负责验证 executable、参数、cwd、Environment 和 Policy，持久化 Runtime Process，调用平台驱动创建进程，管理 stdin、stdout、stderr、活动时间、Timeout、Process Tree、Cancel、Pause、Recovery、Orphan 和 Cleanup，并将所有重要行为转换为 Canonical Runtime Event。Process 的生命所有权属于 Run，而不是 Browser、SSE 或单次 HTTP Request。

简化表达：

```text
Provider / Tool / Git Runtime
  ↓
Process Launch Request
  ↓
Validation + Policy
  ↓
Process Reservation
  ↓
Platform Driver
  ↓
OS Process + Process Tree
  ↓
Stream Pipeline + Activity + Timeout
  ↓
Runtime Event + Raw Artifact
  ↓
Graceful Stop / Force Tree Termination
  ↓
Exit + Recovery + Cleanup
```

平台定义：

```text
Windows:
  Job Object
  → Ctrl Break / Native Interrupt
  → taskkill Tree Fallback
  → Survivor Verification

Linux / macOS:
  Process Group
  → SIGINT
  → SIGTERM
  → SIGKILL
  → Group Verification
```

本文件定义的 Process Runtime 是 AgentOS v2 Provider Runtime、可靠取消、长期任务、Server Recovery、Runtime Inspector 和安全执行能力的操作系统基础。
