# AgentOS Skills / Plugins / MCP Extension Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不复制 Codex、KimiCode、OpenCode 原生扩展 Runtime 的前提下，为 AgentOS 增加可验证的扩展发现、作用域管理、信任授权、MCP 状态展示和逐次 Run 使用审计。

**Architecture:** Provider Adapter 通过只读 probe 返回自身能够可靠发现和管理的扩展能力；Server 将规范化元数据持久化为 Extension Registry，并将“发现状态”“用户授权”“运行时实际使用”分开保存。AgentOS 不直接执行第三方 Skill/Plugin 脚本，不把 MCP 密钥写入公开事件，也不在 Provider 不支持原生启停时伪造控制能力。

**Tech Stack:** TypeScript、Node.js >= 22.5、Express、`node:sqlite`、Next.js 14、React 18、Vitest、Node Test Runner、SSE、PowerShell、pnpm workspace。

**Base:** 用户已验收并在 `docs/acceptance/agentos-collaboration-workbench-final.md` 记录的计划 D Task D6 HEAD。

**Branch:** `codex/agentos-extension-center`。

## Global Constraints

- 本计划只能在计划 A 的 `AgentProvider`、`ResolvedRuntime` 和 Adapter probe 模型稳定后实施。
- E0 依赖计划 A3 Provider/Adapter 模型；E2-E4 写接口依赖计划 A1 本地 API 防线；E5 依赖计划 B1 persisted sequence。
- AgentOS 只管理、展示和审计 CLI 原生扩展；不解析并执行 Skill 内容，不代理 MCP tool call，不实现新的 Plugin Runtime。
- Provider 没有稳定发现接口时返回 `unsupported`；目录扫描结果只能标为 `filesystem_hint`，不能标为已启用或可控制。
- 扩展发现、授权和本次运行实际使用是三个独立事实；“已发现”不等于“已启用”，“已启用”不等于“本次已使用”。
- Workspace 导入的第三方扩展默认 `untrusted`；含脚本、hook、命令或网络配置的变更必须显式确认。
- API、SQLite、AgentEvent、日志和 UI 只保存环境变量名称，不保存环境变量值、访问令牌或认证头。
- config hash 只基于脱敏后的稳定配置；不同机器的绝对路径、临时端口和密钥值不得进入 hash。
- 所有可选 scopeId 在持久层规范化为空字符串；任何唯一约束不得直接依赖 nullable scope_id。
- Extension Center 不阻塞计划 B–D 的交付；本计划每个 Task 都可独立验收和停止。

## Plan Start Gate

- [ ] 读取计划 D 最终验收记录并人工确认其中 HEAD 是本计划唯一基准。
- [ ] 执行 `git status --short`；非空则停止并先划清残留改动归属。
- [ ] 执行 `git rev-parse HEAD` 并写入 `docs/acceptance/extension-center-baseline.md`。
- [ ] 确认分支不存在后执行 `git switch -c codex/agentos-extension-center`。

验收：baseline 文档包含 base branch、base HEAD、Node/pnpm 与三种 CLI 版本、全量测试结果；计划 A1/B1 安全与 sequence Gate 仍通过。

---

## Task E0：冻结 Provider 扩展能力矩阵

**Files:**

- Create: `docs/acceptance/extension-center-baseline.md`
- Create: `docs/acceptance/extension-provider-capabilities.md`
- Create: `scripts/probe-provider-extensions.ps1`
- Modify: `packages/agent-core/src/adapters/types.ts`
- Modify: `packages/agent-core/src/adapters/types.test.ts`

**Interfaces:**

```ts
export type ExtensionKind = 'skill' | 'plugin' | 'mcp';
export type ExtensionScope = 'user' | 'workspace' | 'agent' | 'conversation';
export type ExtensionDiscoveryMode = 'native' | 'filesystem_hint' | 'unsupported';
export type ExtensionControl = 'discover' | 'enable' | 'disable' | 'start' | 'stop';

export interface ProviderExtensionCapability {
  kind: ExtensionKind;
  discovery: ExtensionDiscoveryMode;
  controls: ExtensionControl[];
  supportedScopes: ExtensionScope[];
  controlsByScope: Partial<Record<ExtensionScope, ExtensionControl[]>>;
  configLocations: string[];
  evidence: string;
  unavailableReason?: string;
}

export interface ExtensionProbeInput {
  commandPath: string;
  detectedProvider: AgentProvider;
  workspaceRoot?: string;
}

export interface ProviderExtensionProbeResult {
  provider: AgentProvider;
  version?: string;
  capabilities: ProviderExtensionCapability[];
  probedAt: string;
}

export interface AgentCliAdapter {
  probe(commandPath: string): Promise<ProviderProbeResult>;
  probeExtensions?(input: ExtensionProbeInput): Promise<ProviderExtensionProbeResult>;
}
```

