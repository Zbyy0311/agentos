import { inTransaction, type TransactionDatabase } from './Transaction.js';

export const LEGACY_DATA_MIGRATION_INVALID_RECORD = 'LEGACY_DATA_MIGRATION_INVALID_RECORD' as const;
export const LEGACY_DATA_MIGRATION_INVALID_STATE = 'LEGACY_DATA_MIGRATION_INVALID_STATE' as const;
export const LEGACY_DATA_MIGRATION_INTERRUPTED = 'LEGACY_DATA_MIGRATION_INTERRUPTED' as const;

/** Stable, payload-free Repository failure. Never echoes source content. */
export class LegacyDataMigrationError extends Error {
  readonly code: string;

  constructor(code: string, reason: string) {
    super(`${code}: ${reason}`);
    this.name = 'LegacyDataMigrationError';
    this.code = code;
  }
}

export const LEGACY_MIGRATION_KINDS = ['workspace_adoption', 'legacy_task_item_import'] as const;
export type LegacyMigrationKind = (typeof LEGACY_MIGRATION_KINDS)[number];

export const LEGACY_SOURCE_KEYS = ['workspaces.json', 'tasks.json'] as const;
export type LegacySourceKey = (typeof LEGACY_SOURCE_KEYS)[number];

export const LEGACY_SCOPE_KINDS = ['global', 'workspace'] as const;
export type LegacyScopeKind = (typeof LEGACY_SCOPE_KINDS)[number];

export const LEGACY_MIGRATION_STATUSES = ['running', 'completed', 'failed', 'quarantined'] as const;
export type LegacyMigrationStatus = (typeof LEGACY_MIGRATION_STATUSES)[number];

export const LEGACY_COMPATIBILITY_SCHEMA_VERSION = 1 as const;
export const LEGACY_HASH_ALGORITHM = 'sha256' as const;

