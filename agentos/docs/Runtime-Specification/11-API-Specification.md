# AgentOS Runtime Specification v2.0

## 11 — API Specification

> Status: Draft  
> Version: 2.0  
> Last Updated: 2026-08-08
> Scope: AgentOS v2 HTTP, Realtime and Internal Runtime API Contract  
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
> Repository: `Zbyy0311/agentos`
> P3C-0B: MERGED
> Option A Alignment: MERGED via PR #29
> P3C-1 Start Portion: IMPLEMENTED AND MERGED via PR #31
> P3C-1 Retry production: IMPLEMENTED AND MERGED via PR #33
> P3C-1 Retry contract: IMPLEMENTED CONTRACT / CURRENT
> P3C-1: COMPLETE
> M3 P3E entry production baseline: `7efecc67a8f8cb8abe64a4ceefe7f144d22ec17e`
> P3D-0 PREPLANNING: COMPLETE
> P3D CONTRACT CLOSURE: OWNER APPROVED / DOCUMENTED
> M3-TD-31 / M3-TD-32: OWNER APPROVED / IMPLEMENTED AND MERGED via PR #37
> P3D-1 / P3D-2: IMPLEMENTED AND MERGED via PR #36 / PR #37
> P3D-3: COMPLETE AND MERGED via PR #38
> P3E integrated verification evidence: COMPLETE (test/docs only, commit `400a3b29697b7185d29df2cb9da0417260549913`; no API production behavior added)
> Migration 014: NOT REQUIRED / NOT AUTHORIZED / ABSENT
> Production Cutover: NOT PERFORMED / NOT AUTHORIZED
> Remote Checks: UNAVAILABLE — NOT PASS

---

## 1. Document Purpose

本文件定义 AgentOS v2 的统一 API Specification。

它将前述 Runtime Specification 中的领域对象、生命周期、事件、审批和持久化模型映射为可实现、可测试、可生成 OpenAPI 的 API 合同。

本文件规定：

- API 分层；
- HTTP 路径；
- Resource Naming；
- Request / Response Envelope；
- Error Format；
- Authentication；
- Authorization；
- Workspace Boundary；
- Versioning；
- Idempotency；
- Optimistic Concurrency；
- Pagination；
- Filtering；
- Sorting；
- Search；
- Async Operation；
- Command Endpoint；
- Long-running Run；
- Runtime Event Query；
- SSE；
- WebSocket；
- Reconnect；
- Rate Limit；
- Audit；
- Security；
- OpenAPI；
- SDK；
- Internal API；
- Recovery；
- Testing；
- v1 Migration。

本文件是以下模块共同遵循的外部合同：

- Web UI；
- CLI Client；
- Desktop Client；
- Mobile Client；
- Runtime Inspector；
- Extension Center；
- Provider Settings；
- Conversation UI；
- Approval Center；
- Automation Client；
- Future Remote Worker；
- Future Third-party SDK。

---

## 2. API Goals

AgentOS v2 API 必须满足：

1. **资源可识别**  
   Workspace、Agent、Task、Run、Process、Worktree、Message 等拥有稳定 URL。

2. **执行可持续**  
   HTTP 请求结束后，Run 和 Process 可以继续。

3. **控制可幂等**  
   Cancel、Approve、Retry、Merge 等重复请求不会制造重复副作用。

4. **状态可恢复**  
   客户端断线后可以重新读取当前状态和补齐事件。

5. **历史可审计**  
   API 返回的当前状态能链接到 Runtime Event 和 Audit。

6. **并发可控制**  
   修改操作使用 ETag、Version、Expected Commit 或 Idempotency Key。

7. **错误可编程处理**  
   客户端依赖稳定 Error Code，而不是解析报错字符串。

8. **安全边界明确**  
   API 不允许客户端伪造 Provider、Agent、Policy Principal 或 Secret Value。

9. **本地优先**  
   Localhost 部署无需复杂云基础设施。

10. **未来可远程化**  
    合同保留认证、权限、分页、异步任务和多客户端能力。

---

## 3. API Architecture

```text
Client
  ├── REST API
  ├── Server-Sent Events
  └── WebSocket
        ↓
API Gateway / HTTP Server
        ↓
Application Services
  ├── Workspace Service
  ├── Agent Registry
  ├── Provider Runtime
  ├── Task Runtime
  ├── Run Engine
  ├── Process Runtime
  ├── Worktree Runtime
  ├── Memory Runtime
  ├── Policy Runtime
  ├── Conversation Runtime
  └── Artifact Runtime
        ↓
Storage + Event Store + Outbox
```

### 3.1 Public API

前端和受信客户端使用：

```text
/api/*
```

### 3.2 Internal API

仅 AgentOS 内部服务使用：

```text
/internal/*
```

Internal API 不应暴露到公网。

### 3.3 Realtime API

```text
/api/runs/:runId/stream
/api/conversations/:conversationId/stream
/api/realtime
```

### 3.4 Static Artifact Delivery

Artifact 内容由专用受控 Endpoint 返回。

不得让客户端直接拼接本地文件路径。

---

# Part I — Global HTTP Contract

## 4. Base URL

v2 Foundation 的 Canonical Base Path：

```text
/api
```

示例：

```text
http://127.0.0.1:3001/api
```

### 4.1 Route Versioning

当前 v2 继续使用 `/api`，以兼容现有 AgentOS 路径。

API 版本通过以下方式公开：

```text
GET /api/meta
AgentOS-API-Version: 2.0
```

未来发生 Breaking Change 时使用：

```text
/api/v3
```

或新的 Vendor Media Type。

### 4.2 No Version in Query

禁止：

```text
/api/tasks?version=2
```

作为协议版本控制方式。

---

## 5. Media Types

普通 JSON：

```text
Content-Type: application/json
Accept: application/json
```

错误：

```text
Content-Type: application/problem+json
```

SSE：

```text
Content-Type: text/event-stream
```

Artifact：

根据实际 MIME Type。

OpenAPI：

```text
application/yaml
application/json
```

---

## 6. Character Encoding

所有 JSON、SSE、文本响应使用：

```text
UTF-8
```

时间使用 UTC ISO 8601。

---

## 7. Resource Naming

路径使用复数 kebab-case：

```text
/provider-sessions
/policy-grants
/memory-candidates
```

JSON 字段使用 camelCase：

```json
{
  "providerConfigId": "provider_123",
  "createdAt": "2026-07-19T12:00:00.000Z"
}
```

---

## 8. Resource IDs

ID 是不透明字符串。

客户端不得解析 ID 中的时间或类型。

```text
run_01JZ...
msg_01JZ...
```

路径参数必须使用 URL Encoding。

---

## 9. Success Envelope

### 9.1 Single Resource

```ts
interface ApiResponse<T> {
  data: T;

  meta?: {
    requestId: string;
    apiVersion: string;
    generatedAt: string;
    warnings?: ApiWarning[];
  };
}
```

示例：

```json
{
  "data": {
    "id": "task_123",
    "status": "ready"
  },
  "meta": {
    "requestId": "req_123",
    "apiVersion": "2.0",
    "generatedAt": "2026-07-19T12:00:00.000Z"
  }
}
```

### 9.2 Empty Success

使用：

```text
204 No Content
```

不返回：

```json
{"success": true}
```

### 9.3 Command Result

同步命令：

```ts
interface CommandResponse<T> {
  data: T;

  meta: {
    requestId: string;
    idempotencyKey?: string;
    operationId?: string;
  };
}
```

---

## 10. List Envelope

```ts
interface ApiListResponse<T> {
  data: T[];

  page: {
    limit: number;
    hasMore: boolean;
    nextCursor?: string;
    previousCursor?: string;
  };

  meta?: {
    requestId: string;
    totalEstimate?: number;
    warnings?: ApiWarning[];
  };
}
```

### 10.1 No Mandatory Total Count

大列表默认不计算精确总数。

需要时使用：

```text
includeTotal=true
```

并允许返回 `totalEstimate`。

---

## 11. Error Format

使用 `application/problem+json`：

```ts
interface ApiProblem {
  type: string;

  title: string;

  status: number;

  code: string;

  detail: string;

  instance: string;

  requestId: string;

  retryable: boolean;

  retryAfterMs?: number;

  suggestedAction?: string;

  errors?: Array<{
    field?: string;
    code: string;
    message: string;
  }>;

  context?: {
    workspaceId?: string;
    taskId?: string;
    runId?: string;
    stageId?: string;
    providerSessionId?: string;
    processId?: string;
    worktreeId?: string;
    approvalRequestId?: string;
  };
}
```

示例：

```json
{
  "type": "urn:agentos:error:provider-auth-required",
  "title": "Provider authentication required",
  "status": 409,
  "code": "PROVIDER_AUTH_REQUIRED",
  "detail": "KimiCode must be logged in before this run can start.",
  "instance": "/api/runs/run_123",
  "requestId": "req_123",
  "retryable": false,
  "suggestedAction": "Complete KimiCode CLI login and validate the provider again.",
  "context": {
    "runId": "run_123"
  }
}
```

### 11.1 Stable Code

客户端依赖：

```text
code
```

不得依赖 `detail` 文本。

---

## 12. HTTP Status Mapping

| Status | Meaning |
|---|---|
| 200 | Query or synchronous command completed |
| 201 | Resource created |
| 202 | Long-running operation accepted |
| 204 | Successful response without body |
| 304 | Conditional GET not modified |
| 400 | Invalid request shape or argument |
| 401 | Authentication required |
| 403 | Authenticated but policy/access denied |
| 404 | Resource not found |
| 409 | State, version, idempotency or lifecycle conflict |
| 410 | Resource/cursor removed by retention |
| 412 | ETag / precondition failed |
| 413 | Payload too large |
| 415 | Unsupported media type |
| 422 | Semantically invalid request |
| 423 | Resource locked |
| 429 | Rate or concurrency limit |
| 500 | Unexpected internal failure |
| 502 | Provider or remote dependency failure |
| 503 | Runtime unavailable or degraded |
| 504 | Upstream timeout |

### 12.1 Approval Required

Policy 要求审批时：

- 创建长期 Operation 的请求：可以返回 `202`，Operation 进入 `waiting_approval`；
- 单次同步 Action：返回 `409 POLICY_APPROVAL_REQUIRED`，附 `approvalRequestId`；
- UI 应优先处理 Approval Resource。

---

## 13. Request Headers

### Required or Recommended

```text
X-Request-ID
Idempotency-Key
If-Match
If-None-Match
Last-Event-ID
AgentOS-Client
AgentOS-Client-Version
```

### 13.1 `X-Request-ID`

客户端可提供。

Server 未收到时生成。

响应始终返回：

```text
X-Request-ID: req_...
```

### 13.2 `AgentOS-Client`

示例：

```text
web
desktop
cli
mobile
extension:<id>
```

---

## 14. Response Headers

```text
X-Request-ID
AgentOS-API-Version
ETag
Location
Retry-After
Cache-Control
```

敏感 API：

```text
Cache-Control: no-store
```

---

# Part II — Authentication and Authorization

## 15. Authentication Modes

```ts
type ApiAuthenticationMode =
  | 'local-session'
  | 'bearer-token'
  | 'reverse-proxy'
  | 'disabled-loopback-only';
```

### 15.1 Local Session

Web UI 使用 HttpOnly Session Cookie。

要求：

- SameSite；
- CSRF Protection；
- Secure when HTTPS；
- Session Rotation。

### 15.2 Bearer Token

CLI 和远程客户端：

```text
Authorization: Bearer <token>
```

Token 不进入 URL、日志或 Error。

### 15.3 Disabled Loopback-only

只允许：

```text
127.0.0.1
::1
```

Server 监听非 Loopback 时不得继续使用无认证模式。

---

## 16. API Principal

认证层生成 User Principal。

Runtime 内的 Agent、Provider、Extension Principal 由 Server 根据受信实体构建。

客户端不得在请求体中声明：

```json
{
  "principal": {
    "type": "system"
  }
}
```

---

## 17. Authorization

API Authorization 分两层：

1. Resource Access；
2. Runtime Policy Evaluation。

### 17.1 Resource Access

判断用户是否能读取或管理 Workspace、Conversation、Artifact。

### 17.2 Runtime Policy

判断 Action 是否能执行。

例如用户能查看 Worktree，不代表可以 Force Cleanup。

---

## 18. Workspace Boundary

创建资源时 Workspace 来自：

- Path；
- Parent Resource；
- Auth Context。

如果 Path 已有 Workspace ID，请求体中的 Workspace ID 必须省略或一致。

禁止跨 Workspace 引用：

```text
Task from workspace A
+ Provider from workspace B
```

除非 Provider Configuration 是 Global 且允许。

---

## 19. CSRF

Cookie Session 的修改请求必须验证 CSRF。

Bearer Token 请求不使用 Cookie CSRF，但仍受 Origin 和 CORS Policy。

---

## 20. CORS

默认只允许 AgentOS UI Origin。

Remote API 必须显式配置 Allowed Origin。

禁止：

```text
Access-Control-Allow-Origin: *
```

同时允许 Credential。

---

# Part III — Versioning and Concurrency

## 21. Resource Version

所有可变 Aggregate 返回：

```json
{
  "version": 7
}
```

响应：

```text
ETag: "v7"
```

---

## 22. Conditional Update

PATCH、DELETE 和高风险 Command 推荐要求：

```text
If-Match: "v7"
```

不匹配：

```text
412 Precondition Failed
STORAGE_VERSION_CONFLICT
```

### 22.1 Body Fallback

非 HTTP Client 可以传：

```json
{
  "expectedVersion": 7
}
```

但不得同时提供不一致的 Header 和 Body。

---

## 23. Idempotency

### 23.1 Required Operations

以下操作必须实现 `Idempotency-Key` 支持；Client 是否必须提供由各
Endpoint 合同决定：

- Create Task；
- Create Run；
- Start Run；
- Send Message；
- Create Worktree；
- Start Provider Session；
- Resolve Approval；
- Merge；
- Artifact Export；
- Memory Candidate Accept；
- Conversation Projection；
- Extension Install。

### 23.2 Semantics

相同 Key + 相同 Request Hash：

- 返回原状态和原响应；
- 不重复执行。

相同 Key + 不同 Request Hash：

```text
409 IDEMPOTENCY_KEY_REUSED
```

### 23.3 Retention

Idempotency Record 至少保留到：

- Operation Terminal；
- 再加配置的安全窗口。

---

## 24. Expected Resource State

高风险命令可要求：

```json
{
  "expectedStatus": "ready_for_review",
  "expectedHeadCommit": "abc123",
  "expectedTargetCommit": "def456"
}
```

