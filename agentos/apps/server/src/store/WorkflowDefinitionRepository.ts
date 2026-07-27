import type {
  AgentRole,
  WorkflowDefinition,
  WorkflowDefinitionPayloadV1,
} from '@agentos/shared';
import type { TransactionDatabase } from './Transaction.js';
import { hashCanonicalJson } from '../snapshots/canonicalJson.js';

interface WorkflowDefinitionRow {
  id: string;
  definition_key: string;
  version: number;
  name: string;
  definition_json: string;
  definition_hash: string;
  enabled: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const AGENT_ROLES = new Set<AgentRole>(['codex', 'kimi', 'opencode', 'mimo']);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function integrityFailure(id: string, reason: string): WorkflowDefinitionIntegrityError {
  return new WorkflowDefinitionIntegrityError(
    `WORKFLOW_DEFINITION_INTEGRITY_FAILED: ${reason} for ${id}`,
  );
}

function validatePayload(
  row: WorkflowDefinitionRow,
  payload: unknown,
): asserts payload is WorkflowDefinitionPayloadV1 {
  if (!isRecord(payload)) throw integrityFailure(row.id, 'payload is not a plain object');
  if (payload.schemaVersion !== 1) throw integrityFailure(row.id, 'schemaVersion mismatch');
  if (typeof payload.definitionKey !== 'string' || payload.definitionKey !== row.definition_key) {
    throw integrityFailure(row.id, 'definitionKey mismatch');
  }
  if (payload.version !== row.version) throw integrityFailure(row.id, 'version mismatch');
  if (typeof payload.name !== 'string' || payload.name !== row.name) {
    throw integrityFailure(row.id, 'name mismatch');
  }
  if (payload.executionMode !== 'legacy_pipeline' && payload.executionMode !== 'unbound') {
    throw integrityFailure(row.id, 'executionMode is invalid');
  }
  if (payload.retryPolicy !== null) throw integrityFailure(row.id, 'retryPolicy is invalid');
  if (!Array.isArray(payload.stages)) throw integrityFailure(row.id, 'stages is invalid');

  const keys = new Set<string>();
  const sequences = new Set<number>();
  for (const stage of payload.stages) {
    if (!isRecord(stage)) throw integrityFailure(row.id, 'stage is invalid');
    if (typeof stage.key !== 'string' || stage.key.length === 0) {
      throw integrityFailure(row.id, 'stage key is invalid');
    }
    if (keys.has(stage.key)) throw integrityFailure(row.id, 'duplicate stage key');
    keys.add(stage.key);
    if (typeof stage.sequence !== 'number' || !Number.isInteger(stage.sequence) || stage.sequence < 1) {
      throw integrityFailure(row.id, 'stage sequence is invalid');
    }
    if (sequences.has(stage.sequence)) throw integrityFailure(row.id, 'duplicate stage sequence');
    sequences.add(stage.sequence);
    if (stage.agentRole !== null && (typeof stage.agentRole !== 'string' || !AGENT_ROLES.has(stage.agentRole as AgentRole))) {
      throw integrityFailure(row.id, 'stage agentRole is invalid');
    }
  }
  if (!/^[0-9a-f]{64}$/.test(row.definition_hash)) {
    throw integrityFailure(row.id, 'definition_hash is invalid');
  }
  try {
    if (hashCanonicalJson(payload) !== row.definition_hash) {
      throw integrityFailure(row.id, 'definition_hash mismatch');
    }
  } catch (error) {
    if (error instanceof WorkflowDefinitionIntegrityError) throw error;
    throw integrityFailure(row.id, 'payload canonicalization failed');
  }
}

function mapRow(row: WorkflowDefinitionRow): WorkflowDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.definition_json) as unknown;
  } catch {
    throw integrityFailure(row.id, 'definition_json is invalid');
  }
  validatePayload(row, parsed);
  return {
    id: row.id,
    definitionKey: row.definition_key,
    version: row.version,
    name: row.name,
    payload: parsed,
    definitionHash: row.definition_hash,
    enabled: row.enabled === 1,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const WORKFLOW_COLUMNS = `
  id, definition_key, version, name, definition_json, definition_hash,
  enabled, archived_at, created_at, updated_at
`;

export class WorkflowDefinitionIntegrityError extends Error {
  readonly code = 'WORKFLOW_DEFINITION_INTEGRITY_FAILED' as const;

  constructor(message = 'WORKFLOW_DEFINITION_INTEGRITY_FAILED') {
    super(message);
    this.name = 'WorkflowDefinitionIntegrityError';
  }
}

export class WorkflowDefinitionRepository {
  constructor(private readonly db: TransactionDatabase) {}

  findById(id: string): WorkflowDefinition | undefined {
    const row = this.db.prepare(
      `SELECT ${WORKFLOW_COLUMNS} FROM workflow_definitions WHERE id = ?`,
    ).get(id) as WorkflowDefinitionRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  findByKeyVersion(definitionKey: string, version: number): WorkflowDefinition | undefined {
    const row = this.db.prepare(
      `SELECT ${WORKFLOW_COLUMNS} FROM workflow_definitions WHERE definition_key = ? AND version = ?`,
    ).get(definitionKey, version) as WorkflowDefinitionRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  findLatestAvailableByKey(definitionKey: string): WorkflowDefinition | undefined {
    const row = this.db.prepare(`
      SELECT ${WORKFLOW_COLUMNS}
      FROM workflow_definitions
      WHERE definition_key = ? AND enabled = 1 AND archived_at IS NULL
      ORDER BY version DESC, id ASC
      LIMIT 1
    `).get(definitionKey) as WorkflowDefinitionRow | undefined;
    return row ? mapRow(row) : undefined;
  }
}
