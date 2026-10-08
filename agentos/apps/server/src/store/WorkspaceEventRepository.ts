import type {
  CentralRuntimeEventRegistry,
  WorkspaceEventDraft,
  WorkspaceEventEnvelope,
} from '@agentos/shared';
import { canonicalizeJson } from '../snapshots/canonicalJson.js';
import { isCanonicalUtcTimestamp } from './CanonicalTimestamp.js';
import { isValidEntityId } from './Identity.js';
import type { TransactionDatabase } from './Transaction.js';

export class WorkspaceEventRepositoryError extends Error {
  constructor(
    readonly code:
      | 'WORKSPACE_EVENT_ID_INVALID'
      | 'WORKSPACE_EVENT_TIMESTAMP_INVALID'
      | 'WORKSPACE_EVENT_EPHEMERAL_NOT_PERSISTABLE'
      | 'WORKSPACE_EVENT_PERSISTENCE_FAILED'
      | 'WORKSPACE_EVENT_READ_FAILED',
    message: string,
  ) {
    super(code + ': ' + message);
    this.name = 'WorkspaceEventRepositoryError';
  }
}

/** One persisted `workspace_events` row, run-free by construction. */
export interface WorkspaceEventRecord {
  readonly id: string;
  readonly schemaVersion: number;
  readonly type: string;
  readonly workspaceId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly source: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly parentEventId: string | null;
  readonly severity: string;
  readonly visibility: string;
  readonly durability: string;
  readonly payload: Record<string, unknown>;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: string;
}

interface WorkspaceEventRow {
  id: string;
  schema_version: number;
  type: string;
  workspace_id: string;
  sequence: number;
  timestamp: string;
  source: string;
  correlation_id: string;
  causation_id: string;
  parent_event_id: string | null;
  severity: string;
  visibility: string;
  durability: string;
  payload_json: string;
  metadata_json: string | null;
  created_at: string;
}

const EVENT_COLUMNS = 'id, schema_version, type, workspace_id, sequence, timestamp, source,'
  + ' correlation_id, causation_id, parent_event_id, severity, visibility, durability,'
  + ' payload_json, metadata_json, created_at';

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Persistence for the frozen MF-5 Workspace Event stream.
 *
 * One narrow adapter over `workspace_events`: the caller owns the SQLite
 * transaction; this repository allocates no sequence, publishes nothing, and
 * notifies nobody. It validates the draft through
 * `CentralRuntimeEventRegistry.publishWorkspace` (envelope shape plus the
 * frozen type allowlist), refuses a non-durable Event, canonicalizes the
 * payload JSON, and inserts exactly one row. It writes no Outbox row, no
 * `runtime_events` row, and no `operations` row.
 *
 * The Run reader cannot serve this table (it requires a non-empty `runId`),
 * so the Workspace-side reader lives here as well: the Write Stream and the
 * Read Stream of one Workspace stay in one module.
 *
 * Authorization: PR #127,
 * `docs/implementation/milestones/MF5-workspace-event-schema-authorization.md`
 * sections 6.2, 7.2, and 10.
 */
export class WorkspaceEventRepository {
  constructor(
    private readonly db: TransactionDatabase,
    private readonly registry: CentralRuntimeEventRegistry,
  ) {}

  /** One-connection proof for a composing writer; not a second write path. */
  get transactionDatabase(): TransactionDatabase {
    return this.db;
  }

