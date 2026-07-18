# Provider Runtime 基线与恢复点

记录时间：2026-07-18 19:12（`baselineId=20260718-191210`）  
AgentOS 代码目录：`E:\workspace\Multi-Agent\agentos`  
Git 仓库根目录：`E:\workspace\Multi-Agent`  
实施前分支：`codex/agentos-current`  
实施前 HEAD：`b316a4dedbc511e6367d37f48308a0bd2c06bc83`  
实施分支：`codex/agentos-provider-runtime`

## 安全边界

- 当前工作树在备份前未执行 `reset`、`clean`、`stash` 或覆盖性 `checkout`。
- 备份与恢复前必须关闭 AgentOS Server/Web/CLI，并重新检查仓库内运行中的 Node 进程。
- Codex 桌面运行时的 `cua_node` 进程使用本目录作为工作目录，但不是 AgentOS Server/Web 写进程；A0 检查将它单独记录并保留，不强制结束。
- 备份目录位于 Git ignored 的 `.agentos/backups`，不进入提交。
- 只允许在恢复时删除以下两个精确 SQLite sidecar：
  `E:\workspace\Multi-Agent\agentos\.agentos\agentos.sqlite-wal` 和
  `E:\workspace\Multi-Agent\agentos\.agentos\agentos.sqlite-shm`。

## 备份包

恢复包根目录：
`E:\workspace\Multi-Agent\agentos\.agentos\backups\provider-runtime-20260718-191210`

索引文件：
`E:\workspace\Multi-Agent\agentos\.agentos\latest-provider-runtime-backup.txt`

已保存：

- `head.txt`、`status.txt`、`tracked-stat.txt`
- `tracked.patch`：通过 `git diff HEAD --binary --output` 保存，覆盖 staged 与 unstaged tracked 修改；保存后 `git apply --check --reverse --binary` 成功
- `untracked-files.txt` 与 `untracked/`：12 个未跟踪普通文件及其仓库相对路径副本
- `agentos.sqlite`：执行 `PRAGMA wal_checkpoint(TRUNCATE)` 后通过 `VACUUM INTO` 生成的一致性快照
- `database-verification.json`：`integrity_check=ok`；核心表计数为 `agent_profiles=6`、`conversations=8`、`messages=109`、`agent_runs=44`、`executions=68`、`agent_events=558`、`runtime_artifacts=6`
- `workspace-state/workspaces.json`
- `workspace-state/tasks/d7994c0c/.agentos/tasks.json`
- `workspace-state/tasks/e525c034/.agentos/tasks.json`
- `versions.txt`、`agent-core-test.txt`、`server-test.txt`、`web-test.txt`、`build.txt`

## 实施前改动归属

| 文件/范围 | 归属 | 处理 |
| --- | --- | --- |
| `apps/server/src/services/ConversationService.ts`、对应测试 | 前序用户业务改动 | 保留，不在 A0/A1/A2/A3/A4/A5/A6 提交中暂存 |
| `apps/web/src/app/globals.css`、`ChatPanel.tsx`、workspace 页面 | 前序用户 UI 改动 | 保留，不在本计划提交中暂存 |
| `apps/web/src/components/chat/ExecutionInspector.tsx`、`apps/web/src/lib/executionInspector.ts` 及测试 | A2 候选改动，需按 A2.1 再确认 | 只有 A2 验收后才可提交这些明确文件 |
| `packages/agent-core/src/executor.ts` 及测试 | A2 候选改动，需按 A2.1 再确认 | 只有 A2 验收后才可提交明确变更 |
| `packages/agent-core/src/opencodeUsage.ts` 及测试 | A2 候选改动 | 只有 A2 验收后才可提交 |
| `docs/PROJECT_OVERVIEW.md`、`docs/superpowers/plans/*.md` | 前序文档/计划 | 保留；A0 基线提交不暂存这些文件 |
| 其他未跟踪文件 | 备份副本已保存 | 未经任务文件列表授权不得提交 |

## 基线验证

