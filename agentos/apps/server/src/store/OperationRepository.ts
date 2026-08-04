import type {
  ApiOperation,
  ApiOperationResult,
  ApiProblem,
  M3OperationStatus,
} from '@agentos/shared';
import { M3_OPERATION_STATUSES } from '@agentos/shared';
import { isCanonicalUtcTimestamp } from './CanonicalTimestamp.js';
import { assertVersionedMutation } from './Repository.js';
import { isValidEntityId } from './Identity.js';
import type { TransactionDatabase } from './Transaction.js';
import { VersionConflictError } from './Version.js';

export const OPERATION_TYPES = Object.freeze([
  'run.create',
  'run.start',
  'run.cancel',
  'run.retry',
] as const);

export type OperationType = (typeof OPERATION_TYPES)[number];

export const NON_TERMINAL_OPERATION_STATUSES = Object.freeze([
  'queued',
  'running',
  'waiting_approval',
  'paused',
] as const);

export class OperationValidationError extends Error {
  readonly code = 'OPERATION_VALIDATION_FAILED' as const;

  constructor(message: string) {
    super(`OPERATION_VALIDATION_FAILED: ${message}`);
    this.name = 'OperationValidationError';
  }
}

export class OperationNotFoundError extends Error {
  readonly code = 'OPERATION_NOT_FOUND' as const;

  constructor(operationId: string) {
    super(`Operation not found: ${operationId}`);
    this.name = 'OperationNotFoundError';
  }
}

export interface InsertOperationInput {
  readonly id: string;
  readonly type: OperationType;
  readonly status: M3OperationStatus;
  readonly workspaceId: string;
  readonly aggregateType: 'run';
  readonly aggregateId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly result?: ApiOperationResult;
  readonly error?: ApiProblem;
}

export interface UpdateOperationInput {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly expectedStatus: M3OperationStatus;
  readonly expectedVersion: number;
  readonly status: M3OperationStatus;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly result: ApiOperationResult | null;
  readonly error: ApiProblem | null;
}

interface OperationRow {
  id: string;
  type: string;
  status: string;
  workspace_id: string;
  aggregate_type: string;
  aggregate_id: string;
  run_id: string;
  correlation_id: string;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  version: number;
}

const OPERATION_ROW_KEYS = Object.freeze([
  'id',
  'type',
  'status',
  'workspace_id',
  'aggregate_type',
  'aggregate_id',
  'run_id',
  'correlation_id',
  'result_json',
  'error_json',
  'created_at',
  'started_at',
  'completed_at',
  'updated_at',
  'version',
] as const);

const OPERATION_SELECT = `
  SELECT id, type, status, workspace_id, aggregate_type, aggregate_id, run_id,
    correlation_id, result_json, error_json, created_at, started_at,
    completed_at, updated_at, version
  FROM operations
`;

type JsonValue = null | string | boolean | number | JsonValue[] | { readonly [key: string]: JsonValue };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOperationType(value: unknown): value is OperationType {
  return typeof value === 'string' && (OPERATION_TYPES as readonly string[]).includes(value);
}

function isOperationStatus(value: unknown): value is M3OperationStatus {
  return typeof value === 'string' && (M3_OPERATION_STATUSES as readonly string[]).includes(value);
}

function isJsonValue(value: unknown, ancestors = new WeakSet<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      if (Object.getOwnPropertySymbols(value).length > 0) return false;
      for (const name of Object.getOwnPropertyNames(value)) {
        if (name === 'length') continue;
        if (!/^(0|[1-9]\d*)$/.test(name)) return false;
        const index = Number(name);
        if (index >= value.length) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false;
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !isJsonValue(descriptor.value, ancestors)) {
          return false;
        }
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    for (const name of Object.getOwnPropertyNames(value)) {
      if (name === 'toJSON') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)
        || !isJsonValue(descriptor.value, ancestors)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function hasOnlyOwnKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.getOwnPropertyNames(value).every(key => allowed.includes(key))
    && Object.getOwnPropertySymbols(value).length === 0;
}

