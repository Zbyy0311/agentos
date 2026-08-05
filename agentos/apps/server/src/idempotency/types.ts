import type {
  ApiOperation,
  Run,
  Task,
  V2RunOrigin,
  V2RunReason,
  V2RunStatus,
  V2TaskPriority,
  V2TaskStatus,
} from '@agentos/shared';
import { isCanonicalUtcTimestamp } from '../store/CanonicalTimestamp.js';

export const IDEMPOTENCY_OPERATIONS = Object.freeze([
  'task.create',
  'run.create',
  'run.cancel',
  'task.accept',
  'task.cancel',
  'task.reopen',
  'run.start',
  'run.retry',
] as const);

export type IdempotencyOperation = (typeof IDEMPOTENCY_OPERATIONS)[number];

export type IdempotencyHttpStatus = 200 | 201 | 202;

export const IDEMPOTENCY_HTTP_STATUS: Readonly<Record<IdempotencyOperation, IdempotencyHttpStatus>> = Object.freeze({
  'task.create': 201,
  'run.create': 201,
  'run.cancel': 200,
  'task.accept': 200,
  'task.cancel': 200,
  'task.reopen': 200,
  'run.start': 202,
  'run.retry': 201,
});

export const TASK_RESULT_OPERATIONS = Object.freeze([
  'task.create',
  'task.accept',
  'task.cancel',
  'task.reopen',
] as const);

export type TaskResultOperation = (typeof TASK_RESULT_OPERATIONS)[number];

export const RUN_RESULT_OPERATIONS = Object.freeze([
  'run.create',
  'run.cancel',
] as const);

export type RunResultOperation = (typeof RUN_RESULT_OPERATIONS)[number];

export interface IdempotencyTaskDtoV1 {
  id: string;
  workspaceId: string;
  legacyTaskId?: string;
  title: string;
  description?: string;
  status: V2TaskStatus;
  priority: V2TaskPriority;
  sourceConversationId?: string;
  sourceMessageId?: string;
  acceptedRunId?: string;
  pendingResultRunId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  archivedAt?: string;
  version: number;
}

export interface IdempotencyRunDtoV1 {
  id: string;
  workspaceId: string;
  taskId: string;
  parentRunId?: string;
  rootRunId: string;
  status: V2RunStatus;
  reason: V2RunReason;
  origin: V2RunOrigin;
  objective?: string;
  failureCode?: string;
  failureMessage?: string;
  cancellationRequestedAt?: string;
  nextEventSequence: number;
  startedAt?: string;
  completedAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface IdempotencyEnvelopeBaseV1 {
  schemaVersion: 1;
  operation: IdempotencyOperation;
}

export interface TaskResultEnvelopeV1 extends IdempotencyEnvelopeBaseV1 {
  operation: TaskResultOperation;
  body: { task: IdempotencyTaskDtoV1 };
}

export interface RunResultEnvelopeV1 extends IdempotencyEnvelopeBaseV1 {
  operation: RunResultOperation;
  body: { run: IdempotencyRunDtoV1 };
}

export interface IdempotencyOperationDtoV1 {
  id: string;
  type: 'run.start';
  status: 'queued';
  workspaceId: string;
  aggregateType: 'run';
  aggregateId: string;
  runId: string;
  correlationId: string;
  createdAt: string;
  version: 1;
}

export interface OperationResultEnvelopeV1 extends IdempotencyEnvelopeBaseV1 {
  operation: 'run.start';
  body: { operation: IdempotencyOperationDtoV1 };
}

export interface IdempotencyRetryOperationDtoV1 {
  id: string;
  type: 'run.retry';
  status: 'completed';
  workspaceId: string;
  aggregateType: 'run';
  aggregateId: string;
  runId: string;
  correlationId: string;
  result: { resourceType: 'run'; resourceId: string };
  createdAt: string;
  startedAt: string;
  completedAt: string;
  version: 3;
}

export interface RetryResultEnvelopeV1 extends IdempotencyEnvelopeBaseV1 {
  operation: 'run.retry';
  body: {
    run: IdempotencyRunDtoV1;
    operation: IdempotencyRetryOperationDtoV1;
  };
}

export type IdempotencyResultEnvelopeV1 =
  | TaskResultEnvelopeV1
  | RunResultEnvelopeV1
  | OperationResultEnvelopeV1
  | RetryResultEnvelopeV1;

export interface IdempotencyRecord {
  id: string;
  workspaceId: string;
  operation: IdempotencyOperation;
  keyHash: string;
  requestHash: string;
  resultSchemaVersion: 1;
  envelope: IdempotencyResultEnvelopeV1;
  resultHash: string;
  httpStatus: IdempotencyHttpStatus;
  createdAt: string;
}

export interface InsertCompletedIdempotencyRecord {
  id: string;
  workspaceId: string;
  operation: IdempotencyOperation;
  keyHash: string;
  requestHash: string;
  envelope: IdempotencyResultEnvelopeV1;
  httpStatus: IdempotencyHttpStatus;
  createdAt: string;
}

export interface FingerprintInput {
  operation: IdempotencyOperation;
  workspaceId: string;
  pathParams: Readonly<Record<string, string>>;
  domainInput: Readonly<Record<string, unknown>>;
  expectedVersion: number | null;
}

export class IdempotencyRecordInvalidError extends Error {
  readonly code = 'IDEMPOTENCY_RECORD_INVALID' as const;

