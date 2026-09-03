import type {
  CentralRuntimeEventRegistry,
  RuntimeEventConsumptionResult,
  RuntimeEventDraft,
  RuntimeEventEnvelope,
  RuntimeEventMetadata,
  RuntimeEventContext,
  RuntimeEventSeverity,
  RuntimeEventSource,
  RuntimeEventVisibility,
} from '@agentos/shared';
import { canonicalizeJson } from '../snapshots/canonicalJson.js';
import type { RuntimeEventNotifier } from '../services/RuntimeEventNotifier.js';
import { isTransactionActive, registerAfterCommit, type TransactionDatabase } from './Transaction.js';
import { createEntityId, isValidEntityId } from './Identity.js';
import { isCanonicalUtcTimestamp } from './CanonicalTimestamp.js';
import type { RunSequenceAllocator } from './RunSequenceAllocator.js';
import type { OutboxMessage, OutboxRepository } from './OutboxRepository.js';

export class RuntimeEventRepositoryError extends Error {
  constructor(
    readonly code:
      | 'RUNTIME_EVENT_ID_INVALID'
      | 'RUNTIME_EVENT_TIMESTAMP_INVALID'
      | 'RUNTIME_EVENT_EPHEMERAL_NOT_PERSISTABLE'
      | 'RUNTIME_EVENT_PERSISTENCE_FAILED'
      | 'RUNTIME_EVENT_READ_FAILED',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RuntimeEventRepositoryError';
  }
}

/**
 * One narrow adapter over the existing M3 Event Store + Outbox. P2B
 * repositories receive this interface rather than constructing a second
 * persistence path. The caller owns the SQLite transaction; this writer only
 * allocates the canonical Run sequence, appends the Event, and inserts its
 * one Outbox handoff.
 */
export interface DurableRuntimeFactInput {
  readonly type: string;
  readonly workspaceId: string;
  readonly taskId?: string;
  readonly runId: string;
  readonly stageId?: string;
  readonly providerSessionId?: string;
  readonly processId?: string;
  readonly artifactId?: string;
  readonly timestamp: string;
  /**
   * Optional Runtime Event source. Omission preserves the historical
   * process-manager default. When supplied it must equal the Registry
   * definition source for the event type; a caller can never invent a
   * source string the Registry does not own.
   */
  readonly source?: RuntimeEventSource;
  /** Accepted Operation/Run execution context; never generated here. */
  readonly eventContext: RuntimeEventContext;
  readonly metadata?: RuntimeEventMetadata;
  readonly payload: Record<string, unknown>;
}

export interface DurableRuntimeFactResult {
  readonly event: RuntimeEventEnvelope;
  readonly outbox: OutboxMessage;
}

export interface DurableRuntimeFactWriter {
  appendWithinTransaction(input: DurableRuntimeFactInput): DurableRuntimeFactResult;
}

export interface RuntimeEventOutboxWriterOptions {
  readonly createEventId?: () => string;
  readonly createOutboxId?: (eventId: string) => string;
}

function requireContext(context: RuntimeEventContext): RuntimeEventContext {
  if (typeof context?.correlationId !== 'string' || context.correlationId.trim().length === 0) {
    throw new RuntimeEventRepositoryError(
      'RUNTIME_EVENT_PERSISTENCE_FAILED',
      'Durable Runtime fact requires a caller-provided correlationId',
    );
  }
  if (context.correlationId.startsWith('m4-p2b:')) {
    throw new RuntimeEventRepositoryError(
      'RUNTIME_EVENT_PERSISTENCE_FAILED',
      'Synthetic m4-p2b correlationId is forbidden',
    );
  }
  if (typeof context.causationId !== 'string' || context.causationId.trim().length === 0) {
    throw new RuntimeEventRepositoryError(
      'RUNTIME_EVENT_PERSISTENCE_FAILED',
      'Durable Runtime fact requires a caller-provided causationId',
    );
  }
  if (context.parentEventId !== undefined
    && (typeof context.parentEventId !== 'string' || context.parentEventId.trim().length === 0)) {
    throw new RuntimeEventRepositoryError(
      'RUNTIME_EVENT_PERSISTENCE_FAILED',
      'parentEventId must be non-empty when supplied',
    );
  }
  return context;
}

