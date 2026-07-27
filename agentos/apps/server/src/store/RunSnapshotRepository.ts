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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function validationFailure(reason: string): RunSnapshotValidationError {
  return new RunSnapshotValidationError(`RUN_SNAPSHOT_VALIDATION_FAILED: ${reason}`);
}

function integrityFailure(runId: string, reason: string): RunSnapshotIntegrityError {
  return new RunSnapshotIntegrityError(
    `RUN_SNAPSHOT_INTEGRITY_FAILED: ${reason} for ${runId}`,
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  path: string,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  let ownKeys: (string | symbol)[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw validationFailure(`${path} keys are invalid`);
  }
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw validationFailure(`${path} contains an unsupported field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      throw validationFailure(`${path}.${key} property descriptor is invalid`);
    }
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      throw validationFailure(`${path}.${key} is missing or invalid`);
    }
  }
}

function assertExactObject(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw validationFailure(`${path} must be a plain object`);
  assertExactKeys(value, path, keys);
  return value;
}

function assertDenseArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw validationFailure(`${path} must be an array`);
  let ownKeys: (string | symbol)[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw validationFailure(`${path} is invalid`);
  }
  for (const key of ownKeys) {
    if (typeof key === 'symbol' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) {
      throw validationFailure(`${path} contains an unsupported property`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      throw validationFailure(`${path} must be dense`);
    }
  }
  return value;
}

function assertString(value: unknown, path: string, nonEmpty = false): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    throw validationFailure(`${path} must be a${nonEmpty ? ' non-empty' : ''} string`);
  }
  return value;
}

function assertNullableString(value: unknown, path: string, nonEmpty = false): string | null {
  if (value === null) return null;
  return assertString(value, path, nonEmpty);
}

function assertPositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw validationFailure(`${path} must be a positive integer`);
  }
  return value;
}

function assertNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw validationFailure(`${path} must be a non-negative integer`);
  }
  return value;
}

function assertEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw validationFailure(`${path} is invalid`);
  }
  return value as T;
}

function assertBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw validationFailure(`${path} must be boolean`);
  return value;
}

function validatePermissions(value: unknown, path: string): void {
  const permissions = assertDenseArray(value, path);
  for (const [index, permission] of permissions.entries()) {
    assertEnum(permission, `${path}[${index}]`, ['read', 'write', 'review'] as const);
  }
}

const CAPABILITY_KEYS = [
  'sessionResume',
  'structuredEvents',
  'nativeApprovals',
  'subagents',
  'toolEvents',
  'fileEvents',
  'usageEvents',
  'reasoningStream',
  'interactiveInput',
  'pause',
  'cancellation',
  'modelSelection',
  'workspaceAwareness',
  'nativeSandbox',
  'outputContracts',
] as const;

const TIMEOUT_KEYS = [
  'discoveryTimeoutMs',
  'validationTimeoutMs',
  'startupTimeoutMs',
  'idleTimeoutMs',
  'totalTimeoutMs',
  'cancelGracePeriodMs',
  'approvalTimeoutMs',
] as const;

function validateCapabilities(value: unknown, path: string): void {
  const capabilities = assertExactObject(value, path, CAPABILITY_KEYS);
  for (const key of CAPABILITY_KEYS) assertBoolean(capabilities[key], `${path}.${key}`);
}

function validateTimeoutPolicy(value: unknown, path: string): void {
  const timeoutPolicy = assertExactObject(value, path, TIMEOUT_KEYS);
  for (const key of TIMEOUT_KEYS) {
    const nullable = key === 'idleTimeoutMs' || key === 'totalTimeoutMs' || key === 'approvalTimeoutMs';
    if (nullable && timeoutPolicy[key] === null) continue;
    assertNonNegativeInteger(timeoutPolicy[key], `${path}.${key}`);
  }
}

function validateWorkspaceRelativePath(value: unknown, path: string): void {
  const directory = assertNullableString(value, path, true);
  if (directory === null) return;
  if (
    directory.startsWith('/')
    || directory.startsWith('\\\\')
    || directory.startsWith('//')
    || /^[A-Za-z]:[\\/]/.test(directory)
    || directory.split(/[\\/]+/).includes('..')
  ) {
    throw validationFailure(`${path} must be a workspace-relative path`);
  }
}

function validateAgent(value: unknown, path: string): void {
  const agent = assertExactObject(value, path, [
    'agentId',
    'name',
    'role',
    'roleTitle',
    'systemPrompt',
    'permissions',
    'providerConfigId',
    'enabled',
    'version',
  ]);
  assertString(agent.agentId, `${path}.agentId`, true);
  assertString(agent.name, `${path}.name`, true);
  assertEnum(agent.role, `${path}.role`, ['codex', 'kimi', 'opencode', 'mimo'] as const);
  assertString(agent.roleTitle, `${path}.roleTitle`);
  assertString(agent.systemPrompt, `${path}.systemPrompt`);
  validatePermissions(agent.permissions, `${path}.permissions`);
  assertString(agent.providerConfigId, `${path}.providerConfigId`, true);
  assertBoolean(agent.enabled, `${path}.enabled`);
  assertPositiveInteger(agent.version, `${path}.version`);
}

function validateProvider(value: unknown, path: string): void {
  const provider = assertExactObject(value, path, [
    'providerConfigId',
    'name',
    'providerType',
    'adapterId',
    'runtimeMode',
    'executable',
    'argsTemplate',
    'model',
    'environmentProfileId',
    'secretProfileId',
    'workingDirectoryMode',
    'workspaceRelativeWorkingDirectory',
    'capabilities',
    'timeoutPolicy',
    'approvalMode',
    'outputMode',
    'enabled',
    'version',
  ]);
  assertString(provider.providerConfigId, `${path}.providerConfigId`, true);
  assertString(provider.name, `${path}.name`, true);
  assertEnum(provider.providerType, `${path}.providerType`, [
    'codex', 'claude-code', 'kimicode', 'opencode', 'gemini-cli', 'custom-cli', 'remote',
  ] as const);
  assertString(provider.adapterId, `${path}.adapterId`, true);
  assertEnum(provider.runtimeMode, `${path}.runtimeMode`, ['cli', 'api', 'ssh', 'container'] as const);
  assertNullableString(provider.executable, `${path}.executable`);
  const argsTemplate = assertDenseArray(provider.argsTemplate, `${path}.argsTemplate`);
  for (const [index, argument] of argsTemplate.entries()) assertString(argument, `${path}.argsTemplate[${index}]`);
  assertNullableString(provider.model, `${path}.model`);
  assertNullableString(provider.environmentProfileId, `${path}.environmentProfileId`);
  assertNullableString(provider.secretProfileId, `${path}.secretProfileId`);
  assertEnum(provider.workingDirectoryMode, `${path}.workingDirectoryMode`, ['workspace', 'worktree', 'custom'] as const);
  validateWorkspaceRelativePath(provider.workspaceRelativeWorkingDirectory, `${path}.workspaceRelativeWorkingDirectory`);
  validateCapabilities(provider.capabilities, `${path}.capabilities`);
  validateTimeoutPolicy(provider.timeoutPolicy, `${path}.timeoutPolicy`);
  assertEnum(provider.approvalMode, `${path}.approvalMode`, ['agentos', 'native', 'hybrid', 'disabled'] as const);
  assertEnum(provider.outputMode, `${path}.outputMode`, ['structured', 'parsed-text', 'raw-stream'] as const);
  assertBoolean(provider.enabled, `${path}.enabled`);
  assertPositiveInteger(provider.version, `${path}.version`);
}

function validateStage(value: unknown, path: string): void {
  const stage = assertExactObject(value, path, ['workflowStageKey', 'name', 'sequence', 'agent', 'provider']);
  const key = assertString(stage.workflowStageKey, `${path}.workflowStageKey`, true);
  if (key !== key.trim()) throw validationFailure(`${path}.workflowStageKey must not be trimmed`);
  if (assertString(stage.name, `${path}.name`) !== key) throw validationFailure(`${path}.name must match key`);
  assertPositiveInteger(stage.sequence, `${path}.sequence`);
  const agentIsNull = stage.agent === null;
  const providerIsNull = stage.provider === null;
  if (agentIsNull !== providerIsNull) throw validationFailure(`${path} agent/provider binding is invalid`);
  if (!agentIsNull && !providerIsNull) {
    validateAgent(stage.agent, `${path}.agent`);
    validateProvider(stage.provider, `${path}.provider`);
    const agent = stage.agent as Record<string, unknown>;
    const provider = stage.provider as Record<string, unknown>;
    if (agent.providerConfigId !== provider.providerConfigId) {
      throw validationFailure(`${path} agent/provider ids do not match`);
    }
  }
}

function validatePayloadEnvelope(payload: unknown): asserts payload is RunSnapshotPayloadV1 {
  const root = assertExactObject(payload, 'payload', ['schemaVersion', 'capturedAt', 'run', 'workflow', 'security']);
  if (root.schemaVersion !== 1) throw validationFailure('schemaVersion is invalid');
  assertString(root.capturedAt, 'capturedAt', true);

  const run = assertExactObject(root.run, 'run', [
    'workspaceId', 'taskId', 'origin', 'reason', 'parentRunId', 'rootRunId',
  ]);
  assertString(run.workspaceId, 'run.workspaceId', true);
  assertString(run.taskId, 'run.taskId', true);
  assertEnum(run.origin, 'run.origin', ['v2_api', 'legacy_pipeline'] as const);
  assertEnum(run.reason, 'run.reason', [
    'initial', 'retry', 'resume-fallback', 'review-fix', 'provider-comparison', 'manual',
  ] as const);
  assertNullableString(run.parentRunId, 'run.parentRunId', true);
  assertString(run.rootRunId, 'run.rootRunId', true);

  const workflow = assertExactObject(root.workflow, 'workflow', [
    'definitionId', 'definitionKey', 'definitionVersion', 'name', 'definitionHash', 'stages',
  ]);
  assertString(workflow.definitionId, 'workflow.definitionId', true);
  assertString(workflow.definitionKey, 'workflow.definitionKey', true);
  assertPositiveInteger(workflow.definitionVersion, 'workflow.definitionVersion');
  assertString(workflow.name, 'workflow.name', true);
  const definitionHash = assertString(workflow.definitionHash, 'workflow.definitionHash', true);
  if (!/^[0-9a-f]{64}$/.test(definitionHash)) throw validationFailure('workflow.definitionHash is invalid');
  const stages = assertDenseArray(workflow.stages, 'workflow.stages');
  const stageKeys = new Set<string>();
  const stageSequences = new Set<number>();
  for (const [index, stage] of stages.entries()) {
    validateStage(stage, `workflow.stages[${index}]`);
    const typedStage = stage as Record<string, unknown>;
    const key = typedStage.workflowStageKey as string;
    const sequence = typedStage.sequence as number;
    if (stageKeys.has(key)) throw validationFailure('workflow stage key is duplicated');
    if (stageSequences.has(sequence)) throw validationFailure('workflow stage sequence is duplicated');
    stageKeys.add(key);
    stageSequences.add(sequence);
  }

  const security = assertExactObject(root.security, 'security', ['redactionApplied']);
  assertBoolean(security.redactionApplied, 'security.redactionApplied');
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
    const run = this.db.prepare(`
      SELECT workspace_id, task_id, origin, reason, parent_run_id, root_run_id
      FROM runs
      WHERE workspace_id = ? AND id = ?
    `).get(row.workspace_id, row.run_id) as RunRow | undefined;
    if (!run) throw integrityFailure(runId, 'referenced run is missing');
    if (
      payload.run.workspaceId !== run.workspace_id
      || payload.run.taskId !== run.task_id
      || payload.run.origin !== run.origin
      || payload.run.reason !== run.reason
      || payload.run.parentRunId !== run.parent_run_id
      || payload.run.rootRunId !== run.root_run_id
    ) {
      throw integrityFailure(runId, 'referenced run metadata mismatch');
    }
    const workflow = this.db.prepare(`
      SELECT id, definition_key, version, name, definition_hash
      FROM workflow_definitions
      WHERE id = ?
    `).get(row.workflow_definition_id) as WorkflowRow | undefined;
    if (!workflow) throw integrityFailure(runId, 'referenced workflow definition is missing');
    if (
      payload.workflow.definitionId !== workflow.id
      || payload.workflow.definitionKey !== workflow.definition_key
      || payload.workflow.definitionVersion !== workflow.version
      || payload.workflow.name !== workflow.name
      || payload.workflow.definitionHash !== workflow.definition_hash
    ) {
      throw integrityFailure(runId, 'referenced workflow metadata mismatch');
    }
    return mapRow(row, payload);
  }

  verifyHash(snapshot: RunSnapshot): boolean {
    try {
      validatePayloadEnvelope(snapshot.payload);
      return hashCanonicalJson(snapshot.payload) === snapshot.contentHash;
    } catch {
      return false;
    }
  }
}