- [ ] **Step E0.1：先写能力归一化失败测试**

覆盖未知 Provider、命令不存在、命令超时、非 JSON 输出、返回部分能力、路径包含用户目录以及输出包含疑似密钥。断言失败只影响对应 Provider，不阻塞 Server 启动。

- [ ] **Step E0.2：实现只读 probe 脚本**

脚本分别记录 Codex、KimiCode、OpenCode 的实际命令路径、版本、只读 help/config/list 输出和退出码。原始输出写入 `.agentos/acceptance/extension-probes/`，公开 Markdown 只保留脱敏摘要。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/probe-provider-extensions.ps1
```

脚本不得执行 install、remove、enable、disable、start、stop 或任何会改配置的命令。

- [ ] **Step E0.3：形成能力矩阵**

每个 Provider × ExtensionKind 必须填写：发现方式、可用控制、supportedScopes、controlsByScope、配置来源、证据命令、失败原因、验证日期和 CLI 版本。无法验证时写 `unsupported` 或 `blocked`，不得根据产品宣传补全。

- [ ] **Step E0.4：增加独立 Extension Probe**

统一沿用计划 A 的 `ProviderProbeResult` 名称，但不把完整 Extension 扫描塞入普通 `probe()`。Adapter 可选实现 `probeExtensions()`；普通 Run resolve 只调用轻量 runtime probe，不因 Skills/MCP 列表延迟。Extension probe 单命令仍遵守 5 秒上限，只在 Extension Center refresh 或运行前必要快照时调用，Server 使用 `detectedProvider + commandPath + version` 作为缓存键。

未实现 `probeExtensions` 的 Adapter 返回明确 unsupported；不得回退到普通 probe 并猜测扩展。

- [ ] **Step E0.5：验证**

```powershell
pnpm.cmd --filter @agentos/agent-core test
powershell -ExecutionPolicy Bypass -File scripts/probe-provider-extensions.ps1
git diff --check
```

- [ ] **Step E0.6：提交**

```powershell
git add docs/acceptance/extension-center-baseline.md docs/acceptance/extension-provider-capabilities.md scripts/probe-provider-extensions.ps1 packages/agent-core/src/adapters/types.ts packages/agent-core/src/adapters/types.test.ts
git commit -m "docs: freeze provider extension capabilities"
```

### Task E0 验收标准

- 三个 Provider 的 Skill/Plugin/MCP 均有真实证据或明确 `unsupported/blocked`。
- probe 全程只读，失败不会修改用户配置或阻止 Server 启动。
- 公开报告中没有密钥值、认证头或完整用户目录。
- `configuredProvider` 与 `detectedProvider` 不一致时使用 detected Provider 的能力矩阵，并在 UI/API 暴露 mismatch。
- 普通 Agent Run 不触发完整扩展扫描；Extension probe 超时不改变 Runtime probe 的 AVAILABLE 结果。
- 每个控制动作都能解释支持的 scope，不允许把 conversation 操作退化成 workspace/user 修改。

---

## Task E1：Extension Registry 数据模型与发现同步

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Create: `packages/agent-core/src/extensions/discovery.ts`
- Create: `packages/agent-core/src/extensions/discovery.test.ts`
- Create: `apps/server/src/services/ExtensionDiscoveryService.ts`
- Create: `apps/server/src/services/ExtensionDiscoveryService.test.ts`
- Create: `apps/server/src/services/ExtensionRegistryService.ts`
- Create: `apps/server/src/services/ExtensionRegistryService.test.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`
- Create: `apps/server/src/routes/extensions.ts`
- Create: `apps/server/src/routes/extensions.test.ts`
- Modify: `apps/server/src/index.ts`

**Interfaces:**

```ts
export type ExtensionDiscoverySource = 'provider_native' | 'filesystem_hint';
export type ExtensionAvailability = 'available' | 'disabled' | 'unavailable' | 'unsupported';

