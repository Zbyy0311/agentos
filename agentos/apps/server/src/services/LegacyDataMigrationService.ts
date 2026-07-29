import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import {
  LegacyDataMigrationRepository,
  type LegacyDataMigrationRecord,
  type LegacyMigrationKind,
  type LegacyMigrationScope,
  type LegacyScopeKind,
  type LegacySourceKey,
} from '../store/LegacyDataMigrationRepository.js';
import { parseLegacyJsonSource, type LegacySourceParseResult } from './LegacySourceParser.js';
import {
  LegacyMigrationExecutionLock,
  canonicalizeLegacyMigrationDatabasePath,
  type LegacyMigrationLease,
} from './LegacyMigrationExecutionLock.js';
import { LegacyBackupVerifier, type LegacyBackupResult } from './LegacyBackupVerifier.js';

export const LEGACY_DATA_MIGRATION_PATH_MISMATCH = 'LEGACY_DATA_MIGRATION_PATH_MISMATCH' as const;
export const LEGACY_DATA_MIGRATION_PARSE_FAILED = 'LEGACY_DATA_MIGRATION_PARSE_FAILED' as const;
export const LEGACY_DATA_MIGRATION_OPERATION_FAILED = 'LEGACY_DATA_MIGRATION_OPERATION_FAILED' as const;
export const LEGACY_DATA_MIGRATION_INVALID_INPUT = 'LEGACY_DATA_MIGRATION_INVALID_INPUT' as const;

/** Stable, payload-free and path-free Service failure. */
export class LegacyDataMigrationServiceError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'LegacyDataMigrationServiceError';
    this.code = code;
  }
}

export interface LegacyMigrationDatabase extends TransactionDatabase {
  close(): void;
}

export type LegacyMigrationLeaseFactory = (
  projectRoot: string,
  databasePath: string,
) => Promise<LegacyMigrationLease>;

export type LegacyMigrationIdFactory = () => string;

export type LegacyMigrationClock = () => string;

export type LegacySourceParserFn = (bytes: Uint8Array) => LegacySourceParseResult;

export interface LegacyBackupProviderPort {
  createAndVerify(input: Record<string, unknown>): Promise<LegacyBackupResult | Record<string, unknown>>;
}

export interface LegacyMigrationProcessContext {
  /** Migration write connection; valid only inside the processing callback. */
  db: LegacyMigrationDatabase;
  parsed: LegacySourceParseResult;
  record: LegacyDataMigrationRecord;
  revisionAction: 'new' | 'reuse';
  revision: number;
  scope: LegacyMigrationScope;
}

export interface LegacyMigrationProcessOutcome {
  outcome: 'completed' | 'quarantined';
  errorCode?: string;
}

export type LegacyMigrationProcessFn = (
  context: LegacyMigrationProcessContext,
) => Promise<LegacyMigrationProcessOutcome | Record<string, unknown>> | LegacyMigrationProcessOutcome | Record<string, unknown>;

export interface LegacyDataMigrationRunInput {
  projectRoot: string;
  databasePath: string;
  migrationKind: LegacyMigrationKind;
  sourceKey: LegacySourceKey;
  scopeKind: LegacyScopeKind;
  scopeKey: string;
  canonicalWorkspaceId?: string | null;
  sourceBytesLoader: () => Promise<Uint8Array> | Uint8Array;
  databaseFactory: () => LegacyMigrationDatabase;
  backupProvider?: LegacyBackupProviderPort;
  backupDirectory?: string;
  expectedTables?: readonly string[];
  expectedTableCounts?: Record<string, number>;
  process: LegacyMigrationProcessFn;
}

export interface LegacyDataMigrationRunResult {
  status: 'completed' | 'quarantined' | 'noop';
  record: LegacyDataMigrationRecord;
}

