# AgentOS Isolation, Security, and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为并行写入提供 clean-base Worktree 隔离和完整恢复 Artifact，并补齐 usage 来源、容量策略、本地 API 高风险路由回归、Playwright 浏览器自动化、性能与发布验收。

**Architecture:** `parallel_isolated` 只从 clean HEAD 创建 execution 级 Worktree；每次 Execution 结束生成 tracked patch、untracked tar 和 manifest，全部可读且 hash 一致后才允许用户确认 force remove。计划 A1 已全局建立 loopback/CORS/Origin 防线，本计划对新增危险接口逐一做真实回归；最终 E2E 在隔离端口和临时数据库中运行。

**Tech Stack:** TypeScript、Express、SQLite、Git worktree、Node tar package、Playwright Test、Chrome、PowerShell、pnpm workspace。

**Base:** 用户已验收并在 `docs/acceptance/role-collaboration-final.md` 记录的计划 C Task C7 HEAD。

**Branch:** `codex/agentos-isolation-release`。

## Global Constraints

- 必须基于计划 C 已通过的串行路由、RunStep、RunDecision 与 RuntimePolicy。
- `parallel_isolated` 第一版要求主工作区 clean；不继承未提交修改。
- Worktree branch/path 必须包含 executionId，不能只用 runId + agentId。
- 清理前必须验证 tracked patch、untracked archive、manifest、sha256 和内容可读性。
- 不自动 merge、cherry-pick、解决冲突或删除自动创建 branch。
- Worktree 绝对路径只存在服务端 Store/日志，不进入公开 API/事件/UI。
- Runtime retention 默认不自动删除用户 Run/Artifact；清理必须先 preview，再显式 apply。
- Server 默认绑定 `127.0.0.1`，默认 CORS 仅允许本地 Web origin。
- 浏览器 Gate 使用 Playwright 自动执行；人工体验确认另行记录。

## Plan Start Gate

- [ ] 读取计划 C 最终验收记录并人工确认其中 HEAD 是本计划唯一基准。
- [ ] 执行 `git status --short`；非空则停止并先划清残留改动归属。
- [ ] 执行 `git rev-parse HEAD` 并写入 `docs/acceptance/isolation-release-baseline.md`。
- [ ] 确认分支不存在后执行 `git switch -c codex/agentos-isolation-release`。

验收：baseline 文档包含 base branch、base HEAD、Node/pnpm/Git 版本和全量测试结果；计划 A1 本地 API 安全矩阵仍通过。

---

## Task D1：Worktree clean gate、execution 级 lease 与重启恢复

**Files:**

- Create: `docs/acceptance/isolation-release-baseline.md`
- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/server/src/services/WorktreeManager.ts`
- Create: `apps/server/src/services/WorktreeManager.test.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/services/GroupOrchestrator.ts`
- Create: `apps/server/src/routes/worktrees.ts`
- Create: `apps/server/src/routes/worktrees.test.ts`
- Modify: `apps/server/src/index.ts`

**Interfaces:**

```ts
export type WorktreeLeaseStatus =
  | 'creating'
  | 'active'
  | 'completed'
  | 'cleanup_pending'
  | 'cleaned'
  | 'failed';

export interface WorktreeLease {
  id: string;
  workspaceId: string;
  runId: string;
  executionId: string;
  agentId: string;
  branchName: string;
  pathLabel: string;
  baseCommit: string;
  status: WorktreeLeaseStatus;
  createdAt: string;
  updatedAt: string;
}

interface WorktreeLeaseRecord extends WorktreeLease {
  absolutePath: string;
}
```

配置：

```text
AGENTOS_WORKTREE_MODE=off|isolated
AGENTOS_WORKTREE_ROOT=E:\AgentOSWorktrees
```

- [ ] **Step D1.1：先写 preflight 拒绝测试**

拒绝以下情况并返回明确 code：非 Git、bare、无 HEAD、`git status --porcelain=v1 -z` 非空、root 非绝对路径、root 位于 target workspace 内、目标路径已存在且非空、branch 已存在。

- [ ] **Step D1.2：实现 clean 检查**

```ts
const status = await git(workspaceRoot, ['status', '--porcelain=v1', '-z']);
if (status.length > 0) throw new WorktreeError('workspace_dirty', '主工作区存在未提交修改，不能启动隔离并行执行');
```

不生成 baseline patch，不静默从旧 HEAD 继续。

- [ ] **Step D1.3：实现无碰撞 branch/path**

```ts
function segment(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 8);
}