export interface ExtensionDescriptor {
  id: string;
  provider: AgentProvider;
  kind: ExtensionKind;
  nativeId: string;
  displayName: string;
  version?: string;
  source: string;
  sourceHash?: string;
  scope: ExtensionScope;
  scopeId?: string;
  discoverySource: ExtensionDiscoverySource;
  availability: ExtensionAvailability;
  controllable: boolean;
  lastSeenAt: string;
}
```

SQLite 只向前增加：

```sql
CREATE TABLE extension_registry (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  native_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  version TEXT,
  source_label TEXT NOT NULL,
  source_hash TEXT,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  discovery_source TEXT NOT NULL,
  availability TEXT NOT NULL,
  controllable INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(provider, kind, native_id, scope, scope_id)
);
```

- [ ] **Step E1.1：先写迁移与幂等同步失败测试**

用旧数据库 fixture 启动，连续同步相同结果两次，再同步删除、重命名、版本变化和 Provider mismatch。特别连续插入两次 `scope=user, scope_id=''`，断言普通 UNIQUE 真正拒绝重复。旧表记录数不减少，同一 native extension 不重复插入，未再次发现的项目标为 `unavailable` 而不是物理删除。

- [ ] **Step E1.2：实现规范化与稳定 ID**

稳定 ID 由 `provider/kind/nativeId/scope/normalizedScopeId` 计算，其中缺失 scopeId 一律规范化为 `''`；展示名、版本和来源变化不得创建第二条逻辑记录。所有路径先 canonicalize，只对 UI 返回相对标签或配置来源类别。

- [ ] **Step E1.3：实现发现同步服务**

按 detected Provider 调用 Adapter 原生 discover；仅当 E0 标记 `filesystem_hint` 时允许只读扫描已确认的配置目录，且结果 `controllable=false`。同步使用单 workspace/provider 锁，避免两个刷新请求互相覆盖。

- [ ] **Step E1.4：实现只读 API**

```http
GET /api/workspaces/:workspaceId/extensions
GET /api/workspaces/:workspaceId/extensions/capabilities
POST /api/workspaces/:workspaceId/extensions/refresh
```

列表支持 provider/kind/scope/availability/trust 筛选；refresh 只触发只读发现，不改变 CLI 配置。

- [ ] **Step E1.5：验证**

```powershell
pnpm.cmd --filter @agentos/agent-core test
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/ExtensionDiscoveryService.test.ts src/services/ExtensionRegistryService.test.ts src/routes/extensions.test.ts src/store/SqliteStore.test.ts
pnpm.cmd --filter @agentos/server test
pnpm.cmd -r run build
```

- [ ] **Step E1.6：提交**

```powershell
git add packages/shared/src/types/index.ts packages/agent-core/src/extensions/discovery.ts packages/agent-core/src/extensions/discovery.test.ts apps/server/src/services/ExtensionDiscoveryService.ts apps/server/src/services/ExtensionDiscoveryService.test.ts apps/server/src/services/ExtensionRegistryService.ts apps/server/src/services/ExtensionRegistryService.test.ts apps/server/src/store/SqliteStore.ts apps/server/src/store/SqliteStore.test.ts apps/server/src/routes/extensions.ts apps/server/src/routes/extensions.test.ts apps/server/src/index.ts
git commit -m "feat: discover provider-native extensions"
```

### Task E1 验收标准

- 旧数据库可向前迁移，重复 refresh 不产生重复记录。
- Provider 原生发现、文件系统提示和不支持三种状态在 API 中可区分。
- 未再次发现的扩展保留审计历史并标记 `unavailable`。
- API 不返回绝对用户目录、环境变量值或原始 Provider 配置。
- user scope 连续同步不会因 SQLite NULL 唯一语义产生重复行。

---

## Task E2：Skill Registry 作用域与原生配置控制

**Entry Gate:** 计划 A1 已完成并验证 Origin/loopback 写请求防线；未满足时只能实现和测试作用域纯函数，不得注册 assignment 写路由。

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/server/src/services/SkillRegistryService.ts`
- Create: `apps/server/src/services/SkillRegistryService.test.ts`
- Modify: `apps/server/src/routes/extensions.ts`
- Modify: `apps/server/src/routes/extensions.test.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/web/src/lib/useApi.ts`

