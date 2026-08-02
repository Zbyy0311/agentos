import type {
  CentralRuntimeEventRegistry,
  RuntimeEventConsumptionResult,
  RuntimeEventDraft,
  RuntimeEventEnvelope,
} from '@agentos/shared';
import { canonicalizeJson } from '../snapshots/canonicalJson.js';
import type { TransactionDatabase } from './Transaction.js';

export class RuntimeEventRepositoryError extends Error {
  constructor(
    readonly code: 'RUNTIME_EVENT_EPHEMERAL_NOT_PERSISTABLE' | 'RUNTIME_EVENT_PERSISTENCE_FAILED' | 'RUNTIME_EVENT_READ_FAILED',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RuntimeEventRepositoryError';
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

function optionalValue(value: string | null): string | undefined {
  return value ?? undefined;
}

function toRecord(row: RuntimeEventRow): Record<string, unknown> {
  const payload = JSON.parse(row.payload_json) as unknown;
  const metadata = row.metadata_json === null ? undefined : JSON.parse(row.metadata_json) as unknown;
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    type: row.type,
    workspaceId: row.workspace_id,
    taskId: optionalValue(row.task_id),
    runId: row.run_id,
    stageId: optionalValue(row.stage_id),
    agentId: optionalValue(row.agent_id),
    providerConfigId: optionalValue(row.provider_config_id),
    providerSessionId: optionalValue(row.provider_session_id),
    processId: optionalValue(row.process_id),
    worktreeId: optionalValue(row.worktree_id),
    artifactId: optionalValue(row.artifact_id),
    approvalRequestId: optionalValue(row.approval_request_id),
    conversationId: optionalValue(row.conversation_id),
    messageId: optionalValue(row.message_id),
    sequence: row.sequence,
    timestamp: row.timestamp,
    source: row.source,
    correlationId: row.correlation_id,
    causationId: optionalValue(row.causation_id),
    parentEventId: optionalValue(row.parent_event_id),
    severity: row.severity,
    visibility: row.visibility,
    durability: row.durability,
    payload,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

export class RuntimeEventRepository {
  constructor(
    private readonly db: TransactionDatabase,
    private readonly registry: CentralRuntimeEventRegistry,
  ) {}

  appendWithinTransaction<TPayload>(draft: RuntimeEventDraft<TPayload>): RuntimeEventEnvelope<TPayload> {
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