function assertOperationCorrelationBinding(
  type: OperationType,
  id: string,
  runId: string,
  correlationId: string,
): void {
  const expectedCorrelationId = type === 'run.create' ? runId : id;
  if (correlationId !== expectedCorrelationId) {
    throw new OperationValidationError('correlationId does not match the operation identity contract');
  }
}

function assertPositiveVersion(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new OperationValidationError('version must be a positive safe integer');
  }
}

function assertCanonicalTimestamp(value: unknown, field: string): asserts value is string {
  if (!isCanonicalUtcTimestamp(value)) {
    throw new OperationValidationError(`${field} must be a canonical UTC timestamp`);
  }
}

function assertOptionalTimestamp(value: unknown, field: string): asserts value is string | null | undefined {
  if (value !== null && value !== undefined) assertCanonicalTimestamp(value, field);
}

function assertOperationStateTimestamps(
  status: M3OperationStatus,
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): void {
  const hasStartedAt = startedAt !== null && startedAt !== undefined;
  const hasCompletedAt = completedAt !== null && completedAt !== undefined;
  if (status === 'queued' && (hasStartedAt || hasCompletedAt)) {
    throw new OperationValidationError('queued operations cannot have lifecycle timestamps');
  }
  if (status === 'running' || status === 'waiting_approval' || status === 'paused') {
    if (!hasStartedAt || hasCompletedAt) {
      throw new OperationValidationError(`${status} operations require startedAt and no completedAt`);
    }
  }
  if (status === 'completed' && (!hasStartedAt || !hasCompletedAt)) {
    throw new OperationValidationError('completed operations require startedAt and completedAt');
  }
  if ((status === 'failed' || status === 'cancelled') && !hasCompletedAt) {
    throw new OperationValidationError(`${status} operations require completedAt`);
  }
}

export function isValidApiOperationResult(value: unknown): value is ApiOperationResult {
  if (!isPlainRecord(value) || !isJsonValue(value)
    || !hasOnlyOwnKeys(value, ['resourceType', 'resourceId', 'data'])) return false;
  return (value.resourceType === undefined || typeof value.resourceType === 'string')
    && (value.resourceId === undefined || typeof value.resourceId === 'string')
    && (value.data === undefined || isJsonValue(value.data));
}

function isValidApiProblemFieldError(value: unknown): boolean {
  if (!isPlainRecord(value) || !isJsonValue(value)
    || !hasOnlyOwnKeys(value, ['field', 'code', 'message'])) return false;
  return (value.field === undefined || typeof value.field === 'string')
    && typeof value.code === 'string'
    && typeof value.message === 'string';
}

function isValidApiProblemContext(value: unknown): boolean {
  if (!isPlainRecord(value) || !isJsonValue(value)) return false;
  const allowed = [
    'workspaceId',
    'taskId',
    'runId',
    'stageId',
    'operationId',
    'providerSessionId',
    'processId',
    'worktreeId',
    'approvalRequestId',
  ];
  return hasOnlyOwnKeys(value, allowed)
    && Object.values(value).every(item => typeof item === 'string');
}

export function isValidApiProblem(value: unknown): value is ApiProblem {
  if (!isPlainRecord(value) || !isJsonValue(value)
    || !hasOnlyOwnKeys(value, [
      'type', 'title', 'status', 'code', 'detail', 'instance', 'requestId',
      'retryable', 'retryAfterMs', 'suggestedAction', 'errors', 'context',
    ])) return false;
  return typeof value.type === 'string'
    && typeof value.title === 'string'
    && Number.isSafeInteger(value.status)
    && typeof value.code === 'string'
    && typeof value.detail === 'string'
    && typeof value.instance === 'string'
    && typeof value.requestId === 'string'
    && typeof value.retryable === 'boolean'
    && (value.retryAfterMs === undefined
      || (typeof value.retryAfterMs === 'number'
        && Number.isSafeInteger(value.retryAfterMs)
        && value.retryAfterMs >= 0))
    && (value.suggestedAction === undefined || typeof value.suggestedAction === 'string')
    && (value.errors === undefined
      || (Array.isArray(value.errors) && value.errors.every(isValidApiProblemFieldError)))
    && (value.context === undefined || isValidApiProblemContext(value.context));
}

