import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { getAgentOsBuildIdentity } from './BuildIdentity.js';

const require = createRequire(import.meta.url);
type SqliteStatement = {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): unknown;
};
type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
};
type DatabaseSyncLike = {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
};
type SqliteBackup = (
  sourceDb: unknown,
  destination: string,
  options?: { rate?: number; progress?: (progress: { remainingPages: number; totalPages: number }) => void },
) => Promise<number>;
const sqlite = require('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
  backup?: SqliteBackup;
};

const BACKUP_FORMAT = 'agentos-maintenance-backup';
const BACKUP_FORMAT_VERSION = 2;
const BUILD_IDENTITY = getAgentOsBuildIdentity();
const RESERVED_AGENTOS_DIRS = new Set(['backups', 'migration-backups', 'logs', 'cache', 'caches', 'tmp', 'temp', 'worktrees']);
const CLEANUP_QUARANTINE_RELATIVE = '.agentos/cleanup-quarantine';
const MAX_WORKSPACE_ID_LENGTH = 160;
const ROTATED_LOG_PATTERN = /(?:\.log\.\d+(?:\.gz)?|\.log-\d{4}(?:-\d{2}){0,2}(?:\.gz)?)$/i;

export interface WorkspaceRoot {
  readonly id: string;
  readonly rootPath: string;
}

export interface BackupFileEntry {
  readonly scope: 'database' | 'data-root' | 'workspace-root';
  readonly workspaceId?: string;
  readonly targetPath: string;
  readonly payloadPath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface MaintenanceBackupManifest {
  readonly format: typeof BACKUP_FORMAT;
  readonly formatVersion: typeof BACKUP_FORMAT_VERSION;
  readonly createdAt: string;
  readonly buildVersion: string;
  readonly buildCommit: string;
  readonly buildId: string;
  readonly sourceDataRoot: string;
  readonly schemaVersion: string;
  readonly migrations: readonly { readonly id: string; readonly name: string; readonly checksum: string }[];
  readonly workspaceRoots: Readonly<Record<string, string>>;
  readonly files: readonly BackupFileEntry[];
}

export interface BackupResult {
  readonly backupDirectory: string;
  readonly manifest: MaintenanceBackupManifest;
}

export interface RestoreResult {
  readonly dataRoot: string;
  readonly schemaVersion: string;
  readonly restoredFiles: number;
  readonly restoredWorkspaceFiles: number;
}

export interface StorageDiagnostics {
  readonly checkedAt: string;
  readonly dataRoot: string;
  readonly filesystem: {
    readonly status: 'available' | 'unavailable';
    readonly blockSizeBytes?: number;
    readonly totalBytes?: number;
    readonly freeBytes?: number;
    readonly availableBytes?: number;
  };
  readonly database: { readonly present: boolean; readonly sizeBytes: number };
  readonly backups: { readonly count: number; readonly sizeBytes: number };
  readonly managedData: { readonly fileCount: number; readonly sizeBytes: number };
  readonly skippedSymlinks: number;
}

export interface BackupOptions {
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export interface CleanupCandidate {
  readonly id: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly modifiedAtMs: number;
  readonly fileIdentity: string;
  readonly sha256: string;
  readonly reason: string;
}

export interface CleanupPreview {
  readonly previewVersion: string;
  readonly generatedAt: string;
  readonly deletionsAvailable: true;
  readonly candidates: readonly CleanupCandidate[];
  readonly protected: readonly string[];
}

export interface CleanupApplyRequest {
  readonly previewVersion: string;
  readonly generatedAt: string;
  readonly candidates: readonly CleanupCandidate[];
}

export interface CleanupApplyResult {
  readonly previewVersion: string;
  readonly deletedCount: number;
  readonly deletedBytes: number;
  readonly deleted: readonly string[];
}

/** @internal Deterministic filesystem race seam for cleanup safety tests. */
interface MaintenanceServiceSeams {
  readonly beforeCleanupQuarantine?: (input: { readonly sourcePath: string }) => void | Promise<void>;
  readonly afterCleanupQuarantine?: (input: { readonly sourcePath: string; readonly quarantinedPath: string }) => void | Promise<void>;
}

export class MaintenanceServiceError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'MaintenanceServiceError';
  }
}

/** Creates and verifies portable snapshots of AgentOS-owned state. */
export class MaintenanceService {
  private readonly dataRoot: string;

  constructor(
    dataRoot: string,
    private readonly database: SqliteDatabase,
    private readonly workspaces: readonly WorkspaceRoot[],
    private readonly now: () => Date = () => new Date(),
    private readonly seams: MaintenanceServiceSeams = {},
  ) {
    this.dataRoot = resolve(dataRoot);
  }