const branchName = `agentos/run-${segment(runId)}-exec-${segment(executionId)}`;
const absolutePath = join(worktreeRoot, segment(workspaceId), segment(runId), segment(executionId));
```

同一 Agent 在同一 Run 重试时 executionId 不同，因此 lease 不冲突。

- [ ] **Step D1.4：异步创建 worktree**

```ts
await git(workspaceRoot, ['rev-parse', '--show-toplevel']);
const baseCommit = (await git(workspaceRoot, ['rev-parse', 'HEAD'])).trim();
await git(workspaceRoot, ['worktree', 'add', '-b', branchName, absolutePath, baseCommit]);
```

全部使用 `execFile` 参数数组、10 秒超时、无 shell。

- [ ] **Step D1.5：接入 `parallel_isolated`**

leader plan 在主工作区只读执行；每个 write-capable worker 创建独立 lease，CLI cwd 指向 lease path；reviewer/leader summary 消费公开 summary 和 Artifact，不直接读取其他 worker 的未保存绝对路径。

- [ ] **Step D1.6：重启 reconcile**

启动时扫描 creating/active/cleanup_pending：

- 路径与 `.git` 均存在 -> active。
- 路径不存在 -> failed。
- cleanup_pending -> 重新验证 Artifact 后等待用户再次确认，不自动 force remove。

任何路径先 realpath 并确认位于 configured root。

- [ ] **Step D1.7：验证**

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/WorktreeManager.test.ts src/services/GroupOrchestrator.test.ts
pnpm.cmd --filter @agentos/server test
pnpm.cmd -r run build
```

- [ ] **Step D1.8：提交**

```powershell
git add docs/acceptance/isolation-release-baseline.md packages/shared/src/types/index.ts apps/server/src/services/WorktreeManager.ts apps/server/src/services/WorktreeManager.test.ts apps/server/src/store/SqliteStore.ts apps/server/src/services/GroupOrchestrator.ts apps/server/src/routes/worktrees.ts apps/server/src/routes/worktrees.test.ts apps/server/src/index.ts
git commit -m "feat: isolate executions in clean worktrees"
```

### Task D1 验收标准

- dirty workspace 返回 409/code `workspace_dirty`。
- 同 Agent 同 Run 两次 execution 创建不同 branch/path。
- 主工作区不被 isolated worker 修改。
- 重启后 lease 状态可恢复，不自动删除路径。
- API/UI 不包含 absolutePath。

---

## Task D2：tracked patch、untracked archive、manifest 与安全清理

**Entry Gate:** 计划 A1 全局写请求防线已通过；否则不得注册 Worktree DELETE。

**Files:**

- Modify: `apps/server/package.json`
- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/server/src/services/WorktreeArtifactService.ts`
- Create: `apps/server/src/services/WorktreeArtifactService.test.ts`
- Modify: `apps/server/src/services/RuntimeArtifactService.ts`
- Modify: `apps/server/src/services/RuntimeArtifactService.test.ts`
- Modify: `apps/server/src/services/WorktreeManager.ts`
- Modify: `apps/server/src/routes/worktrees.ts`
- Modify: `apps/web/src/components/runs/RunDetails.tsx`

**Dependencies:**

```json
{
  "tar": "^7.4.3"
}
```

**Interfaces:**

```ts
export type RuntimeArtifactType =
  | 'file'
  | 'diff'
  | 'report'
  | 'image'
  | 'log'
  | 'archive'
  | 'manifest';