**Interfaces:**

```ts
export interface ExtensionAssignment {
  id: string;
  extensionId: string;
  scope: ExtensionScope;
  scopeId?: string;
  desiredState: 'enabled' | 'disabled';
  effectiveState: 'enabled' | 'disabled' | 'unsupported' | 'blocked';
  configuredAt: string;
  configuredBy: 'user';
}
```

SQLite identity：

```sql
CREATE TABLE extension_assignments (
  id TEXT PRIMARY KEY,
  extension_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  desired_state TEXT NOT NULL,
  effective_state TEXT NOT NULL,
  configured_at TEXT NOT NULL,
  configured_by TEXT NOT NULL,
  UNIQUE(extension_id, scope, scope_id)
);
```

`scope_id TEXT NOT NULL DEFAULT ''`；Store 在入库前统一 normalize，禁止写 NULL。

- [ ] **Step E2.1：先写作用域解析测试**

覆盖 user → workspace → agent → conversation 的逐层覆盖，显式 disabled 优先于上层 enabled，同优先级冲突拒绝保存，已删除 scopeId 返回 404。能力矩阵只支持 user/workspace 时，agent/conversation 请求必须保留 desiredState 但 effectiveState=`unsupported`，且没有任何 CLI 配置写入。

- [ ] **Step E2.2：实现纯函数作用域解析器**

解析器只计算 desired/effective 状态，不调用 CLI。输出必须包含生效来源，便于 UI 解释“由用户级启用、被当前会话禁用”。

- [ ] **Step E2.3：实现 Provider 原生配置写入**

仅当 E0 能力矩阵的 `controlsByScope[requestedScope]` 声明对应 `enable/disable` 且 Adapter 提供原生实现时注册写接口。写入前保存脱敏配置 hash，写入后重新 probe 并校验实际状态；失败不更新 effectiveState，记录公开诊断。Provider 不支持的 agent/conversation scope 不得退化为 workspace/user 写入。

```http
PUT /api/workspaces/:workspaceId/extensions/:extensionId/assignment
Content-Type: application/json

{"scope":"agent","scopeId":"agent-id","desiredState":"enabled"}
```

如果 Provider 只支持发现，接口返回 409/code `extension_control_unsupported`，不得在 AgentOS 数据库中制造“已启用”假象。

- [ ] **Step E2.4：实现配置漂移检测**

每次运行前比较 registry sourceHash、assignment 记录和原生 probe 状态。外部 CLI 修改配置时更新 effectiveState 并产生 `extension.configuration_changed` 公开事件，不自动覆盖外部修改。

- [ ] **Step E2.5：验证**

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/SkillRegistryService.test.ts src/routes/extensions.test.ts
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web test
pnpm.cmd -r run build
```

- [ ] **Step E2.6：提交**

```powershell
git add packages/shared/src/types/index.ts apps/server/src/services/SkillRegistryService.ts apps/server/src/services/SkillRegistryService.test.ts apps/server/src/routes/extensions.ts apps/server/src/routes/extensions.test.ts apps/server/src/store/SqliteStore.ts apps/web/src/lib/useApi.ts
git commit -m "feat: manage native skill assignments"
```

### Task E2 验收标准

- 四级 scope 覆盖结果确定且能解释生效来源。
- 不支持原生 enable/disable 的 Provider 不能被 UI/API 伪装成可控制。
- 写入后必须由二次 probe 证明实际状态才显示成功。
- 用户在 CLI 外部修改配置后，AgentOS 更新展示但不擅自覆盖。
- Provider 只支持 user/workspace 时，agent/conversation 请求显示 unsupported，且更大范围配置保持不变。

---

## Task E3：MCP Server 清单、健康状态与敏感信息隔离

**Entry Gate:** 只读 list/status 可在 E1 后实现；start/stop 路由只有计划 A1 全局写请求防线验收后才能注册。MCP 控制是用户主动 AgentOS action，不复用 C6 Provider 工具审批。

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/server/src/services/McpRegistryService.ts`
- Create: `apps/server/src/services/McpRegistryService.test.ts`
- Create: `apps/server/src/services/McpRedactionService.ts`
- Create: `apps/server/src/services/McpRedactionService.test.ts`
- Modify: `apps/server/src/routes/extensions.ts`
- Modify: `apps/server/src/routes/extensions.test.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`

