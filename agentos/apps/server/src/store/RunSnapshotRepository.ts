import type {
  RunSnapshot,
  RunSnapshotPayloadV1,
  V2RunOrigin,
  V2RunReason,
} from '@agentos/shared';
import type { TransactionDatabase } from './Transaction.js';
import { canonicalizeJson, hashCanonicalJson } from '../snapshots/canonicalJson.js';
import { createEntityId } from './Identity.js';

interface RunRow {
  workspace_id: string;
  task_id: string;
  origin: V2RunOrigin;
  reason: V2RunReason;
  parent_run_id: string | null;
  root_run_id: string;
}

interface WorkflowRow {
  id: string;
  definition_key: string;
  version: number;
  name: string;
  definition_hash: string;
}

interface SnapshotRow {
  id: string;
  workspace_id: string;
  run_id: string;
  workflow_definition_id: string;
  snapshot_schema_version: number;
  snapshot_json: string;
  content_hash: string;
  redaction_applied: number;
  captured_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationFailure(reason: string): RunSnapshotValidationError {
  return new RunSnapshotValidationError(`RUN_SNAPSHOT_VALIDATION_FAILED: ${reason}`);
}

function integrityFailure(runId: string, reason: string): RunSnapshotIntegrityError {
  return new RunSnapshotIntegrityError(
    `RUN_SNAPSHOT_INTEGRITY_FAILED: ${reason} for ${runId}`,
  );
}

function validatePayloadEnvelope(payload: unknown): asserts payload is RunSnapshotPayloadV1 {
  if (!isRecord(payload) || payload.schemaVersion !== 1) {
    throw validationFailure('schemaVersion is invalid');
  }
  if (typeof payload.capturedAt !== 'string') throw validationFailure('capturedAt is invalid');
  if (!isRecord(payload.run) || !isRecord(payload.workflow) || !isRecord(payload.security)) {
    throw validationFailure('payload envelope is invalid');
  }
  const run = payload.run;
  if (
    typeof run.workspaceId !== 'string'
    || typeof run.taskId !== 'string'
    || (run.parentRunId !== null && typeof run.parentRunId !== 'string')
    || typeof run.rootRunId !== 'string'
  ) {
    throw validationFailure('run metadata is invalid');
  }
  if (!['v2_api', 'legacy_pipeline'].includes(String(run.origin))) {
    throw validationFailure('run origin is invalid');
  }
  if (!['initial', 'retry', 'resume-fallback', 'review-fix', 'provider-comparison', 'manual'].includes(String(run.reason))) {
    throw validationFailure('run reason is invalid');
  }
  const workflow = payload.workflow;
  if (
    typeof workflow.definitionId !== 'string'
    || typeof workflow.definitionKey !== 'string'
    || typeof workflow.definitionVersion !== 'number'
    || typeof workflow.name !== 'string'
    || typeof workflow.definitionHash !== 'string'
    || !Array.isArray(workflow.stages)
  ) {
    throw validationFailure('workflow metadata is invalid');
  }
  if (typeof payload.security.redactionApplied !== 'boolean') {
    throw validationFailure('security metadata is invalid');
  }
}

function mapRow(row: SnapshotRow, payload: RunSnapshotPayloadV1): RunSnapshot {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    workflowDefinitionId: row.workflow_definition_id,
    snapshotSchemaVersion: row.snapshot_schema_version,
    payload,
    contentHash: row.content_hash,
    redactionApplied: row.redaction_applied === 1,
    capturedAt: row.captured_at,
  };
}

export interface InsertRunSnapshotInput {
  workspaceId: string;
  runId: string;
  workflowDefinitionId: string;
  payload: RunSnapshotPayloadV1;
}

export class RunSnapshotValidationError extends Error {
  readonly code = 'RUN_SNAPSHOT_VALIDATION_FAILED' as const;

  constructor(message = 'RUN_SNAPSHOT_VALIDATION_FAILED') {
    super(message);
    this.name = 'RunSnapshotValidationError';
  }
}

export class RunSnapshotIntegrityError extends Error {
  readonly code = 'RUN_SNAPSHOT_INTEGRITY_FAILED' as const;

