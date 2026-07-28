import type {
  Run,
  Task,
  V2RunOrigin,
  V2RunReason,
  V2RunStatus,
  V2TaskPriority,
  V2TaskStatus,
} from '@agentos/shared';

export const IDEMPOTENCY_OPERATIONS = Object.freeze([
  'task.create',
  'run.create',
  'run.cancel',
  'task.accept',
  'task.cancel',
  'task.reopen',
] as const);

export type IdempotencyOperation = (typeof IDEMPOTENCY_OPERATIONS)[number];

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

export type IdempotencyResultEnvelopeV1 = TaskResultEnvelopeV1 | RunResultEnvelopeV1;

export interface IdempotencyRecord {
  id: string;
  workspaceId: string;
  operation: IdempotencyOperation;
  keyHash: string;
  requestHash: string;
  resultSchemaVersion: 1;
  envelope: IdempotencyResultEnvelopeV1;
  resultHash: string;
  httpStatus: 200 | 201;
  createdAt: string;
}

export interface InsertCompletedIdempotencyRecord {
  id: string;
  workspaceId: string;
  operation: IdempotencyOperation;
  keyHash: string;
  requestHash: string;
  envelope: IdempotencyResultEnvelopeV1;
  httpStatus: 200 | 201;
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
  assertKeySet(value.body, ['run'], []);
  return {
    schemaVersion: 1,
    operation: operation as RunResultOperation,
    body: { run: parseRunDto(value.body.run) },
  };
}