**Interfaces:**

```ts
export interface McpServerDescriptor {
  extensionId: string;
  transport: 'stdio' | 'http' | 'sse' | 'unknown';
  status: 'available' | 'stopped' | 'error' | 'unsupported' | 'unknown';
  toolNames: string[];
  environmentKeys: string[];
  endpointLabel?: string;
  lastCheckedAt?: string;
  statusReason?: string;
}

export interface McpControlRequest {
  requestId: string;
  action: 'start' | 'stop';
  expectedConfigHash: string;
  confirmed: true;
}

export interface McpControlAudit {
  requestId: string;
  workspaceId: string;
  extensionId: string;
  action: 'start' | 'stop';
  actor: 'user';
  expectedConfigHash: string;
  result: 'completed' | 'failed' | 'conflict';
  createdAt: string;
}
```

- [ ] **Step E3.1：先写脱敏和状态测试**

fixture 包含 API key、Bearer header、URL userinfo、query token、Windows 用户目录、stdio args 和环境变量。断言 API/SQLite/events/snapshot 中只保留 env key、脱敏 endpointLabel 和允许的非敏感参数。

另测 start/stop 的 expectedConfigHash mismatch、重复 requestId、Provider 不支持目标 scope 和用户未确认；四种情况都不能调用 Adapter 控制方法。

- [ ] **Step E3.2：规范化 MCP 描述**

由 Provider 原生 list/status 输出转换 transport/status/toolNames；tool list 不可用时返回空数组并说明原因，不通过主动调用业务工具来探测。

- [ ] **Step E3.3：受控健康刷新**

刷新只调用 Provider 声明的原生 status/list 接口，单 server 5 秒超时、workspace 并发上限 4、60 秒缓存。没有 status 能力时保持 `unknown/unsupported`，不自行 spawn 第三方 server。

- [ ] **Step E3.4：用户确认的 start/stop 管理动作**

只有 E0 `controlsByScope` 为目标 scope 声明原生 `start/stop` 时开放接口；请求必须经过计划 A1 Origin 防线，携带 `confirmed=true`、唯一 requestId 和当前 expectedConfigHash。执行前重新读取配置 hash，不一致返回 409/code `extension_config_changed`；相同 requestId 重放返回首次结果，不重复启停。全过程写入 `extension.action.requested/completed/failed` 审计事件。

这不是 Provider 在 Run 中发出的 `approval.requested`，不得创建或消费 C6 ApprovalGrant。否则按钮隐藏，API 返回 `mcp_control_unsupported`。

```http
POST /api/workspaces/:workspaceId/extensions/:extensionId/mcp/refresh
POST /api/workspaces/:workspaceId/extensions/:extensionId/mcp/start
POST /api/workspaces/:workspaceId/extensions/:extensionId/mcp/stop
```

- [ ] **Step E3.5：验证**

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/McpRegistryService.test.ts src/services/McpRedactionService.test.ts src/routes/extensions.test.ts
pnpm.cmd --filter @agentos/server test
pnpm.cmd -r run build
```

- [ ] **Step E3.6：提交**

```powershell
git add packages/shared/src/types/index.ts apps/server/src/services/McpRegistryService.ts apps/server/src/services/McpRegistryService.test.ts apps/server/src/services/McpRedactionService.ts apps/server/src/services/McpRedactionService.test.ts apps/server/src/routes/extensions.ts apps/server/src/routes/extensions.test.ts apps/server/src/store/SqliteStore.ts
git commit -m "feat: inspect provider MCP servers safely"
```

### Task E3 验收标准

- stdio/http/sse/unknown 传输类型与 available/stopped/error/unsupported/unknown 状态可区分。
- 环境变量值、认证头、URL 凭据和绝对用户目录不进入持久层或公开 UI。
- 健康刷新不调用业务工具、不自动启动第三方进程。
- start/stop 只有 Provider 原生支持且用户授权后才可执行。
- start/stop 必须由用户明确确认并绑定 config hash；重复 requestId 不重复执行，且不依赖 C6 Provider approval。

---

## Task E4：Plugin 来源、Workspace 信任与授权

**Entry Gate:** 计划 A1 已完成；未满足时只允许计算 trust/risk/hash，不得注册 trust 决策写路由。

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/server/src/services/ExtensionTrustService.ts`
- Create: `apps/server/src/services/ExtensionTrustService.test.ts`
- Modify: `apps/server/src/routes/extensions.ts`
- Modify: `apps/server/src/routes/extensions.test.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/managers/WorkspaceManager.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`