export interface LegacyDataMigrationServiceOptions {
  leaseFactory?: LegacyMigrationLeaseFactory;
  migrationIdFactory?: LegacyMigrationIdFactory;
  clock?: LegacyMigrationClock;
  parser?: LegacySourceParserFn;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validate the frozen Project Root / Database relationship before any
 * Ownership, database connection, Backup, Attempt or source write:
 *
 *   canonicalDatabasePath === canonicalize(join(canonicalProjectRoot, '.agentos', 'agentos.sqlite'))
 */
export function assertCanonicalProjectDatabasePath(projectRoot: string, databasePath: string): void {
  if (!isNonEmptyString(projectRoot) || !isNonEmptyString(databasePath)) {
    throw new LegacyDataMigrationServiceError(LEGACY_DATA_MIGRATION_PATH_MISMATCH);
  }
  const canonicalProjectRoot = canonicalizeLegacyMigrationDatabasePath(projectRoot);
  const canonicalDatabasePath = canonicalizeLegacyMigrationDatabasePath(databasePath);
  const expectedDatabasePath = canonicalizeLegacyMigrationDatabasePath(
    join(canonicalProjectRoot, '.agentos', 'agentos.sqlite'),
  );
  if (canonicalDatabasePath !== expectedDatabasePath) {
    throw new LegacyDataMigrationServiceError(LEGACY_DATA_MIGRATION_PATH_MISMATCH);
  }
}

/**
 * Generic M2.7 migration lifecycle foundation. It is not a P2/P3 domain
 * migration: the domain work happens inside the restricted `process` seam.
 * Fixed order: canonical path validation, two-layer Ownership, read-only
 * source preflight, exact-source no-op, verified Backup, atomic Attempt
 * Reservation, strict Parser, processing, atomic terminal transition and
 * reverse-order Ownership release.
 */
export class LegacyDataMigrationService {
  private readonly leaseFactory: LegacyMigrationLeaseFactory;
  private readonly migrationIdFactory: LegacyMigrationIdFactory;
  private readonly clock: LegacyMigrationClock;
  private readonly parser: LegacySourceParserFn;

  constructor(options: LegacyDataMigrationServiceOptions = {}) {
    this.leaseFactory = options.leaseFactory
      ?? ((projectRoot, databasePath) => new LegacyMigrationExecutionLock().acquire(projectRoot, databasePath));
    this.migrationIdFactory = options.migrationIdFactory ?? (() => randomUUID());
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.parser = options.parser ?? parseLegacyJsonSource;
  }