  constructor() {
    super('Idempotency record is invalid');
    this.name = 'IdempotencyRecordInvalidError';
  }
}

const OPERATION_DTO_KEYS = Object.freeze([
  'id',
  'type',
  'status',
  'workspaceId',
  'aggregateType',
  'aggregateId',
  'runId',
  'correlationId',
  'createdAt',
  'version',
] as const);

const RETRY_RUN_DTO_KEYS = Object.freeze([
  'id',
  'workspaceId',
  'taskId',
  'parentRunId',
  'rootRunId',
  'status',
  'reason',
  'origin',
  'nextEventSequence',
  'createdBy',
  'createdAt',
  'updatedAt',
  'version',
] as const);

const RETRY_OPERATION_DTO_KEYS = Object.freeze([
  'id',
  'type',
  'status',
  'workspaceId',
  'aggregateType',
  'aggregateId',
  'runId',
  'correlationId',
  'result',
  'createdAt',
  'startedAt',
  'completedAt',
  'version',
] as const);

const RETRY_RESULT_KEYS = Object.freeze(['resourceType', 'resourceId'] as const);

function assertNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) invalid();
  return value;
}

function assertCanonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !isCanonicalUtcTimestamp(value)) invalid();
  return value;
}

function assertOperationSnapshot(value: ApiOperation): IdempotencyOperationDtoV1 {
  if (!isPlainRecord(value)) invalid();
  assertKeySet(value, OPERATION_DTO_KEYS, []);
  const id = assertNonEmptyString(value.id);
  const type = value.type;
  const status = value.status;
  const workspaceId = assertNonEmptyString(value.workspaceId);
  const aggregateType = value.aggregateType;
  const aggregateId = assertNonEmptyString(value.aggregateId);
  const runId = assertNonEmptyString(value.runId);
  const correlationId = assertNonEmptyString(value.correlationId);
  const createdAt = value.createdAt;
  const version = value.version;
  if (type !== 'run.start' || status !== 'queued' || aggregateType !== 'run') invalid();
  if (aggregateId !== runId || correlationId !== id) invalid();
  if (typeof createdAt !== 'string' || !isCanonicalUtcTimestamp(createdAt)) invalid();
  if (version !== 1) invalid();
  return {
    id,
    type: 'run.start',
    status: 'queued',
    workspaceId,
    aggregateType: 'run',
    aggregateId,
    runId,
    correlationId,
    createdAt,
    version: 1,
  };
}

export function buildOperationResultEnvelopeV1(
  operation: 'run.start',
  value: ApiOperation,
): OperationResultEnvelopeV1 {
  const dto = assertOperationSnapshot(value);
  return {
    schemaVersion: 1,
    operation,
    body: { operation: { ...dto } },
  };
}