**Interfaces:**

```ts
export type ExtensionTrust = 'trusted' | 'untrusted' | 'changed' | 'blocked';

export interface ExtensionTrustDecision {
  extensionId: string;
  workspaceId: string;
  trust: ExtensionTrust;
  sourceHash?: string;
  riskFlags: Array<'script' | 'hook' | 'command' | 'network' | 'unknown_source'>;
  decidedAt?: string;
  decidedBy?: 'user';
}
```

- [ ] **Step E4.1：先写信任状态机测试**

覆盖新导入 Workspace、已信任来源 hash 不变、只修改 plugin.js bytes、扩展消失后重现、含 hook/script、未知来源、symlink 逃逸和用户明确阻止。断言只有用户动作可从 untrusted/changed 进入 trusted；只改脚本正文也必须进入 changed。

- [ ] **Step E4.2：默认不信任 Workspace 扩展**

Workspace 创建或重新绑定路径时，仅登记发现结果，不启用第三方扩展。用户级 Provider 内置扩展可沿用 Provider 状态，但必须标明来源，不能继承为 Workspace trust。

- [ ] **Step E4.3：基于实际文件内容的风险摘要与 hash**

对扩展根目录下全部允许的普通文件按 normalized relative path 排序；每项纳入 relative path、file type 和 file bytes SHA-256，再加入 canonical sanitized manifest 与 relevant config key names，最终计算 sourceHash。脚本正文只参与本地 hash/风险分类，不写入数据库或 AgentEvent；数据库只保存最终 digest。

symlink、越界路径、无法读取文件、超过 10,000 文件或 250 MiB 总量时标记 blocked，不能降级成只 hash manifest。任何实际文件 bytes 变化都会把 trusted 改为 changed 并要求重新确认。

- [ ] **Step E4.4：授权 API**

```http
POST /api/workspaces/:workspaceId/extensions/:extensionId/trust
Content-Type: application/json

{"decision":"trusted","expectedSourceHash":"sha256-value"}
```

expectedSourceHash 不匹配返回 409，防止用户审核后扩展内容被替换。阻止决定可撤销，但撤销仍需新的显式用户动作。

- [ ] **Step E4.5：运行前重新计算并防止审核后替换**

创建 Execution 快照前重新计算完整 sourceHash，并与 trust decision.expectedSourceHash 比较；不一致立即 changed/block，旧授权失效。Run context 只注入 effectiveState=enabled 且 trust=trusted 的 Workspace 扩展；untrusted/changed/blocked 产生公开诊断并排除。Provider 无法细粒度排除时整个 Run 进入 waiting_user，不能声称已安全隔离单个扩展。

- [ ] **Step E4.6：验证**

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/ExtensionTrustService.test.ts src/routes/extensions.test.ts
pnpm.cmd --filter @agentos/server test
pnpm.cmd -r run build
```

- [ ] **Step E4.7：提交**

```powershell
git add packages/shared/src/types/index.ts apps/server/src/services/ExtensionTrustService.ts apps/server/src/services/ExtensionTrustService.test.ts apps/server/src/routes/extensions.ts apps/server/src/routes/extensions.test.ts apps/server/src/store/SqliteStore.ts apps/server/src/store/SqliteStore.test.ts apps/server/src/managers/WorkspaceManager.ts
git commit -m "security: require trust for workspace extensions"
```

### Task E4 验收标准

- 新 Workspace 的第三方 Skill/Plugin/MCP 默认不信任且不注入 Run。
- 来源 hash 改变后自动进入 changed，旧授权不能继续生效。
- 授权请求绑定 expectedSourceHash，避免审核与执行之间被替换。
- Provider 无法隔离扩展时明确暂停或阻止，不伪造单扩展 sandbox。
- 只修改 plugin.js/hook.ts/script.ps1 内容、不改 manifest 或文件名，也必然改变 sourceHash。
- 用户确认后、Run 启动前发生文件变化时旧 trust 立即失效。

---

## Task E5：逐次 Run 扩展使用审计

**Entry Gate:** 计划 B1 的 SQLite `AgentEvent.sequence` 已完成并通过重启/重放测试。

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`
- Create: `apps/server/src/services/ExtensionAuditService.ts`
- Create: `apps/server/src/services/ExtensionAuditService.test.ts`
- Modify: `apps/server/src/services/ConversationService.ts`
- Modify: `apps/server/src/services/ConversationService.test.ts`
- Modify: `apps/server/src/services/RuntimeEventProjector.ts`
- Modify: `apps/server/src/routes/runs.ts`
- Modify: `apps/server/src/routes/runs.test.ts`
- Modify: `apps/web/src/components/runs/RunDetails.tsx`