export interface UntrackedManifestEntry {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface WorktreeRecoveryBundle {
  trackedPatchArtifactId: string;
  untrackedArchiveArtifactId: string;
  manifestArtifactId: string;
  entryCount: number;
}
```

- [ ] **Step D2.1：先写 untracked 丢失回归测试**

在临时 worktree 修改 tracked file 并新增文本/二进制文件。生成 bundle 后 force remove，再把 patch/archive 解到新 worktree，断言所有文件 bytes 与原 sha256 相同。

- [ ] **Step D2.2：生成 tracked patch**

```ts
const patch = await git(lease.absolutePath, ['diff', '--binary', lease.baseCommit]);
```

保存为 diff Artifact；空 diff 也创建内容可用的 0-byte patch，便于完整验收。

- [ ] **Step D2.3：生成 untracked manifest 与 tar**

用 `git ls-files --others --exclude-standard -z` 获取相对路径；拒绝绝对路径、`..`、symlink 逃逸。使用 Node `tar` package 只打包清单中的相对文件，生成 `untracked-files.tar`；manifest 记录 path/size/sha256 并按 path 排序。

- [ ] **Step D2.4：扩展 Artifact 限制**

- archive：最大 100 MiB，仅 attachment 下载，不 inline。
- manifest：最大 1 MiB，可文本预览。
- 每 Run 总 Artifact 仍最多 100；超过时 Worktree cleanup 不可用并要求人工处理。

- [ ] **Step D2.5：清理前完整验证**

```ts
export async function verifyRecoveryBundle(bundle: WorktreeRecoveryBundle): Promise<void> {
  // 三个 Artifact 均 contentAvailable=true、sha256 非空；
  // 从托管存储重新读取 bytes 并复算 sha256；
  // tar entries 与 manifest path/size/hash 完全一致。
}
```

任一失败则 lease -> cleanup_pending，拒绝 remove。

- [ ] **Step D2.6：显式确认后清理**

```http
DELETE /api/workspaces/:workspaceId/runs/:runId/worktrees/:leaseId
Content-Type: application/json

{"confirmRecoveryBundle":true}
```

仅 terminal Run、bundle 验证通过、用户明确确认后，才通过参数数组执行 `git(lease.workspaceRoot, ['worktree', 'remove', '--force', lease.absolutePath])`。自动 branch 保留；不执行 `git branch -D`。

- [ ] **Step D2.7：验证**

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/WorktreeArtifactService.test.ts src/services/RuntimeArtifactService.test.ts src/services/WorktreeManager.test.ts
pnpm.cmd --filter @agentos/server test
pnpm.cmd -r run build
```

- [ ] **Step D2.8：提交**

```powershell
git add apps/server/package.json pnpm-lock.yaml packages/shared/src/types/index.ts apps/server/src/services/WorktreeArtifactService.ts apps/server/src/services/WorktreeArtifactService.test.ts apps/server/src/services/RuntimeArtifactService.ts apps/server/src/services/RuntimeArtifactService.test.ts apps/server/src/services/WorktreeManager.ts apps/server/src/routes/worktrees.ts apps/web/src/components/runs/RunDetails.tsx
git commit -m "feat: preserve complete worktree recovery bundles"
```

### Task D2 验收标准

- tracked 修改、untracked 文本和二进制文件均可完整恢复。
- manifest/tar 不包含绝对路径、越界路径或 symlink 逃逸。
- 三个 Artifact 从托管存储重新读取并校验 sha256 后才可清理。
- bundle 不完整时即使用户请求 DELETE 也拒绝 force remove。
- branch 默认保留，Worktree 路径安全移除。

---

## Task D3：Usage 来源、事件容量与显式 retention

**Entry Gate:** 计划 A1 全局写请求防线已通过；否则不得注册 retention apply。

**Files:**

- Modify: `packages/agent-core/src/adapters/types.ts`
- Modify: `apps/server/src/services/RuntimeEventProjector.ts`
- Create: `apps/server/src/services/RuntimeEventBuffer.ts`
- Create: `apps/server/src/services/RuntimeEventBuffer.test.ts`
- Create: `apps/server/src/services/RuntimeStorageService.ts`
- Create: `apps/server/src/services/RuntimeStorageService.test.ts`
- Modify: `apps/server/src/services/RetentionService.ts`
- Modify: `apps/server/src/services/RetentionService.test.ts`
- Create: `apps/server/src/routes/storage.ts`
- Create: `apps/server/src/routes/storage.test.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/web/src/lib/executionInspector.ts`
- Modify: `apps/web/src/components/chat/ExecutionInspector.tsx`

**Interfaces:**

```ts
export interface UsageEvent {
  type: 'usage';
  source: 'structured' | 'database_delta' | 'unavailable';
  provider: AgentProvider;
  model?: string;
  estimated: boolean;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface RuntimeStoragePolicy {
  maxOutputEventsPerRun: 5000;
  maxDiagnosticEventsPerRun: 1000;
  maxToolPairsPerRun: 5000;
  maxArtifactsPerRun: 100;
  workspaceArtifactWarningBytes: 5368709120;
  automaticRunDeletion: false;
}
```

- [ ] **Step D3.1：先写 usage provenance 测试**

Codex/Kimi structured -> source structured；OpenCode DB -> database_delta；无数据 -> unavailable。estimated 当前始终 false；不得用字符数推算后标成真实 Token。

- [ ] **Step D3.2：实现 output coalescing**

相邻 `execution.output.appended` 在 250ms 或 4096 字符达到任一条件时 flush；结构事件不延迟。SSE conversation chunk 继续实时，coalescing 只减少持久化 AgentEvent 数量。

- [ ] **Step D3.3：实现 per-run quota**

达到 output/diagnostic/tool pair 上限后，停止持久化该类详细 payload，写入一条 `execution.diagnostic` 说明已汇总；run/step/terminal/approval/artifact 事件永远保留。

- [ ] **Step D3.4：Storage usage API**

```http
GET /api/workspaces/:workspaceId/storage
POST /api/workspaces/:workspaceId/retention/preview
POST /api/workspaces/:workspaceId/retention/apply
```

preview 返回将删除的 terminal runs/artifacts 和 bytes；apply 必须携带 preview 返回的短期 token 与相同 selection。默认不自动删除 Run/Artifact。apply 路由依赖计划 A1 的全局 Origin/loopback 中间件，不再实现临时 503 或 endpoint 私有安全协议。

- [ ] **Step D3.5：前端来源和容量展示**

Tokens 卡显示来源 tooltip：结构化、数据库增量、不可用；workspace 达 5 GiB 只警告，不自动清理。

- [ ] **Step D3.6：验证**

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/RuntimeEventBuffer.test.ts src/services/RuntimeStorageService.test.ts src/services/RetentionService.test.ts
pnpm.cmd --filter @agentos/agent-core test
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web test
```

- [ ] **Step D3.7：提交**

```powershell
git add packages/agent-core/src/adapters/types.ts apps/server/src/services/RuntimeEventProjector.ts apps/server/src/services/RuntimeEventBuffer.ts apps/server/src/services/RuntimeEventBuffer.test.ts apps/server/src/services/RuntimeStorageService.ts apps/server/src/services/RuntimeStorageService.test.ts apps/server/src/services/RetentionService.ts apps/server/src/services/RetentionService.test.ts apps/server/src/routes/storage.ts apps/server/src/routes/storage.test.ts apps/server/src/index.ts apps/web/src/lib/executionInspector.ts apps/web/src/components/chat/ExecutionInspector.tsx
git commit -m "feat: bound runtime storage and expose usage provenance"
```

### Task D3 验收标准

- 每条 usage 能解释 Provider、model、source 和 estimated。
- 长输出持久化事件显著减少，实时文字不受影响。
- 结构/终态事件不会因 quota 丢失。
- retention 默认不自动删除；service 层在 preview/apply selection 不一致时拒绝，HTTP apply 同时通过计划 A1 全局写请求防线。
- Workspace 容量达到警戒值只提示用户。

---

## Task D4：本地 API 高风险路由回归与远程模式收口

**Files:**

- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/localApiSecurity.ts`
- Modify: `apps/server/src/localApiSecurity.test.ts`
- Modify: `apps/server/src/routes/worktrees.test.ts`
- Modify: `apps/server/src/routes/storage.ts`
- Modify: `apps/server/src/routes/storage.test.ts`
- Modify: `apps/server/src/routes/approvals.test.ts`
- Modify: `apps/server/src/routes/conversations.test.ts`
- Modify: `start-dev.ps1`
- Modify: `README.md`

**Interfaces:**

```ts
export interface LocalApiSecurityConfig {
  host: string;
  allowedOrigins: string[];
  allowRemote: boolean;
}
```

默认：

```text
AGENTOS_SERVER_HOST=127.0.0.1
AGENTOS_WEB_ORIGINS=http://localhost:3001,http://127.0.0.1:3001
AGENTOS_ALLOW_REMOTE=false
```

- [ ] **Step D4.1：扩展高风险请求矩阵**

在计划 A1 的基础矩阵上加入：partial-write decision resolve、approval resolve/grant revoke、Worktree DELETE、retention apply。每个 endpoint 覆盖 allowed Origin、evil Origin、无 Origin + loopback、无 Origin + non-loopback 与重复提交。

- [ ] **Step D4.2：验证监听与代理边界**

确认默认 `app.listen(PORT, '127.0.0.1')`；非 loopback host 缺少 `AGENTOS_ALLOW_REMOTE=true` 时启动失败。服务不启用 `trust proxy`，不信任客户端伪造 `X-Forwarded-For` 绕过 remoteAddress 判断。

- [ ] **Step D4.3：回归 CORS allowlist**

确认未知 Origin 不返回 CORS header，禁止 wildcard + credentials；允许列表解析拒绝空项、非 http/https Origin 与包含路径的值。

- [ ] **Step D4.4：验证全局中间件覆盖未来路由**

注册一个测试用新增写路由，不添加 endpoint 私有 guard，证明计划 A1 的全局中间件仍自动保护它。Worktree DELETE 还必须校验 recovery bundle；retention apply 还必须校验 preview token；安全层通过不等于业务确认通过。

- [ ] **Step D4.5：敏感信息与路径测试**

API/AgentEvent/diagnostic 不返回 env value、token、absolute worktree path。Run Details 只返回 pathLabel 和相对 workspace path。

- [ ] **Step D4.6：验证**

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/localApiSecurity.test.ts src/routes/worktrees.test.ts src/routes/storage.test.ts src/routes/approvals.test.ts src/routes/conversations.test.ts
pnpm.cmd --filter @agentos/server test
pnpm.cmd -r run build
```

- [ ] **Step D4.7：提交**

```powershell
git add apps/server/src/index.ts apps/server/src/localApiSecurity.ts apps/server/src/localApiSecurity.test.ts apps/server/src/routes/worktrees.test.ts apps/server/src/routes/storage.ts apps/server/src/routes/storage.test.ts apps/server/src/routes/approvals.test.ts apps/server/src/routes/conversations.test.ts start-dev.ps1 README.md
git commit -m "test: harden dangerous local API routes"
```

### Task D4 验收标准

- 默认只监听 127.0.0.1。
- evil Origin 无法触发 decision、approval、Worktree 或 retention 写接口。
- 本机 PowerShell/curl 无 Origin 请求仍可在 loopback 使用。
- remote bind 需要显式开关和文档警告。
- 绝对路径和敏感 env value 不进入公开响应。
- 新增写路由无需私有 guard 也会被全局中间件保护，业务 token/confirm 校验仍独立生效。

---

## Task D5：Playwright 自动浏览器与性能 Gate

**Files:**

- Modify: `apps/web/package.json`
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/collaboration-workbench.spec.ts`
- Create: `scripts/start-collaboration-e2e.mjs`
- Create: `scripts/verify-collaboration-workbench-e2e.ps1`
- Create: `scripts/fixtures/collaboration-runtime/fake-agent.mjs`

**Dependencies:**

```json
{
  "@playwright/test": "^1.55.0"
}
```

- [ ] **Step D5.1：固定隔离环境**

E2E 使用 Server 3200、Web 3201、临时 project root、临时 SQLite、临时 workspace/worktree root、fake Providers。脚本负责启动、等待 health、执行、停止和清理，不复用 3000/3001 或用户 `.next`。

- [ ] **Step D5.2：Playwright 使用安装 Chrome**

配置 `channel: 'chrome'`；当前机器无 Playwright managed browser 时不下载 Chromium。CI 可显式安装 browser。截图输出 `.agentos/acceptance/collaboration-workbench/`。

- [ ] **Step D5.3：自动浏览器场景**

```text
创建 direct conversation
发送 fake streaming Run
等待任务树完成
断言工具、Tokens 来源、Files、最终结论
刷新并断言 sequence/steps 恢复
打开 Artifact 预览
创建 group、编辑 roleKind、@Agent、leader_route
触发 waiting_user 并恢复
触发 partial write decision
检查 console/pageerror/network 5xx
```

- [ ] **Step D5.4：三档截图**

分别以 1280x720、1440x900、1920x1080 运行核心页并保存截图；深浅色各至少一张。任何 console error、pageerror、hydration warning 使测试失败。

- [ ] **Step D5.5：性能 fixture**

注入 1000 AgentEvent、100 tool pair、500 messages、4 concurrent direct Runs 和一次 SSE 300-event replay。验收：

- Run Details API 本机小于 500ms。
- 页面 5 秒内出现可操作 Inspector。
- archive filter 操作小于 100ms。
- SSE replay 后无重复 step/tool。
- 浏览器 heap 不因 10 次 Conversation 切换持续线性增长。

- [ ] **Step D5.6：验证**

```powershell
pnpm.cmd install --frozen-lockfile=false
pnpm.cmd --filter @agentos/web exec playwright test
powershell -ExecutionPolicy Bypass -File scripts/verify-collaboration-workbench-e2e.ps1
```

- [ ] **Step D5.7：提交**

```powershell
git add apps/web/package.json pnpm-lock.yaml apps/web/playwright.config.ts apps/web/e2e/collaboration-workbench.spec.ts scripts/start-collaboration-e2e.mjs scripts/verify-collaboration-workbench-e2e.ps1 scripts/fixtures/collaboration-runtime/fake-agent.mjs
git commit -m "test: automate collaboration workbench acceptance"
```

### Task D5 验收标准

- 一键脚本实际调用 Playwright，不把人工清单冒充自动化。
- 三档分辨率截图、console/pageerror/network 结果自动保存。
- 长事件、长会话、并发 direct Run 和 SSE replay Gate 通过。
- E2E 结束后无孤儿 server/node/CLI、端口、临时目录或 active lease。

---

## Task D6：真实 CLI Gate 与发布收尾

**Files:**

- Create: `docs/acceptance/agentos-collaboration-workbench-final.md`
- Modify: `README.md`
- Modify: `docs/AGENTOS_V2.md`
- Modify: `docs/PROJECT_OVERVIEW.md`
- Modify: `docs/SECURITY.md`

- [ ] **Step D6.1：全量自动化**

```powershell
pnpm.cmd --filter @agentos/agent-core test
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web test
pnpm.cmd -r run build
powershell -ExecutionPolicy Bypass -File scripts/verify-collaboration-workbench-e2e.ps1
git diff --check
```

- [ ] **Step D6.2：真实 Provider Gate**

- Codex：工作区只读 + 受控写入。
- Kimi：真实 stream-json 只读与工具/usage。
- OpenCode：仅计划 A Gate 可用时执行；否则明确 BLOCKED。
- 每个 Gate 记录 configured/detected Provider、path、version、model、policy、usage source、files、Artifact 和终态。

- [ ] **Step D6.3：真实 Worktree Gate**

两个 Agent 在 clean 临时 repo 的独立 execution worktree 修改同名文件并新增未跟踪文件；验证主工作区不变、两个 recovery bundle 可还原、确认清理后 `git worktree list` 无目录残留。

- [ ] **Step D6.4：文档和回滚边界**

记录日期、分支、HEAD、Node/pnpm、CLI 版本、测试数量、Playwright 截图路径、性能结果、Blocked Gate、Task A0 恢复包、Worktree branch 保留策略和 retention 默认关闭。

- [ ] **Step D6.5：提交**

```powershell
git add docs/acceptance/agentos-collaboration-workbench-final.md README.md docs/AGENTOS_V2.md docs/PROJECT_OVERVIEW.md docs/SECURITY.md
git commit -m "docs: close AgentOS workbench release acceptance"
```

### Task D6 最终验收标准

- 测试、构建、Playwright、真实 CLI、Worktree、安全和性能 Gate 均有证据。
- OpenCode 只能是真实 PASS 或明确 BLOCKED。
- 浏览器 console error/hydration warning 为 0。
- 清理后无孤儿进程、端口、worktree 目录或 cleanup_pending lease。
- 文档准确说明工作区只读、usage 来源、容量与扩展边界。

## 计划 D 停止点

A-D 到此完成。自动 merge/cherry-pick、跨 Workspace Memory、云控制面仍不进入范围；Skills/Plugins/MCP 按独立计划 E 推进。