  /**
   * Append one Workspace Event inside an ALREADY ACTIVE transaction. The
   * sequence is supplied by the caller (allocated by
   * `WorkspaceSequenceAllocator` in that same transaction); this method never
   * allocates one itself, so a second sequence space can never appear.
   */
  appendWithinTransaction<TPayload>(
    draft: WorkspaceEventDraft<TPayload>,
  ): WorkspaceEventEnvelope<TPayload> {
    if (!isValidEntityId(draft.id, 'event')) {
      throw new WorkspaceEventRepositoryError(
        'WORKSPACE_EVENT_ID_INVALID',
        'Workspace Event id must be a canonical evt_ ULID',
      );
    }
    if (!isCanonicalUtcTimestamp(draft.timestamp)) {
      throw new WorkspaceEventRepositoryError(
        'WORKSPACE_EVENT_TIMESTAMP_INVALID',
        'Workspace Event timestamp must be canonical UTC ISO 8601 milliseconds',
      );
    }
    const event = this.registry.publishWorkspace(draft);
    if (event.durability !== 'durable') {
      throw new WorkspaceEventRepositoryError(
        'WORKSPACE_EVENT_EPHEMERAL_NOT_PERSISTABLE',
        'Ephemeral Workspace Events must not be written to workspace_events',
      );
    }

    let payloadJson: string;
    let metadataJson: string | null;
    try {
      payloadJson = canonicalizeJson(event.payload);
      metadataJson = event.metadata === undefined ? null : canonicalizeJson(event.metadata);
    } catch (error) {
      throw new WorkspaceEventRepositoryError(
        'WORKSPACE_EVENT_PERSISTENCE_FAILED',
        error instanceof Error ? error.message : 'Workspace Event JSON serialization failed',
      );
    }

    try {
      this.db.prepare(`
        INSERT INTO workspace_events (
          id, schema_version, type, workspace_id, sequence, timestamp, source,
          correlation_id, causation_id, parent_event_id, severity, visibility,
          durability, payload_json, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.schemaVersion,
        event.type,
        event.workspaceId,
        event.sequence,
        event.timestamp,
        event.source,
        event.correlationId,
        event.causationId,
        event.parentEventId ?? null,
        event.severity,
        event.visibility,
        event.durability,
        payloadJson,
        metadataJson,
        event.timestamp,
      );
    } catch {
      throw new WorkspaceEventRepositoryError(
        'WORKSPACE_EVENT_PERSISTENCE_FAILED',
        'Workspace Event could not be persisted',
      );
    }
    return event;
  }

  findById(workspaceId: string, eventId: string): WorkspaceEventRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(eventId)) return undefined;
    return this.readOne(
      'SELECT ' + EVENT_COLUMNS + ' FROM workspace_events WHERE workspace_id = ? AND id = ?',
      workspaceId, eventId,
    );
  }

  findByWorkspaceAndSequence(workspaceId: string, sequence: number): WorkspaceEventRecord | undefined {
    if (!nonBlank(workspaceId) || !Number.isSafeInteger(sequence) || sequence < 1) return undefined;
    return this.readOne(
      'SELECT ' + EVENT_COLUMNS + ' FROM workspace_events WHERE workspace_id = ? AND sequence = ?',
      workspaceId, sequence,
    );
  }

  /**
   * Ordered Workspace history after a sequence cursor. `afterSequence` is
   * exclusive, so a caller can page one Event at a time in the frozen
   * per-Workspace append order.
   */
  listByWorkspaceAfterSequence(
    workspaceId: string,
    afterSequence: number,
    limit = 100,
  ): WorkspaceEventRecord[] {
    if (!nonBlank(workspaceId)) return [];
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new WorkspaceEventRepositoryError(
        'WORKSPACE_EVENT_READ_FAILED',
        'afterSequence must be a non-negative safe integer',
      );
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new WorkspaceEventRepositoryError(
        'WORKSPACE_EVENT_READ_FAILED',
        'limit must be a positive safe integer',
      );
    }
    return this.readMany(
      'SELECT ' + EVENT_COLUMNS + ' FROM workspace_events'
        + ' WHERE workspace_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?',
      workspaceId, afterSequence, limit,
    );
  }

  countForWorkspace(workspaceId: string): number {
    if (!nonBlank(workspaceId)) return 0;
    try {
      const row = this.db.prepare(
        'SELECT COUNT(*) AS total FROM workspace_events WHERE workspace_id = ?',
      ).get(workspaceId) as { total: number | bigint } | undefined;
      if (row === undefined) return 0;
      return typeof row.total === 'bigint' ? Number(row.total) : row.total;
    } catch {
      throw new WorkspaceEventRepositoryError(
        'WORKSPACE_EVENT_READ_FAILED',
        'Workspace Events could not be counted',
      );
    }
  }

  private readOne(sql: string, ...parameters: readonly (string | number)[]): WorkspaceEventRecord | undefined {
    try {
      const row = this.db.prepare(sql).get(...parameters) as WorkspaceEventRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    } catch (error) {
      throw new WorkspaceEventRepositoryError(
        'WORKSPACE_EVENT_READ_FAILED',
        error instanceof Error ? error.message : 'Workspace Event could not be read',
      );
    }
  }

  private readMany(sql: string, ...parameters: readonly (string | number)[]): WorkspaceEventRecord[] {
    try {
      const rows = this.db.prepare(sql).all(...parameters) as WorkspaceEventRow[];
      return rows.map(toRecord);
    } catch (error) {
      throw new WorkspaceEventRepositoryError(
        'WORKSPACE_EVENT_READ_FAILED',
        error instanceof Error ? error.message : 'Workspace Events could not be read',
      );
    }
  }
}

function toRecord(row: WorkspaceEventRow): WorkspaceEventRecord {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    type: row.type,
    workspaceId: row.workspace_id,
    sequence: row.sequence,
    timestamp: row.timestamp,
    source: row.source,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    parentEventId: row.parent_event_id,
    severity: row.severity,
    visibility: row.visibility,
    durability: row.durability,
    payload: parseJsonObject(row.payload_json, row.id),
    metadata: row.metadata_json === null ? null : parseJsonObject(row.metadata_json, row.id),
    createdAt: row.created_at,
  };
}

function parseJsonObject(json: string, eventId: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new WorkspaceEventRepositoryError(
      'WORKSPACE_EVENT_READ_FAILED',
      'Workspace Event ' + eventId + ' carries unreadable JSON',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WorkspaceEventRepositoryError(
      'WORKSPACE_EVENT_READ_FAILED',
      'Workspace Event ' + eventId + ' carries a non-object payload',
    );
  }
  return parsed as Record<string, unknown>;
}
