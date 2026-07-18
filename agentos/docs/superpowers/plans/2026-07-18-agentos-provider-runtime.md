# AgentOS Provider Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 安全收口当前 Runtime 改动，分离配置 Provider 与实际命令身份，并让 Codex/Kimi/OpenCode 在真实能力允许时通过统一结构化事件协议运行。

**Architecture:** `WorkspaceAgent.provider` 表示用户配置身份，`ResolvedRuntime.detectedProvider` 表示真实命令探测结果，二者不再由可执行文件名静默绑定。每个 Adapter 自己负责 Provider probe、invocation 构造和 JSONL parser；`CLIExecutor` 只负责通用进程生命周期、超时、取消、stdout/stderr 和文件变化。

**Tech Stack:** TypeScript、Node.js >= 22.5、Vitest、Express、SQLite、PowerShell、pnpm workspace、Codex CLI、KimiCode CLI、OpenCode CLI。

**Base:** Task A0 记录的实施前 HEAD 与完整恢复包。

**Branch:** `codex/agentos-provider-runtime`。

## Global Constraints

- 实施任何代码/schema 变更前必须完成 Task A0 安全基线。
- 默认中文错误与诊断；fixture 和日志进入仓库前必须脱敏。
- Provider 工具事件只来自结构化输出；plain fallback 不猜测工具。
- 配置 Provider 与检测 Provider 不一致时必须公开 mismatch，不能静默改身份。
- Adapter probe 全部异步，单条命令最多 5 秒，不阻塞 Express 事件循环。
- OpenCode 命令不可用时保持 blocked，不创建伪 fixture，不用 Codex 结果冒充 OpenCode Gate。
- 当前未提交文件属于用户或前序任务；只提交明确列出的本任务文件。

---

## Task A0：实施前安全基线、备份和恢复点

**Files:**

- Create outside Git tracking: `.agentos/backups/provider-runtime-$baselineId/status.txt`
- Create outside Git tracking: `.agentos/backups/provider-runtime-$baselineId/tracked.patch`
- Create outside Git tracking: `.agentos/backups/provider-runtime-$baselineId/untracked-files.txt`
- Create outside Git tracking: `.agentos/backups/provider-runtime-$baselineId/untracked/`
- Create outside Git tracking: `.agentos/latest-provider-runtime-backup.txt`
- Create outside Git tracking: `.agentos/backups/provider-runtime-$baselineId/agentos.sqlite`
- Create outside Git tracking: `.agentos/backups/provider-runtime-$baselineId/workspace-state/`
- Create: `docs/acceptance/provider-runtime-baseline.md`

**Interfaces:** 无业务接口；本任务产出可验证恢复包和固定开发分支 `codex/agentos-provider-runtime`。

- [ ] **Step A0.1：确认当前仓库和目标路径**

```powershell
git rev-parse --show-toplevel
git branch --show-current
git status --short
Resolve-Path .
```

Expected: 仓库根目录为 `E:\workspace\Multi-Agent\agentos`；任何差异先记录，不执行 reset/checkout/clean。

- [ ] **Step A0.2：创建时间戳恢复目录**

```powershell
$baselineId = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path (Resolve-Path '.agentos') "backups\provider-runtime-$baselineId"
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $backupRoot 'untracked') | Out-Null
Set-Content -Encoding UTF8 -Path (Join-Path $backupRoot 'baseline-id.txt') -Value $baselineId
Set-Content -Encoding UTF8 -Path '.agentos/latest-provider-runtime-backup.txt' -Value $backupRoot
```

Expected: 新目录位于当前仓库明确的 `.agentos/backups/` 内，不覆盖既有备份。

- [ ] **Step A0.3：保存 tracked patch 与状态**

```powershell
$patchPath = Join-Path $backupRoot 'tracked.patch'
$statPath = Join-Path $backupRoot 'tracked-stat.txt'
$headPath = Join-Path $backupRoot 'head.txt'

git status --short | Set-Content -Encoding UTF8 (Join-Path $backupRoot 'status.txt')
git rev-parse HEAD | Set-Content -Encoding UTF8 $headPath
git diff HEAD --binary --output="$patchPath"
if ($LASTEXITCODE -ne 0) { throw 'failed to create tracked patch' }
git diff HEAD --stat --output="$statPath"
if ($LASTEXITCODE -ne 0) { throw 'failed to create tracked stat' }
if ((Get-Item -LiteralPath $patchPath).Length -gt 0) {
  git apply --check --reverse --binary $patchPath
  if ($LASTEXITCODE -ne 0) { throw 'tracked patch does not match the current working tree' }
}
```

Expected: `tracked.patch` 同时包含 staged 与 unstaged tracked 修改，且 Git 直接写文件，不经过 PowerShell 文本编码转换；`--reverse --check` 证明当前工作树包含该 patch。不得使用 `git stash` 隐藏当前改动。

