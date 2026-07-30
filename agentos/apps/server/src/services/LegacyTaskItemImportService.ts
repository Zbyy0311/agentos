import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { inTransaction } from '../store/Transaction.js';
import {
  LegacyDataMigrationRepository,
  type LegacyMigrationScope,
} from '../store/LegacyDataMigrationRepository.js';
import { LegacyTaskItemRepository } from '../store/LegacyTaskItemRepository.js';
import {
  assertCanonicalProjectDatabasePath,
  type LegacyMigrationDatabase,
} from './LegacyDataMigrationService.js';
import {
  canonicalizeLegacyMigrationDatabasePath,
  LegacyMigrationExecutionLock,
  type LegacyMigrationLease,
} from './LegacyMigrationExecutionLock.js';
import {
  LegacyBackupVerifier,
  type LegacyBackupInput,
  type LegacyBackupResult,
} from './LegacyBackupVerifier.js';
import {
  canonicalizeLegacyJson,
  parseLegacyJsonSource,
  type LegacySourceParseResult,
} from './LegacySourceParser.js';

export const LEGACY_TASK_IMPORT_INVALID_ARGUMENTS = 'LEGACY_TASK_MIGRATION_INVALID_ARGUMENTS' as const;
export const LEGACY_TASK_SOURCE_NOT_READABLE = 'LEGACY_TASK_SOURCE_NOT_READABLE' as const;
export const LEGACY_TASK_SOURCE_PARSE_FAILED = 'LEGACY_TASK_SOURCE_PARSE_FAILED' as const;
export const LEGACY_TASK_SOURCE_INVALID = 'LEGACY_TASK_SOURCE_INVALID' as const;
export const LEGACY_TASK_DUPLICATE_SOURCE_ID = 'LEGACY_TASK_DUPLICATE_SOURCE_ID' as const;
export const LEGACY_TASK_CROSS_WORKSPACE_ITEM = 'LEGACY_TASK_CROSS_WORKSPACE_ITEM' as const;
export const LEGACY_TASK_IMPORT_OPERATION_FAILED = 'LEGACY_TASK_IMPORT_OPERATION_FAILED' as const;
export const LEGACY_TASK_IMPORT_BACKUP_FAILED = 'LEGACY_DATA_MIGRATION_BACKUP_FAILED' as const;

/** Stable, payload-free and path-free Task import failure. */
export class LegacyTaskItemImportError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'LegacyTaskItemImportError';
    this.code = code;
  }
}

export type LegacyTaskImportMode = 'dry-run' | 'apply';

export interface LegacyTaskImportRunInput {
  projectRoot: string;
  sourceRoot: string;
  databasePath: string;
  backupDirectory: string;
  kind: 'tasks';
  mode: LegacyTaskImportMode;
  workspaceId: string;
}

export interface LegacyTaskImportSummary {
  mode: LegacyTaskImportMode;
  kind: 'tasks';
  workspaceId: string;
  sourceCount: number;
  validTaskCount: number;
  completedCount: number;
  noopCount: number;
  quarantinedCount: number;
  importedCount: number;
  revision: number | null;
}

interface TaskImportDatabase extends LegacyMigrationDatabase {
  readonly isTransaction?: boolean;
}