- `@agentos/agent-core`：19 个测试文件、110 个测试通过。
- `@agentos/server`：138 个测试通过，0 失败。
- `@agentos/web`：74 个测试通过，0 失败。
- `pnpm.cmd -r run build`：shared、agent-core、web、server 构建通过。
- 环境：Node `v24.18.0`，pnpm `11.11.0`，Kimi `0.23.5`，OpenCode 未在 PATH；Codex 可执行文件存在但版本命令受 Windows 应用权限阻止，已记录在 `versions.txt`。

## 恢复步骤

恢复属于破坏性操作。执行前先停止 AgentOS，再创建一份新的当前状态备份；确认当前目录仍为 `E:\workspace\Multi-Agent\agentos`，并确认当前 HEAD 等于基线 HEAD。

```powershell
$repoRoot = 'E:\workspace\Multi-Agent'
$scopeRoot = 'E:\workspace\Multi-Agent\agentos'
$backupRoot = 'E:\workspace\Multi-Agent\agentos\.agentos\backups\provider-runtime-20260718-191210'
$allowedRoot = 'E:\workspace\Multi-Agent\agentos\.agentos\backups'

if (-not (Test-Path -LiteralPath $backupRoot)) { throw 'backup root is missing' }
if (-not ((Resolve-Path $backupRoot).Path.StartsWith((Resolve-Path $allowedRoot).Path, [System.StringComparison]::OrdinalIgnoreCase))) {
  throw 'backup root escaped .agentos/backups'
}
if ((git -C $repoRoot rev-parse HEAD).Trim() -ne 'b316a4dedbc511e6367d37f48308a0bd2c06bc83') {
  throw 'current HEAD does not match provider runtime baseline'
}

$patchPath = Join-Path $backupRoot 'tracked.patch'
if ((Get-Item -LiteralPath $patchPath).Length -gt 0) {
  git -C $repoRoot apply --check --binary $patchPath
  if ($LASTEXITCODE -ne 0) { throw 'tracked patch cannot be applied cleanly' }
  git -C $repoRoot apply --binary $patchPath
  if ($LASTEXITCODE -ne 0) { throw 'tracked patch apply failed' }
}

$untrackedRoot = Join-Path $backupRoot 'untracked'
foreach ($relativePath in Get-Content -Encoding UTF8 (Join-Path $backupRoot 'untracked-files.txt')) {
  if ([string]::IsNullOrWhiteSpace($relativePath)) { continue }
  $sourcePath = Join-Path $untrackedRoot $relativePath
  $targetPath = Join-Path $repoRoot $relativePath
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "missing untracked backup: $relativePath" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
  Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
}

$databaseBackup = Join-Path $backupRoot 'agentos.sqlite'
if (Test-Path -LiteralPath $databaseBackup) {
  foreach ($sidecar in @(
    'E:\workspace\Multi-Agent\agentos\.agentos\agentos.sqlite-wal',
    'E:\workspace\Multi-Agent\agentos\.agentos\agentos.sqlite-shm'
  )) {
    if (Test-Path -LiteralPath $sidecar) { Remove-Item -LiteralPath $sidecar -Force }
  }
  Copy-Item -LiteralPath $databaseBackup -Destination 'E:\workspace\Multi-Agent\agentos\.agentos\agentos.sqlite' -Force
}

Copy-Item -LiteralPath (Join-Path $backupRoot 'workspace-state\workspaces.json') -Destination 'E:\workspace\Multi-Agent\agentos\workspace\workspaces.json' -Force
foreach ($relativePath in Get-ChildItem -LiteralPath (Join-Path $backupRoot 'workspace-state\tasks') -Recurse -File) {
  $relativeTask = $relativePath.FullName.Substring((Join-Path $backupRoot 'workspace-state\tasks').Length).TrimStart('\')
  $targetPath = Join-Path 'E:\workspace\Multi-Agent\agentos\workspace' $relativeTask
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
  Copy-Item -LiteralPath $relativePath.FullName -Destination $targetPath -Force
}
```

恢复后重新运行计划 A 的 A0.9 基线测试，并在确认无误后再继续任何代码/schema 变更。