- [ ] **Step A0.4：复制全部未跟踪文件并保留相对路径**

```powershell
$untracked = @(git ls-files --others --exclude-standard)
$untracked | Set-Content -Encoding UTF8 (Join-Path $backupRoot 'untracked-files.txt')
foreach ($relativePath in $untracked) {
  $sourcePath = Join-Path (Resolve-Path '.') $relativePath
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { continue }
  $targetPath = Join-Path (Join-Path $backupRoot 'untracked') $relativePath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
  Copy-Item -LiteralPath $sourcePath -Destination $targetPath
}
```

Expected: `untracked-files.txt` 中每个普通文件在 backup `untracked/` 下存在；目录和忽略文件不擅自纳入。

- [ ] **Step A0.5：停止 AgentOS 并确认没有仓库内 Node 写进程**

先在运行 AgentOS 的终端正常停止 Server/Web/CLI，再执行：

```powershell
$repoRoot = (Resolve-Path '.').Path
$agentOsNodeProcesses = @(
  Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like "*$repoRoot*" }
)
if ($agentOsNodeProcesses.Count -gt 0) {
  $agentOsNodeProcesses | Select-Object ProcessId, CommandLine | Format-Table -AutoSize
  throw 'AgentOS 相关 Node 进程仍在运行；停止后再备份。'
}
```

Expected: 仓库路径关联的 Node 进程为 0；不得在此步骤强制结束未知进程。

- [ ] **Step A0.6：使用 SQLite 一致性快照并校验完整性**

```powershell
$databasePath = Join-Path (Resolve-Path '.agentos') 'agentos.sqlite'
if (Test-Path -LiteralPath $databasePath) {
  $databaseBackup = Join-Path $backupRoot 'agentos.sqlite'
  $env:AGENTOS_BACKUP_SOURCE = $databasePath
  $env:AGENTOS_BACKUP_TARGET = $databaseBackup
  @'
import { DatabaseSync } from 'node:sqlite';
const source = process.env.AGENTOS_BACKUP_SOURCE;
const target = process.env.AGENTOS_BACKUP_TARGET;
if (!source || !target) throw new Error('backup paths are required');
const quote = value => value.replaceAll("'", "''");
const sourceDb = new DatabaseSync(source);
sourceDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
sourceDb.exec(`VACUUM INTO '${quote(target)}'`);
sourceDb.close();
const backupDb = new DatabaseSync(target);
const integrity = backupDb.prepare('PRAGMA integrity_check').all();
if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
  throw new Error(`integrity_check failed: ${JSON.stringify(integrity)}`);
}
const tables = ['agent_profiles', 'conversations', 'messages', 'agent_runs', 'executions', 'agent_events', 'runtime_artifacts'];
const counts = Object.fromEntries(tables.map(table => [table, backupDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
console.log(JSON.stringify({ integrity: 'ok', counts }, null, 2));
backupDb.close();
'@ | node --input-type=module | Set-Content -Encoding UTF8 (Join-Path $backupRoot 'database-verification.json')
  if ($LASTEXITCODE -ne 0) { throw 'SQLite consistent backup failed' }
  Get-FileHash -Algorithm SHA256 -LiteralPath $databasePath, $databaseBackup |
    Format-Table -AutoSize | Out-String | Set-Content -Encoding UTF8 (Join-Path $backupRoot 'database-hash.txt')
} else {
  Set-Content -Encoding UTF8 -Path (Join-Path $backupRoot 'database-hash.txt') -Value 'DATABASE_NOT_PRESENT'
  Set-Content -Encoding UTF8 -Path (Join-Path $backupRoot 'database-verification.json') -Value '{"integrity":"DATABASE_NOT_PRESENT","counts":{}}'
}
```

Expected: `VACUUM INTO` 生成单文件一致性快照，`integrity_check` 为 `ok`，七张核心表的行数可读取；原库与快照 hash 不要求相同，因为 VACUUM 会重排页面。

- [ ] **Step A0.7：备份 JSON Workspace/Task fallback 状态**

```powershell
$workspaceStateRoot = Join-Path $backupRoot 'workspace-state'
New-Item -ItemType Directory -Force -Path $workspaceStateRoot | Out-Null
$workspaceIndex = 'workspace/workspaces.json'
if (Test-Path -LiteralPath $workspaceIndex) {
  Copy-Item -LiteralPath $workspaceIndex -Destination (Join-Path $workspaceStateRoot 'workspaces.json')
}
$taskFiles = @(Get-ChildItem -LiteralPath 'workspace' -Recurse -Force -Filter 'tasks.json' -File -ErrorAction SilentlyContinue)
foreach ($taskFile in $taskFiles) {
  $relativePath = [System.IO.Path]::GetRelativePath((Resolve-Path 'workspace').Path, $taskFile.FullName)
  $targetPath = Join-Path (Join-Path $workspaceStateRoot 'tasks') $relativePath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
  Copy-Item -LiteralPath $taskFile.FullName -Destination $targetPath
}
$taskFiles.FullName | Set-Content -Encoding UTF8 (Join-Path $backupRoot 'task-files.txt')
```

