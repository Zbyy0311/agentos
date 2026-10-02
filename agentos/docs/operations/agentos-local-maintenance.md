# AgentOS local readiness, backup, restore, and cleanup (Windows)

AgentOS uses `.agentos` below its data root for SQLite and runtime state. The Windows launcher and server both use `AGENTOS_PROJECT_ROOT` as the data root; `AGENTOS_DATA_ROOT` remains a fallback only when `AGENTOS_PROJECT_ROOT` is unset. `AGENTOS_SERVER_INSTANCE_ID` identifies a server instance and is generated when absent. Set `AGENTOS_BUILD_VERSION`, `AGENTOS_BUILD_COMMIT`, and `AGENTOS_BUILD_ID` in packaged deployments that do not retain Git metadata. In a Git checkout, the package version and `HEAD` commit provide defaults. A restore requires an exact match of version, commit, and build ID.

Run the CLI from an AgentOS checkout with its installed dependencies:

```powershell
pnpm --filter @agentos/server exec tsx src/commands/maintenance.ts readiness
pnpm --filter @agentos/server exec tsx src/commands/maintenance.ts diagnostics-export
pnpm --filter @agentos/server exec tsx src/commands/maintenance.ts storage
pnpm --filter @agentos/server exec tsx src/commands/maintenance.ts backup
```

`/api/health` is liveness only. The launcher-ready contract is `/api/readiness`; `/api/health/ready` calls the same handler. Both report SQLite integrity and foreign keys, migration checksums and pending migrations, recovery state, maintenance lease, and Provider authentication/version/capabilities separately. A Provider validation failure is visible as degraded Provider status and stable error codes; it does not hide database or migration state. The sanitized diagnostics export omits credentials, raw probe text, executable paths, data-root paths, and private configuration values.

`storage` reports filesystem capacity, SQLite size, backup totals, and aggregate AgentOS-managed file counts without printing file contents. Diagnostic logs rotate at 8 MiB per instance into four numbered files; the active log remains separate.

## Backup and verify

`backup` calls the local loopback server. The server fences new API writes and runtime dispatch, pauses background writers, waits for admitted writes and active executions to drain, then creates a SQLite online snapshot (or `VACUUM INTO` fallback). It hashes each payload and writes a manifest containing the package version, source commit/build ID, schema version, migration checksums, and referenced files. AgentOS durable state, app-owned configuration, task metadata, candidate/evidence files, referenced memory files, and conversation attachments are included. User project trees, worktree checkouts, diagnostic logs, derived caches, and migration backup copies are not copied. Treat the backup as private because it can contain local provider configuration and user memory/evidence.

Verify the entire bundle and build identity offline before restore:

```powershell
$backup = 'D:\AgentOS\backups\agentos-...'
pnpm --filter @agentos/server exec tsx src/commands/maintenance.ts verify-backup --backup $backup
```

The command must run from the exact matching build. It checks every payload hash and manifest path, SQLite integrity and foreign keys, registered migration checksums, and build identity. A different version, commit, or build ID is rejected.

## Restore and rollback

Restore is an offline CLI operation; stop the source server first. It verifies the whole backup before creating a sibling staging directory under a new target data root. Referenced workspace files are copied under `workspace-roots/<workspace-id>` inside that new root, and SQLite plus legacy workspace metadata are remapped there. Restore never creates or overwrites files in the original workspaces. It rechecks copied hashes, SQLite integrity, foreign keys, migrations, and workspace mappings before one directory rename installs the target. The old data root is not moved or replaced. Choose a new absolute target outside the backup and existing workspace roots.

```powershell
$sourceDataRoot = 'E:\AgentOS\data'
$backup = 'D:\AgentOS\backups\agentos-...'
$restoredDataRoot = 'D:\AgentOS\data-restored'
pnpm --filter @agentos/server exec tsx src/commands/maintenance.ts restore `
  --backup $backup `
  --source-data-root $sourceDataRoot `
  --target-data-root $restoredDataRoot

$env:AGENTOS_PROJECT_ROOT = $restoredDataRoot
$env:AGENTOS_SERVER_INSTANCE_ID = 'agentos-local-restored'
pnpm --filter @agentos/server run dev:stable
```

For an upgrade, first create and verify a backup with build A, stop A, then start build B against the original data root and check `/api/readiness`. Keep A and the backup available until B passes local acceptance. If rollback is needed, stop B and run the restore CLI from build A (the manifest-matching build) into a separate new data root; then start A with `AGENTOS_PROJECT_ROOT` set to that restored root. Do not ask build B to restore build A's backup, and do not point an older binary at a database already migrated by B. This restore does not reverse schema migrations; it installs the verified pre-upgrade database copy. Keep the original upgraded data root intact until rollback is accepted.

## Preview and apply cleanup

Preview and save the exact JSON before applying:

```powershell
$preview = Join-Path $PWD 'agentos-cleanup-preview.json'
pnpm --filter @agentos/server exec tsx src/commands/maintenance.ts cleanup-preview |
  Set-Content -Encoding utf8 $preview
pnpm --filter @agentos/server exec tsx src/commands/maintenance.ts cleanup-apply --preview-file $preview
```

Only regular files below `.agentos/cache`, `.agentos/caches`, and rotated-log filenames under `.agentos/logs` are eligible. The live instance log, `.agentos/tmp`, workspace data, candidates, evidence, recovery records, artifacts, and backups are protected. Each candidate carries a relative path, size, modification time, reason, and SHA-256; the preview version covers the complete candidate inventory. Apply enters the maintenance barrier, drains active work, and deletes only when the submitted preview still exactly matches the current inventory and hashes. A stale preview is rejected; directories are never recursively deleted.

The durable maintenance lease renews every 60 seconds and has a 15-minute maximum. An expired or interrupted lease remains fail-closed until startup recovery or `POST /api/maintenance/recover-expired` clears it after expiry.