function serializeJson(value: ApiOperationResult | ApiProblem | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (!isJsonValue(value)) throw new OperationValidationError(`${field} must be a JSON Value`);
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') {
      throw new OperationValidationError(`${field} must serialize to a JSON string`);
    }
    return serialized;
  } catch {
    throw new OperationValidationError(`${field} must be JSON serializable`);
  }
}

function parseJson(value: string | null, field: string): unknown {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    throw new OperationValidationError(`${field} must contain valid JSON`);
  }
}

function isOperationRow(value: Record<string, unknown>): value is Record<string, unknown> & OperationRow {
  return typeof value.id === 'string'
    && typeof value.type === 'string'
    && typeof value.status === 'string'
    && typeof value.workspace_id === 'string'
    && typeof value.aggregate_type === 'string'
    && typeof value.aggregate_id === 'string'
    && typeof value.run_id === 'string'
    && typeof value.correlation_id === 'string'
    && (value.result_json === null || typeof value.result_json === 'string')
    && (value.error_json === null || typeof value.error_json === 'string')
    && typeof value.created_at === 'string'
    && (value.started_at === null || typeof value.started_at === 'string')
    && (value.completed_at === null || typeof value.completed_at === 'string')
    && typeof value.updated_at === 'string'
    && typeof value.version === 'number';
}

function assertPayloadInvariants(
  status: M3OperationStatus,
  result: ApiOperationResult | undefined,
  error: ApiProblem | undefined,
): void {
  if (result !== undefined && error !== undefined) {
    throw new OperationValidationError('result and error cannot both be present');
  }
  if (status === 'completed') {
    if (error !== undefined) throw new OperationValidationError('completed operations cannot contain error');
    return;
  }
  if (status === 'failed') {
    if (result !== undefined || error === undefined) {
      throw new OperationValidationError('failed operations require error and cannot contain result');
    }
    return;
  }
  if (result !== undefined || error !== undefined) {
    throw new OperationValidationError('non-completed operations cannot contain result or error');
  }
}

function assertInsertInput(input: InsertOperationInput): void {
  if (!isPlainRecord(input)) throw new OperationValidationError('operation input must be an object');
  if (!isValidEntityId(input.id, 'operation')) throw new OperationValidationError('id must be a valid operation entity ID');
  if (!isOperationType(input.type)) throw new OperationValidationError('type is invalid');
  if (!isOperationStatus(input.status)) throw new OperationValidationError('status is invalid');
  if (!isNonEmptyString(input.workspaceId)) throw new OperationValidationError('workspaceId is required');
  if (input.aggregateType !== 'run') throw new OperationValidationError('aggregateType must be run');
  if (!isNonEmptyString(input.aggregateId) || !isNonEmptyString(input.runId)) {
    throw new OperationValidationError('aggregateId and runId are required');
  }
  if (input.aggregateId !== input.runId) throw new OperationValidationError('aggregateId must equal runId');
  if (!isNonEmptyString(input.correlationId)) throw new OperationValidationError('correlationId is required');
  assertOperationCorrelationBinding(input.type, input.id, input.runId, input.correlationId);
  assertCanonicalTimestamp(input.createdAt, 'createdAt');
  assertCanonicalTimestamp(input.updatedAt, 'updatedAt');
  assertOptionalTimestamp(input.startedAt, 'startedAt');
  assertOptionalTimestamp(input.completedAt, 'completedAt');
  assertPositiveVersion(input.version);
  if (input.result !== undefined && !isValidApiOperationResult(input.result)) {
    throw new OperationValidationError('result is malformed');
  }
  if (input.error !== undefined && !isValidApiProblem(input.error)) {
    throw new OperationValidationError('error is malformed');
  }
  assertPayloadInvariants(input.status, input.result, input.error);
  assertOperationStateTimestamps(input.status, input.startedAt, input.completedAt);
}