export interface LegacyDataMigrationRecord {
  id: string;
  migrationKind: LegacyMigrationKind;
  sourceKey: LegacySourceKey;
  scopeKind: LegacyScopeKind;
  scopeKey: string;
  canonicalWorkspaceId: string | null;
  sourceHash: string;
  payloadHash: string | null;
  hashAlgorithm: typeof LEGACY_HASH_ALGORITHM;
  sourceSchemaVersion: number | null;
  compatibilitySchemaVersion: typeof LEGACY_COMPATIBILITY_SCHEMA_VERSION;
  status: LegacyMigrationStatus;
  attempt: number;
  revision: number | null;
  entityCount: number;
  errorCode: string | null;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

export interface LegacyMigrationScope {
  migrationKind: LegacyMigrationKind;
  sourceKey: LegacySourceKey;
  scopeKind: LegacyScopeKind;
  scopeKey: string;
  canonicalWorkspaceId: string | null;
  sourceHash: string;
}

export interface ReserveAttemptInput extends LegacyMigrationScope {
  migrationId: string;
  now: string;
}

export interface CompleteAttemptInput {
  payloadHash: string;
  sourceSchemaVersion: number;
  revision: number;
  entityCount: number;
  finishedAt: string;
  updatedAt: string;
}

export interface FailAttemptInput {
  errorCode: string;
  finishedAt: string;
  updatedAt: string;
}

export interface QuarantineAttemptInput {
  errorCode: string;
  finishedAt: string;
  updatedAt: string;
  /** Parsed evidence may be preserved when the conflict is known. */
  payloadHash?: string;
  sourceSchemaVersion?: number;
  entityCount?: number;
}

interface RepositoryDatabase extends TransactionDatabase {
  readonly isTransaction?: boolean;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/;

function invalidRecord(reason: string): LegacyDataMigrationError {
  return new LegacyDataMigrationError(LEGACY_DATA_MIGRATION_INVALID_RECORD, reason);
}

function invalidState(reason: string): LegacyDataMigrationError {
  return new LegacyDataMigrationError(LEGACY_DATA_MIGRATION_INVALID_STATE, reason);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === 'string' && TIMESTAMP_PATTERN.test(value);
}

function isStableErrorCode(value: unknown): value is string {
  return typeof value === 'string' && ERROR_CODE_PATTERN.test(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function assertScope(scope: LegacyMigrationScope): void {
  if (!LEGACY_MIGRATION_KINDS.includes(scope.migrationKind)) throw invalidRecord('migration_kind');
  if (!LEGACY_SOURCE_KEYS.includes(scope.sourceKey)) throw invalidRecord('source_key');
  if (!LEGACY_SCOPE_KINDS.includes(scope.scopeKind)) throw invalidRecord('scope_kind');
  if (!isNonEmptyString(scope.scopeKey)) throw invalidRecord('scope_key');
  if (scope.migrationKind === 'workspace_adoption' && scope.sourceKey !== 'workspaces.json') {
    throw invalidRecord('kind/source combination');
  }
  if (scope.migrationKind === 'legacy_task_item_import' && scope.sourceKey !== 'tasks.json') {
    throw invalidRecord('kind/source combination');
  }
  if (scope.migrationKind === 'legacy_task_item_import' && scope.scopeKind !== 'workspace') {
    throw invalidRecord('kind/scope combination');
  }
  if (scope.scopeKind === 'global') {
    if (scope.scopeKey !== 'global' || scope.canonicalWorkspaceId !== null) {
      throw invalidRecord('global scope shape');
    }
  } else if (scope.canonicalWorkspaceId !== null && !isNonEmptyString(scope.canonicalWorkspaceId)) {
    throw invalidRecord('canonical_workspace_id');
  }
  if (!isValidHash(scope.sourceHash)) throw invalidRecord('source_hash');
}

const ROW_COLUMNS = `
  id, migration_kind, source_key, scope_kind, scope_key, canonical_workspace_id,
  source_hash, payload_hash, hash_algorithm, source_schema_version,
  compatibility_schema_version, status, attempt, revision, entity_count,
  error_code, created_at, started_at, finished_at, updated_at
`;

/**
 * Strictly validate one Registry row. A malformed row fails closed; it is
 * never repaired, coerced or silently ignored.
 */
export function validateLegacyDataMigrationRow(row: unknown): LegacyDataMigrationRecord {
  if (typeof row !== 'object' || row === null) throw invalidRecord('row shape');
  const r = row as Record<string, unknown>;
  if (!isNonEmptyString(r.id)) throw invalidRecord('id');
  if (!LEGACY_MIGRATION_KINDS.includes(r.migration_kind as LegacyMigrationKind)) throw invalidRecord('migration_kind');
  if (!LEGACY_SOURCE_KEYS.includes(r.source_key as LegacySourceKey)) throw invalidRecord('source_key');
  if (!LEGACY_SCOPE_KINDS.includes(r.scope_kind as LegacyScopeKind)) throw invalidRecord('scope_kind');
  if (!isNonEmptyString(r.scope_key)) throw invalidRecord('scope_key');
  if (r.canonical_workspace_id !== null && !isNonEmptyString(r.canonical_workspace_id)) {
    throw invalidRecord('canonical_workspace_id');
  }
  if (!isValidHash(r.source_hash)) throw invalidRecord('source_hash');
  if (r.payload_hash !== null && !isValidHash(r.payload_hash)) throw invalidRecord('payload_hash');
  if (r.hash_algorithm !== LEGACY_HASH_ALGORITHM) throw invalidRecord('hash_algorithm');
  if (r.source_schema_version !== null && !isPositiveInt(r.source_schema_version)) {
    throw invalidRecord('source_schema_version');
  }
  if (r.compatibility_schema_version !== LEGACY_COMPATIBILITY_SCHEMA_VERSION) {
    throw invalidRecord('compatibility_schema_version');
  }
  if (!LEGACY_MIGRATION_STATUSES.includes(r.status as LegacyMigrationStatus)) throw invalidRecord('status');
  if (!isPositiveInt(r.attempt)) throw invalidRecord('attempt');
  if (r.revision !== null && !isPositiveInt(r.revision)) throw invalidRecord('revision');
  if (!isNonNegativeInt(r.entity_count)) throw invalidRecord('entity_count');
  if (r.error_code !== null && !isStableErrorCode(r.error_code)) throw invalidRecord('error_code');
  if (!isValidTimestamp(r.created_at)) throw invalidRecord('created_at');
  if (!isValidTimestamp(r.started_at)) throw invalidRecord('started_at');
  if (r.finished_at !== null && !isValidTimestamp(r.finished_at)) throw invalidRecord('finished_at');
  if (!isValidTimestamp(r.updated_at)) throw invalidRecord('updated_at');

  const migrationKind = r.migration_kind as LegacyMigrationKind;
  const sourceKey = r.source_key as LegacySourceKey;
  const scopeKind = r.scope_kind as LegacyScopeKind;
  const status = r.status as LegacyMigrationStatus;

  if (migrationKind === 'workspace_adoption' && sourceKey !== 'workspaces.json') {
    throw invalidRecord('kind/source combination');
  }
  if (migrationKind === 'legacy_task_item_import' && sourceKey !== 'tasks.json') {
    throw invalidRecord('kind/source combination');
  }
  if (migrationKind === 'legacy_task_item_import' && scopeKind !== 'workspace') {
    throw invalidRecord('kind/scope combination');
  }
  if (scopeKind === 'global' && (r.scope_key !== 'global' || r.canonical_workspace_id !== null)) {
    throw invalidRecord('global scope shape');
  }

  if (status === 'running') {
    if (r.payload_hash !== null || r.source_schema_version !== null || r.revision !== null
      || r.finished_at !== null || r.error_code !== null) {
      throw invalidRecord('running field combination');
    }
  } else if (status === 'completed') {
    if (r.payload_hash === null || r.source_schema_version === null || r.revision === null
      || r.finished_at === null || r.error_code !== null) {
      throw invalidRecord('completed field combination');
    }
  } else {
    if (r.revision !== null || r.finished_at === null || r.error_code === null) {
      throw invalidRecord('terminal field combination');
    }
  }

  return {
    id: r.id,
    migrationKind,
    sourceKey,
    scopeKind,
    scopeKey: r.scope_key,
    canonicalWorkspaceId: r.canonical_workspace_id,
    sourceHash: r.source_hash,
    payloadHash: r.payload_hash,
    hashAlgorithm: LEGACY_HASH_ALGORITHM,
    sourceSchemaVersion: r.source_schema_version,
    compatibilitySchemaVersion: LEGACY_COMPATIBILITY_SCHEMA_VERSION,
    status,
    attempt: r.attempt,
    revision: r.revision,
    entityCount: r.entity_count,
    errorCode: r.error_code,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Transactional Registry for M2.7 legacy data migrations. Uses the injected
 * database; it never opens a real database itself. Mutation helpers join the
 * caller's `BEGIN IMMEDIATE` transaction when one is active, and otherwise
 * open their own atomic unit. There is no DELETE and no arbitrary UPDATE.
 */
export class LegacyDataMigrationRepository {
  constructor(private readonly db: RepositoryDatabase) {}

  private atomically<T>(fn: () => T): T {
    if (this.db.isTransaction === true) {
      return fn();
    }
    return inTransaction(this.db, fn);
  }

  private selectOne(sql: string, ...params: unknown[]): LegacyDataMigrationRecord | null {
    const row = this.db.prepare(sql).get(...params);
    if (row === undefined || row === null) return null;
    return validateLegacyDataMigrationRow(row);
  }

  findById(id: string): LegacyDataMigrationRecord | null {
    if (!isNonEmptyString(id)) throw invalidRecord('id');
    return this.selectOne(`SELECT ${ROW_COLUMNS} FROM legacy_data_migrations WHERE id = ?`, id);
  }

  /** Completed no-op row for the Scope plus exact source identity. */
  findCompletedByExactSource(scope: LegacyMigrationScope): LegacyDataMigrationRecord | null {
    assertScope(scope);
    return this.selectOne(
      `SELECT ${ROW_COLUMNS} FROM legacy_data_migrations
       WHERE migration_kind = ? AND source_key = ? AND scope_kind = ? AND scope_key = ?
         AND source_hash = ? AND hash_algorithm = ? AND compatibility_schema_version = ?
         AND status = 'completed'`,
      scope.migrationKind, scope.sourceKey, scope.scopeKind, scope.scopeKey,
      scope.sourceHash, LEGACY_HASH_ALGORITHM, LEGACY_COMPATIBILITY_SCHEMA_VERSION,
    );
  }

  /** Latest accepted Completed state: revision DESC, then attempt DESC. */
  findLatestAcceptedCompleted(scope: LegacyMigrationScope): LegacyDataMigrationRecord | null {
    assertScope(scope);
    return this.selectOne(
      `SELECT ${ROW_COLUMNS} FROM legacy_data_migrations
       WHERE migration_kind = ? AND source_key = ? AND scope_kind = ? AND scope_key = ?
         AND status = 'completed'
       ORDER BY revision DESC, attempt DESC
       LIMIT 1`,
      scope.migrationKind, scope.sourceKey, scope.scopeKind, scope.scopeKey,
    );
  }

  findRunningByScope(scope: LegacyMigrationScope): LegacyDataMigrationRecord | null {
    assertScope(scope);
    return this.selectOne(
      `SELECT ${ROW_COLUMNS} FROM legacy_data_migrations
       WHERE migration_kind = ? AND source_key = ? AND scope_kind = ? AND scope_key = ?
         AND status = 'running'`,
      scope.migrationKind, scope.sourceKey, scope.scopeKind, scope.scopeKey,
    );
  }

  /**
   * Reconcile the target Scope's stale Running Attempt, allocate the next
   * Attempt and INSERT the new Running row as one atomic unit. Callers that
   * already hold `BEGIN IMMEDIATE` are joined; otherwise this method opens
   * its own transaction. Never invoked by a lock contender.
   */
  reconcileStaleRunningAndReserveAttempt(input: ReserveAttemptInput): LegacyDataMigrationRecord {
    assertScope(input);
    if (!isNonEmptyString(input.migrationId)) throw invalidRecord('migration id');
    if (!isValidTimestamp(input.now)) throw invalidRecord('now');
    return this.atomically(() => {
      const stale = this.findRunningByScope(input);
      if (stale !== null) {
        this.db.prepare(`
          UPDATE legacy_data_migrations
          SET status = 'failed', error_code = ?, finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(LEGACY_DATA_MIGRATION_INTERRUPTED, input.now, input.now, stale.id);
      }
      const attemptRow = this.db.prepare(`
        SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt
        FROM legacy_data_migrations
        WHERE migration_kind = ? AND source_key = ? AND scope_kind = ? AND scope_key = ?
      `).get(input.migrationKind, input.sourceKey, input.scopeKind, input.scopeKey) as { next_attempt: number };
      const attempt = attemptRow.next_attempt;
      if (!isPositiveInt(attempt)) throw invalidRecord('attempt allocation');
      this.db.prepare(`
        INSERT INTO legacy_data_migrations (
          id, migration_kind, source_key, scope_kind, scope_key, canonical_workspace_id,
          source_hash, payload_hash, hash_algorithm, source_schema_version,
          compatibility_schema_version, status, attempt, revision, entity_count,
          error_code, created_at, started_at, finished_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, 'running', ?, NULL, 0, NULL, ?, ?, NULL, ?)
      `).run(
        input.migrationId, input.migrationKind, input.sourceKey, input.scopeKind, input.scopeKey,
        input.canonicalWorkspaceId, input.sourceHash, LEGACY_HASH_ALGORITHM,
        LEGACY_COMPATIBILITY_SCHEMA_VERSION, attempt, input.now, input.now, input.now,
      );
      const record = this.findById(input.migrationId);
      if (record === null) throw invalidState('reserved attempt missing');
      return record;
    });
  }

  private requireRunning(id: string): LegacyDataMigrationRecord {
    const record = this.findById(id);
    if (record === null) throw invalidState('attempt not found');
    if (record.status !== 'running') throw invalidState('terminal attempts cannot transition');
    return record;
  }

  transitionRunningToCompleted(id: string, input: CompleteAttemptInput): LegacyDataMigrationRecord {
    if (!isValidHash(input.payloadHash)) throw invalidRecord('payload_hash');
    if (!isPositiveInt(input.sourceSchemaVersion)) throw invalidRecord('source_schema_version');
    if (!isPositiveInt(input.revision)) throw invalidRecord('revision');
    if (!isNonNegativeInt(input.entityCount)) throw invalidRecord('entity_count');
    if (!isValidTimestamp(input.finishedAt)) throw invalidRecord('finished_at');
    if (!isValidTimestamp(input.updatedAt)) throw invalidRecord('updated_at');
    this.requireRunning(id);
    this.db.prepare(`
      UPDATE legacy_data_migrations
      SET status = 'completed', payload_hash = ?, source_schema_version = ?, revision = ?,
          entity_count = ?, error_code = NULL, finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(
      input.payloadHash, input.sourceSchemaVersion, input.revision,
      input.entityCount, input.finishedAt, input.updatedAt, id,
    );
    const record = this.findById(id);
    if (record === null || record.status !== 'completed') throw invalidState('completion not applied');
    return record;
  }

  transitionRunningToFailed(id: string, input: FailAttemptInput): LegacyDataMigrationRecord {
    if (!isStableErrorCode(input.errorCode)) throw invalidRecord('error_code');
    if (!isValidTimestamp(input.finishedAt)) throw invalidRecord('finished_at');
    if (!isValidTimestamp(input.updatedAt)) throw invalidRecord('updated_at');
    this.requireRunning(id);
    this.db.prepare(`
      UPDATE legacy_data_migrations
      SET status = 'failed', error_code = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(input.errorCode, input.finishedAt, input.updatedAt, id);
    const record = this.findById(id);
    if (record === null || record.status !== 'failed') throw invalidState('failure not applied');
    return record;
  }

  transitionRunningToQuarantined(id: string, input: QuarantineAttemptInput): LegacyDataMigrationRecord {
    if (!isStableErrorCode(input.errorCode)) throw invalidRecord('error_code');
    if (!isValidTimestamp(input.finishedAt)) throw invalidRecord('finished_at');
    if (!isValidTimestamp(input.updatedAt)) throw invalidRecord('updated_at');
    if (input.payloadHash !== undefined && !isValidHash(input.payloadHash)) throw invalidRecord('payload_hash');
    if (input.sourceSchemaVersion !== undefined && !isPositiveInt(input.sourceSchemaVersion)) {
      throw invalidRecord('source_schema_version');
    }
    if (input.entityCount !== undefined && !isNonNegativeInt(input.entityCount)) {
      throw invalidRecord('entity_count');
    }
    this.requireRunning(id);
    this.db.prepare(`
      UPDATE legacy_data_migrations
      SET status = 'quarantined', error_code = ?,
          payload_hash = COALESCE(?, payload_hash),
          source_schema_version = COALESCE(?, source_schema_version),
          entity_count = COALESCE(?, entity_count),
          finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(
      input.errorCode,
      input.payloadHash ?? null,
      input.sourceSchemaVersion ?? null,
      input.entityCount ?? null,
      input.finishedAt, input.updatedAt, id,
    );
    const record = this.findById(id);
    if (record === null || record.status !== 'quarantined') throw invalidState('quarantine not applied');
    return record;
  }
}