  async run(input: LegacyDataMigrationRunInput): Promise<LegacyDataMigrationRunResult> {
    // Step 1: canonical path binding — before Ownership, connections, Backup.
    assertCanonicalProjectDatabasePath(input.projectRoot, input.databasePath);

    if (typeof input.sourceBytesLoader !== 'function'
      || typeof input.databaseFactory !== 'function'
      || typeof input.process !== 'function') {
      throw new LegacyDataMigrationServiceError(LEGACY_DATA_MIGRATION_INVALID_INPUT);
    }
    const scope: LegacyMigrationScope = {
      migrationKind: input.migrationKind,
      sourceKey: input.sourceKey,
      scopeKind: input.scopeKind,
      scopeKey: input.scopeKey,
      canonicalWorkspaceId: input.canonicalWorkspaceId ?? null,
      // Filled in after the read-only source preflight; validated before use.
      sourceHash: '0'.repeat(64),
    };

    // Steps 2+3: Project Runtime Ownership, then database-wide Ownership.
    const lease = await this.leaseFactory(input.projectRoot, input.databasePath);

    let db: LegacyMigrationDatabase | undefined;
    try {
      // Step 4: read-only source preflight.
      const sourceBytes = await input.sourceBytesLoader();
      if (!(sourceBytes instanceof Uint8Array)) {
        throw new LegacyDataMigrationServiceError(LEGACY_DATA_MIGRATION_INVALID_INPUT);
      }
      const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
      scope.sourceHash = sourceHash;

      db = input.databaseFactory();
      const repository = new LegacyDataMigrationRepository(db);

      // Steps 5+6: exact-source Completed no-op before any Backup.
      const noop = repository.findCompletedByExactSource(scope);
      if (noop !== null) {
        return { status: 'noop', record: noop };
      }

      // Step 7: write-intent Backup creation and verification.
      const migrationId = this.migrationIdFactory();
      if (!isNonEmptyString(migrationId)) {
        throw new LegacyDataMigrationServiceError(LEGACY_DATA_MIGRATION_INVALID_INPUT);
      }
      const backupProvider = input.backupProvider ?? this.defaultBackupProvider(input);
      await backupProvider.createAndVerify({
        databasePath: input.databasePath,
        database: db,
        backupDirectory: input.backupDirectory,
        migrationId,
        sourceBytes,
        sourceHash,
        expectedTables: input.expectedTables,
        expectedTableCounts: input.expectedTableCounts,
      });

      // Step 8: one BEGIN IMMEDIATE transaction reconciles the target Scope's
      // stale Running Attempt and reserves the next Attempt.
      const running = inTransaction(db, () => repository.reconcileStaleRunningAndReserveAttempt({
        ...scope,
        migrationId,
        now: this.clock(),
      }));

      // Step 9: strict Parser after Reservation; rejection becomes Quarantined.
      let parsed: LegacySourceParseResult;
      try {
        parsed = this.parser(sourceBytes);
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        if (code === 'LEGACY_SOURCE_PARSE_FAILED') {
          const record = repository.transitionRunningToQuarantined(running.id, {
            errorCode: LEGACY_DATA_MIGRATION_PARSE_FAILED,
            finishedAt: this.clock(),
            updatedAt: this.clock(),
          });
          return { status: 'quarantined', record };
        }
        return this.recordOperationalFailure(db, repository, running.id, error);
      }

      // Steps 10-14: Revision branch, processing callback, atomic terminal.
      const latestAccepted = repository.findLatestAcceptedCompleted(scope);
      let revisionAction: 'new' | 'reuse';
      let revision: number;
      if (latestAccepted === null) {
        revisionAction = 'new';
        revision = 1;
      } else if (latestAccepted.payloadHash === parsed.payloadHash) {
        revisionAction = 'reuse';
        revision = latestAccepted.revision ?? 1;
      } else {
        revisionAction = 'new';
        revision = (latestAccepted.revision ?? 0) + 1;
      }

      db.exec('BEGIN IMMEDIATE');
      try {
        const outcome = await input.process({
          db,
          parsed,
          record: running,
          revisionAction,
          revision,
          scope,
        }) as LegacyMigrationProcessOutcome;

        if (outcome?.outcome === 'completed') {
          const record = repository.transitionRunningToCompleted(running.id, {
            payloadHash: parsed.payloadHash,
            sourceSchemaVersion: parsed.sourceSchemaVersion,
            revision,
            entityCount: parsed.entityCount,
            finishedAt: this.clock(),
            updatedAt: this.clock(),
          });
          db.exec('COMMIT');
          return { status: 'completed', record };
        }

        if (outcome?.outcome === 'quarantined') {
          // Deterministic invalid input: compatibility rows are rolled back;
          // only the Registry terminal update commits, with parsed evidence.
          db.exec('ROLLBACK');
          const record = repository.transitionRunningToQuarantined(running.id, {
            errorCode: isNonEmptyString(outcome.errorCode)
              ? outcome.errorCode
              : LEGACY_DATA_MIGRATION_PARSE_FAILED,
            payloadHash: parsed.payloadHash,
            sourceSchemaVersion: parsed.sourceSchemaVersion,
            entityCount: parsed.entityCount,
            finishedAt: this.clock(),
            updatedAt: this.clock(),
          });
          return { status: 'quarantined', record };
        }

        throw new LegacyDataMigrationServiceError(LEGACY_DATA_MIGRATION_INVALID_INPUT);
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        return this.recordOperationalFailure(db, repository, running.id, error);
      }
    } finally {
      if (db !== undefined) {
        try { db.close(); } catch { /* best-effort close */ }
      }
      // Steps 15+16: database-wide Ownership first, Project Ownership second.
      await lease.release().catch(() => {});
    }
  }

  private defaultBackupProvider(input: LegacyDataMigrationRunInput): LegacyBackupProviderPort {
    if (!isNonEmptyString(input.backupDirectory)) {
      throw new LegacyDataMigrationServiceError(LEGACY_DATA_MIGRATION_INVALID_INPUT);
    }
    const verifier = new LegacyBackupVerifier();
    return {
      createAndVerify: backupInput => verifier.createAndVerify(backupInput as never),
    };
  }

  /**
   * Operational failure: processing is rolled back by the caller; the failure
   * record commits in its own independent transaction.
   */
  private recordOperationalFailure(
    db: LegacyMigrationDatabase,
    repository: LegacyDataMigrationRepository,
    attemptId: string,
    error: unknown,
  ): never {
    try {
      inTransaction(db, () => {
        repository.transitionRunningToFailed(attemptId, {
          errorCode: LEGACY_DATA_MIGRATION_OPERATION_FAILED,
          finishedAt: this.clock(),
          updatedAt: this.clock(),
        });
      });
    } catch {
      // Failure-record write failures never mask the original error.
    }
    throw error;
  }
}