function buildRetryRunDto(childRun: Run): IdempotencyRunDtoV1 {
  if (!isPlainRecord(childRun)) invalid();
  assertKeySet(childRun, RETRY_RUN_DTO_KEYS, []);
  const id = assertNonEmptyString(childRun.id);
  const workspaceId = assertNonEmptyString(childRun.workspaceId);
  const taskId = assertNonEmptyString(childRun.taskId);
  const parentRunId = assertNonEmptyString(childRun.parentRunId);
  const rootRunId = assertNonEmptyString(childRun.rootRunId);
  const createdBy = assertNonEmptyString(childRun.createdBy);
  const createdAt = assertCanonicalTimestamp(childRun.createdAt);
  const updatedAt = assertCanonicalTimestamp(childRun.updatedAt);
  if (
    id === parentRunId
    || childRun.status !== 'queued'
    || childRun.reason !== 'retry'
    || !RUN_ORIGINS.includes(childRun.origin)
    || childRun.nextEventSequence !== 1
    || childRun.version !== 1
  ) {
    invalid();
  }
  return {
    id,
    workspaceId,
    taskId,
    parentRunId,
    rootRunId,
    status: 'queued',
    reason: 'retry',
    origin: childRun.origin,
    nextEventSequence: 1,
    createdBy,
    createdAt,
    updatedAt,
    version: 1,
  };
}

function buildRetryOperationDto(
  retryOperation: ApiOperation,
  childRun: IdempotencyRunDtoV1,
): IdempotencyRetryOperationDtoV1 {
  if (!isPlainRecord(retryOperation)) invalid();
  assertKeySet(retryOperation, RETRY_OPERATION_DTO_KEYS, []);
  const id = assertNonEmptyString(retryOperation.id);
  const workspaceId = assertNonEmptyString(retryOperation.workspaceId);
  const aggregateId = assertNonEmptyString(retryOperation.aggregateId);
  const runId = assertNonEmptyString(retryOperation.runId);
  const correlationId = assertNonEmptyString(retryOperation.correlationId);
  const createdAt = assertCanonicalTimestamp(retryOperation.createdAt);
  const startedAt = assertCanonicalTimestamp(retryOperation.startedAt);
  const completedAt = assertCanonicalTimestamp(retryOperation.completedAt);
  if (!isPlainRecord(retryOperation.result)) invalid();
  assertKeySet(retryOperation.result, RETRY_RESULT_KEYS, []);
  const resourceId = assertNonEmptyString(retryOperation.result.resourceId);
  if (
    retryOperation.type !== 'run.retry'
    || retryOperation.status !== 'completed'
    || retryOperation.aggregateType !== 'run'
    || aggregateId !== runId
    || runId !== childRun.parentRunId
    || correlationId !== id
    || retryOperation.result.resourceType !== 'run'
    || resourceId !== childRun.id
    || retryOperation.version !== 3
    || Date.parse(createdAt) > Date.parse(startedAt)
    || Date.parse(startedAt) > Date.parse(completedAt)
  ) {
    invalid();
  }
  if (workspaceId !== childRun.workspaceId) invalid();
  return {
    id,
    type: 'run.retry',
    status: 'completed',
    workspaceId,
    aggregateType: 'run',
    aggregateId,
    runId,
    correlationId,
    result: { resourceType: 'run', resourceId },
    createdAt,
    startedAt,
    completedAt,
    version: 3,
  };
}

export function buildRetryResultEnvelopeV1(
  operation: 'run.retry',
  childRun: Run,
  retryOperation: ApiOperation,
): RetryResultEnvelopeV1 {
  if (operation !== 'run.retry') invalid();
  const run = buildRetryRunDto(childRun);
  const operationDto = buildRetryOperationDto(retryOperation, run);
  return {
    schemaVersion: 1,
    operation,
    body: {
      run: { ...run },
      operation: { ...operationDto, result: { ...operationDto.result } },
    },
  };
}