/** Reuses the M3 repositories; it is not a second Event/Outbox store. */
export class RuntimeEventOutboxWriter implements DurableRuntimeFactWriter {
  private readonly createEventId: () => string;
  private readonly createOutboxId: (eventId: string) => string;

  /**
   * Exposes the bound transaction DB so a composing service can prove all of
   * its collaborators share ONE SQLite connection before opening BEGIN
   * IMMEDIATE. This is an identity assertion, not a second persistence path.
   */
  get transactionDatabase(): TransactionDatabase {
    return this.db;
  }

  constructor(
    private readonly runtimeEvents: RuntimeEventRepository,
    private readonly runSequenceAllocator: RunSequenceAllocator,
    private readonly outbox: OutboxRepository,
    private readonly db: TransactionDatabase,
    options: RuntimeEventOutboxWriterOptions = {},
  ) {
    this.createEventId = options.createEventId ?? (() => createEntityId('event'));
    this.createOutboxId = options.createOutboxId ?? (eventId => `outbox_${eventId}`);
    // HIGH-1 round 2: the writer owns the frozen one-BEGIN / one-connection
    // invariant, so construction must fail immediately when ANY internal
    // collaborator is bound to a different TransactionDatabase. Identity
    // assertions (=== on the better-sqlite3 handle) are structural: a caller
    // can never assemble a cross-connection persistence graph whose Runtime
    // Events or Outbox rows would commit through a second connection while
    // Artifact rows commit through this.db.
    if (runtimeEvents.transactionDatabase !== db) {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_PERSISTENCE_FAILED',
        'RuntimeEventOutboxWriter requires its RuntimeEventRepository to share the writer TransactionDatabase',
      );
    }
    if (runSequenceAllocator.transactionDatabase !== db) {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_PERSISTENCE_FAILED',
        'RuntimeEventOutboxWriter requires its RunSequenceAllocator to share the writer TransactionDatabase',
      );
    }
    if (outbox.transactionDatabase !== db) {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_PERSISTENCE_FAILED',
        'RuntimeEventOutboxWriter requires its OutboxRepository to share the writer TransactionDatabase',
      );
    }
    if (outbox.runtimeEventRepository !== runtimeEvents) {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_PERSISTENCE_FAILED',
        'RuntimeEventOutboxWriter requires its OutboxRepository to read through the same RuntimeEventRepository',
      );
    }
  }

  appendWithinTransaction(input: DurableRuntimeFactInput): DurableRuntimeFactResult {
    if (!isTransactionActive(this.db)) {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_PERSISTENCE_FAILED',
        'Durable Runtime facts require an active transaction',
      );
    }
    if (!isCanonicalUtcTimestamp(input.timestamp)) {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_TIMESTAMP_INVALID',
        'Durable Runtime fact timestamp must be canonical UTC ISO 8601 milliseconds',
      );
    }

    const context = requireContext(input.eventContext);
    this.#assertReferenceBindings(input);
    this.#assertCausalReferences(input, context);

    const sequence = this.runSequenceAllocator.allocateWithinTransaction(input.workspaceId, input.runId);
    const event = this.runtimeEvents.appendWithinTransaction({
      id: this.createEventId(),
      schemaVersion: 1,
      type: input.type,
      workspaceId: input.workspaceId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      runId: input.runId,
      ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
      ...(input.providerSessionId === undefined ? {} : { providerSessionId: input.providerSessionId }),
      ...(input.processId === undefined ? {} : { processId: input.processId }),
      ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
      sequence,
      timestamp: input.timestamp,
      source: input.source ?? 'process-manager',
      correlationId: context.correlationId,
      causationId: context.causationId,
      ...(context.parentEventId === undefined ? {} : { parentEventId: context.parentEventId }),
      payload: input.payload,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
    const outbox = this.outbox.insertWithinTransaction({
      id: this.createOutboxId(event.id),
      eventId: event.id,
      availableAt: input.timestamp,
      createdAt: input.timestamp,
    });
    return { event, outbox };
  }

  /**
   * Event tables intentionally do not carry every M4 resource FK.  Validate
   * the same-transaction bindings at this one write boundary instead of
   * allowing a repository caller to emit a cross-Run/Stage/Process fact.
   */
  #assertReferenceBindings(input: DurableRuntimeFactInput): void {
    const run = this.db.prepare(`
      SELECT task_id FROM runs WHERE workspace_id = ? AND id = ?
    `).get(input.workspaceId, input.runId) as { task_id: string } | undefined;
    if (run === undefined) {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_PERSISTENCE_FAILED',
        'Runtime fact run reference is missing or workspace-mismatched',
      );
    }
    if (input.taskId !== undefined && input.taskId !== run.task_id) {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_PERSISTENCE_FAILED',
        'Runtime fact task reference is not bound to the Run',
      );
    }
    if (input.stageId !== undefined) {
      const stage = this.db.prepare(`
        SELECT 1 FROM run_stages
        WHERE workspace_id = ? AND id = ? AND run_id = ?
      `).get(input.workspaceId, input.stageId, input.runId);
      if (stage === undefined) {
        throw new RuntimeEventRepositoryError(
          'RUNTIME_EVENT_PERSISTENCE_FAILED',
          'Runtime fact stage reference is missing or Run-mismatched',
        );
      }
    }
    let process: {
      stage_id: string | null;
      provider_session_id: string | null;
      authority_role: string | null;
    } | undefined;
    if (input.processId !== undefined) {
      process = this.db.prepare(`
        SELECT stage_id, provider_session_id, authority_role
        FROM runtime_processes
        WHERE workspace_id = ? AND id = ? AND run_id = ?
      `).get(input.workspaceId, input.processId, input.runId) as typeof process;
      if (process === undefined) {
        throw new RuntimeEventRepositoryError(
          'RUNTIME_EVENT_PERSISTENCE_FAILED',
          'Runtime fact process reference is missing or Run-mismatched',
        );
      }
      if (input.stageId !== undefined && process.stage_id !== input.stageId) {
        throw new RuntimeEventRepositoryError(
          'RUNTIME_EVENT_PERSISTENCE_FAILED',
          'Runtime fact process/stage references do not match',
        );
      }
      if (input.providerSessionId !== undefined
        && process.provider_session_id !== input.providerSessionId) {
        throw new RuntimeEventRepositoryError(
          'RUNTIME_EVENT_PERSISTENCE_FAILED',
          'Runtime fact process/session references do not match',
        );
      }
      if (input.type === 'process.launch_requested' && process.authority_role === 'primary-provider'
        && (input.stageId === undefined || input.providerSessionId === undefined)) {
        throw new RuntimeEventRepositoryError(
          'RUNTIME_EVENT_PERSISTENCE_FAILED',
          'Provider-root launch fact requires Stage and ProviderSession references',
        );
      }
    }
    if (input.providerSessionId !== undefined) {
      const session = this.db.prepare(`
        SELECT stage_id FROM provider_sessions
        WHERE workspace_id = ? AND id = ? AND run_id = ?
      `).get(input.workspaceId, input.providerSessionId, input.runId) as { stage_id: string } | undefined;
      if (session === undefined) {
        throw new RuntimeEventRepositoryError(
          'RUNTIME_EVENT_PERSISTENCE_FAILED',
          'Runtime fact ProviderSession reference is missing or Run-mismatched',
        );
      }
      if (input.stageId !== undefined && session.stage_id !== input.stageId) {
        throw new RuntimeEventRepositoryError(
          'RUNTIME_EVENT_PERSISTENCE_FAILED',
          'Runtime fact session/stage references do not match',
        );
      }
    }
    if (input.artifactId !== undefined && input.processId !== undefined) {
      const artifact = this.db.prepare(`
        SELECT 1 FROM process_output_references
        WHERE workspace_id = ? AND run_id = ? AND process_id = ? AND artifact_id = ?
      `).get(input.workspaceId, input.runId, input.processId, input.artifactId);
      if (artifact === undefined) {
        throw new RuntimeEventRepositoryError(
          'RUNTIME_EVENT_PERSISTENCE_FAILED',
          'Runtime fact artifact reference is not bound to the Process output reference',
        );
      }
    }

    if (input.type === 'artifact.diff.registered') {
      this.#assertCanonicalDiffArtifactBinding(input);
    }
  }

  /**
   * artifact.diff.registered must reference a real canonical Artifact inserted
   * (possibly earlier in the SAME transaction) in this Workspace/Run, with a
   * content hash/size that exactly matches the Event payload. The Registry can
   * only validate the payload shape; this closes the DB binding hole so a fake
   * or mismatched Artifact can never be published.
   */
  #assertCanonicalDiffArtifactBinding(input: DurableRuntimeFactInput): void {
    const fail = (message: string): never => {
      throw new RuntimeEventRepositoryError('RUNTIME_EVENT_PERSISTENCE_FAILED', message);
    };
    const artifactId = input.artifactId;
    if (artifactId === undefined || artifactId.trim().length === 0) {
      fail('artifact.diff.registered requires an envelope artifactId');
    }
    const payload = input.payload;
    if (payload.artifactId !== artifactId) {
      fail('artifact.diff.registered envelope artifactId must equal payload artifactId');
    }
    const row = this.db.prepare(`
      SELECT workspace_id, provenance_kind, canonical_run_id, artifact_type, content_available, sha256, size_bytes
      FROM runtime_artifacts
      WHERE id = ?
    `).get(artifactId) as {
      workspace_id: string;
      provenance_kind: string;
      canonical_run_id: string | null;
      artifact_type: string;
      content_available: number;
      sha256: string | null;
      size_bytes: number;
    } | undefined;
    if (row === undefined) {
      fail('artifact.diff.registered references a nonexistent Artifact');
    }
    const artifact = row as {
      workspace_id: string;
      provenance_kind: string;
      canonical_run_id: string | null;
      artifact_type: string;
      content_available: number;
      sha256: string | null;
      size_bytes: number;
    };
    if (artifact.artifact_type !== 'diff') {
      fail('artifact.diff.registered requires an Artifact whose artifact_type is diff');
    }
    if (artifact.workspace_id !== input.workspaceId) {
      fail('artifact.diff.registered Artifact belongs to another Workspace');
    }
    if (artifact.provenance_kind !== 'CANONICAL') {
      fail('artifact.diff.registered requires a CANONICAL provenance Artifact');
    }
    if (artifact.canonical_run_id !== input.runId) {
      fail('artifact.diff.registered Artifact belongs to another canonical Run');
    }
    if (artifact.content_available !== 1) {
      fail('artifact.diff.registered requires a content-available Artifact');
    }
    if (artifact.sha256 === null || artifact.sha256 !== payload.contentHash) {
      fail('artifact.diff.registered content hash does not match the Artifact');
    }
    if (artifact.size_bytes !== payload.sizeBytes) {
      fail('artifact.diff.registered size does not match the Artifact');
    }
  }

  #assertCausalReferences(
    input: DurableRuntimeFactInput,
    context: RuntimeEventContext,
  ): void {
    const check = (id: string, field: string): void => {
      if (!id.startsWith('evt_')) return;
      if (!isValidEntityId(id, 'event')) {
        throw new RuntimeEventRepositoryError(
          'RUNTIME_EVENT_PERSISTENCE_FAILED',
          `${field} is not a canonical Runtime Event id`,
        );
      }
      const row = this.db.prepare(`
        SELECT workspace_id, run_id, sequence FROM runtime_events WHERE id = ?
      `).get(id) as { workspace_id: string; run_id: string; sequence: number } | undefined;
      if (row === undefined || row.workspace_id !== input.workspaceId || row.run_id !== input.runId) {
        throw new RuntimeEventRepositoryError(
          'RUNTIME_EVENT_PERSISTENCE_FAILED',
          `${field} must reference an Event in the same Workspace/Run`,
        );
      }
    };
    check(context.causationId, 'causationId');
    if (context.parentEventId !== undefined) {
      if (!isValidEntityId(context.parentEventId, 'event')) {
        throw new RuntimeEventRepositoryError(
          'RUNTIME_EVENT_PERSISTENCE_FAILED',
          'parentEventId must be a canonical Runtime Event id',
        );
      }
      check(context.parentEventId, 'parentEventId');
    }
    if (input.type === 'process.failed'
      && input.payload.outcome === 'spawn-failure-after-cancel') {
      const cancelCausationId = input.payload.cancelCausationId;
      if (typeof cancelCausationId !== 'string' || cancelCausationId.trim().length === 0) {
        throw new RuntimeEventRepositoryError(
          'RUNTIME_EVENT_PERSISTENCE_FAILED',
          'After-cancel process.failed requires a caller-provided cancelCausationId',
        );
      }
      check(cancelCausationId, 'cancelCausationId');
    }
  }
}