Expected: Workspace index 与所有已存在 `tasks.json` 均有独立副本；不依赖 Git ignored/untracked 枚举发现它们。

- [ ] **Step A0.8：记录环境和 CLI 能力**

```powershell
node --version | Set-Content -Encoding UTF8 (Join-Path $backupRoot 'versions.txt')
pnpm.cmd --version | Add-Content -Encoding UTF8 (Join-Path $backupRoot 'versions.txt')
foreach ($name in @('codex', 'kimi', 'opencode')) {
  $command = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $command) {
    Add-Content -Encoding UTF8 (Join-Path $backupRoot 'versions.txt') "${name}=NOT_FOUND"
    continue
  }
  Add-Content -Encoding UTF8 (Join-Path $backupRoot 'versions.txt') "${name}_path=$($command.Source)"
  try { & $command.Source --version 2>&1 | Add-Content -Encoding UTF8 (Join-Path $backupRoot 'versions.txt') }
  catch { Add-Content -Encoding UTF8 (Join-Path $backupRoot 'versions.txt') "${name}_version_error=$($_.Exception.Message)" }
}
```

- [ ] **Step A0.9：记录测试基线**

```powershell
pnpm.cmd --filter @agentos/agent-core test *>&1 | Tee-Object (Join-Path $backupRoot 'agent-core-test.txt')
if ($LASTEXITCODE -ne 0) { throw 'agent-core baseline failed' }
pnpm.cmd --filter @agentos/server test *>&1 | Tee-Object (Join-Path $backupRoot 'server-test.txt')
if ($LASTEXITCODE -ne 0) { throw 'server baseline failed' }
pnpm.cmd --filter @agentos/web test *>&1 | Tee-Object (Join-Path $backupRoot 'web-test.txt')
if ($LASTEXITCODE -ne 0) { throw 'web baseline failed' }
pnpm.cmd -r run build *>&1 | Tee-Object (Join-Path $backupRoot 'build.txt')
if ($LASTEXITCODE -ne 0) { throw 'build baseline failed' }
```

- [ ] **Step A0.10：确认改动归属并创建专用分支**

在 `docs/acceptance/provider-runtime-baseline.md` 中逐文件标记：`Task A2`、用户已有改动、其他计划。确认目标分支不存在后创建：

```powershell
if (git branch --list 'codex/agentos-provider-runtime') {
  throw '分支 codex/agentos-provider-runtime 已存在；停止并先确认是否复用。'
}
git switch -c codex/agentos-provider-runtime
```

- [ ] **Step A0.11：写明恢复命令**

```powershell
$backupRoot = (Get-Content -Raw '.agentos/latest-provider-runtime-backup.txt').Trim()
$backupRoot = (Resolve-Path -LiteralPath $backupRoot).Path
$allowedRoot = (Resolve-Path -LiteralPath '.agentos/backups').Path
if (-not $backupRoot.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw '恢复目录越界，停止恢复。'
}

$patchPath = Join-Path $backupRoot 'tracked.patch'
$expectedHead = (Get-Content -Raw (Join-Path $backupRoot 'head.txt')).Trim()
$currentHead = (git rev-parse HEAD).Trim()
if ($currentHead -ne $expectedHead) { throw '当前 HEAD 与备份基准不一致，停止恢复。' }
if ((Get-Item -LiteralPath $patchPath).Length -gt 0) {
  git apply --check --binary $patchPath
  git apply --binary $patchPath
}

$untrackedRoot = Join-Path $backupRoot 'untracked'
foreach ($relativePath in Get-Content -Encoding UTF8 (Join-Path $backupRoot 'untracked-files.txt')) {
  if ([string]::IsNullOrWhiteSpace($relativePath)) { continue }
  $sourcePath = Join-Path $untrackedRoot $relativePath
  $targetPath = Join-Path (Resolve-Path '.') $relativePath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
  Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
}

$databaseBackup = Join-Path $backupRoot 'agentos.sqlite'
if (Test-Path -LiteralPath $databaseBackup) {
  foreach ($sidecar in @('.agentos/agentos.sqlite-wal', '.agentos/agentos.sqlite-shm')) {
    if (Test-Path -LiteralPath $sidecar) { Remove-Item -LiteralPath $sidecar -Force }
  }
  Copy-Item -LiteralPath $databaseBackup -Destination '.agentos/agentos.sqlite' -Force
}

$workspaceStateRoot = Join-Path $backupRoot 'workspace-state'
if (Test-Path -LiteralPath (Join-Path $workspaceStateRoot 'workspaces.json')) {
  Copy-Item -LiteralPath (Join-Path $workspaceStateRoot 'workspaces.json') -Destination 'workspace/workspaces.json' -Force
}
if (Test-Path -LiteralPath (Join-Path $workspaceStateRoot 'tasks')) {
  Copy-Item -Path (Join-Path $workspaceStateRoot 'tasks/*') -Destination 'workspace' -Recurse -Force
}
```