export function buildTaskResultEnvelopeV1(
  operation: TaskResultOperation,
  task: Task,
): TaskResultEnvelopeV1 {
  const dto: IdempotencyTaskDtoV1 = {
    id: task.id,
    workspaceId: task.workspaceId,
    title: task.title,
    status: task.status,
    priority: task.priority,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    version: task.version,
  };
  if (task.legacyTaskId !== undefined) dto.legacyTaskId = task.legacyTaskId;
  if (task.description !== undefined) dto.description = task.description;
  if (task.sourceConversationId !== undefined) dto.sourceConversationId = task.sourceConversationId;
  if (task.sourceMessageId !== undefined) dto.sourceMessageId = task.sourceMessageId;
  if (task.acceptedRunId !== undefined) dto.acceptedRunId = task.acceptedRunId;
  if (task.pendingResultRunId !== undefined) dto.pendingResultRunId = task.pendingResultRunId;
  if (task.completedAt !== undefined) dto.completedAt = task.completedAt;
  if (task.archivedAt !== undefined) dto.archivedAt = task.archivedAt;
  return { schemaVersion: 1, operation, body: { task: dto } };
}

export function buildRunResultEnvelopeV1(
  operation: RunResultOperation,
  run: Run,
): RunResultEnvelopeV1 {
  const dto: IdempotencyRunDtoV1 = {
    id: run.id,
    workspaceId: run.workspaceId,
    taskId: run.taskId,
    rootRunId: run.rootRunId,
    status: run.status,
    reason: run.reason,
    origin: run.origin,
    nextEventSequence: run.nextEventSequence,
    createdBy: run.createdBy,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    version: run.version,
  };
  if (run.parentRunId !== undefined) dto.parentRunId = run.parentRunId;
  if (run.objective !== undefined) dto.objective = run.objective;
  if (run.failureCode !== undefined) dto.failureCode = run.failureCode;
  if (run.failureMessage !== undefined) dto.failureMessage = run.failureMessage;
  if (run.cancellationRequestedAt !== undefined) dto.cancellationRequestedAt = run.cancellationRequestedAt;
  if (run.startedAt !== undefined) dto.startedAt = run.startedAt;
  if (run.completedAt !== undefined) dto.completedAt = run.completedAt;
  return { schemaVersion: 1, operation, body: { run: dto } };
}

const TASK_DTO_REQUIRED_KEYS = Object.freeze([
  'id',
  'workspaceId',
  'title',
  'status',
  'priority',
  'createdBy',
  'createdAt',
  'updatedAt',
  'version',
] as const);

const TASK_DTO_OPTIONAL_KEYS = Object.freeze([
  'legacyTaskId',
  'description',
  'sourceConversationId',
  'sourceMessageId',
  'acceptedRunId',
  'pendingResultRunId',
  'completedAt',
  'archivedAt',
] as const);

const RUN_DTO_REQUIRED_KEYS = Object.freeze([
  'id',
  'workspaceId',
  'taskId',
  'rootRunId',
  'status',
  'reason',
  'origin',
  'nextEventSequence',
  'createdBy',
  'createdAt',
  'updatedAt',
  'version',
] as const);

const RUN_DTO_OPTIONAL_KEYS = Object.freeze([
  'parentRunId',
  'objective',
  'failureCode',
  'failureMessage',
  'cancellationRequestedAt',
  'startedAt',
  'completedAt',
] as const);

const TASK_STATUSES = Object.freeze(['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const);
const TASK_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'critical'] as const);
const RUN_STATUSES = Object.freeze([
  'queued', 'starting', 'running', 'waiting_approval', 'paused', 'completed', 'failed', 'cancelled',
] as const);
const RUN_REASONS = Object.freeze([
  'initial', 'retry', 'resume-fallback', 'review-fix', 'provider-comparison', 'manual',
] as const);
const RUN_ORIGINS = Object.freeze(['v2_api', 'legacy_pipeline'] as const);