interface RuntimeEventRow {
  id: string;
  schema_version: number;
  type: string;
  workspace_id: string;
  task_id: string | null;
  run_id: string;
  stage_id: string | null;
  agent_id: string | null;
  provider_config_id: string | null;
  provider_session_id: string | null;
  process_id: string | null;
  worktree_id: string | null;
  artifact_id: string | null;
  approval_request_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  sequence: number;
  timestamp: string;
  source: string;
  correlation_id: string;
  causation_id: string | null;
  parent_event_id: string | null;
  severity: string;
  visibility: string;
  durability: string;
  payload_json: string;
  metadata_json: string | null;
  created_at: string;
}

export interface RuntimeEventRunQuery {
  readonly workspaceId: string;
  readonly runId: string;
  readonly afterSequence: number;
  readonly beforeSequence?: number;
  readonly limit: number;
  readonly types?: readonly string[];
  readonly stageId?: string;
  readonly severity?: RuntimeEventSeverity;
  readonly visibilities?: readonly RuntimeEventVisibility[];
  readonly source?: RuntimeEventSource;
  readonly correlationId?: string;
}

export interface RuntimeEventRunQueryResult {
  readonly results: readonly RuntimeEventConsumptionResult[];
  readonly hasMore: boolean;
}

function toRecord(row: RuntimeEventRow): Record<string, unknown> {
  const payload = JSON.parse(row.payload_json) as unknown;
  const metadata = row.metadata_json === null ? undefined : JSON.parse(row.metadata_json) as unknown;
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    type: row.type,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    sequence: row.sequence,
    timestamp: row.timestamp,
    source: row.source,
    correlationId: row.correlation_id,
    severity: row.severity,
    visibility: row.visibility,
    durability: row.durability,
    payload,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.stage_id === null ? {} : { stageId: row.stage_id }),
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    ...(row.provider_config_id === null ? {} : { providerConfigId: row.provider_config_id }),
    ...(row.provider_session_id === null ? {} : { providerSessionId: row.provider_session_id }),
    ...(row.process_id === null ? {} : { processId: row.process_id }),
    ...(row.worktree_id === null ? {} : { worktreeId: row.worktree_id }),
    ...(row.artifact_id === null ? {} : { artifactId: row.artifact_id }),
    ...(row.approval_request_id === null ? {} : { approvalRequestId: row.approval_request_id }),
    ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
    ...(row.parent_event_id === null ? {} : { parentEventId: row.parent_event_id }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

export class RuntimeEventRepository {
  constructor(
    private readonly db: TransactionDatabase,
    private readonly registry: CentralRuntimeEventRegistry,
    private readonly notifier?: RuntimeEventNotifier,
  ) {}

  /**
   * Exposes the bound transaction DB so a composing writer can prove the
   * repository writes through ONE SQLite connection. This is an identity
   * assertion, not a second persistence path.
   */
  get transactionDatabase(): TransactionDatabase {
    return this.db;
  }

  appendWithinTransaction<TPayload>(draft: RuntimeEventDraft<TPayload>): RuntimeEventEnvelope<TPayload> {
    if (!isValidEntityId(draft.id, 'event')) {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_ID_INVALID',
        'Runtime Event id must be a canonical evt_ ULID',
      );
    }
    if (!isCanonicalUtcTimestamp(draft.timestamp)) {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_TIMESTAMP_INVALID',
        'Runtime Event timestamp must be canonical UTC ISO 8601 milliseconds',
      );
    }
    const event = this.registry.publish(draft);
    if (event.durability !== 'durable') {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_EPHEMERAL_NOT_PERSISTABLE',
        'Ephemeral Runtime Events must not be written to runtime_events',
      );
    }

    let payloadJson: string;
    let metadataJson: string | null;
    try {
      payloadJson = canonicalizeJson(event.payload);
      metadataJson = event.metadata === undefined ? null : canonicalizeJson(event.metadata);
    } catch (error) {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_PERSISTENCE_FAILED',
        error instanceof Error ? error.message : 'Runtime Event JSON serialization failed',
      );
    }

    if (this.notifier && !isTransactionActive(this.db)) {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_PERSISTENCE_FAILED',
        'Runtime Event notification requires an active transaction',
      );
    }

    try {
      this.db.prepare(`
        INSERT INTO runtime_events (
          id, schema_version, type, workspace_id, task_id, run_id, stage_id,
          agent_id, provider_config_id, provider_session_id, process_id, worktree_id,
          artifact_id, approval_request_id, conversation_id, message_id, sequence,
          timestamp, source, correlation_id, causation_id, parent_event_id, severity,
          visibility, durability, payload_json, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.schemaVersion,
        event.type,
        event.workspaceId,
        event.taskId ?? null,
        event.runId,
        event.stageId ?? null,
        event.agentId ?? null,
        event.providerConfigId ?? null,
        event.providerSessionId ?? null,
        event.processId ?? null,
        event.worktreeId ?? null,
        event.artifactId ?? null,
        event.approvalRequestId ?? null,
        event.conversationId ?? null,
        event.messageId ?? null,
        event.sequence,
        event.timestamp,
        event.source,
        event.correlationId,
        event.causationId ?? null,
        event.parentEventId ?? null,
        event.severity,
        event.visibility,
        event.durability,
        payloadJson,
        metadataJson,
        event.timestamp,
      );
    } catch {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_PERSISTENCE_FAILED',
        'Runtime Event could not be persisted',
      );
    }
    if (this.notifier) {
      const registered = registerAfterCommit(this.db, () => {
        this.notifier!.publish({
          runId: event.runId,
          sequence: event.sequence,
          eventId: event.id,
        });
      });
      if (!registered) {
        throw new RuntimeEventRepositoryError(
          'RUNTIME_EVENT_PERSISTENCE_FAILED',
          'Runtime Event notification could not be registered',
        );
      }
    }
    return event;
  }

  findById(eventId: string): RuntimeEventConsumptionResult | undefined {
    return this.consumeRow(this.db.prepare(`
      SELECT * FROM runtime_events WHERE id = ?
    `).get(eventId) as RuntimeEventRow | undefined);
  }

  findByRunAndSequence(runId: string, sequence: number): RuntimeEventConsumptionResult | undefined {
    return this.consumeRow(this.db.prepare(`
      SELECT * FROM runtime_events WHERE run_id = ? AND sequence = ?
    `).get(runId, sequence) as RuntimeEventRow | undefined);
  }

  findDurableByWorkspaceRunAndSequence(
    workspaceId: string,
    runId: string,
    sequence: number,
  ): RuntimeEventConsumptionResult | undefined {
    return this.consumeRow(this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE workspace_id = ? AND run_id = ? AND sequence = ? AND durability = 'durable'
    `).get(workspaceId, runId, sequence) as RuntimeEventRow | undefined);
  }

  listByRunAfterSequence(runId: string, afterSequence: number): RuntimeEventConsumptionResult[] {
    const rows = this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence ASC
    `).all(runId, afterSequence) as RuntimeEventRow[];
    return rows.map(row => this.consumeRow(row)!);
  }

  listByRunAndCorrelation(runId: string, correlationId: string): RuntimeEventConsumptionResult[] {
    const rows = this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE run_id = ? AND correlation_id = ?
      ORDER BY sequence ASC
    `).all(runId, correlationId) as RuntimeEventRow[];
    return rows.map(row => this.consumeRow(row)!);
  }

  queryByRun(input: RuntimeEventRunQuery): RuntimeEventRunQueryResult {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0
      || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200
      || (input.beforeSequence !== undefined
        && (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1))) {
      throw new RuntimeEventRepositoryError('RUNTIME_EVENT_READ_FAILED', 'Runtime Event query is invalid');
    }

    const conditions = ["workspace_id = ?", "run_id = ?", "durability = 'durable'", 'sequence > ?'];
    const parameters: unknown[] = [input.workspaceId, input.runId, input.afterSequence];
    if (input.beforeSequence !== undefined) {
      conditions.push('sequence < ?');
      parameters.push(input.beforeSequence);
    }
    if (input.types && input.types.length > 0) {
      conditions.push(`type IN (${input.types.map(() => '?').join(', ')})`);
      parameters.push(...input.types);
    }
    if (input.stageId !== undefined) {
      conditions.push('stage_id = ?');
      parameters.push(input.stageId);
    }
    if (input.severity !== undefined) {
      conditions.push('severity = ?');
      parameters.push(input.severity);
    }
    if (input.visibilities && input.visibilities.length > 0) {
      conditions.push(`visibility IN (${input.visibilities.map(() => '?').join(', ')})`);
      parameters.push(...input.visibilities);
    }
    if (input.source !== undefined) {
      conditions.push('source = ?');
      parameters.push(input.source);
    }
    if (input.correlationId !== undefined) {
      conditions.push('correlation_id = ?');
      parameters.push(input.correlationId);
    }
    parameters.push(input.limit + 1);

    const rows = this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY sequence ASC
      LIMIT ?
    `).all(...parameters) as RuntimeEventRow[];
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    return {
      results: page.map(row => this.consumeRow(row)!),
      hasMore,
    };
  }

  getRunHighWatermark(workspaceId: string, runId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS high_watermark
      FROM runtime_events
      WHERE workspace_id = ? AND run_id = ? AND durability = 'durable'
    `).get(workspaceId, runId) as { high_watermark: number };
    return row.high_watermark;
  }

  listRunSequencesInRange(
    workspaceId: string,
    runId: string,
    fromSequence: number,
    toSequence: number,
  ): number[] {
    const rows = this.db.prepare(`
      SELECT sequence FROM runtime_events
      WHERE workspace_id = ? AND run_id = ?
        AND durability = 'durable'
        AND sequence >= ? AND sequence <= ?
      ORDER BY sequence ASC
    `).all(workspaceId, runId, fromSequence, toSequence) as { sequence: number }[];
    return rows.map(row => row.sequence);
  }

  private consumeRow(row: RuntimeEventRow | undefined): RuntimeEventConsumptionResult | undefined {
    if (!row) return undefined;
    try {
      return this.registry.consume(toRecord(row));
    } catch {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_READ_FAILED',
        'Persisted Runtime Event could not be consumed',
      );
    }
  }
}