`provider-runtime-baseline.md` 必须写入 Step A0.2 生成的真实 `$backupRoot`，并注明备份与恢复前都要关闭 AgentOS Server。恢复是破坏性动作，执行前必须再次保存当时状态；只允许删除已验证的两个 SQLite sidecar 精确路径。

- [ ] **Step A0.12：只提交基线说明**

```powershell
git add docs/acceptance/provider-runtime-baseline.md
git commit -m "docs: record provider runtime baseline"
```

不得暂存任何用户已有业务改动；恢复包位于 ignored `.agentos/`，不进入 Git。

### Task A0 验收标准

- tracked patch、未跟踪文件副本、SQLite 备份、版本、测试日志全部存在。
- tracked patch 覆盖 staged 与 unstaged 修改，且保存真实基准 HEAD。
- 备份时仓库关联 Node 进程为 0；SQLite `integrity_check` 返回 `ok`，核心表计数可读取。
- Workspace index 与全部现有 Task fallback JSON 均有副本。
- 每个未跟踪普通文件都有对应备份。
- `provider-runtime-baseline.md` 无占位符，包含真实 backup path 和恢复命令。
- 已切换到 `codex/agentos-provider-runtime`；未执行 reset、clean 或覆盖性 checkout。
- 基线说明已单独提交，用户已有业务改动仍未被暂存。

---

## Task A1：Local API Security Foundation

**Files:**

- Modify: `apps/server/src/index.ts`
- Create: `apps/server/src/localApiSecurity.ts`
- Create: `apps/server/src/localApiSecurity.test.ts`
- Create: `apps/server/src/localApiSecurity.integration.test.ts`
- Modify: `start-dev.ps1`
- Modify: `README.md`

**Interfaces:**

```ts
export interface LocalApiSecurityConfig {
  host: string;
  allowedOrigins: string[];
  allowRemote: boolean;
}

export function resolveLocalApiSecurityConfig(env: NodeJS.ProcessEnv): LocalApiSecurityConfig;
export function createLocalCorsOptions(config: LocalApiSecurityConfig): CorsOptions;
export function createLocalWriteGuard(config: LocalApiSecurityConfig): RequestHandler;
```

默认配置：

```text
AGENTOS_SERVER_HOST=127.0.0.1
AGENTOS_WEB_ORIGINS=http://localhost:3001,http://127.0.0.1:3001
AGENTOS_ALLOW_REMOTE=false
```

- [ ] **Step A1.1：先写请求矩阵失败测试**

覆盖 allowed Origin、evil Origin、无 Origin + IPv4/IPv6 loopback、无 Origin + non-loopback、GET、HEAD、OPTIONS、POST、PATCH、PUT、DELETE。断言未知 Origin 不获得 CORS header，所有危险写方法在进入路由 handler 前被拒绝。

- [ ] **Step A1.2：限制监听地址与远程模式**

`app.listen(PORT, security.host)` 默认只监听 `127.0.0.1`。非 loopback host 只有 `AGENTOS_ALLOW_REMOTE=true` 时允许启动，否则启动失败并输出中文诊断；不得自动启用 Express `trust proxy`。

- [ ] **Step A1.3：安装全局 CORS/Origin 中间件**

中间件必须注册在所有 `/api` 路由之前：

```ts
const security = resolveLocalApiSecurityConfig(process.env);
app.use(cors(createLocalCorsOptions(security)));
app.use(createLocalWriteGuard(security));
```

- GET/HEAD/OPTIONS 可读，但 CORS 只向 allowlist Origin 返回 header。
- POST/PATCH/PUT/DELETE 要求 allowlist Origin；无 Origin 时仅允许直接 loopback remoteAddress。
- 拒绝 wildcard + credentials。
- middleware 按 HTTP method 统一保护未来新增路由，不能依赖每个危险 endpoint 自己记得加 guard。

- [ ] **Step A1.4：覆盖现有写接口回归**

至少验证 Workspace create/delete、Agent update、Conversation send、preference update：allowed Origin 可用，evil Origin 返回 403/code `origin_not_allowed`，本机 PowerShell/curl 无 Origin 仍可用。敏感响应不得包含环境变量值或绝对工作区路径。