ETag 不能替代 Git Expected Commit。

---

# Part IV — Pagination, Filtering and Search

## 25. Cursor Pagination

普通列表使用：

```text
?limit=50&cursor=<opaque>
```

Cursor 是不透明值。

客户端不得修改 Cursor 内容。

### 25.1 Default and Maximum

建议：

```text
default = 50
maximum = 200
```

---

## 26. Sequence Pagination

严格有序资源使用 Sequence：

### Runtime Event

```text
afterSequence
beforeSequence
```

### Message

```text
afterSequence
beforeSequence
```

Sequence Pagination 优先于 Cursor。

---

## 27. Filtering

过滤字段使用明确参数：

```text
status=running
providerType=kimicode
agentId=agent_123
createdAfter=...
createdBefore=...
```

多个值：

```text
status=running,paused
```

---

## 28. Sorting

```text
sort=createdAt
order=desc
```

每个 Endpoint 只允许白名单字段。

未知字段返回 `400`。

---

## 29. Search

全文搜索使用：

```text
q=<text>
```

Search 与结构化 Filter 可以组合。

搜索结果必须受 Workspace 和权限约束。

---

## 30. Expansion

资源关联默认不自动深度展开。

使用：

```text
include=stages,providerSessions,artifacts
```

### 30.1 Limits

最多允许有限层级。

禁止：

```text
include=everything
```

造成无限对象图。

---

# Part V — Asynchronous Operation

## 31. Operation Resource

长时间命令返回 Operation：

```ts
interface ApiOperation {
  id: string;

  type: string;

  status:
    | 'queued'
    | 'running'
    | 'waiting_approval'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled';

  workspaceId?: string;

  aggregateType?: string;

  aggregateId?: string;

  progress?: {
    current?: number;
    total?: number;
    percent?: number;
    message?: string;
  };

  approvalRequestId?: string;

  result?: {
    resourceType?: string;
    resourceId?: string;
    data?: unknown;
  };

  error?: ApiProblem;

  createdAt: string;
  startedAt?: string;
  completedAt?: string;

  version: number;
}
```

---

## 32. Async Response

```text
202 Accepted
Location: /api/operations/op_123
```

```json
{
  "data": {
    "id": "op_123",
    "status": "queued",
    "aggregateType": "run",
    "aggregateId": "run_123"
  }
}
```

---

## 33. Operation APIs

```text
GET  /api/operations/:operationId
GET  /api/operations/:operationId/events
POST /api/operations/:operationId/cancel
```

### 33.1 Operation Is Not Run

Run 是工程执行实体。

Operation 是 API 长命令的跟踪实体。

创建 Run 的 Operation 完成后，Run 仍可能继续运行。

### 33.2 M3 P3D Operation Cancel Contract

