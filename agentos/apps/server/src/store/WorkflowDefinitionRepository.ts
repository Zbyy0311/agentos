import type {
  AgentRole,
  WorkflowDefinition,
  WorkflowDefinitionPayload,
  WorktreeMode,
} from '@agentos/shared';
import type { TransactionDatabase } from './Transaction.js';
import { canonicalizeJson, hashCanonicalJson } from '../snapshots/canonicalJson.js';

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
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function integrityFailure(id: string, reason: string): WorkflowDefinitionIntegrityError {
  return new WorkflowDefinitionIntegrityError(
    `WORKFLOW_DEFINITION_INTEGRITY_FAILED: ${reason} for ${id}`,
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  rowId: string,
  path: string,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  let ownKeys: (string | symbol)[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw integrityFailure(rowId, `${path} keys are invalid`);
  }
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw integrityFailure(rowId, `${path} contains an unsupported field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      throw integrityFailure(rowId, `${path}.${key} property descriptor is invalid`);
    }
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      throw integrityFailure(rowId, `${path}.${key} is missing or invalid`);
    }
  }
}

function assertExactObject(
  value: unknown,
  rowId: string,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw integrityFailure(rowId, `${path} is not a plain object`);
  assertExactKeys(value, rowId, path, keys);
  return value;
}

function assertDenseArray(value: unknown, rowId: string, path: string): unknown[] {
  if (!Array.isArray(value)) throw integrityFailure(rowId, `${path} is invalid`);
  let ownKeys: (string | symbol)[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw integrityFailure(rowId, `${path} is invalid`);
  }
  for (const key of ownKeys) {
    if (typeof key === 'symbol' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) {
      throw integrityFailure(rowId, `${path} contains an unsupported property`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      throw integrityFailure(rowId, `${path} must be dense`);
    }
  }
  return value;
}

function assertString(value: unknown, rowId: string, path: string, nonEmpty = false): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    throw integrityFailure(rowId, `${path} is invalid`);
  }
  return value;
}

function assertPositiveInteger(value: unknown, rowId: string, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw integrityFailure(rowId, `${path} is invalid`);
  }
  return value;
}

function assertWorktreeMode(value: unknown, rowId: string, path: string): WorktreeMode {
  if (value !== 'required' && value !== 'preferred' && value !== 'disabled') {
    throw integrityFailure(rowId, `${path} is invalid`);
  }
  return value;
}

function validatePayload(
  row: WorkflowDefinitionRow,
  payload: unknown,
): asserts payload is WorkflowDefinitionPayload {
  if (!isRecord(payload)) throw integrityFailure(row.id, 'payload is not a plain object');
  const schemaVersion = payload.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw integrityFailure(row.id, 'schemaVersion mismatch');
  }
  const root = assertExactObject(payload, row.id, 'payload', schemaVersion === 1
    ? ['schemaVersion', 'definitionKey', 'version', 'name', 'executionMode', 'retryPolicy', 'stages']
    : ['schemaVersion', 'definitionKey', 'version', 'name', 'executionMode', 'retryPolicy', 'stages', 'worktreeMode']);
  if (root.schemaVersion !== schemaVersion) throw integrityFailure(row.id, 'schemaVersion mismatch');
  if (assertString(root.definitionKey, row.id, 'definitionKey', true) !== row.definition_key) {
    throw integrityFailure(row.id, 'definitionKey mismatch');
  }
  if (assertPositiveInteger(root.version, row.id, 'version') !== row.version) {
    throw integrityFailure(row.id, 'version mismatch');
  }
  if (assertString(root.name, row.id, 'name', true) !== row.name) {
    throw integrityFailure(row.id, 'name mismatch');
  }
  if (root.executionMode !== 'legacy_pipeline' && root.executionMode !== 'unbound') {
    throw integrityFailure(row.id, 'executionMode is invalid');
  }
  if (root.retryPolicy !== null) throw integrityFailure(row.id, 'retryPolicy is invalid');

  const stages = assertDenseArray(root.stages, row.id, 'stages');
  const keys = new Set<string>();
  const sequences = new Set<number>();
  const stageMetadata = new Map<string, { sequence: number; dependsOn: string[] }>();
  for (const stage of stages) {
    const stageRecord = assertExactObject(stage, row.id, 'stage', schemaVersion === 1
      ? ['key', 'sequence', 'agentRole']
      : ['key', 'sequence', 'agentRole', 'dependsOn']);
    const key = assertString(stageRecord.key, row.id, 'stage.key', true);
    if (key !== key.trim()) throw integrityFailure(row.id, 'stage key must not be trimmed');
    if (keys.has(key)) throw integrityFailure(row.id, 'duplicate stage key');
    keys.add(key);
    const sequence = assertPositiveInteger(stageRecord.sequence, row.id, 'stage.sequence');
    if (sequences.has(sequence)) throw integrityFailure(row.id, 'duplicate stage sequence');
    sequences.add(sequence);
    if (stageRecord.agentRole !== null && (typeof stageRecord.agentRole !== 'string' || !AGENT_ROLES.has(stageRecord.agentRole as AgentRole))) {
      throw integrityFailure(row.id, 'stage agentRole is invalid');
    }
    const dependsOn = schemaVersion === 2
      ? assertDenseArray(stageRecord.dependsOn, row.id, 'stage.dependsOn').map((dependency, index) => {
        const value = assertString(dependency, row.id, `stage.dependsOn[${index}]`, true);
        if (value !== value.trim()) throw integrityFailure(row.id, 'stage dependency must not be trimmed');
        return value;
      })
      : [];
    stageMetadata.set(key, { sequence, dependsOn });
  }
  if (schemaVersion === 2) {
    assertWorktreeMode(root.worktreeMode, row.id, 'worktreeMode');
    for (const [key, metadata] of stageMetadata) {
      const dependencies = new Set<string>();
      for (const dependency of metadata.dependsOn) {
        if (dependencies.has(dependency)) throw integrityFailure(row.id, 'stage dependency is duplicated');
        dependencies.add(dependency);
        if (dependency === key) throw integrityFailure(row.id, 'stage dependency cannot reference itself');
        const dependencyMetadata = stageMetadata.get(dependency);
        if (!dependencyMetadata) throw integrityFailure(row.id, 'stage dependency does not exist');
        if (dependencyMetadata.sequence >= metadata.sequence) {
          throw integrityFailure(row.id, 'stage dependency must precede the stage');
        }
      }
    }
  }
  const definitionHash = assertString(row.definition_hash, row.id, 'definition_hash', true);
  if (!/^[0-9a-f]{64}$/.test(definitionHash)) {
    throw integrityFailure(row.id, 'definition_hash is invalid');
  }
  try {
    const canonical = canonicalizeJson(payload);
    if (row.definition_json !== canonical) {
      throw integrityFailure(row.id, 'definition_json is not canonical');
    }
    if (hashCanonicalJson(payload) !== definitionHash) {
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