- [ ] **Step A1.5：验证**

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/localApiSecurity.test.ts src/localApiSecurity.integration.test.ts src/routes/conversations.test.ts src/routes/preferences.test.ts
pnpm.cmd --filter @agentos/server test
pnpm.cmd -r run build
```

- [ ] **Step A1.6：提交**

```powershell
git add apps/server/src/index.ts apps/server/src/localApiSecurity.ts apps/server/src/localApiSecurity.test.ts apps/server/src/localApiSecurity.integration.test.ts start-dev.ps1 README.md
git commit -m "security: protect the local AgentOS API"
```

### Task A1 验收标准

- Server 默认只监听 `127.0.0.1`，remote bind 需要显式开关。
- 所有当前和未来 HTTP 写路由默认经过同一 Origin/loopback guard。
- evil Origin 无法触发 Workspace、Conversation、Agent 或 preference 写入。
- 本机无 Origin CLI 请求仍可在 loopback 使用。
- C4 decision、C6 approval、D2 worktree remove、D3 retention apply、E2 assignment、E3 MCP control 与 E4 trust 均把本任务列为前置 Gate，不再各自实现临时安全协议。

---

## Task A2：收口当前 Inspector 与 OpenCode usage 基线

**Files:**

- Modify: `packages/agent-core/src/opencodeUsage.ts`
- Test: `packages/agent-core/src/opencodeUsage.test.ts`
- Modify: `packages/agent-core/src/executor.ts`
- Test: `packages/agent-core/src/executor.test.ts`
- Modify: `apps/web/src/lib/executionInspector.ts`
- Test: `apps/web/src/lib/executionInspector.test.ts`
- Modify: `apps/web/src/components/chat/ExecutionInspector.tsx`
- Test: `apps/web/src/components/chat/ExecutionInspector.test.tsx`

**Interfaces:**

- `readOpenCodeUsageSnapshot(input): OpenCodeUsageSnapshot | undefined`
- `diffOpenCodeUsage(before, after): NormalizedCliEvent | undefined`
- Tokens 总值：`inputTokens + cachedInputTokens + outputTokens`
- usage 读取失败只降级为 unavailable，不改变 Run 终态。

- [ ] **Step A2.1：确认 Task A0 归属表包含全部文件**

```powershell
git status --short
git diff -- packages/agent-core/src/executor.ts apps/web/src/components/chat/ExecutionInspector.tsx
```

- [ ] **Step A2.2：补充数据库不可用失败测试**

```ts
it('keeps a successful OpenCode execution successful when usage storage is unavailable', async () => {
  const result = await executeFakeOpenCode({ databasePath: 'missing/opencode.db' });
  expect(result.log.exitCode).toBe(0);
  expect(result.events.some(event => event.type === 'usage')).toBe(false);
});
```

- [ ] **Step A2.3：运行局部与全量回归**

```powershell
pnpm.cmd --filter @agentos/agent-core exec vitest run src/opencodeUsage.test.ts src/executor.test.ts
pnpm.cmd --filter @agentos/web test
pnpm.cmd --filter @agentos/agent-core test
pnpm.cmd --filter @agentos/server test
pnpm.cmd -r run build
git diff --check
```

- [ ] **Step A2.4：仅提交归属为 A2 的文件**

```powershell
git add packages/agent-core/src/opencodeUsage.ts packages/agent-core/src/opencodeUsage.test.ts packages/agent-core/src/executor.ts packages/agent-core/src/executor.test.ts apps/web/src/lib/executionInspector.ts apps/web/src/lib/executionInspector.test.ts apps/web/src/components/chat/ExecutionInspector.tsx apps/web/src/components/chat/ExecutionInspector.test.tsx
git commit -m "feat: expose execution tools and provider usage"
```

### Task A2 验收标准

- Current Action、Tool History、Tokens、Duration、Files 均可渲染。
- OpenCode 数据库匹配时显示本次增量；数据库缺失/锁定时显示 unavailable。
- Codex usage 与既有工具事件不回归。
- 提交不包含 `ConversationService`、ChatPanel、globals.css 等非 A1 用户改动，除非 A0 归属表明确授权。

---

## Task A3：分离配置 Provider、检测 Provider 与命令路径

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/agent-core/src/adapters/types.ts`
- Modify: `packages/agent-core/src/adapters/registry.ts`
- Modify: `packages/agent-core/src/adapters/capabilityProbe.ts`
- Modify: `packages/agent-core/src/config.ts`
- Modify: `packages/agent-core/src/executor.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/managers/WorkspaceManager.ts`
- Modify: `apps/server/src/routes/conversations.ts`
- Modify: `apps/web/src/components/chat/AgentEditor.tsx`
- Modify: `packages/agent-core/src/adapters/types.test.ts`
- Modify: `packages/agent-core/src/adapters/registry.test.ts`
- Modify: `packages/agent-core/src/adapters/capabilityProbe.test.ts`
- Modify: `packages/agent-core/src/config.test.ts`
- Modify: `packages/agent-core/src/executor.test.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`
- Modify: `apps/server/src/routes/conversations.test.ts`
- Create: `apps/web/src/components/chat/AgentEditor.test.tsx`

**Interfaces:**

