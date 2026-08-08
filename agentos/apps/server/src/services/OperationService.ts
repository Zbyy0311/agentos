import type {
  ApiOperation,
  ApiOperationResult,
  ApiProblem,
  M3OperationStatus,
} from '@agentos/shared';
import { M3_OPERATION_STATUSES } from '@agentos/shared';
import { isCanonicalUtcTimestamp } from '../store/CanonicalTimestamp.js';
import { createEntityId } from '../store/Identity.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { VersionConflictError } from '../store/Version.js';
import {
  NON_TERMINAL_OPERATION_STATUSES,
  OPERATION_TYPES,
  OperationNotFoundError,
  OperationRepository,
  OperationValidationError,
  isValidApiOperationResult,
  isValidApiProblem,
  type InsertOperationInput,
  type OperationType,
} from '../store/OperationRepository.js';
import type { LifecycleTransactionService } from './LifecycleTransactionService.js';

export interface OperationServiceOptions {
  readonly now?: () => string;
  readonly lifecycleTransactionService?: Pick<
    LifecycleTransactionService,
    'cancelRunForOperationWithinTransaction'
  >;
}

export interface CreateOperationInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly type: OperationType;
}

export interface TransitionOperationInput {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly expectedVersion: number;
  readonly to: M3OperationStatus;
  readonly result?: ApiOperationResult | null;
  readonly error?: ApiProblem | null;
}

export interface CancelOperationInput {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly expectedVersion: number;
}

const TERMINAL_STATUSES: readonly M3OperationStatus[] = ['completed', 'failed', 'cancelled'];

const ALLOWED_TRANSITIONS: Readonly<Record<M3OperationStatus, readonly M3OperationStatus[]>> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  waiting_approval: [],
  paused: [],
  completed: [],
  failed: [],
  cancelled: [],
};

export class InvalidOperationTransitionError extends Error {
  readonly code = 'INVALID_OPERATION_TRANSITION' as const;

  constructor(from: string, to: string) {
    super(`INVALID_OPERATION_TRANSITION: cannot transition operation from '${from}' to '${to}'`);
    this.name = 'InvalidOperationTransitionError';
  }
}

export class OperationNotCancellableError extends Error {
  readonly code = 'OPERATION_NOT_CANCELLABLE' as const;

  constructor(operationId: string) {
    super(`Operation ${operationId} is not cancellable`);
    this.name = 'OperationNotCancellableError';
  }
}

export class OperationLifecycleDependencyError extends Error {
  readonly code = 'OPERATION_LIFECYCLE_DEPENDENCY_MISSING' as const;

  constructor() {
    super('Operation cancellation lifecycle dependency is missing');
    this.name = 'OperationLifecycleDependencyError';
  }
}

export class OperationIntegrityError extends Error {
  readonly code = 'OPERATION_INTEGRITY_FAILED' as const;

  constructor(message: string) {
    super(`OPERATION_INTEGRITY_FAILED: ${message}`);
    this.name = 'OperationIntegrityError';
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

function assertPositiveVersion(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new OperationValidationError('expectedVersion must be a positive safe integer');
  }
}

function assertTimestamp(value: string): string {
  if (!isCanonicalUtcTimestamp(value)) {
    throw new OperationValidationError('transaction timestamp must be canonical UTC ISO 8601 milliseconds');
  }
  return value;
}

export class OperationService {
  private readonly repository: OperationRepository;
  private readonly now: () => string;
  private readonly lifecycleTransactionService: OperationServiceOptions['lifecycleTransactionService'];

  constructor(
    private readonly db: TransactionDatabase,
    options: OperationServiceOptions = {},
  ) {
    this.repository = new OperationRepository(db);
    this.now = options.now ?? (() => new Date().toISOString());
    this.lifecycleTransactionService = options.lifecycleTransactionService;
  }

  create(input: CreateOperationInput): ApiOperation {
    return inTransaction(this.db, () => this.createWithinTransaction(input));
  }

  createWithinTransaction(input: CreateOperationInput): ApiOperation {
    if (!isNonEmptyString(input.workspaceId) || !isNonEmptyString(input.runId)) {
      throw new OperationValidationError('workspaceId and runId are required');
    }
    if (!isOperationType(input.type)) {
      throw new OperationValidationError('type is invalid');
    }

    const timestamp = assertTimestamp(this.now());
    const id = createEntityId('operation');
    const operation: InsertOperationInput = {
      id,
      type: input.type,
      status: 'queued',
      workspaceId: input.workspaceId,
      aggregateType: 'run',
      aggregateId: input.runId,
      runId: input.runId,
      correlationId: input.type === 'run.create' ? input.runId : id,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    };
    return this.repository.insert(operation);
  }

  transition(input: TransitionOperationInput): ApiOperation {
    return inTransaction(this.db, () => this.transitionWithinTransaction(input));
  }

  transitionWithinTransaction(input: TransitionOperationInput): ApiOperation {
    return this.transitionWithinTransactionAt(input, this.now());
  }