  async createBackup(options: BackupOptions = {}): Promise<BackupResult> {
    if (BUILD_IDENTITY.source === 'unavailable' || BUILD_IDENTITY.commit === 'unknown') {
      throw new MaintenanceServiceError('BACKUP_BUILD_ID_UNAVAILABLE');
    }
    const now = options.now ?? this.now;
    const signal = options.signal;
    const backupRoot = join(this.dataRoot, '.agentos', 'backups');
    await mkdir(backupRoot, { recursive: true });
    await assertNoSymlinkComponents(backupRoot);
    if (!isPathInside(await realpath(this.dataRoot), await realpath(backupRoot))) throw new MaintenanceServiceError('BACKUP_TARGET_INVALID');
    const started = now();
    const stem = `agentos-${started.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const stage = join(backupRoot, `${stem}.tmp`);
    const finalPath = join(backupRoot, stem);
    await mkdir(join(stage, 'payload'), { recursive: true });

    try {
      throwIfAborted(signal);
      const databasePath = join(stage, 'payload', '000000.sqlite');
      await createSqliteSnapshot(this.database, databasePath, signal);
      const snapshotDb = openDatabase(databasePath);
      let migrations: Array<{ id: string; name: string; checksum: string }>;
      let workspaceRoots: Record<string, string>;
      let workspaceSnapshot: WorkspaceRoot[];
      let externalFiles: ReturnType<typeof listWorkspaceReferences>;
      try {
        migrations = readMigrationRows(snapshotDb);
        workspaceRoots = readWorkspaceRoots(snapshotDb, []);
        workspaceSnapshot = Object.entries(workspaceRoots).map(([id, rootPath]) => ({ id, rootPath }));
        externalFiles = listWorkspaceReferences(snapshotDb, workspaceSnapshot);
      } finally { snapshotDb.close(); }
      const schemaVersion = migrations.at(-1)?.id ?? '000';
      const files: BackupFileEntry[] = [await makeEntry('database', '.agentos/agentos.sqlite', 'payload/000000.sqlite', databasePath)];
      let index = 1;

      const dataFiles = await listManagedDataFiles(join(this.dataRoot, '.agentos'), '.agentos');
      dataFiles.push(...await listKnownWorkspaceMetadata(this.dataRoot, workspaceSnapshot));
      for (const source of uniqueByTarget(dataFiles, item => item.targetPath)) {
        throwIfAborted(signal);
        const payloadPath = `payload/${String(index).padStart(6, '0')}.bin`;
        const payloadAbsolute = join(stage, ...payloadPath.split('/'));
        await copyStable(source.absolutePath, payloadAbsolute, signal);
        files.push(await makeEntry('data-root', source.targetPath, payloadPath, payloadAbsolute));
        index += 1;
      }

      for (const source of externalFiles) {
        throwIfAborted(signal);
        const workspaceRoot = workspaceRoots[source.workspaceId];
        if (!workspaceRoot) throw new MaintenanceServiceError('BACKUP_WORKSPACE_ROOT_MISSING');
        await validateWorkspacePath(workspaceRoot, source.absolutePath);
        const payloadPath = `payload/${String(index).padStart(6, '0')}.bin`;
        const payloadAbsolute = join(stage, ...payloadPath.split('/'));
        await copyStable(source.absolutePath, payloadAbsolute, signal);
        files.push(await makeEntry('workspace-root', source.relativePath, payloadPath, payloadAbsolute, source.workspaceId));
        index += 1;
      }

      const manifest: MaintenanceBackupManifest = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        createdAt: started.toISOString(),
        buildVersion: BUILD_IDENTITY.version,
        buildCommit: BUILD_IDENTITY.commit,
        buildId: BUILD_IDENTITY.id,
        sourceDataRoot: this.dataRoot,
        schemaVersion,
        migrations,
        workspaceRoots,
        files,
      };
      await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
      throwIfAborted(signal);
      await MaintenanceService.readAndVerifyBackup(stage);
      await rename(stage, finalPath);
      return { backupDirectory: finalPath, manifest };
    } catch (error) {
      await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
      if (error instanceof MaintenanceServiceError) throw error;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') throw new MaintenanceServiceError('BACKUP_REFERENCED_FILE_MISSING');
      throw new MaintenanceServiceError('BACKUP_FAILED');
    }
  }

  static async readAndVerifyBackup(backupDirectory: string): Promise<MaintenanceBackupManifest> {
    const root = resolve(backupDirectory);
    const rootInfo = await lstat(root).catch(() => undefined);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new MaintenanceServiceError('BACKUP_DIRECTORY_INVALID');
    const manifestPath = join(root, 'manifest.json');
    let manifest: MaintenanceBackupManifest;
    try {
      const manifestInfo = await lstat(manifestPath);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('invalid manifest file');
      const text = await readFile(manifestPath, 'utf8');
      manifest = JSON.parse(text) as MaintenanceBackupManifest;
    } catch {
      throw new MaintenanceServiceError('BACKUP_MANIFEST_INVALID');
    }
    validateManifest(manifest);
    const seenPaths = new Set<string>();
    const seenPayloadPaths = new Set<string>();
    for (const entry of manifest.files) {
      validateEntry(entry, manifest);
      const targetScope = entry.scope === 'workspace-root' ? `workspace:${entry.workspaceId}` : 'data-root';
      const key = `${targetScope}:${entry.targetPath}`.toLocaleLowerCase('en-US');
      if (seenPaths.has(key)) throw new MaintenanceServiceError('BACKUP_PATH_DUPLICATE');
      seenPaths.add(key);
      const payloadKey = entry.payloadPath.toLocaleLowerCase('en-US');
      if (seenPayloadPaths.has(payloadKey)) throw new MaintenanceServiceError('BACKUP_PAYLOAD_DUPLICATE');
      seenPayloadPaths.add(payloadKey);
    }
    const databaseEntries = manifest.files.filter(item => item.scope === 'database');
    if (databaseEntries.length !== 1) throw new MaintenanceServiceError('BACKUP_DATABASE_MISSING');
    const databaseEntry = databaseEntries[0]!;
    const dbPath = resolveInside(root, databaseEntry.payloadPath);
    await verifyBackupPayload(root, databaseEntry);
    verifyDatabase(dbPath, manifest);
    for (const entry of manifest.files) {
      if (entry.scope === 'database') continue;
      await verifyBackupPayload(root, entry);
    }
    await verifyPayloadInventory(root, manifest);
    await verifyBackupRecoveryMaterials(root, manifest);
    return manifest;
  }

  static assertMatchingBuild(manifest: MaintenanceBackupManifest): void {
    if (BUILD_IDENTITY.source === 'unavailable' || BUILD_IDENTITY.commit === 'unknown'
      || BUILD_IDENTITY.id === 'unknown' || manifest.buildId === 'unknown') {
      throw new MaintenanceServiceError('RESTORE_BUILD_ID_UNAVAILABLE');
    }
    if (manifest.buildVersion !== BUILD_IDENTITY.version
      || manifest.buildCommit !== BUILD_IDENTITY.commit
      || manifest.buildId !== BUILD_IDENTITY.id) {
      throw new MaintenanceServiceError('RESTORE_BUILD_MISMATCH');
    }
  }

  static async restoreBackup(backupDirectory: string, targetDataRoot: string): Promise<RestoreResult> {
    const manifest = await MaintenanceService.readAndVerifyBackup(backupDirectory);
    const backupRoot = resolve(backupDirectory);
    const target = resolve(targetDataRoot);
    if (!isAbsolute(targetDataRoot) || samePath(target, manifest.sourceDataRoot)
      || isPathInside(backupRoot, target) || isPathInside(target, backupRoot)) {
      throw new MaintenanceServiceError('RESTORE_TARGET_INVALID');
    }
    for (const workspaceRoot of Object.values(manifest.workspaceRoots)) {
      if (isPathInside(resolve(workspaceRoot), target) || isPathInside(target, resolve(workspaceRoot))) {
        throw new MaintenanceServiceError('RESTORE_TARGET_INVALID');
      }
    }
    MaintenanceService.assertMatchingBuild(manifest);
    let targetStat;
    try { targetStat = await lstat(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new MaintenanceServiceError('RESTORE_TARGET_UNAVAILABLE');
    }
    if (targetStat) throw new MaintenanceServiceError('RESTORE_TARGET_MUST_BE_NEW');

    const parent = dirname(target);
    await assertNoSymlinkComponents(target);
    await mkdir(parent, { recursive: true });
    const staging = join(parent, `.${target.split(sep).at(-1) ?? 'agentos'}.restore-${randomUUID()}`);
    await mkdir(staging, { recursive: false });
    try {
      for (const entry of manifest.files) {
        if (entry.scope !== 'data-root') continue;
        const payload = resolveInside(backupRoot, entry.payloadPath);
        const destination = resolveInside(staging, entry.targetPath);
        await mkdir(dirname(destination), { recursive: true });
        await copyStable(payload, destination);
        const copied = await hashStable(destination);
        if (copied.sizeBytes !== entry.sizeBytes || copied.sha256 !== entry.sha256) throw new MaintenanceServiceError('RESTORE_COPY_VERIFY_FAILED');
      }
      const databaseEntry = manifest.files.find(item => item.scope === 'database')!;
      const stagedDatabase = resolveInside(staging, databaseEntry.targetPath);
      await mkdir(dirname(stagedDatabase), { recursive: true });
      await copyStable(resolveInside(backupRoot, databaseEntry.payloadPath), stagedDatabase);
      const databaseHash = await hashStable(stagedDatabase);
      if (databaseHash.sizeBytes !== databaseEntry.sizeBytes || databaseHash.sha256 !== databaseEntry.sha256) {
        throw new MaintenanceServiceError('RESTORE_COPY_VERIFY_FAILED');
      }
      verifyDatabase(stagedDatabase, manifest);

      const external = manifest.files.filter(item => item.scope === 'workspace-root');
      const restoredWorkspaceRoots = restoredWorkspaceRootMap(target, Object.keys(manifest.workspaceRoots));
      for (const workspaceRoot of Object.values(restoredWorkspaceRootMap(staging, Object.keys(manifest.workspaceRoots)))) {
        await mkdir(workspaceRoot, { recursive: true });
      }
      for (const entry of external) {
        const workspaceRoot = restoredWorkspaceRootMap(staging, Object.keys(manifest.workspaceRoots))[entry.workspaceId!];
        if (!workspaceRoot) throw new MaintenanceServiceError('BACKUP_WORKSPACE_ROOT_MISSING');
        const destination = resolveWorkspaceAsset(workspaceRoot, entry.targetPath);
        const payload = resolveInside(backupRoot, entry.payloadPath);
        await mkdir(dirname(destination), { recursive: true });
        await copyStable(payload, destination);
        const copied = await hashStable(destination);
        if (copied.sizeBytes !== entry.sizeBytes || copied.sha256 !== entry.sha256) {
          throw new MaintenanceServiceError('RESTORE_COPY_VERIFY_FAILED');
        }
      }

      updateRestoredWorkspaceRoots(stagedDatabase, restoredWorkspaceRoots);
      await rewriteLegacyWorkspaceRoots(staging, restoredWorkspaceRoots);
      await remapRestoredApplyJournals(stagedDatabase, staging, target, manifest, restoredWorkspaceRoots);
      verifyDatabase(stagedDatabase, manifest, restoredWorkspaceRoots, target);

      await rename(staging, target);
      return {
        dataRoot: target,
        schemaVersion: manifest.schemaVersion,
        restoredFiles: manifest.files.filter(item => item.scope !== 'workspace-root').length,
        restoredWorkspaceFiles: external.length,
      };
    } catch (error) {
      await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
      if (error instanceof MaintenanceServiceError) throw error;
      throw new MaintenanceServiceError('RESTORE_FAILED');
    }
  }

  async previewCleanup(instanceId?: string): Promise<CleanupPreview> {
    const base = join(this.dataRoot, '.agentos');
    const candidates: CleanupCandidate[] = [];
    const scanRoots = ['cache', 'caches'];
    for (const dir of scanRoots) {
      await appendPreviewFiles(join(base, dir), this.dataRoot, candidates, `derived-${dir}`);
    }
    const logsRoot = join(base, 'logs');
    const logs = await walkFiles(logsRoot, { ignoreSymlinks: true }).catch(() => []);
    const activeLog = instanceId ? `server-${instanceId}.log`.toLowerCase() : undefined;
    for (const file of logs) {
      const name = file.absolutePath.split(sep).at(-1)?.toLowerCase() ?? '';
      if (name === activeLog || !ROTATED_LOG_PATTERN.test(name)) continue;
      candidates.push(await previewRecord(file.absolutePath, this.dataRoot, 'rotated-log'));
    }
    candidates.sort((a, b) => a.path.localeCompare(b.path));
    const generatedAt = this.now().toISOString();
    const previewVersion = cleanupPreviewVersion(candidates);
    return {
      previewVersion,
      generatedAt,
      deletionsAvailable: true,
      candidates,
      protected: ['database', 'workspace metadata', 'memories', 'attachments', 'artifacts', 'candidates', 'evidence', 'recovery records', 'cleanup quarantine', 'worktrees', 'backups'],
    };
  }

  async applyCleanup(request: CleanupApplyRequest, instanceId?: string, signal?: AbortSignal): Promise<CleanupApplyResult> {
    if (!request || typeof request.previewVersion !== 'string' || !/^[a-f0-9]{64}$/u.test(request.previewVersion)
      || typeof request.generatedAt !== 'string' || !Number.isFinite(Date.parse(request.generatedAt))
      || !Array.isArray(request.candidates)) {
      throw new MaintenanceServiceError('CLEANUP_PREVIEW_INVALID');
    }
    const current = await this.previewCleanup(instanceId);
    if (request.previewVersion !== current.previewVersion || !sameCleanupCandidates(request.candidates, current.candidates)) {
      throw new MaintenanceServiceError('CLEANUP_PREVIEW_STALE');
    }

    const targets: Array<{ readonly candidate: CleanupCandidate; readonly absolutePath: string }> = [];
    for (const candidate of current.candidates) {
      throwIfAborted(signal);
      const absolutePath = resolveInside(this.dataRoot, candidate.path);
      if (!isCleanupPathAllowed(candidate)) throw new MaintenanceServiceError('CLEANUP_PATH_PROTECTED');
      await assertNoSymlinkComponents(absolutePath);
      const latest = await previewRecord(absolutePath, this.dataRoot, candidate.reason);
      if (!sameCleanupCandidate(candidate, latest)) throw new MaintenanceServiceError('CLEANUP_PREVIEW_STALE');
      targets.push({ candidate, absolutePath });
    }

    const deleted: string[] = [];
    let deletedBytes = 0;
    for (const { candidate, absolutePath } of targets) {
      throwIfAborted(signal);
      await quarantineAndDeleteCleanupFile(
        absolutePath,
        this.dataRoot,
        candidate,
        this.seams.beforeCleanupQuarantine,
        this.seams.afterCleanupQuarantine,
        signal,
      );
      deleted.push(candidate.path);
      deletedBytes += candidate.sizeBytes;
    }
    return { previewVersion: current.previewVersion, deletedCount: deleted.length, deletedBytes, deleted };
  }

  async inspectStorage(): Promise<StorageDiagnostics> {
    const filesystem = await statfs(this.dataRoot).then(info => ({
      status: 'available' as const,
      blockSizeBytes: info.bsize,
      totalBytes: finiteProduct(info.blocks, info.bsize),
      freeBytes: finiteProduct(info.bfree, info.bsize),
      availableBytes: finiteProduct(info.bavail, info.bsize),
    })).catch(() => ({ status: 'unavailable' as const }));
    const databasePath = join(this.dataRoot, '.agentos', 'agentos.sqlite');
    const databaseInfo = await lstat(databasePath).catch(() => undefined);
    const database = databaseInfo?.isFile() && !databaseInfo.isSymbolicLink()
      ? { present: true, sizeBytes: databaseInfo.size }
      : { present: false, sizeBytes: 0 };
    let backupsCount = 0;
    let backupsBytes = 0;
    let managedFileCount = 0;
    let managedBytes = 0;
    let skippedSymlinks = 0;
    const root = join(this.dataRoot, '.agentos');
    const rootInfo = await lstat(root).catch(() => undefined);
    if (rootInfo?.isDirectory() && !rootInfo.isSymbolicLink()) {
      const visit = async (directory: string, topLevel: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const absolutePath = join(directory, entry.name);
          const info = await lstat(absolutePath);
          if (info.isSymbolicLink()) {
            skippedSymlinks += 1;
            continue;
          }
          if (info.isDirectory()) {
            if (topLevel === 'backups' && directory === join(root, 'backups')
              && entry.name.toLowerCase().startsWith('agentos-') && !entry.name.toLowerCase().endsWith('.tmp')) backupsCount += 1;
            await visit(absolutePath, topLevel);
            continue;
          }
          if (!info.isFile() || absolutePath === databasePath) continue;
          managedFileCount += 1;
          managedBytes += info.size;
          if (topLevel === 'backups') backupsBytes += info.size;
        }
      };
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const absolutePath = join(root, entry.name);
        const info = await lstat(absolutePath);
        if (info.isSymbolicLink()) {
          skippedSymlinks += 1;
          continue;
        }
        if (info.isDirectory()) await visit(absolutePath, entry.name.toLowerCase());
        else if (info.isFile() && absolutePath !== databasePath) {
          managedFileCount += 1;
          managedBytes += info.size;
        }
      }
    } else if (rootInfo?.isSymbolicLink()) {
      skippedSymlinks += 1;
    }
    return {
      checkedAt: this.now().toISOString(),
      dataRoot: this.dataRoot,
      filesystem,
      database,
      backups: { count: backupsCount, sizeBytes: backupsBytes },
      managedData: { fileCount: managedFileCount, sizeBytes: managedBytes },
      skippedSymlinks,
    };
  }
}

async function remapRestoredApplyJournals(
  databasePath: string,
  stagingRoot: string,
  finalDataRoot: string,
  manifest: MaintenanceBackupManifest,
  workspaceRoots: Readonly<Record<string, string>>,
): Promise<void> {
  const db = openDatabase(databasePath);
  try {
    const rows = pendingApplyJournalRows(db);
    if (rows.length === 0) return;
    const updateJournal = db.prepare(`UPDATE collaboration_apply_journals SET state='recovery_required',recovery_path=?,images_json=?,updated_at=?
      WHERE control_id=? AND workspace_id=?`);
    const updateControl = db.prepare(`UPDATE collaboration_controls SET state='recovery_required',error_code='RESTORE_RECOVERY_REQUIRED',
      error_message='Restored apply material is preserved for explicit recovery; restore did not change target files.',
      recovery_reference=?,updated_at=? WHERE workspace_id=? AND id=? AND state IN ('reserved','running','recovery_required')`);
    for (const row of rows) {
      const targetRoot = workspaceRoots[row.workspace_id];
      if (!targetRoot) throw new MaintenanceServiceError('RESTORE_RECOVERY_CONTROL_INVALID');
      const targetPath = recoveryTargetPath(row.control_id);
      const stagedPath = resolveInside(stagingRoot, targetPath);
      let sourceText: string;
      try {
        sourceText = await readFile(stagedPath, 'utf8');
      } catch { throw new MaintenanceServiceError('RESTORE_RECOVERY_MATERIAL_INVALID'); }
      const { journal, paths } = validateRecoveryMaterial(row, sourceText, manifest);

      const recoveryPath = join(finalDataRoot, '.agentos', 'collaboration-apply-recovery', `${row.control_id}.json`);
      journal.targetRoot = targetRoot;
      journal.recoveryPath = recoveryPath;
      journal.state = 'recovery_required';
      const serialized = JSON.stringify(journal);
      await writeFile(stagedPath, serialized, { flag: 'w' });
      const recoveryHash = createHash('sha256').update(serialized).digest('hex');
      const now = new Date().toISOString();
      const journalUpdate = updateJournal.run(recoveryPath, JSON.stringify({ recoveryHash, paths }), now, row.control_id, row.workspace_id) as { changes?: number };
      const controlUpdate = updateControl.run(recoveryPath, now, row.workspace_id, row.control_id) as { changes?: number };
      if (journalUpdate.changes !== 1 || controlUpdate.changes !== 1) throw new MaintenanceServiceError('RESTORE_RECOVERY_CONTROL_INVALID');
    }
  } finally { db.close(); }
}

interface PendingApplyJournalRow {
  control_id: string;
  workspace_id: string;
  collaboration_task_id: string;
  candidate_id: string;
  candidate_hash: string;
  base_commit: string;
  state: string;
  recovery_path: string;
  images_json: string;
  control_state: string | null;
}

function pendingApplyJournalRows(db: DatabaseSyncLike): PendingApplyJournalRow[] {
  const hasTable = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (!hasTable('collaboration_apply_journals') || !hasTable('collaboration_controls')) return [];
  return db.prepare(`SELECT j.control_id,j.workspace_id,j.collaboration_task_id,j.candidate_id,j.candidate_hash,
    j.base_commit,j.state,j.recovery_path,j.images_json,c.state AS control_state
    FROM collaboration_apply_journals j
    LEFT JOIN collaboration_controls c ON c.workspace_id=j.workspace_id AND c.id=j.control_id
    WHERE j.state IN ('prepared','written','recovery_required')
      OR (j.state IN ('committed','recovered') AND c.state IN ('reserved','running','recovery_required'))
    ORDER BY j.created_at,j.control_id`).all() as PendingApplyJournalRow[];
}

function recoveryTargetPath(controlId: string): string {
  if (!isSafeControlId(controlId)) throw new MaintenanceServiceError('RESTORE_RECOVERY_CONTROL_INVALID');
  return `.agentos/collaboration-apply-recovery/${controlId}.json`;
}

function validateRecoveryMaterial(
  row: PendingApplyJournalRow,
  sourceText: string,
  manifest: MaintenanceBackupManifest,
): { journal: Record<string, unknown>; paths: Array<{ path: string; pre: string | null; post: string | null }> } {
  if (!isValidWorkspaceId(row.workspace_id) || row.control_state === null
    || !['reserved', 'running', 'recovery_required'].includes(row.control_state)) {
    throw new MaintenanceServiceError('RESTORE_RECOVERY_CONTROL_INVALID');
  }
  const sourceRecoveryPath = join(manifest.sourceDataRoot, recoveryTargetPath(row.control_id).replaceAll('/', sep));
  if (!samePath(row.recovery_path, sourceRecoveryPath)) throw new MaintenanceServiceError('RESTORE_RECOVERY_PATH_INVALID');
  const targetPath = recoveryTargetPath(row.control_id);
  if (!manifest.files.some(item => item.scope === 'data-root' && item.targetPath === targetPath)) {
    throw new MaintenanceServiceError('RESTORE_RECOVERY_MATERIAL_MISSING');
  }
  let summary: { recoveryHash?: unknown; paths?: unknown };
  let journal: Record<string, unknown>;
  try {
    summary = JSON.parse(row.images_json) as typeof summary;
    journal = JSON.parse(sourceText) as Record<string, unknown>;
  } catch { throw new MaintenanceServiceError('RESTORE_RECOVERY_MATERIAL_INVALID'); }
  if (!summary || summary.recoveryHash !== createHash('sha256').update(sourceText).digest('hex')
    || journal.controlId !== row.control_id || journal.workspaceId !== row.workspace_id
    || journal.taskId !== row.collaboration_task_id || journal.candidateId !== row.candidate_id
    || journal.candidateHash !== row.candidate_hash || journal.baseCommit !== row.base_commit
    || typeof journal.targetRoot !== 'string' || !samePath(journal.targetRoot, manifest.workspaceRoots[row.workspace_id] ?? '')
    || !Array.isArray(journal.images) || journal.images.length === 0) {
    throw new MaintenanceServiceError('RESTORE_RECOVERY_MATERIAL_INVALID');
  }
  const images = journal.images as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  for (const image of images) {
    if (typeof image.path !== 'string' || !isSafeRecoveryImagePath(image.path) || seen.has(image.path)) {
      throw new MaintenanceServiceError('RESTORE_RECOVERY_MATERIAL_INVALID');
    }
    seen.add(image.path);
    for (const side of ['pre', 'post'] as const) {
      const value = image[side];
      const mode = image[`${side}Mode`];
      if ((value !== null && (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value))
        || (value === null ? mode !== null : !Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o777)) {
        throw new MaintenanceServiceError('RESTORE_RECOVERY_MATERIAL_INVALID');
      }
    }
  }
  const paths = images.map(image => ({
    path: image.path as string,
    pre: recoveryImageDigest(image.pre as string | null),
    post: recoveryImageDigest(image.post as string | null),
  }));
  if (JSON.stringify(summary.paths) !== JSON.stringify(paths)) throw new MaintenanceServiceError('RESTORE_RECOVERY_MATERIAL_INVALID');
  return { journal, paths };
}

async function verifyBackupRecoveryMaterials(backupRoot: string, manifest: MaintenanceBackupManifest): Promise<void> {
  const databaseEntry = manifest.files.find(item => item.scope === 'database');
  if (!databaseEntry) throw new MaintenanceServiceError('BACKUP_DATABASE_MISSING');
  const db = openDatabase(resolveInside(backupRoot, databaseEntry.payloadPath));
  try {
    for (const row of pendingApplyJournalRows(db)) {
      const entry = manifest.files.find(item => item.scope === 'data-root' && item.targetPath === recoveryTargetPath(row.control_id));
      if (!entry) throw new MaintenanceServiceError('RESTORE_RECOVERY_MATERIAL_MISSING');
      let sourceText: string;
      try { sourceText = await readFile(resolveInside(backupRoot, entry.payloadPath), 'utf8'); }
      catch { throw new MaintenanceServiceError('RESTORE_RECOVERY_MATERIAL_INVALID'); }
      validateRecoveryMaterial(row, sourceText, manifest);
    }
  } finally { db.close(); }
}

function recoveryImageDigest(value: string | null): string | null {
  return value === null ? null : createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex');
}

function isSafeRecoveryImagePath(value: string): boolean {
  return value.length > 0 && !value.includes('\\') && !value.includes(':') && !isAbsolute(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..');
}

function isSafeControlId(value: string): boolean {
  return value.length > 0 && value.length <= 160 && /^[\w.-]+$/u.test(value) && value !== '.' && value !== '..';
}

export async function createSqliteSnapshot(database: SqliteDatabase, target: string, signal?: AbortSignal): Promise<void> {
  const existing = await inspectOptionalFile(target);
  if (existing) throw new MaintenanceServiceError('BACKUP_TARGET_EXISTS');
  if (typeof sqlite.backup === 'function') {
    await sqlite.backup(database, target, {
      rate: 128,
      progress: () => {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new MaintenanceServiceError('MAINTENANCE_ABORTED');
      },
    });
    return;
  }
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new MaintenanceServiceError('MAINTENANCE_ABORTED');
  const sqlPath = target.replaceAll("'", "''");
  database.exec(`VACUUM INTO '${sqlPath}'`);
}

function readMigrationRows(database: DatabaseSyncLike): Array<{ id: string; name: string; checksum: string }> {
  try {
    return database.prepare('SELECT migration_id AS id, name, checksum FROM _schema_migrations ORDER BY CAST(migration_id AS INTEGER)').all() as Array<{ id: string; name: string; checksum: string }>;
  } catch {
    throw new MaintenanceServiceError('BACKUP_MIGRATION_STATE_INVALID');
  }
}

function openDatabase(path: string): DatabaseSyncLike {
  try {
    return new sqlite.DatabaseSync(path);
  } catch {
    throw new MaintenanceServiceError('BACKUP_DATABASE_INVALID');
  }
}

function verifyDatabase(
  path: string,
  manifest: MaintenanceBackupManifest,
  expectedWorkspaceRoots: Readonly<Record<string, string>> = manifest.workspaceRoots,
  expectedDataRoot: string = manifest.sourceDataRoot,
): void {
  const db = openDatabase(path);
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new MaintenanceServiceError('BACKUP_SQLITE_INTEGRITY_FAILED');
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length > 0) throw new MaintenanceServiceError('BACKUP_FOREIGN_KEY_CHECK_FAILED');
    const applied = readMigrationRows(db);
    if (applied.length !== manifest.migrations.length || JSON.stringify(applied) !== JSON.stringify(manifest.migrations)) {
      throw new MaintenanceServiceError('BACKUP_MIGRATION_MANIFEST_MISMATCH');
    }
    const known = new Map(DEFAULT_REGISTRY_MIGRATIONS.map(item => [item.id, { name: item.name, checksum: item.checksum }]));
    for (const migration of applied) {
      const expected = known.get(migration.id);
      if (!expected || expected.name !== migration.name || expected.checksum !== migration.checksum) {
        throw new MaintenanceServiceError('BACKUP_MIGRATION_UNKNOWN_OR_MISMATCHED');
      }
    }
    const latest = applied.at(-1)?.id ?? '000';
    if (latest !== manifest.schemaVersion) throw new MaintenanceServiceError('BACKUP_SCHEMA_VERSION_MISMATCH');
    const workspaceRows = db.prepare('SELECT id, canonical_root_path FROM workspaces ORDER BY id')
      .all() as Array<{ id: string; canonical_root_path: string }>;
    const databaseRoots = Object.fromEntries(workspaceRows.map(row => [row.id, normalizeWorkspaceRoot(row.canonical_root_path)]));
    const manifestRoots = Object.fromEntries(Object.entries(expectedWorkspaceRoots).map(([id, root]) => [id, normalizeWorkspaceRoot(root)]));
    if (Object.keys(databaseRoots).length !== Object.keys(manifestRoots).length
      || Object.entries(databaseRoots).some(([id, root]) => manifestRoots[id] !== root)) {
      throw new MaintenanceServiceError('BACKUP_WORKSPACE_ROOT_MISMATCH');
    }
    verifyReferencedFileClosure(db, manifest, expectedWorkspaceRoots, expectedDataRoot);
  } catch (error) {
    if (error instanceof MaintenanceServiceError) throw error;
    throw new MaintenanceServiceError('BACKUP_DATABASE_INVALID');
  } finally {
    db.close();
  }
}

/**
 * The database snapshot is authoritative: every durable file path it names
 * must have exactly one corresponding entry in the portable bundle. This is
 * deliberately run before restore creates its staging directory.
 */
function verifyReferencedFileClosure(
  database: DatabaseSyncLike,
  manifest: MaintenanceBackupManifest,
  workspaceRoots: Readonly<Record<string, string>>,
  dataRoot: string,
): void {
  const roots = Object.entries(workspaceRoots).map(([id, rootPath]) => ({ id, rootPath }));
  const referencedWorkspaceFiles = listWorkspaceReferences(database as SqliteDatabase, roots);
  const expectedWorkspaceEntries = new Set(referencedWorkspaceFiles.map(item => workspaceReferenceKey(item.workspaceId, item.relativePath)));
  const actualWorkspaceEntries = manifest.files
    .filter(item => item.scope === 'workspace-root')
    .map(item => workspaceReferenceKey(item.workspaceId!, item.targetPath));
  if (new Set(actualWorkspaceEntries).size !== actualWorkspaceEntries.length
    || expectedWorkspaceEntries.size !== actualWorkspaceEntries.length
    || [...expectedWorkspaceEntries].some(key => !actualWorkspaceEntries.includes(key))) {
    throw new MaintenanceServiceError('BACKUP_REFERENCE_SET_MISMATCH');
  }

  const actualDataEntries = new Set(manifest.files
    .filter(item => item.scope === 'data-root')
    .map(item => item.targetPath.toLocaleLowerCase('en-US')));
  const requiredDataEntries = new Set<string>();
  const hasTable = (name: string) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const addArtifactStorageKeys = (table: string): void => {
    if (!hasTable(table)) return;
    const rows = database.prepare(`SELECT storage_key FROM "${table}" WHERE storage_key IS NOT NULL`).all() as Array<{ storage_key: string }>;
    for (const row of rows) {
      const key = safeStorageKey(row.storage_key);
      requiredDataEntries.add(`.agentos/artifacts/${key}`.toLocaleLowerCase('en-US'));
    }
  };
  addArtifactStorageKeys('runtime_artifacts');
  addArtifactStorageKeys('process_output_references');

  if (hasTable('collaboration_candidates')) {
    const rows = database.prepare(`SELECT workspace_id,canonical_run_id,diff_artifact_id,manifest_artifact_id,review_artifact_id
      FROM collaboration_candidates`).all() as Array<{
        workspace_id: string; canonical_run_id: string; diff_artifact_id: string | null;
        manifest_artifact_id: string | null; review_artifact_id: string | null;
      }>;
    for (const row of rows) {
      for (const artifactId of [row.diff_artifact_id, row.manifest_artifact_id, row.review_artifact_id]) {
        if (!artifactId) continue;
        const key = safeStorageKey(`${row.workspace_id}/${row.canonical_run_id}/${artifactId}/content`);
        requiredDataEntries.add(`.agentos/artifacts/${key}`.toLocaleLowerCase('en-US'));
      }
    }
  }
  if (hasTable('collaboration_reviews')) {
    const rows = database.prepare(`SELECT workspace_id,canonical_run_id,artifact_id
      FROM collaboration_reviews WHERE artifact_id IS NOT NULL`).all() as Array<{
        workspace_id: string; canonical_run_id: string; artifact_id: string;
      }>;
    for (const row of rows) {
      const key = safeStorageKey(`${row.workspace_id}/${row.canonical_run_id}/${row.artifact_id}/content`);
      requiredDataEntries.add(`.agentos/artifacts/${key}`.toLocaleLowerCase('en-US'));
    }
  }

  for (const row of pendingApplyJournalRows(database)) {
    const expectedPath = join(dataRoot, ...recoveryTargetPath(row.control_id).split('/'));
    if (!samePath(row.recovery_path, expectedPath)) throw new MaintenanceServiceError('RESTORE_RECOVERY_PATH_INVALID');
    requiredDataEntries.add(recoveryTargetPath(row.control_id).toLocaleLowerCase('en-US'));
  }
  for (const path of requiredDataEntries) {
    if (!actualDataEntries.has(path)) throw new MaintenanceServiceError('BACKUP_DATA_REFERENCE_MISSING');
  }
}

function workspaceReferenceKey(workspaceId: string, path: string): string {
  return `${workspaceId}:${path.replaceAll('\\', '/').toLocaleLowerCase('en-US')}`;
}

function safeStorageKey(value: string): string {
  try {
    validateRelativeManifestPath(value);
  } catch {
    throw new MaintenanceServiceError('BACKUP_REFERENCE_PATH_INVALID');
  }
  return value;
}

async function verifyBackupPayload(root: string, entry: BackupFileEntry): Promise<void> {
  const payload = resolveInside(root, entry.payloadPath);
  try {
    await assertNoSymlinkComponents(payload);
    const rootReal = await realpath(root);
    const payloadReal = await realpath(payload);
    if (!isPathInside(rootReal, payloadReal)) throw new MaintenanceServiceError('BACKUP_PATH_INVALID');
    const info = await lstat(payload);
    if (!info.isFile() || info.isSymbolicLink()) throw new MaintenanceServiceError('BACKUP_FILE_TYPE_UNSUPPORTED');
    const actual = await hashStable(payload);
    if (actual.sizeBytes !== entry.sizeBytes || actual.sha256 !== entry.sha256) {
      throw new MaintenanceServiceError('BACKUP_HASH_MISMATCH');
    }
  } catch (error) {
    if (error instanceof MaintenanceServiceError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MaintenanceServiceError('BACKUP_PAYLOAD_MISSING');
    throw new MaintenanceServiceError('BACKUP_PATH_INVALID');
  }
}

async function verifyPayloadInventory(root: string, manifest: MaintenanceBackupManifest): Promise<void> {
  const payloadRoot = join(root, 'payload');
  let info;
  try { info = await lstat(payloadRoot); }
  catch { throw new MaintenanceServiceError('BACKUP_PAYLOAD_INVENTORY_MISMATCH'); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new MaintenanceServiceError('BACKUP_PAYLOAD_INVENTORY_MISMATCH');
  const expected = new Set(manifest.files.map(item => item.payloadPath.toLocaleLowerCase('en-US')));
  const actual = new Set<string>();
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, child.name);
      const relativePath = [relativeDirectory, child.name].filter(Boolean).join('/');
      const childInfo = await lstat(absolute);
      if (childInfo.isSymbolicLink()) throw new MaintenanceServiceError('BACKUP_SYMLINK_UNSUPPORTED');
      if (childInfo.isDirectory()) await walk(absolute, relativePath);
      else if (childInfo.isFile()) actual.add(relativePath.toLocaleLowerCase('en-US'));
      else throw new MaintenanceServiceError('BACKUP_FILE_TYPE_UNSUPPORTED');
    }
  };
  await walk(payloadRoot, 'payload');
  if (actual.size !== expected.size || [...expected].some(path => !actual.has(path))) {
    throw new MaintenanceServiceError('BACKUP_PAYLOAD_INVENTORY_MISMATCH');
  }
}

function validateManifest(manifest: MaintenanceBackupManifest): void {
  if (!manifest || manifest.format !== BACKUP_FORMAT || manifest.formatVersion !== BACKUP_FORMAT_VERSION
    || typeof manifest.buildVersion !== 'string' || typeof manifest.buildCommit !== 'string'
    || typeof manifest.buildId !== 'string' || typeof manifest.sourceDataRoot !== 'string'
    || !isAbsolute(manifest.sourceDataRoot) || typeof manifest.createdAt !== 'string'
    || typeof manifest.schemaVersion !== 'string' || !Array.isArray(manifest.migrations)
    || !manifest.workspaceRoots || typeof manifest.workspaceRoots !== 'object'
    || !Array.isArray(manifest.files) || manifest.files.length < 1) {
    throw new MaintenanceServiceError('BACKUP_MANIFEST_INVALID');
  }
  for (const [id, root] of Object.entries(manifest.workspaceRoots)) {
    if (!isValidWorkspaceId(id) || typeof root !== 'string' || !isAbsolute(root)) throw new MaintenanceServiceError('BACKUP_MANIFEST_INVALID');
  }
  if (!isBuildLabel(manifest.buildVersion) || !isBuildLabel(manifest.buildId)
    || (manifest.buildCommit !== 'unknown' && !/^[a-f0-9]{7,64}$/u.test(manifest.buildCommit))) {
    throw new MaintenanceServiceError('BACKUP_MANIFEST_INVALID');
  }
  if (!manifest.migrations.every(item => item && /^\d{3}$/.test(item.id)
    && typeof item.name === 'string' && typeof item.checksum === 'string')) {
    throw new MaintenanceServiceError('BACKUP_MANIFEST_INVALID');
  }
}

function validateEntry(entry: BackupFileEntry, manifest: MaintenanceBackupManifest): void {
  if (!entry || !['database', 'data-root', 'workspace-root'].includes(entry.scope)
    || typeof entry.targetPath !== 'string' || typeof entry.payloadPath !== 'string'
    || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0
    || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new MaintenanceServiceError('BACKUP_MANIFEST_INVALID');
  validateRelativeManifestPath(entry.targetPath);
  if (!/^payload\/\d{6}\.sqlite$|^payload\/\d{6}\.bin$/.test(entry.payloadPath)) throw new MaintenanceServiceError('BACKUP_PATH_INVALID');
  if (entry.scope === 'database' && entry.targetPath !== '.agentos/agentos.sqlite') throw new MaintenanceServiceError('BACKUP_PATH_INVALID');
  if (entry.scope === 'data-root' && (!entry.targetPath.startsWith('.agentos/') && !entry.targetPath.startsWith('workspace/'))) {
    throw new MaintenanceServiceError('BACKUP_PATH_INVALID');
  }
  if (entry.scope === 'workspace-root') {
    if (!entry.workspaceId || !manifest.workspaceRoots[entry.workspaceId]) throw new MaintenanceServiceError('BACKUP_WORKSPACE_ROOT_MISSING');
    const normalized = entry.targetPath.replaceAll('\\', '/');
    if (!normalized.startsWith('.agentos/attachments/') && !normalized.startsWith('agent-memory/records/')) {
      throw new MaintenanceServiceError('BACKUP_PATH_INVALID');
    }
  } else if (entry.workspaceId !== undefined) {
    throw new MaintenanceServiceError('BACKUP_MANIFEST_INVALID');
  }
}

function validateRelativeManifestPath(value: string): void {
  if (!value || value.includes('\\') || value.includes(':') || isAbsolute(value)) throw new MaintenanceServiceError('BACKUP_PATH_INVALID');
  const components = value.split('/');
  if (components.some(part => !part || part === '.' || part === '..')) throw new MaintenanceServiceError('BACKUP_PATH_INVALID');
}

function resolveInside(root: string, path: string): string {
  validateRelativeManifestPath(path);
  const base = resolve(root);
  const target = resolve(base, ...path.split('/'));
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new MaintenanceServiceError('BACKUP_PATH_INVALID');
  return target;
}

function resolveWorkspaceAsset(workspaceRoot: string, relativePath: string): string {
  validateRelativeManifestPath(relativePath);
  const root = resolve(workspaceRoot);
  const target = resolve(root, ...relativePath.split('/'));
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new MaintenanceServiceError('BACKUP_PATH_INVALID');
  return target;
}

function isPathInside(parent: string, target: string): boolean {
  const rel = relative(parent, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function samePath(left: string, right: string): boolean {
  const normalizePath = (value: string) => resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US');
  return normalizePath(left) === normalizePath(right);
}

function isValidWorkspaceId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_WORKSPACE_ID_LENGTH && /^[\w.-]+$/u.test(value) && value !== '.' && value !== '..';
}

async function listManagedDataFiles(agentosRoot: string, prefix: string): Promise<Array<{ absolutePath: string; targetPath: string }>> {
  const files: Array<{ absolutePath: string; targetPath: string }> = [];
  const rootInfo = await lstat(agentosRoot).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (rootInfo?.isSymbolicLink()) throw new MaintenanceServiceError('BACKUP_SYMLINK_UNSUPPORTED');
  if (rootInfo && !rootInfo.isDirectory()) throw new MaintenanceServiceError('BACKUP_FILE_TYPE_UNSUPPORTED');
  const root = await realpath(agentosRoot).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!root) return files;
  const walk = async (directory: string, relativeDir: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (relativeDir === '' && RESERVED_AGENTOS_DIRS.has(entry.name.toLowerCase())) continue;
      if (relativeDir === '' && (['agentos.sqlite', 'agentos.sqlite-wal', 'agentos.sqlite-shm', 'maintenance-state.json'].includes(entry.name.toLowerCase())
        || entry.name.toLowerCase().startsWith('maintenance-state.json.'))) continue;
      const absolutePath = join(directory, entry.name);
      const targetPath = `${prefix}/${[relativeDir, entry.name].filter(Boolean).join('/')}`;
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) throw new MaintenanceServiceError('BACKUP_SYMLINK_UNSUPPORTED');
      if (info.isDirectory()) await walk(absolutePath, [relativeDir, entry.name].filter(Boolean).join('/'));
      else if (info.isFile()) files.push({ absolutePath, targetPath });
      else throw new MaintenanceServiceError('BACKUP_FILE_TYPE_UNSUPPORTED');
    }
  };
  await walk(root, '');
  return files;
}

async function listKnownWorkspaceMetadata(dataRoot: string, workspaces: readonly WorkspaceRoot[]): Promise<Array<{ absolutePath: string; targetPath: string }>> {
  const candidates = [{ absolutePath: join(dataRoot, 'workspace', 'workspaces.json'), targetPath: 'workspace/workspaces.json' }];
  for (const workspace of workspaces) {
    if (!isValidWorkspaceId(workspace.id)) throw new MaintenanceServiceError('BACKUP_WORKSPACE_ID_INVALID');
    candidates.push({
      absolutePath: join(dataRoot, 'workspace', workspace.id, '.agentos', 'tasks.json'),
      targetPath: `workspace/${workspace.id}/.agentos/tasks.json`,
    });
  }
  const present: Array<{ absolutePath: string; targetPath: string }> = [];
  for (const item of candidates) {
    const info = await inspectOptionalFile(item.absolutePath);
    if (info) present.push(item);
  }
  return present;
}

function listWorkspaceReferences(database: SqliteDatabase, workspaces: readonly WorkspaceRoot[]): Array<{
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly workspaceId: string;
}> {
  const roots = new Map(workspaces.map(item => [item.id, resolve(item.rootPath)]));
  const references = new Map<string, { absolutePath: string; relativePath: string; workspaceId: string }>();
  const hasTable = (name: string) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const add = (workspaceId: string, storedPath: string, expectedPrefix: string): void => {
    const root = roots.get(workspaceId);
    if (!root) throw new MaintenanceServiceError('BACKUP_WORKSPACE_ROOT_MISSING');
    const normalized = storedPath.replaceAll('\\', '/');
    if (!normalized.startsWith(expectedPrefix)) throw new MaintenanceServiceError('BACKUP_PATH_INVALID');
    const absolutePath = resolveWorkspaceAsset(root, normalized);
    const key = `${workspaceId}:${normalized.toLowerCase()}`;
    references.set(key, { absolutePath, relativePath: normalized, workspaceId });
  };
  if (hasTable('memories')) {
    const rows = database.prepare('SELECT workspace_id, content_path FROM memories').all() as Array<{ workspace_id: string; content_path: string }>;
    for (const row of rows) add(row.workspace_id, row.content_path, 'agent-memory/records/');
  }
  for (const table of ['message_attachments', 'cr_message_attachments']) {
    if (!hasTable(table)) continue;
    const rows = database.prepare(`SELECT workspace_id, relative_path FROM "${table}"`).all() as Array<{ workspace_id: string; relative_path: string }>;
    for (const row of rows) add(row.workspace_id, row.relative_path, '.agentos/attachments/');
  }
  return [...references.values()].sort((a, b) => `${a.workspaceId}/${a.relativePath}`.localeCompare(`${b.workspaceId}/${b.relativePath}`));
}

function readWorkspaceRoots(database: SqliteDatabase, workspaces: readonly WorkspaceRoot[]): Record<string, string> {
  try {
    const rows = database.prepare('SELECT id, canonical_root_path FROM workspaces').all() as Array<{ id: string; canonical_root_path: string }>;
    const roots = new Map(rows.map(row => [row.id, normalizeWorkspaceRoot(row.canonical_root_path)]));
    for (const workspace of workspaces) {
      if (!roots.has(workspace.id)) roots.set(workspace.id, normalizeWorkspaceRoot(workspace.rootPath));
    }
    return Object.fromEntries([...roots.entries()].sort(([left], [right]) => left.localeCompare(right)));
  } catch {
    return Object.fromEntries(workspaces.map(item => [item.id, normalizeWorkspaceRoot(item.rootPath)]).sort(([left], [right]) => left.localeCompare(right)));
  }
}

function restoredWorkspaceRootMap(dataRoot: string, workspaceIds: readonly string[]): Record<string, string> {
  return Object.fromEntries(workspaceIds.map(id => {
    if (!isValidWorkspaceId(id)) throw new MaintenanceServiceError('BACKUP_WORKSPACE_ID_INVALID');
    return [id, resolve(dataRoot, 'workspace-roots', id)];
  }));
}

function updateRestoredWorkspaceRoots(databasePath: string, roots: Readonly<Record<string, string>>): void {
  const db = openDatabase(databasePath);
  try {
    const update = db.prepare('UPDATE workspaces SET root_path = ?, canonical_root_path = ? WHERE id = ?');
    for (const [id, root] of Object.entries(roots)) update.run(root, root, id);
  } catch {
    throw new MaintenanceServiceError('RESTORE_WORKSPACE_MAPPING_FAILED');
  } finally {
    db.close();
  }
}

async function rewriteLegacyWorkspaceRoots(dataRoot: string, roots: Readonly<Record<string, string>>): Promise<void> {
  const path = join(dataRoot, 'workspace', 'workspaces.json');
  let source: string;
  try { source = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new MaintenanceServiceError('RESTORE_WORKSPACE_METADATA_INVALID');
  }
  try {
    const document = JSON.parse(source) as { workspaces?: unknown };
    if (!Array.isArray(document.workspaces)) throw new Error('invalid workspace array');
    for (const workspace of document.workspaces) {
      if (!workspace || typeof workspace !== 'object') continue;
      const record = workspace as { id?: unknown; rootPath?: unknown; canonicalRootPath?: unknown };
      const hasRootReference = typeof record.rootPath === 'string' || typeof record.canonicalRootPath === 'string';
      if (typeof record.id !== 'string') {
        if (hasRootReference) throw new MaintenanceServiceError('RESTORE_WORKSPACE_MAPPING_FAILED');
        continue;
      }
      const root = roots[record.id];
      if (!root) {
        if (hasRootReference) throw new MaintenanceServiceError('RESTORE_WORKSPACE_MAPPING_FAILED');
        continue;
      }
      if (typeof record.rootPath === 'string') record.rootPath = root;
      if (typeof record.canonicalRootPath === 'string') record.canonicalRootPath = root;
    }
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { flag: 'w' });
  } catch (error) {
    if (error instanceof MaintenanceServiceError) throw error;
    throw new MaintenanceServiceError('RESTORE_WORKSPACE_METADATA_INVALID');
  }
}

function normalizeWorkspaceRoot(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function uniqueByTarget<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = keyOf(item).toLocaleLowerCase('en-US');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function makeEntry(
  scope: BackupFileEntry['scope'],
  targetPath: string,
  payloadPath: string,
  filePath: string,
  workspaceId?: string,
): Promise<BackupFileEntry> {
  const hash = await hashStable(filePath);
  return {
    scope,
    ...(workspaceId ? { workspaceId } : {}),
    targetPath,
    payloadPath,
    sizeBytes: hash.sizeBytes,
    sha256: hash.sha256,
  };
}

async function copyStable(sourcePath: string, targetPath: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const info = await lstat(sourcePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new MaintenanceServiceError('BACKUP_FILE_TYPE_UNSUPPORTED');
  const input = await open(sourcePath, 'r');
  try {
    const before = await input.stat();
    const bytes = await input.readFile();
    const after = await input.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new MaintenanceServiceError('BACKUP_SOURCE_CHANGED');
    }
    throwIfAborted(signal);
    await mkdir(dirname(targetPath), { recursive: true });
    const output = await open(targetPath, 'wx');
    try {
      await output.writeFile(bytes);
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

async function hashStable(filePath: string): Promise<{ sizeBytes: number; sha256: string }> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new MaintenanceServiceError('BACKUP_FILE_TYPE_UNSUPPORTED');
  const file = await open(filePath, 'r');
  try {
    const before = await file.stat();
    const bytes = await file.readFile();
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new MaintenanceServiceError('BACKUP_SOURCE_CHANGED');
    }
    return { sizeBytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await file.close();
  }
}

async function inspectOptionalFile(path: string): Promise<{ sizeBytes: number; sha256: string } | undefined> {
  try { return await hashStable(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new MaintenanceServiceError('RESTORE_PATH_SYMLINK_UNSUPPORTED');
      if (info.isDirectory()) break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function validateWorkspacePath(workspaceRoot: string, target: string): Promise<void> {
  const root = resolve(workspaceRoot);
  const rootInfo = await lstat(root).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new MaintenanceServiceError('BACKUP_WORKSPACE_ROOT_UNAVAILABLE');
  await assertNoSymlinkComponents(target);
  const realRoot = await realpath(root);
  const realTarget = await resolveExistingRealPath(target);
  if (!isPathInside(realRoot, realTarget)) throw new MaintenanceServiceError('BACKUP_PATH_INVALID');
}

async function resolveExistingRealPath(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const actual = await realpath(current);
      return missing.reduceRight((resolved, segment) => join(resolved, segment), actual);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) throw new MaintenanceServiceError('BACKUP_PATH_INVALID');
      missing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

async function walkFiles(root: string, options: { ignoreSymlinks: boolean }): Promise<Array<{ absolutePath: string }>> {
  const rootInfo = await lstat(root).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!rootInfo?.isDirectory()) return [];
  const result: Array<{ absolutePath: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        if (options.ignoreSymlinks) continue;
        throw new MaintenanceServiceError('BACKUP_SYMLINK_UNSUPPORTED');
      }
      if (info.isDirectory()) await visit(absolutePath);
      else if (info.isFile()) result.push({ absolutePath });
    }
  };
  await visit(root);
  return result;
}

async function appendPreviewFiles(root: string, dataRoot: string, output: Array<{ path: string; sizeBytes: number; modifiedAt: string; reason: string }>, reason: string): Promise<void> {
  for (const file of await walkFiles(root, { ignoreSymlinks: true })) output.push(await previewRecord(file.absolutePath, dataRoot, reason));
}

async function previewRecord(path: string, dataRoot: string, reason: string): Promise<CleanupCandidate> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw new MaintenanceServiceError('CLEANUP_FILE_UNAVAILABLE');
  const hash = await hashStable(path);
  const after = await lstat(path, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || info.dev !== after.dev || info.ino !== after.ino
    || info.size !== after.size || info.mtimeNs !== after.mtimeNs || info.ctimeNs !== after.ctimeNs) {
    throw new MaintenanceServiceError('CLEANUP_PREVIEW_STALE');
  }
  const fields = {
    path: relative(dataRoot, path).replaceAll(sep, '/'),
    sizeBytes: hash.sizeBytes,
    modifiedAt: new Date(Number(info.mtimeMs)).toISOString(),
    modifiedAtMs: Number(info.mtimeMs),
    fileIdentity: cleanupFileIdentity(info),
    sha256: hash.sha256,
    reason,
  };
  return { id: cleanupCandidateId(fields), ...fields };
}

function cleanupCandidateId(candidate: Omit<CleanupCandidate, 'id'>): string {
  return createHash('sha256').update(JSON.stringify([
    candidate.path,
    candidate.sizeBytes,
    candidate.modifiedAtMs,
    candidate.fileIdentity,
    candidate.sha256,
    candidate.reason,
  ])).digest('hex');
}

function cleanupPreviewVersion(candidates: readonly CleanupCandidate[]): string {
  return createHash('sha256').update(JSON.stringify([
    candidates.map(candidate => [candidate.id, candidate.path, candidate.sizeBytes, candidate.modifiedAtMs,
      candidate.fileIdentity, candidate.sha256, candidate.reason]),
  ])).digest('hex');
}

function sameCleanupCandidate(left: CleanupCandidate, right: CleanupCandidate): boolean {
  return left.id === right.id && left.path === right.path && left.sizeBytes === right.sizeBytes
    && left.modifiedAt === right.modifiedAt && left.modifiedAtMs === right.modifiedAtMs
    && left.fileIdentity === right.fileIdentity
    && left.sha256 === right.sha256 && left.reason === right.reason;
}

function cleanupFileIdentity(info: { readonly dev: bigint; readonly ino: bigint }): string {
  return `${info.dev.toString(16)}:${info.ino.toString(16)}`;
}

async function quarantineAndDeleteCleanupFile(
  sourcePath: string,
  dataRoot: string,
  candidate: CleanupCandidate,
  beforeQuarantine?: MaintenanceServiceSeams['beforeCleanupQuarantine'],
  afterQuarantine?: MaintenanceServiceSeams['afterCleanupQuarantine'],
  signal?: AbortSignal,
): Promise<void> {
  const quarantineRoot = resolveInside(dataRoot, CLEANUP_QUARANTINE_RELATIVE);
  await mkdir(quarantineRoot, { recursive: true });
  await assertNoSymlinkComponents(quarantineRoot);
  if (!isPathInside(await realpath(dataRoot), await realpath(quarantineRoot))) {
    throw new MaintenanceServiceError('CLEANUP_QUARANTINE_INVALID');
  }

  const latest = await previewRecord(sourcePath, dataRoot, candidate.reason);
  if (!sameCleanupCandidate(candidate, latest)) throw new MaintenanceServiceError('CLEANUP_PREVIEW_STALE');
  await beforeQuarantine?.({ sourcePath });
  const operationDirectory = join(quarantineRoot, randomUUID());
  await mkdir(operationDirectory, { recursive: false });
  const quarantinedPath = join(operationDirectory, 'payload');
  try {
    await assertNoSymlinkComponents(sourcePath);
    await rename(sourcePath, quarantinedPath);
  } catch (error) {
    await rmdir(operationDirectory).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MaintenanceServiceError('CLEANUP_PREVIEW_STALE');
    throw error;
  }

  let payloadStillQuarantined = true;
  const preserveOrRestore = async (): Promise<void> => {
    let isolatedInfo;
    try { isolatedInfo = await lstat(quarantinedPath); }
    catch {
      throw new MaintenanceServiceError('CLEANUP_QUARANTINE_RECOVERY_REQUIRED');
    }
    if (!isolatedInfo.isFile() || isolatedInfo.isSymbolicLink()) {
      throw new MaintenanceServiceError('CLEANUP_QUARANTINE_RECOVERY_REQUIRED');
    }
    try {
      // link() creates the original name only if it is still absent. Unlike
      // rename(), it cannot replace a concurrent file at the original path.
      await link(quarantinedPath, sourcePath);
      await unlink(quarantinedPath);
      payloadStillQuarantined = false;
    } catch {
      // Keep the isolated payload for operator recovery when link is
      // unsupported or a replacement already occupies the original name.
      throw new MaintenanceServiceError('CLEANUP_QUARANTINE_RECOVERY_REQUIRED');
    }
  };

  try {
    await afterQuarantine?.({ sourcePath, quarantinedPath });
    const isolatedInfo = await lstat(quarantinedPath, { bigint: true });
    if (!isolatedInfo.isFile() || isolatedInfo.isSymbolicLink()) {
      await preserveOrRestore();
      throw new MaintenanceServiceError('CLEANUP_PREVIEW_STALE');
    }
    const isolatedHash = await hashStable(quarantinedPath);
    const isolatedAfter = await lstat(quarantinedPath, { bigint: true });
    if (!isolatedAfter.isFile() || isolatedAfter.isSymbolicLink()
      || isolatedInfo.dev !== isolatedAfter.dev || isolatedInfo.ino !== isolatedAfter.ino
      || cleanupFileIdentity(isolatedInfo) !== candidate.fileIdentity
      || isolatedInfo.size !== isolatedAfter.size || isolatedInfo.mtimeNs !== isolatedAfter.mtimeNs
      || isolatedHash.sizeBytes !== candidate.sizeBytes || Number(isolatedAfter.mtimeMs) !== candidate.modifiedAtMs
      || isolatedHash.sha256 !== candidate.sha256) {
      await preserveOrRestore();
      throw new MaintenanceServiceError('CLEANUP_PREVIEW_STALE');
    }
    if (signal?.aborted) {
      await preserveOrRestore();
      throwIfAborted(signal);
    }
    // The reviewed file has been moved out of the mutable cache/log path and
    // re-hashed there. Windows and POSIX expose no portable atomic
    // compare-and-unlink primitive, so this is a quarantine-then-verify
    // protocol rather than an OS-level CAS. The source path is never unlinked.
    await unlink(quarantinedPath);
    payloadStillQuarantined = false;
  } catch (error) {
    if (payloadStillQuarantined && !(error instanceof MaintenanceServiceError
      && error.code === 'CLEANUP_QUARANTINE_RECOVERY_REQUIRED')) {
      await preserveOrRestore();
    }
    throw error;
  } finally {
    if (!payloadStillQuarantined) await rmdir(operationDirectory).catch(() => {});
  }
}

function sameCleanupCandidates(left: readonly CleanupCandidate[], right: readonly CleanupCandidate[]): boolean {
  return left.length === right.length
    && left.every((candidate, index) => isCleanupCandidate(candidate)
      && sameCleanupCandidate(candidate, right[index]!));
}

function isCleanupCandidate(candidate: CleanupCandidate): boolean {
  return Boolean(candidate && typeof candidate.id === 'string' && /^[a-f0-9]{64}$/u.test(candidate.id)
    && typeof candidate.path === 'string' && Number.isSafeInteger(candidate.sizeBytes) && candidate.sizeBytes >= 0
    && typeof candidate.modifiedAt === 'string' && Number.isFinite(candidate.modifiedAtMs)
    && typeof candidate.fileIdentity === 'string' && /^[a-f0-9]+:[a-f0-9]+$/u.test(candidate.fileIdentity)
    && typeof candidate.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(candidate.sha256)
    && typeof candidate.reason === 'string');
}

function isCleanupPathAllowed(candidate: CleanupCandidate): boolean {
  const path = candidate.path.replaceAll('\\', '/').toLowerCase();
  if (path.startsWith('.agentos/cache/') && candidate.reason === 'derived-cache') return true;
  if (path.startsWith('.agentos/caches/') && candidate.reason === 'derived-caches') return true;
  if (path.startsWith('.agentos/logs/') && candidate.reason === 'rotated-log') {
    const name = path.split('/').at(-1) ?? '';
    return ROTATED_LOG_PATTERN.test(name);
  }
  return false;
}

function isBuildLabel(value: string): boolean {
  return value.length > 0 && value.length <= 160 && /^[\w.+-]+$/u.test(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new MaintenanceServiceError('MAINTENANCE_ABORTED');
}

function finiteProduct(left: number, right: number): number | undefined {
  const result = left * right;
  return Number.isSafeInteger(result) ? result : undefined;
}