```ts
export type AgentProvider = 'codex' | 'kimi' | 'opencode' | 'mimo' | 'custom';

export interface WorkspaceAgent {
  id: string;
  name: string;
  provider: AgentProvider;
  enabled: boolean;
  cliCommand: string;
  cliArgs: string[];
  model?: string;
  thinkingEffort?: ThinkingEffort;
}

export interface ResolvedRuntime {
  configuredProvider: AgentProvider;
  detectedProvider?: AgentProvider;
  commandPath: string;
  version?: string;
  capabilities: AdapterCapabilities;
  mismatch: boolean;
}

export interface AdapterCapabilities {
  structuredOutput: boolean;
  jsonSchemaOutput: boolean;
  assistantDelta: boolean;
  toolEvents: boolean;
  usage: boolean;
  workspaceReadOnly: boolean;
  approvalEvents: boolean;
}

export interface ProviderProbeResult {
  status: 'AVAILABLE' | 'UNAVAILABLE';
  configuredProvider: AgentProvider;
  detectedProvider?: AgentProvider;
  version?: string;
  capabilities: AdapterCapabilities;
  reason?: string;
}

export interface ProviderInvocationInput {
  commandPath: string;
  baseArgs: readonly string[];
  prompt: string;
  workspaceRoot: string;
  workspaceWrite: boolean;
  imageArgs: readonly string[];
}

export interface ProviderInvocation {
  args: string[];
  promptTransport: 'argument' | 'stdin';
  env: NodeJS.ProcessEnv;
}

export interface AgentCliAdapter {
  readonly provider: AgentProvider;
  probe(commandPath: string): Promise<ProviderProbeResult>;
  buildInvocation(input: ProviderInvocationInput): ProviderInvocation;
  createParser(): CliEventParser;
}
```

- [ ] **Step A3.1：先写旧数据迁移失败测试**

```ts
test('migrates legacy agent role into provider without changing command', () => {
  const store = openLegacyStore({ agent_role: 'kimi', cli_command: 'custom-kimi.cmd' });
  const profile = store.listAgentProfiles('workspace-a')[0]!;
  assert.equal(profile.provider, 'kimi');
  assert.equal(profile.cliCommand, 'custom-kimi.cmd');
});
```

SQLite 新增 `provider TEXT`；旧 `agent_role` 只作为迁移来源保留，不再参与 runtime Adapter 选择。Workspace JSON loader 接受旧 `role`，保存时写 `provider`。

- [ ] **Step A3.2：删除重复 Probe 职责**

移除 `AgentCliAdapter.supportsStructuredOutput(helpText)` 和 Registry 的通用 Provider help 判断。保留一个通用异步命令执行 helper，但版本命令、help 子命令、结构化参数和只读能力判断由各 Adapter 的 `probe()` 决定。

- [ ] **Step A3.3：实现配置/检测 mismatch 测试**

```ts
it('reports configured OpenCode running Codex and selects the detected parser', async () => {
  const result = await registry.resolve({ configuredProvider: 'opencode', commandPath: 'wrapper.cmd' });
  expect(result.runtime.configuredProvider).toBe('opencode');
  expect(result.runtime.detectedProvider).toBe('codex');
  expect(result.runtime.mismatch).toBe(true);
  expect(result.adapter.provider).toBe('codex');
  expect(result.diagnostic?.code).toBe('provider.mismatch');
});
```

规则：

1. 配置 Provider 决定先调用哪个 Adapter probe。
2. probe 从真实 version/help schema 得到 detectedProvider。
3. 一致时使用配置 Adapter。
4. mismatch 且 detected Adapter 可用时，使用 detected parser 并发出 diagnostic。
5. mismatch 无可用 parser 时使用 plain，并发出 diagnostic。
6. 文件名只用于低置信度提示，不能覆盖 probe 结果。

- [ ] **Step A3.4：让 Executor 只消费 `ProviderInvocation`**

删除 Executor 中 Provider-specific JSON 参数装饰；保留通用 spawn、Windows wrapper、prompt 临时文件、超时、取消、stdout/stderr 和 workspace snapshot。

- [ ] **Step A3.5：Agent Editor 显示两个身份**

配置表单显示 `provider`、`cliCommand`；运行状态在 mismatch 时显示“配置：OpenCode；实际：Codex”。不允许用户把 collaboration role 写入 Provider 字段。

- [ ] **Step A3.6：验证**

```powershell
pnpm.cmd --filter @agentos/agent-core exec vitest run src/adapters/types.test.ts src/adapters/registry.test.ts src/adapters/capabilityProbe.test.ts src/config.test.ts src/executor.test.ts
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/store/SqliteStore.test.ts src/routes/conversations.test.ts
pnpm.cmd --filter @agentos/web exec vitest run src/components/chat/AgentEditor.test.tsx
pnpm.cmd --filter @agentos/agent-core test
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web test
pnpm.cmd -r run build
```

- [ ] **Step A3.7：提交**

