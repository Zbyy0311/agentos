# AgentOS local readiness, backup, restore, and cleanup (Windows)

AgentOS uses `.agentos` below its data root for SQLite and runtime state. The Windows launcher and server both use `AGENTOS_PROJECT_ROOT` as the data root; `AGENTOS_DATA_ROOT` remains a fallback only when `AGENTOS_PROJECT_ROOT` is unset. `AGENTOS_SERVER_INSTANCE_ID` identifies a server instance and is generated when absent. Production builds carry a verified `dist/build-identity.json` stamp bound to the emitted JavaScript and package manifests. The compiled server and maintenance CLI use this frozen identity; startup environment and a newer checkout HEAD cannot replace it. Build-time version and commit overrides are supported when building without Git metadata. Missing or changed stamps reject backup/restore with an unavailable build identity. Source-mode development is explicitly unverified. A restore requires an exact match of version, commit, and build ID.

Run the CLI from an AgentOS checkout with its installed dependencies:

```powershell
node apps/server/dist/commands/maintenance.js readiness
node apps/server/dist/commands/maintenance.js diagnostics-export
node apps/server/dist/commands/maintenance.js storage
node apps/server/dist/commands/maintenance.js backup
```

`/api/health` is liveness only. The launcher-ready contract is `/api/readiness`; `/api/health/ready` calls the same handler. Both report SQLite integrity and foreign keys, migration checksums and pending migrations, recovery state, maintenance lease, and Provider authentication/version/capabilities separately. A Provider validation failure is visible as degraded Provider status and stable error codes; it does not hide database or migration state. The sanitized diagnostics export omits credentials, raw probe text, executable paths, data-root paths, and private configuration values.

`storage` reports filesystem capacity, SQLite size, backup totals, and aggregate AgentOS-managed file counts without printing file contents. Diagnostic logs rotate at 8 MiB per instance into four numbered files; the active log remains separate.

## Backup and verify

`backup` calls the local loopback server. The server fences new API writes and runtime dispatch, pauses background writers, waits for admitted writes and active executions to drain, then creates a SQLite online snapshot (or `VACUUM INTO` fallback). It hashes each payload and writes a manifest containing the package version, source commit/build ID, schema version, migration checksums, and referenced files. AgentOS durable state, app-owned configuration, task metadata, candidate/evidence files, referenced memory files, and conversation attachments are included. User project trees, worktree checkouts, diagnostic logs, derived caches, and migration backup copies are not copied. Treat the backup as private because it can contain local provider configuration and user memory/evidence.

Before publication, the SQLite snapshot, copied payloads, and manifest are explicitly synchronized through their file handles. A failed file sync rejects the backup with `BACKUP_SYNC_FAILED` and never returns success. The backup response reports `durability.fileContents: "synced"`. On Windows it also reports `durability.directoryEntries: "not-guaranteed"`: portable Node APIs do not provide a directory-entry persistence guarantee for the final rename, so an immediate power loss can still lose the published directory. On supported POSIX filesystems, the payload/staging directories and publication parent are synchronized; a directory sync failure also rejects success. Keep a verified second copy for power-loss protection, and verify the bundle after an abnormal shutdown. This response describes this backup operation, not older bundles.

If synchronization fails after the final directory rename on POSIX, the complete-looking bundle is retained and the operation still reports failure. Inspect `.agentos/backups` and run offline verification on that bundle before deciding whether to retry; a retained directory alone is not proof that publication was durable.

Verify the entire bundle and build identity offline before restore:

```powershell
$backup = 'D:\AgentOS\backups\agentos-...'
node apps/server/dist/commands/maintenance.js verify-backup --backup $backup
```

The command must run from the exact matching build. It checks every payload hash and manifest path, SQLite integrity and foreign keys, registered migration checksums, and build identity. A different version, commit, or build ID is rejected.

## Restore and rollback

Restore is an offline CLI operation; stop the source server first. It verifies the whole backup before creating a sibling staging directory under a new target data root. Referenced workspace files are copied under `workspace-roots/<workspace-id>` inside that new root, and SQLite plus legacy workspace metadata are remapped there. Restore never creates or overwrites files in the original workspaces. It rechecks copied hashes, SQLite integrity, foreign keys, migrations, and workspace mappings before one directory rename installs the target. The old data root is not moved or replaced. Choose a new absolute target outside the backup and existing workspace roots.

```powershell
$sourceDataRoot = 'E:\AgentOS\data'
$backup = 'D:\AgentOS\backups\agentos-...'
$restoredDataRoot = 'D:\AgentOS\data-restored'
node apps/server/dist/commands/maintenance.js restore `
  --backup $backup `
  --source-data-root $sourceDataRoot `
  --target-data-root $restoredDataRoot

$env:AGENTOS_PROJECT_ROOT = $restoredDataRoot
$env:AGENTOS_SERVER_INSTANCE_ID = 'agentos-local-restored'
pnpm --filter @agentos/server run start
```

For an upgrade, first create and verify a backup with build A, stop A, then start build B against the original data root and check `/api/readiness`. Keep A and the backup available until B passes local acceptance. If rollback is needed, stop B and run the restore CLI from build A (the manifest-matching build) into a separate new data root; then start A with `AGENTOS_PROJECT_ROOT` set to that restored root. Do not ask build B to restore build A's backup, and do not point an older binary at a database already migrated by B. This restore does not reverse schema migrations; it installs the verified pre-upgrade database copy. Keep the original upgraded data root intact until rollback is accepted.

## Preview and apply cleanup

Preview and save the exact JSON before applying:

```powershell
$preview = Join-Path $PWD 'agentos-cleanup-preview.json'
node apps/server/dist/commands/maintenance.js cleanup-preview |
  Set-Content -Encoding utf8 $preview
node apps/server/dist/commands/maintenance.js cleanup-apply --preview-file $preview
```

Only regular files below `.agentos/cache`, `.agentos/caches`, and rotated-log filenames under `.agentos/logs` are eligible. The live instance log, `.agentos/tmp`, `.agentos/cleanup-quarantine`, workspace data, candidates, evidence, recovery records, artifacts, and backups are protected. Each candidate includes its relative path, size, modification time, file identity (`device:inode`), reason, and SHA-256; the preview version binds the complete candidate inventory.

Apply enters the maintenance barrier, drains active work, and rechecks the exact submitted preview. It moves each selected file to `.agentos/cleanup-quarantine/<operation-id>/payload`, then verifies the file identity and SHA-256 there before unlinking it. If the file changed before quarantine, apply fails with `CLEANUP_PREVIEW_STALE`. When the quarantined payload must be restored, AgentOS uses a no-overwrite link so a replacement that appeared at the original path is not replaced. If safe restoration is impossible—for example, the original path is occupied or hard-link restoration is unsupported—apply returns `CLEANUP_QUARANTINE_RECOVERY_REQUIRED` and retains the payload in quarantine for operator recovery. Inspect that payload before retrying cleanup or removing it manually. This is a quarantine-then-verify protocol, not an OS-level atomic compare-and-delete. Directories are never recursively deleted.

The durable maintenance lease lasts 60 seconds, renews every 15 seconds, and has a 15-minute operation maximum. Startup refuses to open SQLite while a recovered lease is active, with `MAINTENANCE_IN_PROGRESS`; retry startup after the lease expires. The next startup records the expired lease before migration or Run recovery. A damaged or unreadable state blocks startup and remains preserved for inspection instead of being replaced by an invented expiry.