**Interfaces:**

```ts
export interface ExtensionUsageRecord {
  id: string;
  runId: string;
  executionId: string;
  provider: AgentProvider;
  extensionId: string;
  kind: ExtensionKind;
  nativeId: string;
  version?: string;
  sourceHash?: string;
  sanitizedConfigHash: string;
  evidence: 'provider_event' | 'tool_namespace' | 'enabled_snapshot';
  actuallyInvoked: boolean;
  firstSequence: number;
  lastSequence: number;
}
```

- [ ] **Step E5.1：先写审计真实性测试**

覆盖已启用但未使用、Provider 明确扩展事件、MCP tool namespace、普通 shell/read_file 工具、SSE 重放、Server 重启和相同工具重复调用。断言 enabled snapshot 不能被展示为“实际调用”。

- [ ] **Step E5.2：冻结运行前快照**

创建 Execution 时保存 detected Provider、扩展 nativeId/version/sourceHash、脱敏 config hash、scope 来源和 trust 状态。Run 进行中 refresh registry 不改变该 Execution 快照。

- [ ] **Step E5.3：投影实际使用证据**

只有结构化 Provider extension event 或已验证 MCP tool namespace 才设置 `actuallyInvoked=true`。无法从 Provider 输出确认时仅保留 `enabled_snapshot`，UI 显示“运行时可用，未确认调用”。

- [ ] **Step E5.4：按 persisted sequence 幂等持久化**

以 `executionId/extensionId/evidence` 唯一，更新 firstSequence/lastSequence；SSE cursor 只负责传输重放，历史顺序和幂等依赖计划 B 的 SQLite `AgentEvent.sequence`。

- [ ] **Step E5.5：Run Details API/UI**

Run Details 增加“扩展”页签，分组显示已确认调用、运行时可用未确认调用、被阻止三类；每项展示 Provider、kind、版本、配置 hash 前 12 位、作用域和证据来源，不展示原始配置。