```powershell
git add packages/shared/src/types/index.ts packages/agent-core/src/adapters/types.ts packages/agent-core/src/adapters/types.test.ts packages/agent-core/src/adapters/registry.ts packages/agent-core/src/adapters/registry.test.ts packages/agent-core/src/adapters/capabilityProbe.ts packages/agent-core/src/adapters/capabilityProbe.test.ts packages/agent-core/src/config.ts packages/agent-core/src/config.test.ts packages/agent-core/src/executor.ts packages/agent-core/src/executor.test.ts apps/server/src/store/SqliteStore.ts apps/server/src/store/SqliteStore.test.ts apps/server/src/managers/WorkspaceManager.ts apps/server/src/routes/conversations.ts apps/server/src/routes/conversations.test.ts apps/web/src/components/chat/AgentEditor.tsx apps/web/src/components/chat/AgentEditor.test.tsx
git commit -m "refactor: separate configured and detected providers"
```

### Task A3 验收标准

- 自定义 `.cmd`、绝对路径和代理脚本可按配置 Provider probe，不依赖 basename。
- mismatch 公开可见且持久化到 invocation observation。
- 旧 Workspace JSON/SQLite 可迁移，命令和模型不被重写。
- Adapter 只有 `probe/buildInvocation/createParser` 三类职责，没有重复 `supportsStructuredOutput`。
- CLIExecutor 不包含 Kimi/OpenCode JSON flag 特例。

---

## Task A4：KimiCode stream-json Adapter

**Files:**

- Create: `packages/agent-core/src/adapters/kimiAdapter.ts`
- Create: `packages/agent-core/src/adapters/kimiAdapter.test.ts`
- Create: `packages/agent-core/src/adapters/fixtures/kimi-0.23.5-basic.jsonl`
- Modify: `packages/agent-core/src/adapters/registry.ts`
- Modify: `packages/agent-core/src/executor.test.ts`
- Modify: `packages/agent-core/src/index.ts`
- Create: `docs/acceptance/kimi-runtime-final.md`

**Interfaces:**

- `KimiAdapter.provider === 'kimi'`
- probe 执行 `--version` 与 `--help`，要求 `--output-format` 包含 `stream-json`。
- buildInvocation 在 prompt mode 中设置 `--output-format stream-json`；已存在时替换，不重复。
- Kimi `step.end` usage 以 uuid 去重后累计，最后一条 usage 是 Execution 总量。

- [ ] **Step A4.1：采集脱敏 fixture**

在临时目录通过真实 Kimi `0.23.5` 运行只读任务，将原始输出保存在临时目录；清洗后使用 `apply_patch` 新增 fixture。fixture 不包含用户目录、session id、凭据、原始 prompt 或私有 reasoning。

- [ ] **Step A4.2：先写分块 Parser 测试**

覆盖半行 JSON、多行同 chunk、assistant delta、tool start/complete/failure、重复 uuid usage、未知事件和 malformed JSON。

- [ ] **Step A4.3：实现 Adapter**

复用 `JsonLineDecoder` 与 redaction；工具按原始 callId 配对；无法配对的完成事件转 diagnostic，不伪造 start。

- [ ] **Step A4.4：fake CLI 集成测试**

```powershell
pnpm.cmd --filter @agentos/agent-core exec vitest run src/adapters/kimiAdapter.test.ts src/adapters/registry.test.ts src/executor.test.ts
```

- [ ] **Step A4.5：真实 AgentOS Kimi Gate**

通过 Server/SSE 执行只读文件检查，确认 assistant、tool、usage、completed 可实时到达并在刷新后恢复。记录 Kimi path/version/model 和事件摘要。

- [ ] **Step A4.6：提交**

```powershell
git add packages/agent-core/src/adapters/kimiAdapter.ts packages/agent-core/src/adapters/kimiAdapter.test.ts packages/agent-core/src/adapters/fixtures/kimi-0.23.5-basic.jsonl packages/agent-core/src/adapters/registry.ts packages/agent-core/src/executor.test.ts packages/agent-core/src/index.ts docs/acceptance/kimi-runtime-final.md
git commit -m "feat: stream Kimi runtime events"
```

### Task A4 验收标准

- fixture parser 和真实 Kimi Gate 均通过。
- 工具 started/completed 按真实 callId 配对。
- usage 最终值等于唯一 step usage 合计，不重复累计。
- 刷新后 Run Details 能恢复 Kimi 工具和 usage。
- fixture 通过敏感字段扫描。

---

## Task A5：OpenCode 能力硬闸门与 Adapter

**Files:**

- Create only after gate: `packages/agent-core/src/adapters/openCodeAdapter.ts`
- Create only after gate: `packages/agent-core/src/adapters/openCodeAdapter.test.ts`
- Create only after gate: `packages/agent-core/src/adapters/fixtures/opencode-basic.jsonl`
- Modify after gate: `packages/agent-core/src/adapters/registry.ts`
- Modify after gate: `packages/agent-core/src/executor.test.ts`
- Create: `docs/acceptance/opencode-runtime-status.md`