export interface LegacyTaskImportServiceOptions {
  leaseFactory?: (projectRoot: string, databasePath: string) => Promise<LegacyMigrationLease>;
  databaseFactory?: (databasePath: string) => TaskImportDatabase;
  backupProvider?: { createAndVerify(input: LegacyBackupInput): Promise<LegacyBackupResult | Record<string, unknown>> };
  migrationIdFactory?: () => string;
  clock?: () => string;
  parser?: (bytes: Uint8Array, sourceKey: 'tasks.json') => LegacySourceParseResult;
  beforeAggregateTransaction?: (input: { scope: LegacyMigrationScope; attemptId: string }) => void | Promise<void>;
  insertHook?: (task: Record<string, unknown>, index: number) => void;
  stageProbe?: (stage: string) => void;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Validate the parsed Task envelope. Every TaskItem must be a plain object
 * with a non-empty string `id`; IDs are unique within one Workspace source;
 * a Task carrying `workspaceId` must match the import Scope. Returns the
 * stable rejection code or null when the envelope is acceptable.
 */
function validateTaskItems(value: unknown[], workspaceId: string): string | null {
  const seen = new Set<string>();
  for (const item of value) {
    if (!isPlainObject(item) || !isNonEmptyString(item.id)) return LEGACY_TASK_SOURCE_INVALID;
    if (seen.has(item.id)) return LEGACY_TASK_DUPLICATE_SOURCE_ID;
    seen.add(item.id);
    if (item.workspaceId !== undefined && item.workspaceId !== workspaceId) {
      return LEGACY_TASK_CROSS_WORKSPACE_ITEM;
    }
  }
  return null;
}

/**
 * M2.7 P3 lossless Legacy Task snapshot import. It reads the exact source
 * bytes of `<sourceRoot>/workspace/<workspaceId>/.agentos/tasks.json`,
 * strictly parses them with the shared Parser, and writes complete
 * `legacy_task_items` compatibility snapshots under the M2.7 P1 lifecycle
 * primitives: two-layer Ownership, verified Backup, transactional Registry
 * Attempts and Revision semantics. It never creates or modifies canonical
 * Task/Run/Artifact/Snapshot/Stage records and never touches the source JSON.
 */
export class LegacyTaskItemImportService {
  private readonly leaseFactory: NonNullable<LegacyTaskImportServiceOptions['leaseFactory']>;
  private readonly databaseFactory: NonNullable<LegacyTaskImportServiceOptions['databaseFactory']>;
  private readonly backupProvider: NonNullable<LegacyTaskImportServiceOptions['backupProvider']>;
  private readonly migrationIdFactory: NonNullable<LegacyTaskImportServiceOptions['migrationIdFactory']>;
  private readonly clock: NonNullable<LegacyTaskImportServiceOptions['clock']>;
  private readonly parser: NonNullable<LegacyTaskImportServiceOptions['parser']>;
  private readonly beforeAggregateTransaction: LegacyTaskImportServiceOptions['beforeAggregateTransaction'];
  private readonly insertHook: LegacyTaskImportServiceOptions['insertHook'];
  private readonly stageProbe: LegacyTaskImportServiceOptions['stageProbe'];

  constructor(options: LegacyTaskImportServiceOptions = {}) {
    this.leaseFactory = options.leaseFactory
      ?? ((projectRoot, databasePath) => new LegacyMigrationExecutionLock().acquire(projectRoot, databasePath));
    this.databaseFactory = options.databaseFactory ?? ((databasePath) => {
      const DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as {
        DatabaseSync: new (path: string) => TaskImportDatabase;
      }).DatabaseSync;
      return new DatabaseSync(databasePath);
    });
    this.backupProvider = options.backupProvider ?? new LegacyBackupVerifier();
    this.migrationIdFactory = options.migrationIdFactory ?? (() => randomUUID());
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.parser = options.parser ?? ((bytes, sourceKey) => parseLegacyJsonSource(bytes, sourceKey));
    this.beforeAggregateTransaction = options.beforeAggregateTransaction;
    this.insertHook = options.insertHook;
    this.stageProbe = options.stageProbe;
  }

  async run(input: LegacyTaskImportRunInput): Promise<LegacyTaskImportSummary> {
    this.validateInput(input);
    this.assertProjectSourceDatabaseBinding(input);

    let lease: LegacyMigrationLease;
    try {
      lease = await this.leaseFactory(input.projectRoot, input.databasePath);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === 'LEGACY_DATA_MIGRATION_RUNTIME_ACTIVE' || code === 'LEGACY_DATA_MIGRATION_ACTIVE') {
        throw new LegacyTaskItemImportError(code);
      }
      throw new LegacyTaskItemImportError(LEGACY_TASK_IMPORT_OPERATION_FAILED);
    }
    this.stageProbe?.('ownership');