- [ ] **Step E5.6：验证**

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/ExtensionAuditService.test.ts src/routes/runs.test.ts src/store/SqliteStore.test.ts
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web test
pnpm.cmd -r run build
```

- [ ] **Step E5.7：提交**

```powershell
git add packages/shared/src/types/index.ts apps/server/src/store/SqliteStore.ts apps/server/src/store/SqliteStore.test.ts apps/server/src/services/ExtensionAuditService.ts apps/server/src/services/ExtensionAuditService.test.ts apps/server/src/services/ConversationService.ts apps/server/src/services/ConversationService.test.ts apps/server/src/services/RuntimeEventProjector.ts apps/server/src/routes/runs.ts apps/server/src/routes/runs.test.ts apps/web/src/components/runs/RunDetails.tsx
git commit -m "feat: audit extension usage per execution"
```

### Task E5 验收标准

- Run Details 能回答本次 Execution 可用和实际使用了哪些扩展、版本、scope 与脱敏 config hash。
- 已启用未调用不会误标为实际调用。
- SSE 重放和 Server 重启不产生重复 usage record，sequence 范围保持一致。
- registry 在 Run 中途变化不篡改既有 Execution 快照。

---

## Task E6：Extension Center UI、自动验收与文档收口

**Files:**

- Create: `apps/web/src/components/extensions/ExtensionCenter.tsx`
- Create: `apps/web/src/components/extensions/ExtensionCenter.test.tsx`
- Create: `apps/web/src/components/extensions/SkillList.tsx`
- Create: `apps/web/src/components/extensions/McpServerList.tsx`
- Create: `apps/web/src/components/extensions/PluginTrustDialog.tsx`
- Modify: `apps/web/src/components/layout/WorkspaceLayout.tsx`
- Modify: `apps/web/src/lib/useApi.ts`
- Create: `apps/web/e2e/extension-center.spec.ts`
- Create: `scripts/fixtures/extensions/fake-extension-provider.mjs`
- Create: `docs/acceptance/extension-center-final.md`
- Modify: `README.md`
- Modify: `docs/PROJECT_OVERVIEW.md`
- Modify: `docs/SECURITY.md`

- [ ] **Step E6.1：先写组件状态测试**

覆盖 loading/empty/error/unsupported/mismatch/untrusted/changed/blocked/available/disabled；断言 unsupported 控制不渲染按钮，敏感字段不在 DOM，长 nativeId 和来源标签不破坏布局。

- [ ] **Step E6.2：实现 Extension Center**

Workspace 侧栏增加“扩展中心”。顶部显示 Provider 与能力；主体用 Skills、MCP、Plugins 三个页签，支持 scope/status/trust 搜索筛选；refresh 显示上次成功时间和单 Provider 错误，不用全屏错误覆盖其他结果。

- [ ] **Step E6.3：实现风险确认交互**

Trust dialog 展示来源、版本、hash、风险标签和影响 scope。用户必须显式勾选“我确认信任此版本”，提交时携带 expectedSourceHash。Provider 无法细粒度隔离时明确说明将暂停整个 Run。

- [ ] **Step E6.4：实现 MCP 与 Skill 状态解释**

状态文案区分：已发现、CLI 已启用、AgentOS 已授权、运行中可用、本次已实际调用。environmentKeys 只展示名称；start/stop/enable/disable 只在 capability 允许时出现。

- [ ] **Step E6.5：Playwright 自动场景**

使用 fake provider 验证 refresh、scope override、unsupported 控制隐藏、hash 变化重新授权、MCP 脱敏、Run usage 审计和刷新后状态持久化。监听 console/pageerror/network 5xx，并保存桌面与窄屏截图。

```powershell
pnpm.cmd --filter @agentos/web exec playwright test e2e/extension-center.spec.ts
```

- [ ] **Step E6.6：真实 Provider 只读 Gate**

依次对本机可用的 Codex/KimiCode/OpenCode 执行 refresh，核对 UI 与 E0 矩阵；任何不可用 Provider 记录 BLOCKED，不用 fake provider 结果冒充真实通过。真实 Gate 不执行扩展安装、删除、启停或授权变更。

- [ ] **Step E6.7：全量验证与文档**

```powershell
pnpm.cmd --filter @agentos/agent-core test
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web test
pnpm.cmd -r run build
pnpm.cmd --filter @agentos/web exec playwright test e2e/extension-center.spec.ts
git diff --check
```

验收文档记录日期、分支、HEAD、Provider/CLI 版本、能力矩阵差异、自动测试结果、截图、真实 Gate 的 PASS/BLOCKED、已知不支持控制和安全边界。

- [ ] **Step E6.8：提交**

```powershell
git add apps/web/src/components/extensions apps/web/src/components/layout/WorkspaceLayout.tsx apps/web/src/lib/useApi.ts apps/web/e2e/extension-center.spec.ts scripts/fixtures/extensions/fake-extension-provider.mjs docs/acceptance/extension-center-final.md README.md docs/PROJECT_OVERVIEW.md docs/SECURITY.md
git commit -m "feat: deliver the AgentOS extension center"
```

### Task E6 最终验收标准

- 用户可在一个页面区分扩展的发现、启用、授权、可用和实际使用状态。
- Skills/Plugins/MCP 在 Provider 不支持控制时只读展示，不出现无效按钮。
- Workspace 第三方扩展默认不信任，hash 改变必须重新授权。
- UI、API、SQLite、AgentEvent 和验收产物不包含环境变量值、token 或绝对用户目录。
- Playwright 自动 Gate 无 console error、pageerror、network 5xx；桌面与窄屏截图可审阅。
- 每个真实 Provider 要么有只读 Gate 证据，要么明确 BLOCKED；fake provider 只用于自动化测试。

## 计划 E 停止点

本计划交付扩展发现、作用域、信任、MCP 状态、逐 Run 审计与管理 UI。扩展市场、远程安装、自动更新、跨机器同步、AgentOS 自有 Plugin Runtime、MCP 代理网关和第三方脚本 sandbox 不在本轮范围。
