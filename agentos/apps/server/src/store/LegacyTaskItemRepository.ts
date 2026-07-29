import { createHash } from 'node:crypto';

import type { TransactionDatabase } from './Transaction.js';
import { canonicalizeLegacyJson } from '../services/LegacySourceParser.js';
import { LEGACY_COMPATIBILITY_SCHEMA_VERSION, LEGACY_HASH_ALGORITHM } from './LegacyDataMigrationRepository.js';

export const LEGACY_TASK_ITEM_INVALID_RECORD = 'LEGACY_TASK_ITEM_INVALID_RECORD' as const;

/** Stable, payload-free compatibility storage failure. */
export class LegacyTaskItemError extends Error {
  readonly code: string;

  constructor(code: string, reason: string) {
    super(`${code}: ${reason}`);
    this.name = 'LegacyTaskItemError';
    this.code = code;
  }
}

export interface LegacyTaskItemRecord {
  workspaceScopeId: string;
  canonicalWorkspaceId: string | null;
  legacyTaskId: string;
  revision: number;
  migrationId: string;
  sourceHash: string;
  payloadHash: string;
  sourceSchemaVersion: number;
  compatibilitySchemaVersion: typeof LEGACY_COMPATIBILITY_SCHEMA_VERSION;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface InsertAcceptedSnapshotInput {
  workspaceScopeId: string;
  canonicalWorkspaceId: string | null;
  legacyTaskId: string;
  revision: number;
  migrationId: string;
  sourceHash: string;
  payloadHash: string;
  sourceSchemaVersion: number;
  /** Complete semantic-lossless TaskItem snapshot, unknown fields included. */
  payload: Record<string, unknown>;
  createdAt: string;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function invalidRecord(reason: string): LegacyTaskItemError {
  return new LegacyTaskItemError(LEGACY_TASK_ITEM_INVALID_RECORD, reason);
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

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ROW_COLUMNS = `
  workspace_scope_id, canonical_workspace_id, legacy_task_id, revision, migration_id,
  source_hash, payload_hash, source_schema_version, compatibility_schema_version,
  payload_json, created_at
`;

/** Strictly validate one stored compatibility row; malformed rows fail closed. */
export function validateLegacyTaskItemRow(row: unknown): LegacyTaskItemRecord {
  if (typeof row !== 'object' || row === null) throw invalidRecord('row shape');
  const r = row as Record<string, unknown>;
  if (!isNonEmptyString(r.workspace_scope_id)) throw invalidRecord('workspace_scope_id');
  if (r.canonical_workspace_id !== null && !isNonEmptyString(r.canonical_workspace_id)) {
    throw invalidRecord('canonical_workspace_id');
  }
  if (!isNonEmptyString(r.legacy_task_id)) throw invalidRecord('legacy_task_id');
  if (!isPositiveInt(r.revision)) throw invalidRecord('revision');
  if (!isNonEmptyString(r.migration_id)) throw invalidRecord('migration_id');
  if (!isValidHash(r.source_hash)) throw invalidRecord('source_hash');
  if (!isValidHash(r.payload_hash)) throw invalidRecord('payload_hash');
  if (!isPositiveInt(r.source_schema_version)) throw invalidRecord('source_schema_version');
  if (r.compatibility_schema_version !== LEGACY_COMPATIBILITY_SCHEMA_VERSION) {
    throw invalidRecord('compatibility_schema_version');
  }
  if (!isNonEmptyString(r.payload_json)) throw invalidRecord('payload_json');
  if (!isValidTimestamp(r.created_at)) throw invalidRecord('created_at');

  let payload: unknown;
  try {
    payload = JSON.parse(r.payload_json);
  } catch {
    throw invalidRecord('payload_json validity');
  }
  if (!isPlainObject(payload)) throw invalidRecord('payload shape');
  const canonical = canonicalizeLegacyJson(payload);
  if (canonical !== r.payload_json) throw invalidRecord('payload canonical form');
  if (createHash(LEGACY_HASH_ALGORITHM).update(r.payload_json).digest('hex') !== r.payload_hash) {
    throw invalidRecord('payload hash mismatch');
  }

  return {
    workspaceScopeId: r.workspace_scope_id,
    canonicalWorkspaceId: r.canonical_workspace_id,
    legacyTaskId: r.legacy_task_id,
    revision: r.revision,
    migrationId: r.migration_id,
    sourceHash: r.source_hash,
    payloadHash: r.payload_hash,
    sourceSchemaVersion: r.source_schema_version,
    compatibilitySchemaVersion: LEGACY_COMPATIBILITY_SCHEMA_VERSION,
    payload,
    createdAt: r.created_at,
  };
}

/**
 * Append-only Legacy Task compatibility storage. It only INSERTs complete
 * accepted snapshots keyed by (workspace_scope_id, legacy_task_id, revision);
 * it never creates canonical Task/Run/Artifact/Snapshot/Stage records, never
 * modifies Legacy JSON, and exposes no UPDATE or DELETE. The only UPDATE the
 * database may ever perform is the Workspace-FK-driven canonical link
 * nulling, which this Repository never issues itself.
 */
export class LegacyTaskItemRepository {
  constructor(private readonly db: TransactionDatabase) {}

  private selectOne(sql: string, ...params: unknown[]): LegacyTaskItemRecord | null {
    const row = this.db.prepare(sql).get(...params);
    if (row === undefined || row === null) return null;
    return validateLegacyTaskItemRow(row);
  }

  /**
   * INSERT one complete accepted snapshot. One migration record may write a
   * scoped Task only once; the database UNIQUE constraint enforces it and the
   * resulting error is intentionally propagated.
   */
  insertAcceptedSnapshot(input: InsertAcceptedSnapshotInput): LegacyTaskItemRecord {
    if (!isNonEmptyString(input.workspaceScopeId)) throw invalidRecord('workspace_scope_id');
    if (input.canonicalWorkspaceId !== null && !isNonEmptyString(input.canonicalWorkspaceId)) {
      throw invalidRecord('canonical_workspace_id');
    }
    if (!isNonEmptyString(input.legacyTaskId)) throw invalidRecord('legacy_task_id');
    if (!isPositiveInt(input.revision)) throw invalidRecord('revision');
    if (!isNonEmptyString(input.migrationId)) throw invalidRecord('migration_id');
    if (!isValidHash(input.sourceHash)) throw invalidRecord('source_hash');
    if (!isValidHash(input.payloadHash)) throw invalidRecord('payload_hash');
    if (!isPositiveInt(input.sourceSchemaVersion)) throw invalidRecord('source_schema_version');
    if (!isPlainObject(input.payload)) throw invalidRecord('payload shape');
    if (!isValidTimestamp(input.createdAt)) throw invalidRecord('created_at');

    const canonical = canonicalizeLegacyJson(input.payload);
    if (createHash(LEGACY_HASH_ALGORITHM).update(canonical).digest('hex') !== input.payloadHash) {
      throw invalidRecord('payload hash mismatch');
    }

    this.db.prepare(`
      INSERT INTO legacy_task_items (
        workspace_scope_id, canonical_workspace_id, legacy_task_id, revision, migration_id,
        source_hash, payload_hash, source_schema_version, compatibility_schema_version,
        payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.workspaceScopeId, input.canonicalWorkspaceId, input.legacyTaskId, input.revision,
      input.migrationId, input.sourceHash, input.payloadHash, input.sourceSchemaVersion,
      LEGACY_COMPATIBILITY_SCHEMA_VERSION, canonical, input.createdAt,
    );

    const record = this.findByRevision(input.workspaceScopeId, input.legacyTaskId, input.revision);
    if (record === null) throw invalidRecord('inserted snapshot missing');
    return record;
  }

  findByRevision(
    workspaceScopeId: string,
    legacyTaskId: string,
    revision: number,
  ): LegacyTaskItemRecord | null {
    return this.selectOne(
      `SELECT ${ROW_COLUMNS} FROM legacy_task_items
       WHERE workspace_scope_id = ? AND legacy_task_id = ? AND revision = ?`,
      workspaceScopeId, legacyTaskId, revision,
    );
  }

  findCurrentHighestRevision(
    workspaceScopeId: string,
    legacyTaskId: string,
  ): LegacyTaskItemRecord | null {
    return this.selectOne(
      `SELECT ${ROW_COLUMNS} FROM legacy_task_items
       WHERE workspace_scope_id = ? AND legacy_task_id = ?
       ORDER BY revision DESC
       LIMIT 1`,
      workspaceScopeId, legacyTaskId,
    );
  }
}