    let db: TaskImportDatabase | undefined;
    try {
      // Source preflight is deliberately performed while both Ownership
      // layers are held, but before Backup and any Attempt.
      const sourcePath = this.resolveSourcePath(input.sourceRoot, input.workspaceId);
      const sourceBytes = this.readSource(sourcePath);
      const sourceHash = sha256(sourceBytes);
      this.stageProbe?.('source-read');

      db = this.databaseFactory(input.databasePath);
      this.assertDatabaseBinding(db, input.databasePath);
      const migrations = new LegacyDataMigrationRepository(db);
      const scope: LegacyMigrationScope = {
        migrationKind: 'legacy_task_item_import',
        sourceKey: 'tasks.json',
        scopeKind: 'workspace',
        scopeKey: input.workspaceId,
        canonicalWorkspaceId: this.lookupCanonicalWorkspace(db, input.workspaceId),
        sourceHash,
      };

      // Exact-source no-op: no Parser, no Backup, no Attempt.
      this.stageProbe?.('noop-check');
      const exact = migrations.findCompletedByExactSource(scope);
      if (exact !== null) {
        return {
          mode: input.mode,
          kind: 'tasks',
          workspaceId: input.workspaceId,
          sourceCount: exact.entityCount,
          validTaskCount: exact.entityCount,
          completedCount: 0,
          noopCount: 1,
          quarantinedCount: 0,
          importedCount: 0,
          revision: exact.revision,
        };
      }

      if (input.mode === 'dry-run') {
        return this.dryRun(scope, sourceBytes);
      }
      return await this.applyRun(db, migrations, scope, input, sourceBytes, sourceHash);
    } catch (error) {
      if (error instanceof LegacyTaskItemImportError) throw error;
      throw new LegacyTaskItemImportError(LEGACY_TASK_IMPORT_OPERATION_FAILED);
    } finally {
      try { db?.close(); } catch { /* best effort */ }
      await lease.release().catch(() => {});
    }
  }

  private validateInput(input: LegacyTaskImportRunInput): void {
    if (input.kind !== 'tasks' || !['dry-run', 'apply'].includes(input.mode)
      || !isNonEmptyString(input.projectRoot) || !isNonEmptyString(input.sourceRoot)
      || !isNonEmptyString(input.databasePath) || !isNonEmptyString(input.backupDirectory)
      || !isNonEmptyString(input.workspaceId)
      || /[\\/]/.test(input.workspaceId) || input.workspaceId.includes('..')) {
      throw new LegacyTaskItemImportError(LEGACY_TASK_IMPORT_INVALID_ARGUMENTS);
    }
  }

  private assertProjectSourceDatabaseBinding(input: LegacyTaskImportRunInput): void {
    try {
      assertCanonicalProjectDatabasePath(input.projectRoot, input.databasePath);
    } catch {
      throw new LegacyTaskItemImportError('LEGACY_DATA_MIGRATION_PATH_MISMATCH');
    }
    if (canonicalizeLegacyMigrationDatabasePath(input.projectRoot)
      !== canonicalizeLegacyMigrationDatabasePath(input.sourceRoot)) {
      throw new LegacyTaskItemImportError('LEGACY_DATA_MIGRATION_PATH_MISMATCH');
    }
  }

  private resolveSourcePath(sourceRoot: string, workspaceId: string): string {
    if (!isAbsolute(sourceRoot)) throw new LegacyTaskItemImportError(LEGACY_TASK_SOURCE_NOT_READABLE);
    const resolvedRoot = resolve(sourceRoot);
    if (!existsSync(resolvedRoot)) throw new LegacyTaskItemImportError(LEGACY_TASK_SOURCE_NOT_READABLE);
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync.native(resolvedRoot);
    } catch {
      throw new LegacyTaskItemImportError(LEGACY_TASK_SOURCE_NOT_READABLE);
    }
    const sourcePath = join(canonicalRoot, 'workspace', workspaceId, '.agentos', 'tasks.json');
    try {
      const stat = lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('source file');
      const canonicalSource = realpathSync.native(sourcePath);
      const relativeSource = relative(canonicalRoot, canonicalSource);
      if (isAbsolute(relativeSource) || relativeSource.startsWith('..')) {
        throw new Error('source escape');
      }
      return sourcePath;
    } catch {
      throw new LegacyTaskItemImportError(LEGACY_TASK_SOURCE_NOT_READABLE);
    }
  }

  private readSource(sourcePath: string): Uint8Array {
    try {
      return readFileSync(sourcePath);
    } catch {
      throw new LegacyTaskItemImportError(LEGACY_TASK_SOURCE_NOT_READABLE);
    }
  }

  private assertDatabaseBinding(db: TaskImportDatabase, databasePath: string): void {
    const rows = db.prepare('PRAGMA database_list').all() as Array<{ name?: unknown; file?: unknown }>;
    const main = rows.find(row => row.name === 'main');
    if (main?.file !== databasePath && (typeof main?.file !== 'string'
      || canonicalizeLegacyMigrationDatabasePath(main.file)
        !== canonicalizeLegacyMigrationDatabasePath(databasePath))) {
      throw new LegacyTaskItemImportError('LEGACY_DATA_MIGRATION_PATH_MISMATCH');
    }
  }

  /** Link to the canonical Workspace only when it exists and is not deleted. */
  private lookupCanonicalWorkspace(db: TaskImportDatabase, workspaceId: string): string | null {
    const row = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
    if (row === undefined) return null;
    const tombstone = db.prepare('SELECT 1 FROM _workspace_tombstones WHERE workspace_id = ?').get(workspaceId);
    if (tombstone !== undefined) return null;
    return workspaceId;
  }

  private dryRun(scope: LegacyMigrationScope, sourceBytes: Uint8Array): LegacyTaskImportSummary {
    let parsed: LegacySourceParseResult;
    try {
      parsed = this.parser(sourceBytes, 'tasks.json');
    } catch {
      throw new LegacyTaskItemImportError(LEGACY_TASK_SOURCE_PARSE_FAILED);
    }
    const invalidCode = validateTaskItems(parsed.value, scope.scopeKey);
    if (invalidCode !== null) throw new LegacyTaskItemImportError(invalidCode);
    return {
      mode: 'dry-run',
      kind: 'tasks',
      workspaceId: scope.scopeKey,
      sourceCount: parsed.entityCount,
      validTaskCount: parsed.entityCount,
      completedCount: 0,
      noopCount: 0,
      quarantinedCount: 0,
      importedCount: 0,
      revision: null,
    };
  }

  private async applyRun(
    db: TaskImportDatabase,
    migrations: LegacyDataMigrationRepository,
    scope: LegacyMigrationScope,
    input: LegacyTaskImportRunInput,
    sourceBytes: Uint8Array,
    sourceHash: string,
  ): Promise<LegacyTaskImportSummary> {
    // Exactly one verified SQLite + JSON Backup after the no-op miss and
    // before any Attempt is reserved.
    let migrationId: string;
    try {
      migrationId = this.migrationIdFactory();
    } catch {
      throw new LegacyTaskItemImportError(LEGACY_TASK_IMPORT_BACKUP_FAILED);
    }
    try {
      this.stageProbe?.('backup');
      await this.backupProvider.createAndVerify({
        databasePath: input.databasePath,
        database: db,
        backupDirectory: input.backupDirectory,
        migrationId,
        sourceBytes,
        sourceHash,
        expectedTables: ['legacy_data_migrations', 'legacy_task_items'],
      });
    } catch {
      throw new LegacyTaskItemImportError(LEGACY_TASK_IMPORT_BACKUP_FAILED);
    }

    // One committed Running Attempt; stale Running is reconciled atomically.
    const running = migrations.reconcileStaleRunningAndReserveAttempt({
      ...scope,
      migrationId,
      now: this.clock(),
    });
    this.stageProbe?.('attempt');

    // Strict Parser rejection becomes a Quarantine with revision NULL.
    let parsed: LegacySourceParseResult;
    try {
      parsed = this.parser(sourceBytes, 'tasks.json');
    } catch {
      migrations.transitionRunningToQuarantined(running.id, {
        errorCode: LEGACY_TASK_SOURCE_PARSE_FAILED,
        finishedAt: this.clock(),
        updatedAt: this.clock(),
      });
      return this.quarantinedSummary(scope);
    }

    // Domain rejection keeps parsed evidence but no compatibility rows.
    const invalidCode = validateTaskItems(parsed.value, scope.scopeKey);
    if (invalidCode !== null) {
      migrations.transitionRunningToQuarantined(running.id, {
        errorCode: invalidCode,
        payloadHash: parsed.payloadHash,
        sourceSchemaVersion: parsed.sourceSchemaVersion,
        entityCount: parsed.entityCount,
        finishedAt: this.clock(),
        updatedAt: this.clock(),
      });
      return this.quarantinedSummary(scope);
    }

    // Revision branch: identical accepted payload reuses the latest Revision
    // without writing rows; anything else gets latest_revision + 1 and a
    // complete new snapshot. Older history is never reused.
    const latest = migrations.findLatestAcceptedCompleted(scope);
    const reuse = latest !== null && latest.payloadHash === parsed.payloadHash;
    const revision = reuse ? (latest?.revision ?? 1) : ((latest?.revision ?? 0) + 1);

    await this.beforeAggregateTransaction?.({ scope, attemptId: running.id });

    const tasks = parsed.value as Record<string, unknown>[];
    const taskItems = new LegacyTaskItemRepository(db);
    let importedCount = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!reuse) {
        for (let index = 0; index < tasks.length; index += 1) {
          this.insertHook?.(tasks[index], index);
          const canonical = canonicalizeLegacyJson(tasks[index]);
          taskItems.insertAcceptedSnapshot({
            workspaceScopeId: scope.scopeKey,
            canonicalWorkspaceId: scope.canonicalWorkspaceId,
            legacyTaskId: tasks[index].id as string,
            revision,
            migrationId: running.id,
            sourceHash,
            payloadHash: sha256(canonical),
            sourceSchemaVersion: parsed.sourceSchemaVersion,
            payload: tasks[index],
            createdAt: this.clock(),
          });
          importedCount += 1;
        }
      }
      migrations.transitionRunningToCompleted(running.id, {
        payloadHash: parsed.payloadHash,
        sourceSchemaVersion: parsed.sourceSchemaVersion,
        revision,
        entityCount: parsed.entityCount,
        finishedAt: this.clock(),
        updatedAt: this.clock(),
      });
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      // The failure record commits in its own independent transaction.
      try {
        inTransaction(db, () => {
          migrations.transitionRunningToFailed(running.id, {
            errorCode: LEGACY_TASK_IMPORT_OPERATION_FAILED,
            finishedAt: this.clock(),
            updatedAt: this.clock(),
          });
        });
      } catch { /* never mask the primary failure */ }
      if (error instanceof LegacyTaskItemImportError) throw error;
      throw new LegacyTaskItemImportError(LEGACY_TASK_IMPORT_OPERATION_FAILED);
    }

    return {
      mode: 'apply',
      kind: 'tasks',
      workspaceId: scope.scopeKey,
      sourceCount: parsed.entityCount,
      validTaskCount: parsed.entityCount,
      completedCount: 1,
      noopCount: 0,
      quarantinedCount: 0,
      importedCount,
      revision,
    };
  }

  private quarantinedSummary(scope: LegacyMigrationScope): LegacyTaskImportSummary {
    return {
      mode: 'apply',
      kind: 'tasks',
      workspaceId: scope.scopeKey,
      sourceCount: 0,
      validTaskCount: 0,
      completedCount: 0,
      noopCount: 0,
      quarantinedCount: 1,
      importedCount: 0,
      revision: null,
    };
  }
}