  constructor(message = 'RUN_SNAPSHOT_INTEGRITY_FAILED') {
    super(message);
    this.name = 'RunSnapshotIntegrityError';
  }
}

export class RunSnapshotRepository {
  constructor(private readonly db: TransactionDatabase) {}

  insert(input: InsertRunSnapshotInput): RunSnapshot {
    validatePayloadEnvelope(input.payload);
    const run = this.db.prepare(`
      SELECT workspace_id, task_id, origin, reason, parent_run_id, root_run_id
      FROM runs
      WHERE workspace_id = ? AND id = ?
    `).get(input.workspaceId, input.runId) as RunRow | undefined;
    if (!run) throw validationFailure('run not found');

    const workflow = this.db.prepare(`
      SELECT id, definition_key, version, name, definition_hash
      FROM workflow_definitions
      WHERE id = ?
    `).get(input.workflowDefinitionId) as WorkflowRow | undefined;
    if (!workflow) throw validationFailure('workflow definition not found');

    const payload = input.payload;
    if (
      payload.run.workspaceId !== input.workspaceId
      || payload.run.taskId !== run.task_id
      || payload.run.origin !== run.origin
      || payload.run.reason !== run.reason
      || payload.run.parentRunId !== run.parent_run_id
      || payload.run.rootRunId !== run.root_run_id
    ) {
      throw validationFailure('run metadata does not match the stored run');
    }
    if (
      payload.workflow.definitionId !== workflow.id
      || payload.workflow.definitionKey !== workflow.definition_key
      || payload.workflow.definitionVersion !== workflow.version
      || payload.workflow.name !== workflow.name
      || payload.workflow.definitionHash !== workflow.definition_hash
    ) {
      throw validationFailure('workflow metadata does not match the stored definition');
    }

    let snapshotJson: string;
    let contentHash: string;
    try {
      snapshotJson = canonicalizeJson(payload);
      contentHash = hashCanonicalJson(payload);
    } catch {
      throw validationFailure('payload canonicalization failed');
    }
    const id = createEntityId('snapshot');
    this.db.prepare(`
      INSERT INTO run_snapshots (
        id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,
        snapshot_json, content_hash, redaction_applied, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.workspaceId,
      input.runId,
      input.workflowDefinitionId,
      payload.schemaVersion,
      snapshotJson,
      contentHash,
      payload.security.redactionApplied ? 1 : 0,
      payload.capturedAt,
    );
    const result = this.findByRunId(input.workspaceId, input.runId);
    if (!result) throw integrityFailure(input.runId, 'inserted snapshot could not be read');
    return result;
  }

  findByRunId(workspaceId: string, runId: string): RunSnapshot | undefined {
    const row = this.db.prepare(`
      SELECT id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,
        snapshot_json, content_hash, redaction_applied, captured_at
      FROM run_snapshots
      WHERE workspace_id = ? AND run_id = ?
    `).get(workspaceId, runId) as SnapshotRow | undefined;
    if (!row) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.snapshot_json) as unknown;
      validatePayloadEnvelope(parsed);
    } catch (error) {
      if (error instanceof RunSnapshotIntegrityError) throw error;
      throw integrityFailure(runId, 'snapshot JSON is invalid');
    }
    const payload = parsed as RunSnapshotPayloadV1;
    let canonical: string;
    let computedHash: string;
    try {
      canonical = canonicalizeJson(payload);
      computedHash = hashCanonicalJson(payload);
    } catch {
      throw integrityFailure(runId, 'snapshot payload canonicalization failed');
    }
    if (
      row.workspace_id !== payload.run.workspaceId
      || row.workflow_definition_id !== payload.workflow.definitionId
      || row.snapshot_schema_version !== payload.schemaVersion
      || row.redaction_applied !== (payload.security.redactionApplied ? 1 : 0)
      || row.captured_at !== payload.capturedAt
      || row.snapshot_json !== canonical
      || row.content_hash !== computedHash
    ) {
      throw integrityFailure(runId, 'stored snapshot metadata or hash mismatch');
    }
    return mapRow(row, payload);
  }

  verifyHash(snapshot: RunSnapshot): boolean {
    try {
      return hashCanonicalJson(snapshot.payload) === snapshot.contentHash;
    } catch {
      return false;
    }
  }
}