function assertUpdateInput(input: UpdateOperationInput): void {
  if (!isNonEmptyString(input.workspaceId) || !isValidEntityId(input.operationId, 'operation')) {
    throw new OperationValidationError('workspaceId and operationId are required');
  }
  if (!isOperationStatus(input.expectedStatus) || !isOperationStatus(input.status)) {
    throw new OperationValidationError('expectedStatus and status are invalid');
  }
  assertPositiveVersion(input.expectedVersion);
  assertCanonicalTimestamp(input.updatedAt, 'updatedAt');
  assertOptionalTimestamp(input.startedAt, 'startedAt');
  assertOptionalTimestamp(input.completedAt, 'completedAt');
  if (input.result !== null && !isValidApiOperationResult(input.result)) {
    throw new OperationValidationError('result is malformed');
  }
  if (input.error !== null && !isValidApiProblem(input.error)) {
    throw new OperationValidationError('error is malformed');
  }
  assertPayloadInvariants(
    input.status,
    input.result === null ? undefined : input.result,
    input.error === null ? undefined : input.error,
  );
  assertOperationStateTimestamps(input.status, input.startedAt, input.completedAt);
}

function mapRow(raw: unknown): ApiOperation {
  if (!isPlainRecord(raw)) throw new OperationValidationError('operation row must be an object');
  const keys = Object.keys(raw);
  if (keys.length !== OPERATION_ROW_KEYS.length
    || keys.some(key => !(OPERATION_ROW_KEYS as readonly string[]).includes(key))) {
    throw new OperationValidationError('operation row shape is invalid');
  }
  if (!isOperationRow(raw)) throw new OperationValidationError('operation row fields are invalid');
  const row = raw;
  if (!isValidEntityId(row.id, 'operation')) throw new OperationValidationError('row id is invalid');
  if (!isOperationType(row.type)) throw new OperationValidationError('row type is invalid');
  if (!isOperationStatus(row.status)) throw new OperationValidationError('row status is invalid');
  if (!isNonEmptyString(row.workspace_id) || !isNonEmptyString(row.aggregate_id)
    || !isNonEmptyString(row.run_id) || !isNonEmptyString(row.correlation_id)) {
    throw new OperationValidationError('row identity fields are invalid');
  }
  if (row.aggregate_type !== 'run' || row.aggregate_id !== row.run_id) {
    throw new OperationValidationError('row aggregate binding is invalid');
  }
  assertOperationCorrelationBinding(row.type, row.id, row.run_id, row.correlation_id);
  assertCanonicalTimestamp(row.created_at, 'created_at');
  assertCanonicalTimestamp(row.updated_at, 'updated_at');
  assertOptionalTimestamp(row.started_at, 'started_at');
  assertOptionalTimestamp(row.completed_at, 'completed_at');
  assertPositiveVersion(row.version);

  const parsedResult = parseJson(row.result_json, 'result_json');
  const parsedError = parseJson(row.error_json, 'error_json');
  const result = parsedResult === undefined ? undefined : parsedResult;
  const error = parsedError === undefined ? undefined : parsedError;
  if (result !== undefined && !isValidApiOperationResult(result)) {
    throw new OperationValidationError('result_json is malformed');
  }
  if (error !== undefined && !isValidApiProblem(error)) {
    throw new OperationValidationError('error_json is malformed');
  }
  assertPayloadInvariants(row.status, result, error);
  assertOperationStateTimestamps(row.status, row.started_at, row.completed_at);

  return {
    id: row.id,
    type: row.type,
    status: row.status,
    workspaceId: row.workspace_id,
    aggregateType: 'run',
    aggregateId: row.aggregate_id,
    runId: row.run_id,
    correlationId: row.correlation_id,
    ...(result === undefined ? {} : { result: result as ApiOperationResult }),
    ...(error === undefined ? {} : { error: error as ApiProblem }),
    createdAt: row.created_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    version: row.version,
  };
}

export class OperationRepository {
  constructor(private readonly db: TransactionDatabase) {}