  transitionWithinTransactionAt(input: TransitionOperationInput, timestamp: string): ApiOperation {
    assertTimestamp(timestamp);
    if (!isNonEmptyString(input.workspaceId) || !isNonEmptyString(input.operationId)) {
      throw new OperationValidationError('workspaceId and operationId are required');
    }
    assertPositiveVersion(input.expectedVersion);
    if (!isOperationStatus(input.to)) {
      throw new OperationValidationError('target status is invalid');
    }

    const current = this.repository.findById(input.workspaceId, input.operationId);
    if (!current) throw new OperationNotFoundError(input.operationId);
    if (current.version !== input.expectedVersion) {
      throw new VersionConflictError('operations', input.operationId, input.expectedVersion);
    }
    if (current.status === input.to || !ALLOWED_TRANSITIONS[current.status].includes(input.to)) {
      throw new InvalidOperationTransitionError(current.status, input.to);
    }

    const result = input.result === null ? undefined : input.result;
    const error = input.error === null ? undefined : input.error;
    if (result !== undefined && !isValidApiOperationResult(result)) {
      throw new OperationValidationError('result is malformed');
    }
    if (error !== undefined && !isValidApiProblem(error)) {
      throw new OperationValidationError('error is malformed');
    }
    this.assertResultErrorContract(input.to, result, error);

    const startedAt = current.startedAt ?? (input.to === 'running' ? timestamp : null);
    const completedAt = TERMINAL_STATUSES.includes(input.to)
      ? current.completedAt ?? timestamp
      : current.completedAt ?? null;

    return this.repository.update({
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      expectedStatus: current.status,
      expectedVersion: input.expectedVersion,
      status: input.to,
      updatedAt: timestamp,
      startedAt,
      completedAt,
      result: result ?? null,
      error: error ?? null,
    });
  }

  cancel(input: CancelOperationInput): ApiOperation {
    return inTransaction(this.db, () => this.cancelWithinTransaction(input));
  }

  cancelWithinTransaction(input: CancelOperationInput): ApiOperation {
    if (!isNonEmptyString(input.workspaceId) || !isNonEmptyString(input.operationId)) {
      throw new OperationValidationError('workspaceId and operationId are required');
    }
    assertPositiveVersion(input.expectedVersion);

    let current: ApiOperation | undefined;
    try {
      current = this.repository.findById(input.workspaceId, input.operationId);
    } catch (error) {
      if (error instanceof OperationValidationError) {
        throw new OperationIntegrityError('persisted Operation row is invalid');
      }
      throw error;
    }
    if (!current) throw new OperationNotFoundError(input.operationId);
    this.assertPersistedBinding(current, input.workspaceId);

    if (current.status === 'cancelled') return current;
    if (current.version !== input.expectedVersion) {
      throw new VersionConflictError('operations', input.operationId, input.expectedVersion);
    }
    if (current.status === 'completed' || current.status === 'failed') {
      throw new OperationNotCancellableError(input.operationId);
    }
    if (!['queued', 'running', 'waiting_approval', 'paused'].includes(current.status)) {
      throw new OperationNotCancellableError(input.operationId);
    }
    if (!this.lifecycleTransactionService) throw new OperationLifecycleDependencyError();

    const timestamp = assertTimestamp(this.now());
    const updated = this.repository.update({
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      expectedStatus: current.status,
      expectedVersion: input.expectedVersion,
      status: 'cancelled',
      updatedAt: timestamp,
      startedAt: current.startedAt ?? null,
      completedAt: timestamp,
      result: null,
      error: null,
    });
    this.lifecycleTransactionService.cancelRunForOperationWithinTransaction({
      workspaceId: current.workspaceId,
      runId: current.runId,
      correlationId: current.correlationId,
    });
    return updated;
  }

  findById(workspaceId: string, operationId: string): ApiOperation {
    const operation = this.repository.findById(workspaceId, operationId);
    if (!operation) throw new OperationNotFoundError(operationId);
    return operation;
  }

  findWorkspaceIdByOpaqueId(operationId: string): string | undefined {
    return this.repository.findWorkspaceIdByOpaqueId(operationId);
  }

  findByCorrelationId(workspaceId: string, correlationId: string): ApiOperation | undefined {
    return this.repository.findByCorrelationId(workspaceId, correlationId);
  }

  listByRun(workspaceId: string, runId: string): ApiOperation[] {
    return this.repository.listByRun(workspaceId, runId);
  }

  listNonTerminalByRunAndType(
    workspaceId: string,
    runId: string,
    type: OperationType,
  ): ApiOperation[] {
    return this.repository.listNonTerminalByRunAndType(workspaceId, runId, type);
  }

  private assertPersistedBinding(operation: ApiOperation, workspaceId: string): void {
    const expectedCorrelationId = operation.type === 'run.create' ? operation.runId : operation.id;
    if (
      operation.workspaceId !== workspaceId
      || operation.aggregateType !== 'run'
      || operation.aggregateId !== operation.runId
      || !isNonEmptyString(operation.runId)
      || operation.correlationId !== expectedCorrelationId
    ) {
      throw new OperationIntegrityError('persisted Operation binding is invalid');
    }
  }

  private assertResultErrorContract(
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
      throw new OperationValidationError('non-terminal or cancelled operations cannot contain result or error');
    }
  }

}

export {
  NON_TERMINAL_OPERATION_STATUSES,
  OPERATION_TYPES,
  OperationNotFoundError,
  OperationValidationError,
  VersionConflictError,
};