**Interfaces:**

- Adapter provider 为 `opencode`，但只有真实 OpenCode probe 通过才注册。
- 结构化 usage 优先；无结构化 usage 时使用数据库 delta；二者不相加。

- [ ] **Step A5.1：执行真实能力 Gate**

```powershell
$command = Get-Command opencode -ErrorAction SilentlyContinue
if (-not $command) {
  Set-Content -Encoding UTF8 docs/acceptance/opencode-runtime-status.md 'OpenCode Runtime: BLOCKED - command not found'
  throw 'OpenCode CLI 未安装或未加入 PATH；停止 Adapter 实现。'
}
& $command.Source --version
& $command.Source run --help
```

自定义路径通过 Agent 配置传入，仍需执行实际 version/help probe。

- [ ] **Step A5.2：采集真实 fixture 并锁定版本**

只使用 help 中实际存在的 JSON 参数。测试常量 `OPEN_CODE_FIXTURE_VERSION` 必须等于真实 version；不得按文章或其他机器示例猜 schema。

- [ ] **Step A5.3：实现 Parser 与 invocation**

覆盖 assistant、tool start/complete/failure、usage（schema 提供时）、unknown、malformed 和权限等待事件。

- [ ] **Step A5.4：usage 来源去重测试**

```ts
it('prefers structured usage over database delta', async () => {
  const events = await runFakeOpenCode({ structuredUsage: 120, databaseDelta: 120 });
  expect(events.filter(event => event.type === 'usage')).toHaveLength(1);
  expect(events.find(event => event.type === 'usage')).toMatchObject({ outputTokens: 120 });
});
```

- [ ] **Step A5.5：真实 OpenCode 读/写 Gate**

经 AgentOS 执行一个工作区只读任务和一个受控写入任务，确认 tool、usage、file changes、Artifact、终态和刷新恢复。

- [ ] **Step A5.6：提交**

```powershell
git add packages/agent-core/src/adapters/openCodeAdapter.ts packages/agent-core/src/adapters/openCodeAdapter.test.ts packages/agent-core/src/adapters/fixtures/opencode-basic.jsonl packages/agent-core/src/adapters/registry.ts packages/agent-core/src/executor.test.ts docs/acceptance/opencode-runtime-status.md
git commit -m "feat: stream OpenCode runtime events"
```

### Task A5 验收标准

- 命令缺失时文档为 BLOCKED，且不存在伪 Adapter/fixture 提交。
- 真实 version/help/fixture/读写 Gate 全部存在后才标记完成。
- 配置 OpenCode 但实际执行 Codex 时显示 mismatch 并使用 Codex parser。
- structured usage 与 database delta 二选一。
- OpenCode 失败不降低 Codex/Kimi 已完成能力。

---

## Task A6：Provider Runtime 阶段验收

**Files:**

- Create: `scripts/verify-provider-runtime.ps1`
- Create: `docs/acceptance/provider-runtime-final.md`
- Modify: `README.md`
- Modify: `docs/AGENTOS_V2.md`

- [ ] **Step A6.1：自动化验证**

```powershell
pnpm.cmd --filter @agentos/agent-core test
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web test
pnpm.cmd -r run build
git diff --check
```

- [ ] **Step A6.2：验证迁移副本**

把 Task A0 的 SQLite 一致性快照、`workspace-state/workspaces.json` 与 Task JSON 按原相对路径复制到同一临时验收根目录，再用新 Store 打开。确认 Workspace、Task、Agent、Conversation、Run、Execution、AgentEvent、Artifact 数量不减少，legacy role 正确迁移为 provider；不得只复制 SQLite 后宣称 Workspace 数据迁移通过。

- [ ] **Step A6.3：记录 Provider 矩阵**

最终文档逐项记录 configuredProvider、detectedProvider、command path、version、structured/jsonSchema/tool/usage/workspaceReadOnly/approvalEvents 能力和真实 Gate 状态。

- [ ] **Step A6.4：提交**

```powershell
git add scripts/verify-provider-runtime.ps1 docs/acceptance/provider-runtime-final.md README.md docs/AGENTOS_V2.md
git commit -m "docs: close provider runtime acceptance"
```

### Task A6 验收标准

- 自动化测试、构建和迁移副本验证通过。
- Codex/Kimi 有真实 Gate；OpenCode 明确为 PASS 或 BLOCKED。
- Provider 矩阵能解释配置身份、实际身份、能力和 usage 来源。
- Task A0 恢复包仍可读，且最终文档记录当前 HEAD 与回滚边界。

## 计划 A 停止点

完成后停止实施，先由用户确认 Provider 列表、mismatch 文案、Kimi 工具轨迹和 OpenCode 状态。确认后再进入计划 B。