  insert(input: InsertOperationInput): ApiOperation {
    assertInsertInput(input);
    this.db.prepare(`
      INSERT INTO operations (
        id, type, status, workspace_id, aggregate_type, aggregate_id, run_id,
        correlation_id, result_json, error_json, created_at, started_at,
        completed_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.type,
      input.status,
      input.workspaceId,
      input.aggregateType,
      input.aggregateId,
      input.runId,
      input.correlationId,
      serializeJson(input.result, 'result'),
      serializeJson(input.error, 'error'),
      input.createdAt,
      input.startedAt ?? null,
      input.completedAt ?? null,
      input.updatedAt,
      input.version,
    );
    const operation = this.findById(input.workspaceId, input.id);
    if (!operation) throw new OperationValidationError('inserted operation could not be read back');
    return operation;
  }

  findById(workspaceId: string, operationId: string): ApiOperation | undefined {
    if (!isNonEmptyString(workspaceId) || !isNonEmptyString(operationId)) {
      throw new OperationValidationError('workspaceId and operationId are required');
    }
    const row = this.db.prepare(`${OPERATION_SELECT} WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, operationId);
    return row === undefined || row === null ? undefined : mapRow(row);
  }

  findByCorrelationId(workspaceId: string, correlationId: string): ApiOperation | undefined {
    if (!isNonEmptyString(workspaceId) || !isNonEmptyString(correlationId)) {
      throw new OperationValidationError('workspaceId and correlationId are required');
    }
    const row = this.db.prepare(`${OPERATION_SELECT} WHERE workspace_id = ? AND correlation_id = ?`)
      .get(workspaceId, correlationId);
    return row === undefined || row === null ? undefined : mapRow(row);
  }

  listByRun(workspaceId: string, runId: string): ApiOperation[] {
    if (!isNonEmptyString(workspaceId) || !isNonEmptyString(runId)) {
      throw new OperationValidationError('workspaceId and runId are required');
    }
    const rows = this.db.prepare(`${OPERATION_SELECT}
      WHERE workspace_id = ? AND run_id = ?
      ORDER BY created_at ASC, id ASC`)
      .all(workspaceId, runId);
    return rows.map(mapRow);
  }

  listNonTerminalByRunAndType(
    workspaceId: string,
    runId: string,
    type: OperationType,
  ): ApiOperation[] {
    if (!isNonEmptyString(workspaceId) || !isNonEmptyString(runId) || !isOperationType(type)) {
      throw new OperationValidationError('workspaceId, runId, and type are required');
    }
    const rows = this.db.prepare(`${OPERATION_SELECT}
      WHERE workspace_id = ? AND run_id = ? AND type = ?
        AND status IN ('queued', 'running', 'waiting_approval', 'paused')
      ORDER BY created_at ASC, id ASC`)
      .all(workspaceId, runId, type);
    return rows.map(mapRow);
  }

  update(input: UpdateOperationInput): ApiOperation {
    assertUpdateInput(input);
    const current = this.findById(input.workspaceId, input.operationId);
    if (!current) throw new OperationNotFoundError(input.operationId);

    const result = this.db.prepare(`
      UPDATE operations
      SET status = ?, result_json = ?, error_json = ?, started_at = ?,
        completed_at = ?, updated_at = ?, version = version + 1
      WHERE workspace_id = ? AND id = ? AND status = ? AND version = ?
    `).run(
      input.status,
      serializeJson(input.result, 'result'),
      serializeJson(input.error, 'error'),
      input.startedAt,
      input.completedAt,
      input.updatedAt,
      input.workspaceId,
      input.operationId,
      input.expectedStatus,
      input.expectedVersion,
    ) as { changes: number };
    assertVersionedMutation(result, {
      entityType: 'operations',
      entityId: input.operationId,
      expectedVersion: input.expectedVersion,
    });
    const operation = this.findById(input.workspaceId, input.operationId);
    if (!operation) throw new OperationValidationError('updated operation could not be read back');
    return operation;
  }
}

export { VersionConflictError };