> **OWNER-APPROVED CONTRACT / IMPLEMENTED AND MERGED.** This section freezes
> the M3 P3D canonical Operation Cancel contract. The frozen contract was
> subsequently implemented and merged: P3D-1 delivered the Operation read
> surface (PR #36), P3D-2 delivered this atomic Cancel route and orchestration
> (PR #37), and P3D-3 closed the Cancel race matrix (PR #38).

The canonical endpoint is exactly:

```text
POST /api/operations/:operationId/cancel
```

The URL accepts only `operationId`. The query string must be empty. The client
must not supply `workspaceId`, `runId`, `correlationId`, `requestedBy`,
`terminatedProcessIds`, `worktreePreserved`, or `reason` through the path,
query, or body.

The request body is an exact JSON object:

```json
{
  "expectedVersion": 1
}
```

`expectedVersion` is required, identifies the Operation version, and must be a
positive JavaScript safe integer. An empty object, an extra field, a missing
field, zero, a negative number, a non-integer, or an unsafe integer returns
`400 VALIDATION_FAILED`. M3 P3D does not accept ETag or `If-Match` as the
canonical version transport; any future ETag transport is a Post-M3 API
decision.

Each of these parseable JSON bodies is a validation failure:

```json
{}
```

```json
{
  "expectedVersion": 1,
  "reason": "x"
}
```

```json
{
  "workspaceId": "x",
  "expectedVersion": 1
}
```

```json
{
  "expectedVersion": 0
}
```

The Operation router must mount before the global `express.json()` middleware.
The request order is frozen:

1. Resolve the opaque `operationId`.
2. Resolve and authorize the owning workspace.
3. For Cancel only, run the route-scoped JSON parser.
4. Validate the empty query and exact body.
5. Invoke `OperationService`.

An unknown Operation therefore returns `404 OPERATION_NOT_FOUND` before
malformed JSON, an invalid query, an invalid `expectedVersion`, or an extra
body field is considered. GET Operation routes do not run a JSON parser.

After locator completion, Cancel executes in exactly one caller-owned
`BEGIN IMMEDIATE` transaction. The service precedence is:

1. Workspace-scoped Operation re-read.
2. Aggregate, Run, workspace, and correlation binding validation.
3. If the Operation is already `cancelled`, return its current
   `ApiOperation` with HTTP 200 and zero lifecycle, Event, or Outbox side
   effects. This no-op takes precedence over a stale `expectedVersion`.
4. Compare `expectedVersion` for every other status.
5. Classify the status as cancellable or terminal.
6. Perform the dedicated guarded Operation update to `cancelled`.
7. Cancel the bound Run through the approval-aware lifecycle seam.
8. Commit.

A stale non-cancelled Operation returns `409 VERSION_CONFLICT`. With a matching
version, `completed` and `failed` return
`409 OPERATION_NOT_CANCELLABLE`. The guarded cancellable Operation statuses are
exactly `queued`, `running`, `waiting_approval`, and `paused`.

The server supplies trusted lifecycle metadata; none of it is accepted from
the client:

```text
requestedBy = "operation_api"
terminatedProcessIds = []
worktreePreserved = true
reason = undefined
```

An empty `terminatedProcessIds` means P3D does not claim to terminate an M4
OS Process. `worktreePreserved = true` means P3D does not delete, reset, clean,
or otherwise modify a Worktree. Existing v2 Run Cancel metadata and behavior
remain unchanged.

For a bound Run in `queued`, `starting`, `running`, or `paused`, the
approval-aware seam may reuse the current caller-owned Run cancellation core.
For a bound Run in `waiting_approval`, it must discover exactly one unresolved
`approval.required` from persisted Runtime Event history while preserving the
original `runId`, optional `stageId`, and `approvalRequestId` binding. Zero,
multiple, or inconsistent unresolved approvals fail closed, roll back the
outer transaction, and are sanitized at the route as `500 INTERNAL_ERROR`;
SQL, SQLite details, paths, Event payload internals, and stacks are never
returned.

The waiting-approval Event order is frozen:

```text
approval.resolved (decision = "cancel_run", decidedBy = "operation_api")
stage.cancelled × N (stage.sequence ASC, then stage.id ASC)
run.cancelled
```

Run Event sequences are contiguous, every Event has exactly one Outbox row,
and all Operation, Run, Stage, Event, Outbox, version, and sequence writes
commit or roll back together. `run.cancellation_requested` is not a required
Event.

Success returns HTTP 200 with the current `ApiOperation`. Cancel creates no
second Operation, no `operation.cancel` Operation, and no new Idempotency
Record. `Idempotency-Key` is not required or consumed and must not be presented
as participating in replay. Existing `run.cancel` vocabulary and v2
idempotency remain unchanged.

The public stable codes frozen for this endpoint are only:

```text
VALIDATION_FAILED
OPERATION_NOT_FOUND
VERSION_CONFLICT
OPERATION_NOT_CANCELLABLE
INTERNAL_ERROR
```

---

## 34. Polling

客户端可：

- Poll Operation；
- 订阅 SSE；
- 使用 WebSocket。

建议 Poll Interval：

```text
1–5 seconds
```

---

# Part VI — System and Metadata APIs

## 35. Health

```text
GET /api/health
```

Response：

```ts
interface HealthResponse {
  status:
    | 'healthy'
    | 'degraded'
    | 'unhealthy';

  database: string;
  eventStore: string;
  processRuntime: string;
  worktreeRuntime: string;
  providerRuntime: string;

  startedAt: string;
  version: string;
}
```

不得泄露 Secret、完整路径或 Credential。

---

## 36. Readiness

```text
GET /api/ready
```

用于判断能否接收新 Run。

Migration、Recovery 或 Storage Failure 时可返回 `503`。

---

## 37. Metadata

```text
GET /api/meta
```

返回：

- AgentOS Version；
- API Version；
- Schema Version；
- Platform；
- Enabled Features；
- Realtime Capability；
- Authentication Mode；
- Local / Remote Mode。

### 37.1 UI Host Metadata

```json
{
  "ui": {
    "supportedHosts": ["web", "tauri"],
    "currentHost": "web"
  }
}
```

> `currentHost` 只作为信息字段，不可作为授权或安全判断依据。

### 37.2 Platform Boundary Note

Tauri Native Command 不替代 AgentOS Runtime REST、SSE 和 WebSocket 合同。

所有 UI Host（Browser / Desktop）都使用相同的 Runtime API。

当前不新增以下 API：

```text
- Sidecar 启动 / 停止 / 状态
- 系统托盘控制
- 原生通知发送
- Native File Reveal
- Auto Update 触发
- 全局快捷键注册
```

这些属于未来 Desktop Host Specification，不应提前设计。

---

## 38. Capabilities

```text
GET /api/capabilities
```

返回 Runtime Feature Flags：

```ts
interface RuntimeCapabilitiesResponse {
  providers: string[];
  platformProcess: Record<string, boolean>;
  worktree: Record<string, boolean>;
  memory: Record<string, boolean>;
  policy: Record<string, boolean>;
  conversation: Record<string, boolean>;
  realtime: Record<string, boolean>;
}
```

---

## 39. System UI Preferences

### 39.1 User UI Preferences

```text
GET   /api/preferences/ui
PATCH /api/preferences/ui
```

Response：

```ts
interface UserUIPreferencesResponse {
  appearance: 'system' | 'light' | 'dark';
  accent?: string;
  density: 'comfortable' | 'compact';
  reducedMotionOverride?: string;
  reducedTransparencyOverride?: string;
  contrastOverride?: string;
  notificationPreferences: Record<string, unknown>;
}
```

### 39.2 Workspace UI Preferences

```text
GET   /api/workspaces/:workspaceId/ui-preferences
PATCH /api/workspaces/:workspaceId/ui-preferences
```

Response：

```ts
interface WorkspaceUIPreferencesResponse {
  defaultArea?: string;
  defaultConversationId?: string;
  sidebarWidth?: number;
  inspectorWidth?: number;
  sidebarCollapsed: boolean;
  inspectorDefaultOpen: boolean;
  savedFilters?: Record<string, unknown>[];
}
```

UI Preferences 字段参见 `10-Data-Model.md` 中 `user_ui_preferences` 和 `workspace_ui_preferences` 的表定义。

---

## 40. OpenAPI

```text
GET /api/openapi.json
GET /api/openapi.yaml
```

---

## 40. System Recovery

```text
GET  /api/system/recovery
POST /api/system/recovery/scan
POST /api/system/recovery/actions/:actionId/execute
```

高风险 Recovery Action 必须通过 Policy 和 Approval。

---

# Part VII — Workspace APIs

## 41. Workspace Collection

```text
GET  /api/workspaces
POST /api/workspaces
```

### Create Workspace

```ts
interface CreateWorkspaceRequest {
  name: string;
  description?: string;
  rootPath: string;
  repositoryType?: 'git' | 'directory' | 'remote';
  defaultBranch?: string;
  idempotencyKey?: string;
}
```

返回 `201`。

---

## 42. Workspace Resource

```text
GET    /api/workspaces/:workspaceId
PATCH  /api/workspaces/:workspaceId
DELETE /api/workspaces/:workspaceId
```

DELETE 默认 Archive / Soft Delete。

存在 Active Run 时返回 `409`。

---

## 43. Workspace Validation

```text
POST /api/workspaces/:workspaceId/validate
```

验证：

- Path；
- Repository；
- Git State；
- Writable Data Root；
- Provider Defaults；
- Worktree Capability。

长检查可以返回 Operation。

---

## 44. Workspace Settings

```text
GET   /api/workspaces/:workspaceId/settings
PATCH /api/workspaces/:workspaceId/settings
```

PATCH 使用 Merge Patch 语义或明确 DTO。

---

## 45. Workspace Defaults

```text
GET   /api/workspaces/:workspaceId/defaults
PATCH /api/workspaces/:workspaceId/defaults
```

可设置：

- Agent；
- Provider；
- Workflow；
- Policy；
- Branch；
- Worktree Strategy。

---

## 46. Workspace History

```text
GET /api/workspaces/:workspaceId/activity
GET /api/workspaces/:workspaceId/audit
```

Activity 是用户友好投影。

Audit 是受权限控制的审计记录。

---

# Part VIII — Agent APIs

## 47. Agent Collection

```text
GET  /api/workspaces/:workspaceId/agents
POST /api/workspaces/:workspaceId/agents
```

### Create Agent

```ts
interface CreateAgentRequest {
  name: string;
  role: string;
  description?: string;
  instructions?: string;
  avatar?: string;
  defaultProviderConfigId?: string;
  defaultWorkflowRole?: string;
  capabilities?: string[];
}
```

---

## 48. Agent Resource

```text
GET    /api/agents/:agentId
PATCH  /api/agents/:agentId
DELETE /api/agents/:agentId
```

DELETE 默认 Archive。

被历史 Run 引用不阻止 Archive。

---

## 49. Agent State

```text
POST /api/agents/:agentId/enable
POST /api/agents/:agentId/disable
POST /api/agents/:agentId/clone
```

---

## 50. Agent Provider Bindings

```text
GET    /api/agents/:agentId/providers
POST   /api/agents/:agentId/providers
PATCH  /api/agents/:agentId/providers/:bindingId
DELETE /api/agents/:agentId/providers/:bindingId
```

---

## 51. Agent History

```text
GET /api/agents/:agentId/history
GET /api/agents/:agentId/conversations
GET /api/agents/:agentId/tasks
GET /api/agents/:agentId/runs
GET /api/agents/:agentId/provider-sessions
GET /api/agents/:agentId/artifacts
GET /api/agents/:agentId/memories
```

History Endpoint 可聚合摘要，不替代各资源查询。

---

# Part IX — Provider APIs

## 52. Provider Configuration

```text
GET  /api/providers
POST /api/providers
```

Filters：

```text
workspaceId
providerType
enabled
valid
authenticated
```

---

## 53. Provider Resource

```text
GET    /api/providers/:providerConfigId
PATCH  /api/providers/:providerConfigId
DELETE /api/providers/:providerConfigId
```

DELETE 默认 Archive。

---

## 54. Provider Discovery

```text
POST /api/providers/discover
```

```ts
interface DiscoverProviderRequest {
  providerType: string;
  configuredExecutable?: string;
  workspaceId?: string;
}
```

Discovery 不安装、不登录、不修改 PATH。

---

## 55. Provider Validation

```text
POST /api/providers/:providerConfigId/validate
GET  /api/providers/:providerConfigId/validations
GET  /api/providers/:providerConfigId/capabilities
GET  /api/providers/:providerConfigId/health
```

Validation 可同步或返回 Operation。

---

## 56. Provider Adapters

```text
GET /api/provider-adapters
GET /api/provider-adapters/:adapterId
```

返回 Manifest、Version、Provider Types、Runtime Modes。

---

## 57. Provider Authentication

```text
POST /api/providers/:providerConfigId/auth/start
GET  /api/providers/:providerConfigId/auth/status
POST /api/providers/:providerConfigId/auth/revalidate
POST /api/providers/:providerConfigId/auth/logout
```

### 57.1 Auth Start

可能返回：

- Operation；
- Device Code；
- Browser URL Reference；
- Native CLI Instruction。

不得返回 Credential Value。

---

## 58. Provider Sessions

```text
GET /api/provider-sessions
GET /api/provider-sessions/:providerSessionId
GET /api/provider-sessions/:providerSessionId/events
GET /api/provider-sessions/:providerSessionId/output
```

Filters：

```text
workspaceId
runId
stageId
agentId
providerConfigId
status
```

---

## 59. Provider Session Control

```text
POST /api/provider-sessions/:providerSessionId/cancel
POST /api/provider-sessions/:providerSessionId/pause
POST /api/provider-sessions/:providerSessionId/resume
```

普通用户应优先控制 Run。

Session Control 主要用于 Inspector 和 Recovery。

---

## 60. Provider Test

```text
POST /api/providers/:providerConfigId/test
```

执行受控、只读、短生命周期测试。

不得修改 Workspace。

---

# Part X — Workflow APIs

## 61. Workflow Collection

```text
GET  /api/workflows
POST /api/workflows
```

Filters：

```text
workspaceId
status
name
```

---

## 62. Workflow Resource

```text
GET    /api/workflows/:workflowDefinitionId
PATCH  /api/workflows/:workflowDefinitionId
DELETE /api/workflows/:workflowDefinitionId
```

已被 Run Snapshot 引用的 Version 不可原地改写。

PATCH 创建新 Definition Version 或更新 Draft。

---

## 63. Workflow Versions

```text
GET  /api/workflows/:workflowDefinitionId/versions
POST /api/workflows/:workflowDefinitionId/versions
GET  /api/workflow-versions/:workflowVersionId
POST /api/workflow-versions/:workflowVersionId/activate
POST /api/workflow-versions/:workflowVersionId/archive
```

---

## 64. Workflow Stage Definitions

```text
GET    /api/workflow-versions/:workflowVersionId/stages
POST   /api/workflow-versions/:workflowVersionId/stages
GET    /api/workflow-stages/:workflowStageDefinitionId
PATCH  /api/workflow-stages/:workflowStageDefinitionId
DELETE /api/workflow-stages/:workflowStageDefinitionId
```

---

## 65. Workflow Edges

```text
GET    /api/workflow-versions/:workflowVersionId/edges
POST   /api/workflow-versions/:workflowVersionId/edges
DELETE /api/workflow-edges/:workflowEdgeId
```

---

## 66. Workflow Validation and Simulation

```text
POST /api/workflow-versions/:workflowVersionId/validate
POST /api/workflow-versions/:workflowVersionId/simulate
```

验证：

- DAG；
- Stage Keys；
- Agent Selector；
- Provider Capability；
- Output Contract；
- Isolation Plan；
- Policy Compatibility。

---

# Part XI — Task APIs

## 67. Task Collection

```text
GET  /api/workspaces/:workspaceId/tasks
POST /api/workspaces/:workspaceId/tasks
```

### Create Task

```ts
interface CreateTaskRequest {
  title: string;
  description?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  assignedAgentId?: string;
  workflowDefinitionId?: string;
  acceptanceCriteria?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  metadata?: Record<string, unknown>;
}
```

返回 `201`。

---

## 68. Task Resource

```text
GET    /api/tasks/:taskId
PATCH  /api/tasks/:taskId
DELETE /api/tasks/:taskId
```

PATCH 允许更新 Draft / Ready Task 的描述和配置。

Running Task 的核心意图变更应创建新 Task 或 Child Task。

---

## 69. Task Lifecycle Commands

```text
POST /api/tasks/:taskId/ready
POST /api/tasks/:taskId/cancel
POST /api/tasks/:taskId/reopen
POST /api/tasks/:taskId/archive
POST /api/tasks/:taskId/restore
```

不得直接：

```json
{"status": "completed"}
```

完成通过 Run Acceptance。

---

## 70. Task Run Collection

```text
GET  /api/tasks/:taskId/runs
POST /api/tasks/:taskId/runs
```

### Create Run

```ts
interface CreateRunRequest {
  reason?: 'initial' | 'retry' | 'review-fix' | 'provider-comparison' | 'manual';

  workflowDefinitionId?: string;
  workflowVersionId?: string;

  defaultAgentId?: string;

  providerOverrides?: Record<string, string>;

  policyProfileId?: string;

  isolationStrategy?: string;

  baseBranch?: string;
  baseCommit?: string;

  priority?: string;

  startImmediately?: boolean;
}
```

返回：

- `201`，仅创建；
- `202`，创建并启动。

---

## 71. Task Acceptance

```text
POST /api/tasks/:taskId/accept
```

```ts
interface AcceptTaskRequest {
  runId: string;
  comment?: string;
  expectedTaskVersion?: number;
}
```

要求：

- Run Completed；
- 属于该 Task；
- 未被拒绝；
- Acceptance Criteria 可满足。

---

## 72. Task Rejection / Changes Requested

```text
POST /api/tasks/:taskId/request-changes
```

```ts
interface RequestTaskChangesInput {
  runId: string;
  findings: string;
  createChildRun?: boolean;
}
```

---

## 73. Task References

```text
GET /api/tasks/:taskId/conversations
GET /api/tasks/:taskId/artifacts
GET /api/tasks/:taskId/memories
GET /api/tasks/:taskId/events
```

---

# Part XII — Run APIs

## 74. Run Resource

```text
GET /api/runs/:runId
```

Query：

```text
include=stages,worktrees,providerSessions,processes,approvals,artifacts
```

---

## 75. Run Start

```text
POST /api/runs/:runId/start
```

这是 canonical Task-domain Run 路径。不得增加 `workspaceId` path
parameter、query parameter 或 body field。

### Headers

```text
Idempotency-Key: optional
```

Client 可以不提供 `Idempotency-Key`。提供时必须遵守 Idempotency Contract；
“必须支持 Idempotency-Key”不等于每次请求必须提供 Idempotency-Key。

### Request Body

唯一允许的 body 形状为：

```json
{
  "expectedVersion": 1
}
```

`expectedVersion` 是 optional；空 object `{}` 合法。body 必须是普通 JSON
object，未知字段返回：

```text
400 VALIDATION_FAILED
```

`workspaceId`、`createdBy`、`requestedBy`、`reason`、`operationId`、
`correlationId`、`runId` 以及任何其他未知字段均禁止。`expectedVersion`
出现时必须是正的 safe integer；`null`、0、负数、小数、字符串、`NaN`
和超出 safe integer 范围的值均返回 `400 VALIDATION_FAILED`。

### Acceptance Preconditions

The A1 HTTP Start Acceptance transaction checks only:

- the opaque `runId` resolves to its owning workspace;
- the Run exists;
- an optional `expectedVersion` matches;
- the Run status is `queued`;
- the complete `run.start` Operation history matrix permits creation;
- the request, Idempotency, and concurrency contracts are satisfied.

### Deferred Engine/Startup Validation

The following validations are not executed inside the A1 HTTP acceptance
transaction:

- Snapshot and Run binding validation;
- Workflow definition and RunStage binding validation;
- dependency graph validation;
- Stage eligibility;
- Provider, Process, and CLI startup validation;
- Policy and Isolation runtime enforcement.

For the current M3 persistent Task-domain Run, the initial status is
`queued`; `created` is not a current `V2RunStatus`, and Start Acceptance only
accepts `queued`.

HTTP 202 means only that the Start Operation was atomically accepted and
queued. It does not mean that Snapshot, Provider, Policy, Isolation, or actual
execution has passed. Engine claim/startup failures use the frozen C1a/C1b
contracts. Idempotency replay does not re-run Engine or startup validation.
The keyed 25-step and no-key 13-step A1 orders recorded in the M3 authority
documents remain unchanged.

### Success Response

```text
202 Accepted
```

Body 顶层精确为：

```json
{
  "operation": {
    "id": "op_...",
    "type": "run.start",
    "status": "queued",
    "workspaceId": "workspace_...",
    "aggregateType": "run",
    "aggregateId": "run_...",
    "runId": "run_...",
    "correlationId": "op_...",
    "createdAt": "2026-08-06T00:00:00.000Z",
    "version": 1
  }
}
```

`correlationId = operation.id` and `aggregateId = runId`. The queued Operation
has no `result`, `error`, `startedAt`, or `completedAt`. The response does not
return the internal Idempotency Envelope, Run snapshot, or Task, and does not
wait for an Engine claim. The example IDs and timestamp are shape examples,
not fixed runtime values. A live 202 response does not set
`Idempotency-Replayed`; its internal result is `replayed = false`.

### Replay Response

For the same Idempotency-Key and the same fingerprint:

```text
202 Accepted
Idempotency-Replayed: true
```

The body remains `{ "operation": { "...original acceptance snapshot..." } }`.
Replay returns the original acceptance-time queued Operation snapshot even if
the Operation later becomes `running`, `completed`, `failed`, or `cancelled`.
It does not call `OperationService.findById()` to rebuild the response, read
the current Operation or Run, re-run the Start history guard, create a new
Operation, mutate the original Operation, or expose internal envelope
top-level fields such as `schemaVersion` or `operation`. The replay header is
set only on replay.

The same Key with a different fingerprint returns:

```text
409 IDEMPOTENCY_KEY_REUSED
```

and creates neither an Operation nor an Idempotency Success Record.

### No-Key Response

Without an Idempotency-Key, success still returns HTTP 202 with the same
`{ "operation": ... }` shape, does not set `Idempotency-Replayed`, and writes
no Idempotency Record. Concurrent losers converge to the stable Start conflict
defined by the lifecycle contract.

Missing Run returns `404 RUN_NOT_FOUND`; invalid request shape or
`expectedVersion` returns `400 VALIDATION_FAILED`. Start-history conflicts use
`409 RUN_START_ALREADY_ACTIVE`, ambiguous or inconsistent history fails closed
with `500 RUN_START_AUTHORIZATION_AMBIGUOUS` or
`500 RUN_START_STATE_INCONSISTENT`, and a human-held SQLite lock timeout uses
`503 RUN_START_BUSY` with the safe message `Run start is temporarily
unavailable` and `retryable = true`.

---

## 76. Run Control

```text
POST /api/runs/:runId/pause
POST /api/runs/:runId/resume
POST /api/runs/:runId/cancel
```

### Cancel

```ts
interface CancelRunRequest {
  reason?: string;
  mode?: 'graceful' | 'force';
  expectedVersion?: number;
}
```

`force` 必须经过 Policy。

---

## 77. Run Retry

> **SUPERSEDED / HISTORICAL — NOT CURRENT CONTRACT.** The generic Retry DTO
> below is retained for compatibility history only. The current M3 P3C-1
> Retry contract is §77.1 and is the only current Retry request/response
> contract.

```text
POST /api/runs/:runId/retry
```

```ts
interface RetryRunRequest {
  mode:
    | 'full'
    | 'failed-stage'
    | 'from-stage'
    | 'provider-switch';

  stageId?: string;

  providerOverrides?: Record<string, string>;

  reuseTaskMemory?: boolean;

  reuseWorktree?: boolean;

  reason?: string;
}
```

默认创建 Child Run 和新 Worktree。

---

## 77.1 M3 P3C-1 Retry current contract (Option A)

This is the current implemented M3 Retry contract. The production acceptance
path was implemented and merged via PR #33 at
`de0b88fb0bed4a27cc38318481a0c7ccd47732a9`.

The contract remains authoritative for `POST /api/runs/:runId/retry`. Its
implementation does not authorize P3D, P3E, Migration 014, RunEngine changes,
or Production Cutover.

### Route, scope, and request

```text
POST /api/runs/:runId/retry
```

`runId` is the opaque Parent Run ID. No `workspaceId` is accepted in path,
query, or body. The route calls the read-only
`findWorkspaceIdByOpaqueId(runId)` locator before query/body/header validation;
locator miss is `404 RUN_NOT_FOUND`. All later reads and writes are scoped to
that workspace.

`Idempotency-Key` is required exactly once. It is case-insensitively found,
trimmed, validated, and never returned or logged. Missing, duplicate, empty,
comma-joined, or invalid values return `400 VALIDATION_FAILED`. There is no
no-key Retry path.

The only accepted request body is a non-empty plain JSON object with
`Content-Type: application/json`:

```json
{ "expectedVersion": 3 }
```

`expectedVersion` is required and must be a positive safe integer for the
Parent Run. Query parameters, malformed/empty JSON, `null`, arrays,
primitives, unknown fields, and all of the following fields are rejected with
`400 VALIDATION_FAILED`: `mode`, `stageId`, `providerOverrides`,
`reuseTaskMemory`, `reuseWorktree`, `reason`, `createdBy`, `requestedBy`,
`workspaceId`, `parentRunId`, `operationId`, and `correlationId`.

### Parent and Child contract

The Parent must be `failed` at the exact requested version. A stale version
returns `409 VERSION_CONFLICT`; every non-failed status returns
`409 RUN_NOT_RETRYABLE`. Neither the Parent nor its Task is modified.

The Child is server-created with this exact lineage: `workspaceId` and
`taskId` from the Parent; `parentRunId = Parent.id`; `rootRunId =
Parent.rootRunId`; `status = queued`; `reason = retry`; `origin = v2_api`;
`objective = Parent.objective`; `createdBy = Parent.createdBy`;
`nextEventSequence = 1`; and `version = 1`. IDs and timestamps are fresh.
The client cannot supply any of these values.

### Snapshot and Stage source

Retry clones the Parent's persisted Snapshot V2 and persisted RunStage graph.
It never resolves current Workspace, Workflow, Agent, Provider, Worktree, or
other defaults. A missing/V1/malformed Snapshot or a Snapshot/Stage mismatch
returns `500 RUN_RETRY_STATE_INCONSISTENT` with zero side effects.

The new Snapshot keeps the V2 workflow identity/hash, `worktreeMode`, stage
`dependsOn`, Agent/Provider snapshots, and redaction result. It remaps only the
run metadata to the Child and creates a fresh `capturedAt`, canonical JSON,
content hash, and row ID. New Child Stages have fresh IDs, Child Run/Snapshot
bindings, the same key/sequence, `attempt = 1`, `status = pending`, and
`version = 1`; runtime state, output, errors, timestamps, and Parent IDs are
not copied.

### Replay-miss decision order, Task active slot, and Retry history

After a replay miss, the domain decision order is frozen as:

1. Read the workspace-scoped Parent.
2. Apply the exact `expectedVersion` guard.
3. Require Parent status `failed`.
4. Check structural ambiguity.
5. Check structural inconsistency.
6. Check the exact valid completed Retry plus direct Child duplicate.
7. Check the Task active slot.
8. Validate the Parent Snapshot V2 and Stage graph.
9. Perform A2 creation writes.

The Task active statuses are `queued`, `starting`, `running`,
`waiting_approval`, and `paused`. If the active Run is exactly the direct Child
whose completed Retry Operation and result binding pass the full duplicate
validation below, return `409 RUN_RETRY_ALREADY_CREATED`. If the Task has any
other active Run, return `409 RUN_ACTIVE_EXISTS` with safe message `Task
already has an active run` and `retryable: false`. A second active Run must
never be created. A uniqueness race from `RunRepository.insert` maps to the
same `409 RUN_ACTIVE_EXISTS` and rolls back all preceding A2 writes.

The only eligible create state has zero direct Child rows, zero completed
Retry Operations, and zero non-terminal Retry Operations; any number of
`failed` or `cancelled` Retry history rows may remain. A valid completed
duplicate has exactly one completed `run.retry`, exactly one direct Child, and
all of these bindings: Operation and Child workspace equal Parent workspace;
Operation `aggregateId` and `runId` equal Parent ID; Child `parentRunId` equals
Parent ID; Child `taskId` and `rootRunId` equal the Parent values; Child
`reason = retry`; Child status is `queued` or a later legal lifecycle status;
Operation result is `{ resourceType: run, resourceId: Child.id }`; and the
Operation is `completed` at version 3. Same-key replay occurs before any
current-state reads. A different key returns `409 RUN_RETRY_ALREADY_CREATED`.

More than one non-terminal Retry, more than one completed Retry, or more than
one direct Child is structural ambiguity and returns
`500 RUN_RETRY_STATE_AMBIGUOUS`. A Retry without its Child, a Child without a
completed Retry, any Operation/result/Parent/Child binding mismatch, a
queued/running Retry with a Child, a completed Retry not at version 3, a
completed Retry without the exact result, or invalid direct Child
workspace/task/root/lineage is structural inconsistency and returns
`500 RUN_RETRY_STATE_INCONSISTENT`.

### A2 transaction order

The caller owns one `BEGIN IMMEDIATE` transaction. The exact order is:

1. Read path Parent `runId`.
2. Resolve the workspace with `findWorkspaceIdByOpaqueId`.
3. Return `404 RUN_NOT_FOUND` on locator miss.
4. Reject query parameters and validate Content-Type, body, and required
   `expectedVersion`.
5. Normalize and validate `Idempotency-Key`.
6. Build the `run.retry` fingerprint from the resolved workspace, path
   `{runId}`, empty domain input, and the required version.
7. Call `prepare()` outside the transaction.
8. Begin `BEGIN IMMEDIATE`.
9. Call `resolve()` as the first Parent/Child/Operation domain action.
10. On replay, return the stored original HTTP 201 dual snapshot immediately;
    do not read current entities.
11. Read the workspace-scoped Parent.
12. Apply the exact Parent version guard.
13. Require Parent status `failed`.
14. Apply structural ambiguity, structural inconsistency, the valid completed
    Retry/direct Child duplicate check, and the Task active-slot check in that
    exact order.
15. Read and validate the Parent Snapshot V2 and Stage graph.
16. Create the Parent-bound queued `run.retry` Operation at version 1.
17. Transition it to `running` at version 2.
18. Insert the queued Child Run.
19. Insert the cloned Child Snapshot.
20. Insert Child initial Stages in Snapshot sequence order.
21. Append Child `run.created`.
22. Append Child `stage.created` Events in that order.
23. Insert one Outbox row for every creation Event.
24. Transition Retry Operation to `completed` at version 3.
25. Write result `{ "resourceType": "run", "resourceId": Child.id }`.
26. Build the schemaVersion 1 internal replay envelope.
27. Call `storeSuccess()` with HTTP 201 and the acceptance-time envelope.
28. Commit.
29. Return the top-level response only after commit.

Nested transactions, transaction-external Parent guards, replay rereads,
automatic Start, Engine tick/dispatch, and Child dispatch are forbidden.

### Operation, Event, and correlation contract

The Retry Operation is Parent-bound with `aggregateType = run`,
`aggregateId = Parent.id`, `runId = Parent.id`, and
`correlationId = operation.id`. Its only lifecycle is
`queued/v1 → running/v2 → completed/v3`; the completed result points to the
Child. Creation Events use `correlationId = Child.id`; each
`stage.created.causationId` and `parentEventId` points to Child
`run.created`. Future execution Events use the independent `run.start`
Operation ID. The completed `run.retry` Operation does not authorize
execution, does not own `run.dequeued`, and creates no independent Operation
Event. `GET /api/operations/:operationId/events` for `run.retry` queries by the
Retry Operation's `runId + correlationId` and therefore normally returns an
empty collection in P3. It must never return Child creation Events or
independent Start execution Events as Retry Operation Events.

### HTTP 201 and replay body

The live response is HTTP 201:

```json
{
  "run": {
    "id": "run_child_...",
    "workspaceId": "workspace_...",
    "taskId": "task_...",
    "parentRunId": "run_parent_...",
    "rootRunId": "run_root_...",
    "status": "queued",
    "reason": "retry",
    "origin": "v2_api",
    "nextEventSequence": 1,
    "createdBy": "server-owned-parent-value",
    "createdAt": "...",
    "updatedAt": "...",
    "version": 1
  },
  "operation": {
    "id": "op_...",
    "type": "run.retry",
    "status": "completed",
    "workspaceId": "workspace_...",
    "aggregateType": "run",
    "aggregateId": "run_parent_...",
    "runId": "run_parent_...",
    "correlationId": "op_...",
    "result": { "resourceType": "run", "resourceId": "run_child_..." },
    "createdAt": "...",
    "startedAt": "...",
    "completedAt": "...",
    "version": 3
  }
}
```

The persisted envelope has internal `schemaVersion: 1`, which is never
exposed in the HTTP body. A same-key replay returns the original queued Child
and completed v3 Operation, sets `Idempotency-Replayed: true`, and never
depends on later Child/Operation state.

### Retry errors, rollback, and concurrency

- No direct Child, no completed Retry, and no non-terminal Retry, with any
  number of failed/cancelled history rows: eligible.
- Exactly one valid completed Retry plus exactly one valid direct Child:
  different key returns `409 RUN_RETRY_ALREADY_CREATED`; same key replays
  before current reads.
- More than one non-terminal Retry, more than one completed Retry, or more
  than one direct Child: `500 RUN_RETRY_STATE_AMBIGUOUS`.
- Retry/Child existence or binding mismatches: `500
  RUN_RETRY_STATE_INCONSISTENT`.
- A different active Run on the Task: `409 RUN_ACTIVE_EXISTS` with safe
  message `Task already has an active run`.
- Key reuse with a different fingerprint: `409 IDEMPOTENCY_KEY_REUSED`.
- Human-held SQLite timeout: `503 RUN_RETRY_BUSY`, message `Run retry is
  temporarily unavailable`, `retryable: true`.
- Unknown failures: sanitized `500 INTERNAL_ERROR`.

Validation is `400 VALIDATION_FAILED`; missing Parent is `404 RUN_NOT_FOUND`;
stale version is `409 VERSION_CONFLICT`; non-failed Parent is
`409 RUN_NOT_RETRYABLE`; invalid Idempotency state is
`500 IDEMPOTENCY_RECORD_INVALID`. No error leaks SQLite text, SQL, paths,
keys, stack traces, or internal entity data.

Injection at Operation insert/transition, Child, Snapshot, any Stage,
creation Event, any Outbox, completion/result, or `storeSuccess` must roll
back the complete A2 transaction: no Child, Snapshot, Stage, Event, Outbox,
Retry Operation, or Idempotency Success; Parent and Task are unchanged.
Same-key concurrency has one live 201 and one replay 201; different keys have
one live 201 and one stable duplicate 409; stale versions have zero side
effects; Parent-failure races have one optimistic winner; normal races never
use 503.

This contract is implemented and merged via PR #33. Its implementation does
not authorize P3D, P3E, Migration 014, RunEngine changes, or Production
Cutover.

---

## 78. Run Stage Collection

```text
GET /api/runs/:runId/stages
```

---

## 79. Run Inspector

```text
GET /api/runs/:runId/inspector
GET /api/runs/:runId/snapshot
GET /api/runs/:runId/checkpoints
GET /api/runs/:runId/audit
```

Inspector 是聚合 Query Model。

---

## 80. Run Result

```text
GET /api/runs/:runId/result
```

返回：

- Status；
- Summary；
- Output Contract；
- Result Artifacts；
- Worktree Diff；
- Test Results；
- Warnings；
- Failure。

---

## 81. Run Relationships

```text
GET /api/runs/:runId/parent
GET /api/runs/:runId/children
GET /api/runs/:runId/attempt-tree
```

---

## 82. Run Unsafe Mode

```text
POST /api/runs/:runId/unsafe-mode/enable
POST /api/runs/:runId/unsafe-mode/disable
```

必须由 User 显式调用。

---

# Part XIII — Stage APIs

## 83. Stage Resource

```text
GET /api/stages/:stageId
```

---

## 84. Stage Control

```text
POST /api/stages/:stageId/pause
POST /api/stages/:stageId/resume
POST /api/stages/:stageId/cancel
POST /api/stages/:stageId/retry
POST /api/stages/:stageId/skip
```

Skip 必须：

- Workflow 允许；
- 下游 Contract 可满足；
- Policy 允许。

---

## 85. Stage Inputs and Outputs

```text
GET /api/stages/:stageId/input
GET /api/stages/:stageId/output
GET /api/stages/:stageId/artifacts
GET /api/stages/:stageId/events
GET /api/stages/:stageId/provider-session
GET /api/stages/:stageId/processes
GET /api/stages/:stageId/worktree
GET /api/stages/:stageId/memory-context
```

---

# Part XIV — Runtime Event and Replay APIs

## 86. Run Events

```text
GET /api/runs/:runId/events
```

Query：

```text
afterSequence
beforeSequence
limit
types
stageId
severity
visibility
source
correlationId
```

Response：

```ts
interface RuntimeEventPage {
  events: RuntimeEvent[];
  nextAfterSequence?: number;
  hasMore: boolean;
}
```

此 Endpoint 可以保持 Event Model 原始 Response，不强制套普通 List Envelope，但 OpenAPI 必须明确。

---

## 87. Event Resource

```text
GET /api/events/:eventId
```

Restricted Event 需要权限。

---

## 88. Replay

```text
GET /api/runs/:runId/replay
```

Query：

```text
fromSequence
toSequence
types
stageId
includeArtifacts
```

返回：

- Run Snapshot；
- Stage Snapshot；
- Ordered Events；
- Artifact Index；
- Compatibility Warning。

---

## 89. Run Stream

```text
GET /api/runs/:runId/stream
```

Query：

```text
afterSequence
```

Header：

```text
Last-Event-ID
```

详见 Realtime Part。

---

# Part XV — Process APIs

## 90. Process Collection

```text
GET /api/runs/:runId/processes
GET /api/processes
```

Top-level Filters：

```text
workspaceId
runId
stageId
providerSessionId
processType
status
nativePid
```

---

## 91. Process Resource

```text
GET /api/processes/:processId
GET /api/processes/:processId/tree
GET /api/processes/:processId/events
GET /api/processes/:processId/output
GET /api/processes/:processId/usage
```

---

## 92. Process Control

```text
POST /api/processes/:processId/stop
POST /api/processes/:processId/pause
POST /api/processes/:processId/resume
POST /api/processes/:processId/cleanup
```

Process Control 是高级 Inspector API。

普通 UI 应优先使用 Run / Stage Control。

---

## 93. Process Output

```text
GET /api/processes/:processId/output?stream=stdout
GET /api/processes/:processId/output?stream=stderr
```

支持：

```text
Range
tailBytes
afterOffset
```

Restricted Output 需要权限。

---

# Part XVI — Worktree APIs

## 94. Worktree Collection

```text
GET /api/workspaces/:workspaceId/worktrees
GET /api/runs/:runId/worktrees
POST /api/worktrees
```

直接 Create 主要供 Runtime 和 Inspector。

普通 Run 由 Isolation Planner 自动创建。

---

## 95. Worktree Resource

```text
GET /api/worktrees/:worktreeId
GET /api/worktrees/:worktreeId/status
GET /api/worktrees/:worktreeId/diff
GET /api/worktrees/:worktreeId/events
GET /api/worktrees/:worktreeId/artifacts
GET /api/worktrees/:worktreeId/processes
GET /api/worktrees/:worktreeId/reviews
GET /api/worktrees/:worktreeId/merges
```

---

## 96. Worktree Commands

```text
POST /api/worktrees/:worktreeId/inspect
POST /api/worktrees/:worktreeId/commit
POST /api/worktrees/:worktreeId/review
POST /api/worktrees/:worktreeId/rebase
POST /api/worktrees/:worktreeId/merge
POST /api/worktrees/:worktreeId/abandon
POST /api/worktrees/:worktreeId/cleanup
POST /api/worktrees/:worktreeId/adopt
```

---

## 97. Worktree Commit

```ts
interface CommitWorktreeRequest {
  message: string;
  includeUntracked: boolean;
  pathspec?: string[];
  expectedHeadCommit?: string;
}
```

---

## 98. Worktree Merge

```ts
interface MergeWorktreeRequest {
  targetBranch: string;

  strategy:
    | 'merge-commit'
    | 'squash'
    | 'rebase-merge'
    | 'fast-forward'
    | 'cherry-pick'
    | 'manual';

  expectedHeadCommit: string;

  expectedTargetCommit?: string;

  approvalRequestId?: string;
}
```

返回 `202` Operation。

---

## 99. Conflict Resolution

```text
GET  /api/worktrees/:worktreeId/conflicts
POST /api/worktrees/:worktreeId/conflicts/resolve
POST /api/worktrees/:worktreeId/conflicts/abort
```

```ts
interface ResolveWorktreeConflictRequest {
  mode:
    | 'manual-completed'
    | 'agent-assisted'
    | 'new-run';

  resolutionArtifactId?: string;

  createChildRun?: boolean;
}
```

---

## 100. Worktree Cleanup

```ts
interface CleanupWorktreeRequest {
  force?: boolean;
  deleteBranch?: boolean;
  archiveDiff?: boolean;
  expectedStatus?: string;
}
```

Force 必须经过 Approval。



# Part XVII — Memory APIs

## 101. Memory Collection

```text
GET  /api/workspaces/:workspaceId/memories
POST /api/memories
```

Filters：

```text
scope
category
status
agentId
conversationId
taskId
runId
pinned
authority
sensitivity
q
```

---

## 102. Memory Resource

```text
GET    /api/memories/:memoryId
PATCH  /api/memories/:memoryId
DELETE /api/memories/:memoryId
```

DELETE 默认 Soft Delete。

Hard Delete：

```text
DELETE /api/memories/:memoryId?mode=hard
```

必须经过权限、隐私和引用检查。

---

## 103. Memory Lifecycle Commands

```text
POST /api/memories/:memoryId/pin
POST /api/memories/:memoryId/unpin
POST /api/memories/:memoryId/archive
POST /api/memories/:memoryId/restore
POST /api/memories/:memoryId/revalidate
POST /api/memories/:memoryId/promote-scope
POST /api/memories/:memoryId/demote-scope
```

### 103.1 Scope Promotion

```ts
interface PromoteMemoryScopeRequest {
  targetScope: string;
  targetOwnerId?: string;
  reason: string;
  expectedVersion?: number;
}
```

Global Promotion 默认需要 Approval。

---

## 104. Memory History and Sources

```text
GET /api/memories/:memoryId/history
GET /api/memories/:memoryId/sources
GET /api/memories/:memoryId/usage
GET /api/memories/:memoryId/conflicts
```

---

## 105. Memory Candidates

```text
GET  /api/memory-candidates
POST /api/memory-candidates/extract
GET  /api/memory-candidates/:candidateId
POST /api/memory-candidates/:candidateId/accept
POST /api/memory-candidates/:candidateId/reject
POST /api/memory-candidates/:candidateId/merge
```

### Accept

```ts
interface AcceptMemoryCandidateRequest {
  targetScope?: string;
  targetCategory?: string;
  editedTitle?: string;
  editedContent?: string;
  expectedCandidateStatus?: 'pending';
}
```

---

## 106. Memory Retrieval

```text
POST /api/memory/retrieve
```

```ts
interface RetrieveMemoryApiRequest {
  workspaceId: string;
  taskId?: string;
  runId?: string;
  stageId?: string;
  conversationId?: string;
  agentId?: string;
  providerConfigId?: string;

  queryText: string;

  scopes: string[];
  categories?: string[];
  tags?: string[];

  includePinned?: boolean;
  includeConflicted?: boolean;
  includeExpired?: boolean;

  strategy?: 'fts' | 'hybrid' | 'structured-only' | 'explicit';

  budget: {
    maxEntries: number;
    maxCharacters: number;
    maxTokens?: number;
  };

  minimumScore?: number;
  limit?: number;
}
```

通常由 Runtime 内部调用。

外部调用必须受 Workspace 权限。

---

## 107. Memory Context

```text
GET /api/runs/:runId/memory-context
GET /api/stages/:stageId/memory-context
GET /api/memory-contexts/:memoryContextId
```

可查询：

- Entries；
- Score；
- Rank；
- Reasons；
- Budget；
- Excluded；
- Prompt Artifact。

---

## 108. Memory Conflicts

```text
GET  /api/memory-conflicts
GET  /api/memory-conflicts/:conflictId
POST /api/memory-conflicts/:conflictId/resolve
```

```ts
interface ResolveMemoryConflictRequest {
  action:
    | 'keep-both'
    | 'supersede'
    | 'merge'
    | 'scope-separate'
    | 'delete';

  winningMemoryId?: string;

  notes?: string;
}
```

---

## 109. Memory Import and Export

```text
POST /api/memory/import
POST /api/memory/export
```

Import 默认生成 Candidate。

Trusted v1 Migration 例外。

---

# Part XVIII — Policy and Approval APIs

## 110. Policy Profiles

```text
GET  /api/policies
POST /api/policies
```

Filters：

```text
workspaceId
mode
enabled
```

---

## 111. Policy Resource

```text
GET    /api/policies/:policyProfileId
PATCH  /api/policies/:policyProfileId
DELETE /api/policies/:policyProfileId
```

DELETE 默认 Archive。

---

## 112. Policy Commands

```text
POST /api/policies/:policyProfileId/validate
POST /api/policies/:policyProfileId/clone
POST /api/policies/:policyProfileId/simulate
GET  /api/policies/:policyProfileId/effective
GET  /api/policies/:policyProfileId/history
```

---

## 113. Policy Rules

```text
GET    /api/policies/:policyProfileId/rules
POST   /api/policies/:policyProfileId/rules
GET    /api/policy-rules/:policyRuleId
PATCH  /api/policy-rules/:policyRuleId
DELETE /api/policy-rules/:policyRuleId
POST   /api/policy-rules/:policyRuleId/enable
POST   /api/policy-rules/:policyRuleId/disable
```

---

## 114. Policy Simulation

```text
POST /api/policy/simulate
```

Simulation 不执行 Action。

Response 包含：

- Decision；
- Risk；
- Matched Rules；
- Precedence Trace；
- Constraints；
- Explanation。

---

## 115. Policy Decisions

```text
GET /api/policy-decisions
GET /api/policy-decisions/:policyDecisionId
```

Filters：

```text
workspaceId
runId
stageId
decision
riskLevel
actionType
createdAfter
```

---

## 116. Approval Queue

```text
GET /api/approvals
GET /api/approvals/:approvalRequestId
```

Filters：

```text
workspaceId
runId
stageId
status
riskLevel
category
providerConfigId
createdAfter
```

---

## 117. Approval Decision

```text
POST /api/approvals/:approvalRequestId/approve
POST /api/approvals/:approvalRequestId/reject
POST /api/approvals/:approvalRequestId/cancel-run
POST /api/approvals/:approvalRequestId/expire
```

### Approve

```ts
interface ApproveRequest {
  scope:
    | 'once'
    | 'action'
    | 'stage'
    | 'run'
    | 'workspace'
    | 'time-limited';

  expiresAt?: string;

  modifiedRequest?: Record<string, unknown>;

  comment?: string;

  expectedVersion?: number;
}
```

必须使用 Idempotency Key。

---

## 118. Policy Grants

```text
GET  /api/policy-grants
GET  /api/policy-grants/:policyGrantId
POST /api/policy-grants/:policyGrantId/revoke
```

普通 API 不提供任意 Grant Create。

Grant 通常由 Approval 创建。

---

## 119. Policy Exceptions

```text
GET    /api/policy-exceptions
POST   /api/policy-exceptions
GET    /api/policy-exceptions/:exceptionId
PATCH  /api/policy-exceptions/:exceptionId
DELETE /api/policy-exceptions/:exceptionId
POST   /api/policy-exceptions/:exceptionId/enable
POST   /api/policy-exceptions/:exceptionId/disable
```

Exception 属于高级安全设置。

---

## 120. Workspace Unsafe Mode

```text
POST /api/workspaces/:workspaceId/unsafe-mode/enable
POST /api/workspaces/:workspaceId/unsafe-mode/disable
GET  /api/workspaces/:workspaceId/unsafe-mode
```

```ts
interface EnableUnsafeModeRequest {
  reason: string;
  expiresAt?: string;
}
```

---

# Part XIX — Conversation APIs

## 121. Conversation Collection

```text
GET  /api/conversations
POST /api/conversations
```

Filters：

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
q
```

---

## 122. Conversation Resource

```text
GET    /api/conversations/:conversationId
PATCH  /api/conversations/:conversationId
DELETE /api/conversations/:conversationId
```

---

## 123. Conversation Lifecycle

```text
POST /api/conversations/:conversationId/archive
POST /api/conversations/:conversationId/restore
POST /api/conversations/:conversationId/mute
POST /api/conversations/:conversationId/unmute
```

Archived Conversation 不自动创建 Agent Turn。

---

## 124. Conversation Members

```text
GET    /api/conversations/:conversationId/members
POST   /api/conversations/:conversationId/members
PATCH  /api/conversations/:conversationId/members/:memberId
DELETE /api/conversations/:conversationId/members/:memberId
```

Member Patch 支持：

- role；
- replyMode；
- priority；
- status。

---

## 125. Conversation Reply Policy

```text
GET   /api/conversations/:conversationId/reply-policy
PATCH /api/conversations/:conversationId/reply-policy
```

高风险变化：

- enable agent-to-agent；
- increase hop limit；
- parallel all agents；

需要 Policy。

---

## 126. Message Collection

```text
GET  /api/conversations/:conversationId/messages
POST /api/conversations/:conversationId/messages
```

### Send Message

```ts
interface SendConversationMessageRequest {
  blocks: Array<{
    type: string;
    contentJson: Record<string, unknown>;
    contentText?: string;
  }>;

  replyToMessageId?: string;

  attachments?: Array<{
    artifactId?: string;
    fileReferenceId?: string;
    type: string;
    name: string;
  }>;

  mentions?: Array<{
    targetType: 'user' | 'agent' | 'all' | 'role';
    targetId?: string;
  }>;

  clientMessageId: string;
}
```

Header：

```text
Idempotency-Key
```

返回 `201`，Routing 异步执行。

---

## 127. Message Resource

```text
GET    /api/messages/:messageId
PATCH  /api/messages/:messageId
DELETE /api/messages/:messageId
```

PATCH 创建 Revision。

---

## 128. Message History

```text
GET /api/messages/:messageId/revisions
GET /api/messages/:messageId/references
GET /api/messages/:messageId/attachments
GET /api/messages/:messageId/mentions
GET /api/messages/:messageId/routing
```

---

## 129. Message Task and Run Bridge

```text
POST /api/messages/:messageId/create-task
POST /api/messages/:messageId/start-run
POST /api/messages/:messageId/link-task
POST /api/messages/:messageId/link-run
```

### Start Run from Message

```ts
interface StartRunFromMessageRequest {
  taskId?: string;
  createTaskIfMissing: boolean;
  workflowDefinitionId?: string;
  agentIds?: string[];
  providerOverrides?: Record<string, string>;
  policyProfileId?: string;
  worktreeMode?: string;
}
```

---

## 130. Agent Turns

```text
GET  /api/conversations/:conversationId/turns
POST /api/conversations/:conversationId/turns
GET  /api/turns/:turnId
POST /api/turns/:turnId/cancel
POST /api/turns/:turnId/retry
```

### Manual Agent Reply

```text
POST /api/conversations/:conversationId/agents/:agentId/reply
```

---

## 131. Group Orchestration

```text
GET  /api/conversations/:conversationId/orchestrator-turns
POST /api/conversations/:conversationId/orchestrator-turns
GET  /api/orchestrator-turns/:orchestratorTurnId
POST /api/orchestrator-turns/:orchestratorTurnId/cancel
```

```ts
interface CreateOrchestratorTurnRequest {
  sourceMessageId: string;

  mode?:
    | 'sequential'
    | 'parallel'
    | 'delegate'
    | 'single';

  selectedAgentIds?: string[];

  maxAgents?: number;
  maxReplies?: number;

  createWorkflowRun?: boolean;
}
```

---

## 132. Conversation Commands

```text
GET  /api/messages/:messageId/command
POST /api/messages/:messageId/command/retry
```

Commands normally enter through Message.

---

## 133. Read State

```text
GET  /api/conversations/read-state
GET  /api/conversations/:conversationId/read-state
POST /api/conversations/:conversationId/read
POST /api/conversations/:conversationId/unread
```

### Mark Read

```ts
interface MarkReadRequest {
  throughSequence: number;
}
```

Server 使用最大 Sequence，避免旧客户端回退 Read State。

---

## 134. Search

```text
GET /api/conversations/search
GET /api/conversations/:conversationId/search
```

Query：

```text
q
senderId
agentId
messageType
taskId
runId
hasAttachment
createdAfter
createdBefore
```

---

## 135. Conversation Summary

```text
GET  /api/conversations/:conversationId/summaries
POST /api/conversations/:conversationId/summaries
GET  /api/conversation-summaries/:summaryId
POST /api/conversation-summaries/:summaryId/accept
POST /api/conversation-summaries/:summaryId/supersede
```

---

## 136. Conversation Export

```text
POST /api/conversations/:conversationId/export
```

格式：

```text
markdown
json
jsonl
html
debug-bundle
```

返回 Operation 和 Artifact。

---

## 137. Conversation Stream

```text
GET /api/conversations/:conversationId/stream
```

Query：

```text
afterMessageSequence
afterRuntimeEventSequence
```

详见 Realtime Part。

---

# Part XX — Artifact APIs

## 138. Artifact Collection

```text
GET /api/artifacts
```

Filters：

```text
workspaceId
taskId
runId
stageId
processId
worktreeId
conversationId
messageId
type
status
sensitivity
createdAfter
```

---

## 139. Artifact Resource

```text
GET    /api/artifacts/:artifactId
DELETE /api/artifacts/:artifactId
```

DELETE 默认 Soft Delete / Retention Request。

Immutable Artifact 不允许内容覆盖。

---

## 140. Artifact Content

```text
GET /api/artifacts/:artifactId/content
GET /api/artifacts/:artifactId/download
```

### 140.1 Content

适合可预览文本。

支持：

```text
Range
offset
limit
```

### 140.2 Download

返回：

```text
Content-Disposition: attachment
```

不得暴露 `storageUri` 本地路径。

---

## 141. Artifact References

```text
GET  /api/artifacts/:artifactId/references
POST /api/artifacts/:artifactId/references
DELETE /api/artifact-references/:referenceId
```

---

## 142. Artifact Finalization

内部或受信 Runtime：

```text
POST /api/artifacts
POST /api/artifacts/:artifactId/finalize
POST /api/artifacts/:artifactId/fail
```

普通用户上传应使用独立 Upload Endpoint。

---

## 143. Artifact Upload

```text
POST /api/workspaces/:workspaceId/artifacts/uploads
```

支持：

- Multipart；
- Chunked Upload，未来；
- Size Limit；
- Sensitivity；
- Checksum。

上传完成返回 Artifact。

---

## 144. Artifact Export / Publish

```text
POST /api/artifacts/:artifactId/export
POST /api/artifacts/:artifactId/publish
```

Publish 属于外部副作用，默认需要 Policy。

---

## 145. Artifact Versions

```text
GET /api/artifacts/:artifactId/versions
GET /api/artifact-versions/:artifactVersionId
```

---

# Part XXI — Extension APIs

## 146. Extension Registry

```text
GET /api/extensions
GET /api/extensions/:extensionId
```

Filters：

```text
status
trustLevel
installed
workspaceId
```

---

## 147. Extension Installation

```text
POST /api/extensions/install
POST /api/extensions/:extensionId/enable
POST /api/extensions/:extensionId/disable
POST /api/extensions/:extensionId/uninstall
```

Install 返回 Operation。

---

## 148. Extension Versions

```text
GET  /api/extensions/:extensionId/versions
GET  /api/extension-versions/:extensionVersionId
POST /api/extensions/:extensionId/upgrade
```

权限新增时必须重新 Approval。

---

## 149. Extension Permissions

```text
GET  /api/extensions/:extensionId/permissions
POST /api/extensions/:extensionId/permissions/review
GET  /api/extensions/:extensionId/policy-decisions
```

---

# Part XXII — Audit and Administration APIs

## 150. Audit Query

```text
GET /api/audit
GET /api/audit/:auditRecordId
```

Filters：

```text
workspaceId
runId
actorType
actorId
actionType
resourceType
result
createdAfter
createdBefore
```

Restricted。

---

## 151. Dead Letters

```text
GET  /api/admin/dead-letters
GET  /api/admin/dead-letters/:deadLetterId
POST /api/admin/dead-letters/:deadLetterId/replay
POST /api/admin/dead-letters/:deadLetterId/resolve
```

Admin / Local Owner Only。

---

## 152. Outbox

```text
GET  /api/admin/outbox
POST /api/admin/outbox/:outboxMessageId/retry
```

默认只在 Runtime Inspector Advanced Mode 展示。

---

## 153. Locks

```text
GET  /api/admin/locks
GET  /api/admin/locks/:lockKey
POST /api/admin/locks/:lockKey/release
```

强制 Release 需要 Policy。

---

## 154. Database Integrity

```text
GET  /api/admin/storage
POST /api/admin/storage/integrity-check
POST /api/admin/storage/backup
POST /api/admin/storage/vacuum
```

长命令返回 Operation。

---

# Part XXIII — Realtime API

## 155. Realtime Principles

1. Durable State 必须可通过 REST 查询。
2. Realtime 只用于降低延迟。
3. 客户端断线不能影响 Run。
4. Reconnect 必须补齐 Durable Data。
5. Delta 可压缩，但 Terminal Fact 不丢失。
6. SSE 和 WebSocket 使用相同 Canonical Event Payload。

---

## 156. Run SSE

```text
GET /api/runs/:runId/stream
```

### 156.1 Request

```text
Accept: text/event-stream
Last-Event-ID: evt_123
```

或：

```text
?afterSequence=100
```

### 156.2 Event

```text
id: evt_123
event: runtime-event
data: {"id":"evt_123","sequence":101,"type":"tool.started",...}
```

### 156.3 Keepalive

```text
event: keepalive
data: {"time":"2026-07-19T12:00:00.000Z"}
```

Keepalive 不持久化。

---

## 157. Conversation SSE

```text
GET /api/conversations/:conversationId/stream
```

事件：

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
runtime-projection
keepalive
```

---

## 158. SSE Reconnect

Server 顺序：

1. Validate Access；
2. Resolve cursor；
3. Return missing durable records；
4. Subscribe realtime；
5. Keepalive。

如果 Cursor 已被 Retention 删除：

```text
410 CURSOR_EXPIRED
```

客户端执行完整同步。

---

## 159. WebSocket Endpoint

```text
GET /api/realtime
Upgrade: websocket
```

---

## 160. WebSocket Envelope

```ts
interface RealtimeEnvelope<T = unknown> {
  id: string;

  type: string;

  channel: string;

  sequence?: number;

  correlationId?: string;

  timestamp: string;

  payload: T;
}
```

---

## 161. WebSocket Client Commands

```json
{
  "id": "client_cmd_1",
  "type": "subscribe",
  "payload": {
    "channels": [
      "run:run_123",
      "conversation:conv_123",
      "approvals:workspace:ws_123"
    ]
  }
}
```

支持：

```text
subscribe
unsubscribe
ack
ping
message.send
turn.cancel
approval.resolve
read-state.update
```

写操作仍需正常认证、幂等和 Policy。

---

## 162. WebSocket Ack

```json
{
  "id": "server_ack_1",
  "type": "ack",
  "correlationId": "client_cmd_1",
  "payload": {
    "accepted": true
  }
}
```

Ack 不表示长 Operation 已完成。

---

## 163. Channel Names

```text
run:<runId>
conversation:<conversationId>
workspace:<workspaceId>
approvals:workspace:<workspaceId>
operations:<operationId>
system
```

---

## 164. Backpressure

客户端必须发送 Ack 或维持有限缓冲。

Server 可以：

- 聚合 Delta；
- 丢弃 Ephemeral Presence；
- 保留 Durable Sequence；
- 要求 REST Resync；
- 关闭过慢连接。

---

## 165. Realtime Security

客户端只能订阅有权访问的 Channel。

Channel Name 不是授权凭证。

---

# Part XXIV — Internal Runtime APIs

## 166. Internal API Principles

Internal API：

- 仅 Loopback / Private Socket；
- 强服务身份；
- 不接受用户伪造 Principal；
- 默认不公开；
- 可使用直接进程内 Port 替代 HTTP。

---

## 167. Policy Evaluation

```text
POST /internal/policy/evaluate
```

```ts
interface InternalPolicyEvaluationRequest {
  policyRequestId: string;
  context: PolicyContext;
}
```

---

## 168. Runtime Event Append

```text
POST /internal/runtime-events
```

只允许 Runtime Component。

Server 负责：

- Validation；
- Redaction；
- Sequence；
- Persist；
- Outbox。

---

## 169. Process Launch

```text
POST /internal/processes
```

普通 Public API 不允许任意 Process Spawn。

---

## 170. Provider Start

```text
POST /internal/provider-sessions
```

只有 Run Engine / Conversation Turn Manager 可调用。

---

## 171. Artifact Append

```text
POST /internal/artifacts/:artifactId/chunks
POST /internal/artifacts/:artifactId/finalize
```

支持受控 Streaming Artifact。

---

## 172. Conversation Projection

```text
POST /internal/conversation-projections
```

通常由 Event Subscriber 直接调用 Service，不必暴露 HTTP。

---

# Part XXV — Validation Rules

## 173. Request Validation

每个请求依次验证：

```text
Content Type
  ↓
JSON Parse
  ↓
Schema
  ↓
Authentication
  ↓
Resource Access
  ↓
Cross-resource Consistency
  ↓
Lifecycle Preconditions
  ↓
Policy
  ↓
Execution
```

---

## 174. Unknown Fields

Public API 默认：

```text
reject unknown fields
```

或在 OpenAPI 中明确 `additionalProperties`。

Provider-specific Metadata 可允许扩展字段。

---

## 175. Enum Validation

未知 Enum 返回：

```text
422 INPUT_ENUM_INVALID
```

客户端必须容忍响应中未来增加的新 Enum 值，并显示 Unknown 状态。

---

## 176. Payload Limits

建议：

```text
JSON Request: 1 MB
Message Text: configurable
Policy Rule: 256 KB
Memory Entry: 64 KB
Runtime Event Payload: 64 KB
Artifact Upload: separate limit
```

大内容进入 Artifact。

---

## 177. Path Validation

API 不直接信任用户传入路径。

必须进行：

- Canonicalization；
- Workspace Boundary；
- Worktree Boundary；
- Symlink / Junction；
- Policy。

---

## 178. URL Validation

Network / Link / Artifact URL：

- Protocol whitelist；
- Host normalization；
- Redirect re-evaluation；
- No Credential in URL；
- Private network check。

---

# Part XXVI — API Security

## 179. Sensitive Response Redaction

默认不返回：

- Secret Value；
- Full Environment；
- OAuth Token；
- Cookie；
- Private Key；
- Hidden Reasoning；
- Raw Restricted Artifact；
- Unredacted Command Args。

---

## 180. Resource-level Sensitivity

资源可以标记：

```text
normal
restricted
secret
```

Restricted 读取需要额外权限。

Secret Value 不通过普通 API 返回。

---

## 181. SSRF Protection

所有 Server-side URL Fetch 必须：

- Resolve DNS；
- Block private/meta addresses；
- Re-check Redirect；
- Limit protocol；
- Limit size；
- Apply Network Policy。

---

## 182. Injection Protection

API 层必须防止：

- SQL Injection；
- Shell Injection；
- Path Traversal；
- HTML Injection；
- Header Injection；
- Log Injection；
- Prompt Injection escalation。

---

## 183. Audit of Mutations

所有重要修改请求记录：

- Request ID；
- User；
- Client；
- IP / Local；
- Resource；
- Action；
- Result；
- Policy Decision；
- Idempotency Key，Hash only；
- Time。

---

# Part XXVII — Cache Contract

## 184. GET Caching

大多数 Runtime GET：

```text
Cache-Control: no-store
```

静态 Metadata：

```text
ETag
Cache-Control: private, max-age=...
```

---

## 185. Conditional GET

支持：

```text
If-None-Match
```

未变化：

```text
304 Not Modified
```

---

## 186. No Client Cache for Secrets

Approval、Policy Decision、Restricted Artifact：

```text
Cache-Control: no-store
```

---

# Part XXVIII — API Warnings

## 187. Warning Model

```ts
interface ApiWarning {
  code: string;
  message: string;
  resourceId?: string;
  suggestedAction?: string;
}
```

适合：

- Provider Version Unknown；
- Raw Stream Fallback；
- Worktree Cleanup Required；
- Memory Conflict；
- Deprecated Endpoint；
- Partial Recovery。

Warning 不替代 Error。



# Part XXIX — Rate, Concurrency and Capacity Limits

## 188. Rate Limits

Local single-user mode可以不启用传统公网 Rate Limit，但仍需要容量限制。

### 188.1 Recommended Limits

- Concurrent Run per Workspace；
- Concurrent Provider Session；
- Concurrent Process；
- Concurrent Merge per Branch；
- Concurrent Agent Turn per Conversation；
- Pending Approval Count；
- Artifact Upload Size；
- SSE / WebSocket Connection Count。

### 188.2 Response

```text
429 Too Many Requests
Retry-After: 5
```

Error：

```text
RUNTIME_CONCURRENCY_LIMIT
```

---

## 189. Concurrency Slots

长任务被 Scheduler 接受但未获得 Slot 时：

```text
Run.status = queued
Operation.status = queued
```

这不是错误。

---

## 190. Per-resource Locks

锁冲突：

```text
423 Locked
```

示例：

- Target Branch 正在 Merge；
- Worktree 正在 Cleanup；
- Approval 正在决策；
- Policy 正在迁移；
- Database 正在恢复。

响应应提供受限的 Lock Owner Summary 和 Retry 建议。

---

# Part XXX — Deprecation and Compatibility

## 191. Deprecation Headers

废弃 Endpoint 返回：

```text
Deprecation: true
Sunset: <date>
Link: </api/new-endpoint>; rel="successor-version"
```

### 191.1 Warning

Response Meta：

```json
{
  "warnings": [
    {
      "code": "API_DEPRECATED",
      "message": "Use /api/runs/:runId/events."
    }
  ]
}
```

---

## 192. Backward-compatible Changes

允许：

- 新 Optional Field；
- 新 Endpoint；
- 新 Enum，客户端需容忍；
- 新 Warning；
- 新 Include；
- 新 Event Type。

---

## 193. Breaking Changes

包括：

- 删除字段；
- 修改字段语义；
- 修改状态迁移；
- 修改默认安全行为；
- 修改 Error Code；
- 改变 Idempotency；
- 改变 Sequence 语义。

必须进入新 Major API Version 或兼容层。

---

## 194. Field Stability

标记：

```ts
interface ApiFieldMetadata {
  stability:
    | 'stable'
    | 'experimental'
    | 'deprecated';
}
```

Experimental Field 不应被核心 UI 当作唯一事实。

---

# Part XXXI — Canonical Request and Response Examples

## 195. Create a Direct Conversation

Request：

```http
POST /api/conversations
Content-Type: application/json
Idempotency-Key: conv-create-001
```

```json
{
  "workspaceId": "ws_agentos",
  "type": "direct",
  "title": "Backend Engineer",
  "memberIds": [
    {
      "memberType": "user",
      "memberId": "user_local",
      "role": "owner"
    },
    {
      "memberType": "agent",
      "memberId": "agent_backend",
      "role": "participant",
      "replyMode": "always"
    }
  ]
}
```

Response：

```http
201 Created
Location: /api/conversations/conv_123
ETag: "v1"
```

```json
{
  "data": {
    "id": "conv_123",
    "workspaceId": "ws_agentos",
    "type": "direct",
    "title": "Backend Engineer",
    "status": "active",
    "version": 1
  }
}
```

---

## 196. Send a Message

```http
POST /api/conversations/conv_123/messages
Idempotency-Key: message-client-001
```

```json
{
  "blocks": [
    {
      "type": "text",
      "contentJson": {
        "text": "检查当前后端测试失败原因，不要修改代码。"
      },
      "contentText": "检查当前后端测试失败原因，不要修改代码。"
    }
  ],
  "mentions": [
    {
      "targetType": "agent",
      "targetId": "agent_backend"
    }
  ],
  "clientMessageId": "client_msg_001"
}
```

Response：

```json
{
  "data": {
    "id": "msg_123",
    "conversationId": "conv_123",
    "status": "final",
    "sequence": 42,
    "messageType": "text",
    "version": 1
  }
}
```

Message 持久化后由 Router 创建 Agent Turn。

---

## 197. Create Task from Message

```http
POST /api/messages/msg_123/create-task
Idempotency-Key: task-from-message-001
```

```json
{
  "title": "Investigate backend test failures",
  "priority": "normal",
  "acceptanceCriteria": "Identify root cause and provide a verified remediation plan."
}
```

Response：

```http
201 Created
Location: /api/tasks/task_123
```

```json
{
  "data": {
    "id": "task_123",
    "workspaceId": "ws_agentos",
    "sourceConversationId": "conv_123",
    "sourceMessageId": "msg_123",
    "status": "draft",
    "version": 1
  }
}
```

---

## 198. Create and Start Run

```http
POST /api/tasks/task_123/runs
Idempotency-Key: run-create-001
```

```json
{
  "workflowDefinitionId": "workflow_investigate",
  "defaultAgentId": "agent_backend",
  "providerOverrides": {
    "investigate": "provider_kimicode_local"
  },
  "policyProfileId": "policy_read_only",
  "isolationStrategy": "none",
  "startImmediately": true
}
```

Response：

```http
202 Accepted
Location: /api/operations/op_run_001
```

```json
{
  "data": {
    "id": "op_run_001",
    "type": "run.create-and-start",
    "status": "queued",
    "aggregateType": "run",
    "aggregateId": "run_123"
  }
}
```

---

## 199. Get Run

```http
GET /api/runs/run_123?include=stages,providerSessions,processes
```

```json
{
  "data": {
    "id": "run_123",
    "taskId": "task_123",
    "status": "running",
    "reason": "initial",
    "baseCommit": "abc123",
    "stages": [
      {
        "id": "stage_123",
        "stageKey": "investigate",
        "status": "running",
        "agentId": "agent_backend",
        "providerConfigId": "provider_kimicode_local"
      }
    ],
    "version": 5
  }
}
```

---

## 200. Reconnect to Run Stream

```http
GET /api/runs/run_123/stream?afterSequence=100
Accept: text/event-stream
```

```text
id: evt_101
event: runtime-event
data: {"id":"evt_101","runId":"run_123","sequence":101,"type":"stream.text_delta","payload":{"delta":"正在检查测试配置"}}
```

---

## 201. Approval Required

```http
GET /api/approvals/approval_123
```

```json
{
  "data": {
    "id": "approval_123",
    "runId": "run_123",
    "stageId": "stage_123",
    "category": "package-install",
    "riskLevel": "medium",
    "status": "pending",
    "title": "Install local package",
    "requestSummary": {
      "package": "example-package",
      "workspaceScope": "owned-worktree"
    },
    "allowedGrantScopes": [
      "once",
      "stage",
      "run"
    ],
    "version": 1
  }
}
```

---

## 202. Approve Once

```http
POST /api/approvals/approval_123/approve
Idempotency-Key: approval-123-once
If-Match: "v1"
```

```json
{
  "scope": "once",
  "comment": "Required for this test only."
}
```

Response：

```json
{
  "data": {
    "approvalRequestId": "approval_123",
    "status": "approved",
    "grantId": "grant_123",
    "reEvaluationStatus": "allowed",
    "version": 2
  }
}
```

---

## 203. Provider Authentication Failure

```json
{
  "type": "urn:agentos:error:provider-auth-required",
  "title": "Provider authentication required",
  "status": 409,
  "code": "PROVIDER_AUTH_REQUIRED",
  "detail": "KimiCode requires login before execution.",
  "instance": "/api/runs/run_123/start",
  "requestId": "req_789",
  "retryable": false,
  "suggestedAction": "Complete KimiCode login and call the provider validation endpoint.",
  "context": {
    "runId": "run_123",
    "stageId": "stage_123"
  }
}
```

---

## 204. Version Conflict

Request：

```http
PATCH /api/agents/agent_backend
If-Match: "v3"
```

Server 当前 Version 为 4。

Response：

```http
412 Precondition Failed
```

```json
{
  "type": "urn:agentos:error:version-conflict",
  "title": "Resource version conflict",
  "status": 412,
  "code": "STORAGE_VERSION_CONFLICT",
  "detail": "The agent profile was changed by another request.",
  "instance": "/api/agents/agent_backend",
  "requestId": "req_456",
  "retryable": true,
  "suggestedAction": "Reload the resource and retry with the latest ETag."
}
```

---

## 205. Worktree Merge

```http
POST /api/worktrees/wt_123/merge
Idempotency-Key: merge-wt-123
If-Match: "v8"
```

```json
{
  "targetBranch": "main",
  "strategy": "squash",
  "expectedHeadCommit": "source123",
  "expectedTargetCommit": "target456"
}
```

Response：

```http
202 Accepted
Location: /api/operations/op_merge_123
```

---

## 206. Memory Retrieval

```http
POST /api/memory/retrieve
```

```json
{
  "workspaceId": "ws_agentos",
  "taskId": "task_123",
  "runId": "run_123",
  "stageId": "stage_123",
  "agentId": "agent_backend",
  "providerConfigId": "provider_kimicode_local",
  "queryText": "Investigate KimiCode authentication and process failures",
  "scopes": [
    "run",
    "task",
    "agent",
    "workspace"
  ],
  "categories": [
    "constraint",
    "failure",
    "provider",
    "environment"
  ],
  "strategy": "fts",
  "budget": {
    "maxEntries": 12,
    "maxCharacters": 12000
  }
}
```

Response 中必须包含 Entry 的 Score 和 Reasons。

---

## 207. Idempotency Replay

第一次：

```http
POST /api/tasks/task_123/runs
Idempotency-Key: run-create-001
```

第二次相同请求：

- 返回同一个 `runId`；
- 可以返回原 `202` 或当前 Operation 状态；
- 不创建第二个 Run。

---

# Part XXXII — OpenAPI Specification

## 208. OpenAPI Version

AgentOS v2 使用：

```text
OpenAPI 3.1
```

原因：

- JSON Schema 2020-12；
- Discriminator；
- Nullable 语义更清晰；
- Webhook / Callback 表达；
- 自动 SDK。

---

## 209. OpenAPI Source of Truth

推荐：

```text
TypeScript DTO + Runtime Schema
  ↓
OpenAPI Generation
```

或：

```text
OpenAPI-first
  ↓
Generated DTO
```

必须避免：

- 手写 DTO；
- 手写 Validator；
- 手写 OpenAPI；

三者长期漂移。

---

## 210. Schema Components

至少包含：

```text
Workspace
AgentProfile
ProviderConfiguration
ProviderSession
WorkflowDefinition
Task
Run
RunStage
RuntimeEvent
RuntimeProcess
Worktree
MemoryEntry
MemoryContext
PolicyProfile
PolicyDecision
ApprovalRequest
Conversation
Message
AgentTurn
Artifact
ApiOperation
ApiProblem
Pagination
```

---

## 211. Discriminator

Runtime Event、Message Block、Policy Decision 使用 Discriminator。

示例：

```yaml
RuntimeEvent:
  oneOf:
    - $ref: '#/components/schemas/RunStartedEvent'
    - $ref: '#/components/schemas/ToolStartedEvent'
  discriminator:
    propertyName: type
```

---

## 212. Endpoint Operation ID

稳定 Operation ID：

```text
listWorkspaces
createWorkspace
getRun
cancelRun
listRunEvents
sendConversationMessage
approveRequest
mergeWorktree
```

SDK 依赖 Operation ID。

---

## 213. OpenAPI Examples

每个高风险 Endpoint 至少包含：

- 成功；
- Approval Required；
- Version Conflict；
- Policy Denied；
- Resource Locked。

---

## 214. Experimental API

OpenAPI Extension：

```yaml
x-agentos-stability: experimental
```

---

# Part XXXIII — SDK Contract

## 215. SDK Targets

Foundation 推荐：

- TypeScript；
- Generated Fetch Client。

未来：

- Python；
- Go；
- Rust。

---

## 216. TypeScript Client

```ts
interface AgentOSClient {
  workspaces: WorkspaceApi;
  agents: AgentApi;
  providers: ProviderApi;
  workflows: WorkflowApi;
  tasks: TaskApi;
  runs: RunApi;
  processes: ProcessApi;
  worktrees: WorktreeApi;
  memories: MemoryApi;
  policies: PolicyApi;
  approvals: ApprovalApi;
  conversations: ConversationApi;
  artifacts: ArtifactApi;
  realtime: RealtimeApi;
}
```

---

## 217. SDK Error

SDK 将 `ApiProblem` 转换为：

```ts
class AgentOSApiError extends Error {
  status: number;
  code: string;
  requestId: string;
  retryable: boolean;
  retryAfterMs?: number;
  suggestedAction?: string;
  context?: Record<string, string>;
}
```

---

## 218. SDK Idempotency

SDK 可以自动为 Create Command 生成 Idempotency Key，但重试时必须复用原 Key。

---

## 219. SDK ETag

SDK Resource Result：

```ts
interface VersionedResource<T> {
  data: T;
  etag?: string;
}
```

Update 时可自动发送 ETag。

---

## 220. Realtime SDK

```ts
interface RunSubscription {
  close(): void;
  onEvent(handler: (event: RuntimeEvent) => void): void;
  onReconnect(handler: () => void): void;
  onGap(handler: (gap: SequenceGap) => void): void;
}
```

---

# Part XXXIV — Observability

## 221. API Metrics

必须监控：

- Request Count；
- Latency；
- Status Code；
- Error Code；
- Route；
- Concurrent Request；
- SSE Connection；
- WebSocket Connection；
- Reconnect；
- Payload Size；
- Idempotency Replay；
- Version Conflict；
- Approval Wait；
- Operation Queue；
- Policy Deny；
- Rate Limit。

---

## 222. Metric Labels

允许：

- Route Template；
- Method；
- Status；
- Error Code；
- Client Type。

禁止：

- Full URL；
- Task Title；
- Prompt；
- Secret；
- User Message；
- File Path；
- Artifact Name，可能敏感。

---

## 223. Tracing

每个请求创建：

```text
requestId
traceId
```

Runtime Event 可记录：

```text
traceId
spanId
```

Trace 不替代 Runtime Event。

---

## 224. Structured Logging

日志字段：

```text
requestId
route
method
status
durationMs
workspaceId
runId
errorCode
```

Args、Message、Prompt 默认不写完整日志。

---

# Part XXXV — API Testing

## 225. Contract Tests

每个 Endpoint 必须验证：

- Method；
- Path；
- Auth；
- Request Schema；
- Response Schema；
- Status；
- Error Code；
- ETag；
- Idempotency；
- Policy；
- Audit。

---

## 226. Resource Tests

### Workspace

- Create；
- Duplicate Root；
- Validate；
- Archive with Active Run；
- Version Conflict。

### Agent

- Create；
- Provider Binding；
- Archive；
- History。

### Provider

- Discover；
- Validate；
- Auth Required；
- Direct KimiCode；
- Session Control。

### Workflow

- Invalid DAG；
- Activate Version；
- Snapshot consistency。

### Task / Run

- Create；
- Start；
- Pause；
- Resume；
- Cancel；
- Retry；
- Accept；
- Child Run。

---

## 227. Event API Tests

- Sequence Pagination；
- Type Filter；
- Visibility；
- Restricted Access；
- Replay；
- Cursor Gap；
- SSE Reconnect；
- Duplicate Delivery。

---

## 228. Process API Tests

- Query；
- Stop；
- Repeated Stop；
- Tree；
- Output Range；
- Restricted Output；
- Orphan Cleanup。

---

## 229. Worktree API Tests

- Create；
- Inspect；
- Diff；
- Commit；
- Review；
- Merge；
- Expected Commit Conflict；
- Conflict Resolution；
- Dirty Cleanup；
- Force Approval。

---

## 230. Memory API Tests

- CRUD；
- Candidate；
- Accept；
- Duplicate；
- Conflict；
- Retrieval；
- Budget；
- Restricted；
- Hard Delete；
- Import。

---

## 231. Policy API Tests

- Rule CRUD；
- Compile；
- Simulate；
- Allow；
- Deny；
- Approval；
- Grant；
- Revoke；
- Unsafe Mode；
- Hard Deny。

---

## 232. Conversation API Tests

- Direct；
- Group；
- Send Message；
- Client Retry；
- Revision；
- Mention；
- Turn；
- Orchestrator；
- Task Bridge；
- Run Bridge；
- Approval Card；
- Read State；
- Search；
- Archive；
- Reconnect。

---

## 233. Artifact API Tests

- Upload；
- Finalize；
- Range；
- Download；
- Restricted；
- Reference；
- Delete；
- Checksum；
- Export。

---

## 234. Concurrency Tests

必须覆盖：

- Two PATCH same ETag；
- Duplicate Run Create；
- Approve vs Reject；
- Cancel vs Complete；
- Merge vs Merge；
- Merge vs Cleanup；
- Message Sequence Concurrent；
- Event Sequence Concurrent；
- Turn Cancel vs Finalize；
- WebSocket duplicate command。

---

## 235. Security Tests

- Missing Auth；
- CSRF；
- Cross Workspace；
- Forged Principal；
- Secret in Request；
- Path Traversal；
- Symlink Escape；
- SSRF；
- Raw HTML；
- Header Injection；
- Oversized JSON；
- Unauthorized Artifact；
- Unsafe Mode by Agent；
- Internal API Exposure。

---

## 236. Chaos and Recovery Tests

- Server crash after 202；
- Outbox delay；
- SSE disconnect；
- WebSocket disconnect；
- Provider crash；
- Database busy；
- Projection failure；
- Operation worker restart；
- Approval recovery；
- Artifact partial write。

---

## 237. OpenAPI Validation

CI 必须：

- Validate OpenAPI；
- Detect Breaking Change；
- Generate Client；
- Compile Client；
- Run Contract Test；
- Compare Runtime Response with Schema。

---

# Part XXXVI — API Performance Targets

## 238. Foundation Targets

本地典型目标：

| API | Target |
|---|---|
| GET single resource | p95 < 100 ms |
| List first page | p95 < 200 ms |
| Create message | p95 < 200 ms before routing |
| Create task | p95 < 200 ms |
| Create run record | p95 < 300 ms |
| Event append | p95 < 50 ms |
| SSE delivery after commit | p95 < 200 ms |
| Memory FTS retrieval | p95 < 300 ms |
| Conversation search | p95 < 500 ms |
| Run inspector | p95 < 1 s |

这些是工程目标，不是硬协议保证。

---

## 239. Large Timeline

Runtime Event 达到 100k 时：

- 默认分页；
- Timeline 聚合；
- 不一次返回全部；
- Replay 支持范围；
- Raw Output 使用 Artifact。

---

## 240. Large Conversation

Message 达到 100k 时：

- Sequence Pagination；
- FTS；
- Summary；
- 不加载全历史；
- Attachment 延迟加载。

---

# Part XXXVII — v1 API Migration

## 241. Current v1 API Model

当前 v1 主要围绕：

```text
Task Form
  ↓
Start Pipeline HTTP Request
  ↓
SSE status / stage / thinking / done
```

问题：

- HTTP Request 与执行生命周期耦合；
- Task 与 Run 混合；
- 无 Agent Resource；
- 无 Provider Resource；
- 无 Process Resource；
- 无 Worktree Resource；
- 无 Approval Resource；
- 无 Conversation；
- 无 Message；
- 无统一 Error；
- 无 Idempotency；
- 无 ETag；
- 无 Operation；
- SSE 断线可能取消执行。

---

## 242. Migration Target

```text
Create Task
  ↓
Create Run
  ↓
Start Run returns 202
  ↓
GET Run
  +
SSE Runtime Events
  +
Conversation Projection
```

---

## 243. Compatibility Endpoints

迁移期间可以保留旧 Endpoint：

```text
POST /api/tasks/:taskId/execute
```

内部映射：

```text
Create Run
  ↓
Start Run
  ↓
Return Compatibility Response
```

并返回 Deprecation Header。

---

## 244. Legacy SSE Mapping

```text
status
  → run / stage state projection

stage
  → stage events

thinking
  → stream.text_delta

done
  → terminal runtime event
```

旧 SSE Endpoint 可以从 Event Store 重建。

---

## 245. Migration Step 1 — Error Envelope

先统一错误：

```text
ApiProblem + stable code
```

---

## 246. Migration Step 2 — Task / Run Split

新增：

```text
POST /api/tasks/:taskId/runs
GET  /api/runs/:runId
```

旧 UI 仍可调用兼容层。

---

## 247. Migration Step 3 — Durable Events

新增：

```text
GET /api/runs/:runId/events
GET /api/runs/:runId/stream
```

---

## 248. Migration Step 4 — Provider and Process Resources

把 CLI 配置和 PID 从 Task Response 中移出。

---

## 249. Migration Step 5 — Conversation API

新增 Direct / Group Conversation 和 Message。

旧 Task 页面逐步变为 Task Conversation。

---

## 250. Migration Step 6 — Approval and Policy

所有高风险确认使用 Approval Resource。

---

## 251. Migration Step 7 — Remove Browser-owned Execution

删除 Request Close → Abort Run。

---

## 252. Migration Step 8 — Remove Deprecated Routes

在：

- UI 已迁移；
- Contract Test 通过；
- Migration Window 完成；

后移除。

---

# Part XXXVIII — Implementation Structure

## 253. Recommended Server Structure

```text
apps/server/src/
├── api/
│   ├── router.ts
│   ├── middleware/
│   │   ├── authentication.ts
│   │   ├── request-id.ts
│   │   ├── csrf.ts
│   │   ├── idempotency.ts
│   │   ├── etag.ts
│   │   ├── validation.ts
│   │   ├── error-handler.ts
│   │   └── audit.ts
│   ├── workspaces/
│   ├── agents/
│   ├── providers/
│   ├── workflows/
│   ├── tasks/
│   ├── runs/
│   ├── stages/
│   ├── events/
│   ├── processes/
│   ├── worktrees/
│   ├── memory/
│   ├── policy/
│   ├── approvals/
│   ├── conversations/
│   ├── artifacts/
│   ├── extensions/
│   ├── operations/
│   ├── admin/
│   └── realtime/
├── application/
├── runtime/
└── storage/
```

---

## 254. Route Handler Rule

Route Handler 只负责：

- Parse；
- Authenticate；
- Validate；
- Call Application Service；
- Map Response。

不得：

- Spawn Process；
- 执行 Git；
- 直接操作数据库表；
- 解析 Provider Output；
- 修改 Run 状态机；
- 决定 Policy。

---

## 255. DTO and Domain Separation

API DTO 不等于 Domain Entity。

```text
HTTP DTO
  ↓
Application Command
  ↓
Domain Aggregate
  ↓
Repository
```

避免直接把数据库 Row 全量返回。

---

## 256. Schema Validation

推荐统一使用 Runtime Schema 工具。

要求：

- TypeScript 类型推导；
- OpenAPI 生成；
- Runtime Validation；
- Error Field Mapping。

---

## 257. Error Mapping

Domain Error：

```text
PROVIDER_AUTH_REQUIRED
```

映射到：

```text
ApiProblem
HTTP 409
```

Mapping 集中管理。

---

## 258. Realtime Server

Realtime Server 只订阅已持久化 Event / Projection。

不直接监听 Provider stdout 作为唯一来源。

---

# Part XXXIX — Definition of Done

## 259. API Foundation DoD

API Foundation 完成必须满足：

1. 所有公共 Endpoint 位于 `/api`。
2. Internal Endpoint 与 Public API 分离。
3. Workspace、Agent、Provider、Workflow、Task、Run 有资源 API。
4. Process、Worktree、Memory、Policy、Conversation、Artifact 有资源 API。
5. Task 与 Run 创建分离。
6. Run Start 返回 202，不占用整个 HTTP 生命周期。
7. Browser Disconnect 不取消 Run。
8. Runtime Event 可查询。
9. Run SSE 支持 Sequence Reconnect。
10. Conversation SSE 支持 Message 和 Delta Recovery。
11. 所有错误使用稳定 `ApiProblem`。
12. 所有可变资源返回 Version 和 ETag。
13. PATCH 支持 If-Match。
14. 高副作用 Create / Command 支持 Idempotency Key。
15. 相同 Idempotency Key 不重复执行。
16. 普通列表支持 Cursor Pagination。
17. Event 和 Message 支持 Sequence Pagination。
18. 长命令有 Operation Resource。
19. Approval 是独立资源。
20. Approval 决策幂等。
21. Approval 后重新评估 Policy。
22. Provider Authentication 有明确 API。
23. KimiCode Provider API 对应直接 KimiCode Adapter。
24. Worktree Merge 使用 Expected Commit。
25. Process Control 不作为普通主流程入口。
26. Artifact API 不暴露本地路径。
27. Secret Value 不通过普通 API 返回。
28. Internal Principal 不可由客户端伪造。
29. Cookie 模式有 CSRF。
30. 非 Loopback 无认证模式被禁止。
31. SSE / WebSocket Channel 受授权。
32. Realtime 不是唯一数据来源。
33. OpenAPI 3.1 可生成。
34. TypeScript SDK 可生成并编译。
35. Contract Test 覆盖成功和错误。
36. Concurrency Test 覆盖版本冲突和幂等。
37. v1 Endpoint 有兼容和废弃计划。
38. API Audit 可以关联 Request、Policy 和 Execution。
39. Runtime Inspector 所需聚合 API 可用。
40. API Schema 与 Data Model 一致。

---

# Part XL — Anti-Patterns

## 260. Long HTTP Run

错误：

```text
POST /run
connection stays open for 30 minutes
```

正确：

```text
POST create/start
  → 202 Operation / Run ID

GET state
SSE events
```

---

## 261. Browser Close Cancels Run

错误：

```text
request close
  → abort process
```

正确：

```text
POST /runs/:id/cancel
```

---

## 262. Status by PATCH

错误：

```http
PATCH /api/runs/run_123
{
  "status": "completed"
}
```

正确：

```text
Run Engine performs terminal transition
```

---

## 263. String Errors

错误：

```json
{
  "error": "something went wrong"
}
```

正确：

```text
application/problem+json
+ stable code
+ requestId
```

---

## 264. Client-generated Principal

错误：

```json
{
  "principalType": "system"
}
```

正确：

Server 根据认证和 Runtime Context 构建 Principal。

---

## 265. Local Path Download

错误：

```json
{
  "path": "E:\\workspace\\..."
}
```

让前端自行读取。

正确：

```text
GET /api/artifacts/:id/content
```

---

## 266. Duplicate Command by Retry

错误：

```text
client timeout
→ create second run
```

正确：

```text
Idempotency-Key
```

---

## 267. No Expected Commit

错误：

```text
POST merge current branch
```

正确：

```text
expectedHeadCommit
expectedTargetCommit
```

---

## 268. Full Object Graph

错误：

```text
GET task returns every event, process, message and artifact
```

正确：

```text
resource
+ include whitelist
+ dedicated query endpoints
```

---

## 269. SSE as Database

错误：

```text
if client missed event, state is lost
```

正确：

```text
Event Store
+ REST Query
+ SSE Delivery
```

---

## 270. Approval by Generic Message

错误：

```text
POST /messages
"好"
→ execute push
```

正确：

```text
POST /approvals/:id/approve
```

---

## 271. API Handler Executes Shell

错误：

```text
route handler
  → child_process.spawn
```

正确：

```text
route
  → application service
  → policy
  → runtime
```

---

## 272. Raw Database Row Response

错误：

```text
SELECT *
→ JSON
```

正确：

```text
Domain Query Model
→ API DTO
```

---

# Part XLI — Global Invariants

## 273. API Invariants

AgentOS v2 API 必须始终满足：

1. HTTP Request 不拥有 Run 生命周期。
2. Browser Connection 不拥有 Process 生命周期。
3. Public API 与 Internal Runtime API 分离。
4. Resource ID 是不透明值。
5. JSON 字段使用 camelCase。
6. 路径使用复数 kebab-case。
7. 时间使用 UTC ISO 8601。
8. 普通成功响应使用统一 Envelope。
9. 错误使用 `application/problem+json`。
10. Error Code 稳定且可编程处理。
11. Request ID 必须贯穿 API、Event 和 Log。
12. 可变 Aggregate 返回 Version 和 ETag。
13. 并发修改使用 If-Match 或 Expected Version。
14. 高副作用请求支持 Idempotency。
15. 相同 Idempotency Key 不得重复副作用。
16. 不同 Request Hash 不得复用同一 Key。
17. 长命令返回 202 Operation。
18. Operation 不等于 Run。
19. Run Start 不保持长 HTTP 连接。
20. Runtime State 可通过 REST 查询。
21. Realtime 只能作为增量通道。
22. SSE 断线不得取消执行。
23. SSE 必须支持 Sequence Resume。
24. WebSocket Channel 必须授权。
25. Runtime Event 与 Message Stream 不混为同一协议对象。
26. Task 创建与 Run 创建分离。
27. Agent Resource 与 Provider Resource 分离。
28. Provider Session 与 Process Resource 分离。
29. Run Status 不允许由普通 PATCH 任意设置。
30. Terminal Transition 只能由 Runtime Engine。
31. Approval 必须是独立资源。
32. Approval 决策必须绑定 Request ID。
33. 模糊文本不得批准高风险 Action。
34. Approval 后必须重新评估 Policy。
35. Unsafe Mode 必须使用显式 Endpoint。
36. Agent、Provider 和 Extension 不得伪造 User Principal。
37. Secret Value 不得进入 URL、JSON Response、Event 或 Log。
38. Artifact 内容通过受控 Endpoint。
39. 本地 Storage Path 不作为下载合同。
40. Cross Workspace 引用必须验证。
41. Path 必须 Canonicalize。
42. Redirect 后必须重新评估 Network Policy。
43. GET 默认无副作用。
44. Lifecycle Command 使用 POST。
45. DELETE 默认 Soft Delete，除非明确。
46. List 使用 Cursor Pagination。
47. Event 和 Message 使用 Sequence Pagination。
48. `include` 必须有白名单和深度限制。
49. Search 必须受 Workspace 和权限约束。
50. Restricted Resource 使用 `no-store`。
51. Internal API 不得暴露公网。
52. Cookie Auth 必须有 CSRF。
53. 无认证模式只能用于 Loopback。
54. Route Handler 不执行 Runtime 副作用。
55. API DTO 不等于数据库 Row。
56. OpenAPI 必须与 Runtime Validation 同源。
57. SDK 必须复用 Idempotency Key 重试。
58. API Breaking Change 必须版本化。
59. Deprecated Endpoint 必须给出迁移信息。
60. v1 SSE `thinking` 必须映射为 `stream.text_delta`。
61. v1 Task Execute 必须映射为 Task + Run。
62. Runtime Inspector API 不应泄露 Secret。
63. Audit 必须关联 Request 和 Policy Decision。
64. Outbox 确保 Persist then Publish。
65. API Contract Test 必须在 CI 执行。

---

# Part XLII — Final Definition

## 274. Final Definition

AgentOS v2 API 定义如下：

> AgentOS v2 API 是 Web UI、CLI、Desktop、Mobile、Extension 和未来 Remote Client 与 AgentOS Runtime 交互的统一合同。它以 REST Resource 表达 Workspace、Agent Profile、Provider Configuration、Workflow、Task、Run、Stage、Provider Session、Process、Worktree、Memory、Policy、Approval、Conversation、Message、Artifact 和 Extension；以 Command Endpoint 表达 Start、Pause、Resume、Cancel、Retry、Approve、Merge、Cleanup 等生命周期行为；以 Operation Resource 跟踪长时间 API 命令；以 Runtime Event Store、SSE 和 WebSocket 提供可恢复的实时执行流；以 `ApiProblem`、稳定 Error Code、ETag、Expected Commit 和 Idempotency Key 保证错误处理和并发安全；以 Policy Runtime 和 Resource Authorization 控制所有高风险行为。

简化表达：

```text
Client Command
  ↓
HTTP Validation + Authentication
  ↓
Resource Access
  ↓
Application Service
  ↓
Policy Evaluation
  ↓
Runtime Command
  ↓
State + Event + Outbox
  ↓
202 Operation / Resource Response
  ↓
REST Query + SSE / WebSocket
```

核心协议边界：

```text
REST
  = durable resource query and command submission

Operation
  = long-running API command tracking

Runtime Event
  = durable ordered execution fact

SSE / WebSocket
  = reconnectable realtime delivery

Conversation Projection
  = user-facing collaboration view

Policy
  = authoritative execution decision

Artifact Endpoint
  = controlled access to large output
```

Task 和 Run 的 API 边界：

```text
POST /api/workspaces/:workspaceId/tasks
  → create durable intent

POST /api/tasks/:taskId/runs
  → create execution attempt

POST /api/runs/:runId/start
  → start asynchronously

GET /api/runs/:runId
  → query current state

GET /api/runs/:runId/events
  → query durable history

GET /api/runs/:runId/stream
  → subscribe realtime

POST /api/runs/:runId/cancel
  → explicit cancellation
```

Conversation 和 Runtime 的 API 边界：

```text
POST /api/conversations/:id/messages
  → persist collaboration message

POST /api/messages/:id/create-task
  → convert intent to Task

POST /api/messages/:id/start-run
  → start engineering execution

Runtime Event Projector
  → update Run / Approval / Artifact cards
```

本文件定义的 API Specification 是 AgentOS v2 前端重构、CLI 客户端、Conversation UI、Runtime Inspector、Approval Center、Extension Center、OpenAPI SDK 和未来远程 Runtime 的外部协议基础。