function invalid(): never {
  throw new IdempotencyRecordInvalidError();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertKeySet(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set<string>([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid();
  }
  for (const key of required) {
    if (!(key in value)) invalid();
  }
}

function assertString(value: unknown): string {
  if (typeof value !== 'string') invalid();
  return value;
}

function parseOperationDto(value: unknown): IdempotencyOperationDtoV1 {
  if (!isPlainRecord(value)) invalid();
  assertKeySet(value, OPERATION_DTO_KEYS, []);
  const id = assertNonEmptyString(value.id);
  const workspaceId = assertNonEmptyString(value.workspaceId);
  const aggregateId = assertNonEmptyString(value.aggregateId);
  const runId = assertNonEmptyString(value.runId);
  const correlationId = assertNonEmptyString(value.correlationId);
  if (
    value.type !== 'run.start'
    || value.status !== 'queued'
    || value.aggregateType !== 'run'
    || aggregateId !== runId
    || correlationId !== id
    || value.version !== 1
    || typeof value.createdAt !== 'string'
    || !isCanonicalUtcTimestamp(value.createdAt)
  ) {
    invalid();
  }
  return {
    id,
    type: 'run.start',
    status: 'queued',
    workspaceId,
    aggregateType: 'run',
    aggregateId,
    runId,
    correlationId,
    createdAt: value.createdAt,
    version: 1,
  };
}

function parseRetryRunDto(value: unknown): IdempotencyRunDtoV1 {
  if (!isPlainRecord(value)) invalid();
  assertKeySet(value, RETRY_RUN_DTO_KEYS, []);
  const id = assertNonEmptyString(value.id);
  const workspaceId = assertNonEmptyString(value.workspaceId);
  const taskId = assertNonEmptyString(value.taskId);
  const parentRunId = assertNonEmptyString(value.parentRunId);
  const rootRunId = assertNonEmptyString(value.rootRunId);
  const createdBy = assertNonEmptyString(value.createdBy);
  const createdAt = assertCanonicalTimestamp(value.createdAt);
  const updatedAt = assertCanonicalTimestamp(value.updatedAt);
  if (
    id === parentRunId
    || value.status !== 'queued'
    || value.reason !== 'retry'
    || !RUN_ORIGINS.includes(value.origin as (typeof RUN_ORIGINS)[number])
    || value.nextEventSequence !== 1
    || value.version !== 1
  ) invalid();
  return {
    id,
    workspaceId,
    taskId,
    parentRunId,
    rootRunId,
    status: 'queued',
    reason: 'retry',
    origin: value.origin as V2RunOrigin,
    nextEventSequence: 1,
    createdBy,
    createdAt,
    updatedAt,
    version: 1,
  };
}

function parseRetryOperationDto(
  value: unknown,
  childRun: IdempotencyRunDtoV1,
): IdempotencyRetryOperationDtoV1 {
  if (!isPlainRecord(value)) invalid();
  assertKeySet(value, RETRY_OPERATION_DTO_KEYS, []);
  const id = assertNonEmptyString(value.id);
  const workspaceId = assertNonEmptyString(value.workspaceId);
  const aggregateId = assertNonEmptyString(value.aggregateId);
  const runId = assertNonEmptyString(value.runId);
  const correlationId = assertNonEmptyString(value.correlationId);
  const createdAt = assertCanonicalTimestamp(value.createdAt);
  const startedAt = assertCanonicalTimestamp(value.startedAt);
  const completedAt = assertCanonicalTimestamp(value.completedAt);
  if (!isPlainRecord(value.result)) invalid();
  assertKeySet(value.result, RETRY_RESULT_KEYS, []);
  const resourceId = assertNonEmptyString(value.result.resourceId);
  if (
    value.type !== 'run.retry'
    || value.status !== 'completed'
    || value.aggregateType !== 'run'
    || aggregateId !== runId
    || runId !== childRun.parentRunId
    || correlationId !== id
    || value.result.resourceType !== 'run'
    || resourceId !== childRun.id
    || value.version !== 3
    || Date.parse(createdAt) > Date.parse(startedAt)
    || Date.parse(startedAt) > Date.parse(completedAt)
  ) invalid();
  if (workspaceId !== childRun.workspaceId) invalid();
  return {
    id,
    type: 'run.retry',
    status: 'completed',
    workspaceId,
    aggregateType: 'run',
    aggregateId,
    runId,
    correlationId,
    result: { resourceType: 'run', resourceId },
    createdAt,
    startedAt,
    completedAt,
    version: 3,
  };
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid();
  return value as T;
}

function assertPositiveSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}

function assertNonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function parseTaskDto(value: unknown): IdempotencyTaskDtoV1 {
  if (!isPlainRecord(value)) invalid();
  assertKeySet(value, TASK_DTO_REQUIRED_KEYS, TASK_DTO_OPTIONAL_KEYS);
  const dto: IdempotencyTaskDtoV1 = {
    id: assertString(value.id),
    workspaceId: assertString(value.workspaceId),
    title: assertString(value.title),
    status: assertEnum(value.status, TASK_STATUSES),
    priority: assertEnum(value.priority, TASK_PRIORITIES),
    createdBy: assertString(value.createdBy),
    createdAt: assertString(value.createdAt),
    updatedAt: assertString(value.updatedAt),
    version: assertPositiveSafeInteger(value.version),
  };
  for (const key of TASK_DTO_OPTIONAL_KEYS) {
    if (key in value) {
      (dto as unknown as Record<string, unknown>)[key] = assertString(value[key]);
    }
  }
  return dto;
}

function parseRunDto(value: unknown): IdempotencyRunDtoV1 {
  if (!isPlainRecord(value)) invalid();
  assertKeySet(value, RUN_DTO_REQUIRED_KEYS, RUN_DTO_OPTIONAL_KEYS);
  const dto: IdempotencyRunDtoV1 = {
    id: assertString(value.id),
    workspaceId: assertString(value.workspaceId),
    taskId: assertString(value.taskId),
    rootRunId: assertString(value.rootRunId),
    status: assertEnum(value.status, RUN_STATUSES),
    reason: assertEnum(value.reason, RUN_REASONS),
    origin: assertEnum(value.origin, RUN_ORIGINS),
    nextEventSequence: assertNonNegativeSafeInteger(value.nextEventSequence),
    createdBy: assertString(value.createdBy),
    createdAt: assertString(value.createdAt),
    updatedAt: assertString(value.updatedAt),
    version: assertPositiveSafeInteger(value.version),
  };
  for (const key of RUN_DTO_OPTIONAL_KEYS) {
    if (key in value) {
      (dto as unknown as Record<string, unknown>)[key] = assertString(value[key]);
    }
  }
  return dto;
}

export function parseIdempotencyResultEnvelopeV1(
  value: unknown,
): IdempotencyResultEnvelopeV1 {
  if (!isPlainRecord(value)) invalid();
  assertKeySet(value, ['schemaVersion', 'operation', 'body'], []);
  if (value.schemaVersion !== 1) invalid();
  const operation = assertEnum(value.operation, IDEMPOTENCY_OPERATIONS);
  if (!isPlainRecord(value.body)) invalid();
  if ((TASK_RESULT_OPERATIONS as readonly string[]).includes(operation)) {
    assertKeySet(value.body, ['task'], []);
    return {
      schemaVersion: 1,
      operation: operation as TaskResultOperation,
      body: { task: parseTaskDto(value.body.task) },
    };
  }
  if (operation === 'run.start') {
    assertKeySet(value.body, ['operation'], []);
    return {
      schemaVersion: 1,
      operation: 'run.start',
      body: { operation: parseOperationDto(value.body.operation) },
    };
  }
  if (operation === 'run.retry') {
    assertKeySet(value.body, ['run', 'operation'], []);
    const run = parseRetryRunDto(value.body.run);
    return {
      schemaVersion: 1,
      operation: 'run.retry',
      body: {
        run,
        operation: parseRetryOperationDto(value.body.operation, run),
      },
    };
  }
  assertKeySet(value.body, ['run'], []);
  return {
    schemaVersion: 1,
    operation: operation as RunResultOperation,
    body: { run: parseRunDto(value.body.run) },
  };
}
