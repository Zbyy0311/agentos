import type { ApiOperation, RuntimeEventEnvelope, Run } from '@agentos/shared';
import { RunNotFoundError, type RunRepository } from '../../store/RunRepository.js';
import type { OperationType } from '../../store/OperationRepository.js';
import type { OutboxMessage } from '../../store/OutboxRepository.js';
import type { OperationService } from '../OperationService.js';
import type {
  LifecycleTransactionService,
  RunLifecycleTransitionResult,
} from '../LifecycleTransactionService.js';

export interface RunEngineTickInput {
  readonly workspaceId: string;
  readonly runId: string;
}

export type RunEngineTickResult =
  | {
      readonly outcome: 'claimed';
      readonly run: Run;
      readonly operation: ApiOperation;
      readonly event: RuntimeEventEnvelope;
      readonly outbox: OutboxMessage;
    }
  | {
      readonly outcome: 'noop';
      readonly reason: 'run-not-queued' | 'no-authorization';
      readonly runId: string;
    };

export type RunEngineErrorCode =
  | 'RUN_ENGINE_AUTHORIZATION_AMBIGUOUS'
  | 'RUN_ENGINE_AUTHORIZATION_NOT_QUEUED'
  | 'RUN_ENGINE_AUTHORIZATION_BINDING_INVALID';

export class RunEngineError extends Error {
  constructor(readonly code: RunEngineErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'RunEngineError';
  }
}

export interface RunEngineDependencies {
  readonly runRepository: Pick<RunRepository, 'findById'>;
  readonly operationService: Pick<OperationService, 'listByRun' | 'transitionWithinTransaction'>;
  readonly lifecycleTransactionService: Pick<
    LifecycleTransactionService,
    'transitionRunWithinTransaction'
  >;
  readonly runInTransaction: <T>(fn: () => T) => T;
}

function isExecutionAuthorization(operation: ApiOperation): boolean {
  return (operation.type === 'run.start' || operation.type === 'run.retry')
    && (
      operation.status === 'queued'
      || operation.status === 'running'
      || operation.status === 'waiting_approval'
      || operation.status === 'paused'
    );
}

function isExecutionAuthorizationType(type: string): type is OperationType {
  return type === 'run.start' || type === 'run.retry';
}

export class RunEngine {
  constructor(private readonly dependencies: RunEngineDependencies) {}

  tick(input: RunEngineTickInput): RunEngineTickResult {
    return this.dependencies.runInTransaction(() => this.tickWithinTransaction(input));
  }

  private tickWithinTransaction(input: RunEngineTickInput): RunEngineTickResult {
    const run = this.dependencies.runRepository.findById(input.workspaceId, input.runId);
    if (!run) throw new RunNotFoundError(input.runId);
    if (run.status !== 'queued') {
      return { outcome: 'noop', reason: 'run-not-queued', runId: run.id };
    }

    const authorizations = this.dependencies.operationService
      .listByRun(input.workspaceId, run.id)
      .filter(isExecutionAuthorization);
    if (authorizations.length === 0) {
      return { outcome: 'noop', reason: 'no-authorization', runId: run.id };
    }
    if (authorizations.length > 1) {
      throw new RunEngineError(
        'RUN_ENGINE_AUTHORIZATION_AMBIGUOUS',
        `Run ${run.id} has ${authorizations.length} active execution authorizations`,
      );
    }

    const authorization = authorizations[0]!;
    if (authorization.status !== 'queued') {
      throw new RunEngineError(
        'RUN_ENGINE_AUTHORIZATION_NOT_QUEUED',
        `Authorization ${authorization.id} is ${authorization.status}, expected queued`,
      );
    }
    if (
      authorization.workspaceId !== run.workspaceId
      || authorization.aggregateType !== 'run'
      || authorization.aggregateId !== run.id
      || authorization.runId !== run.id
      || !isExecutionAuthorizationType(authorization.type)
      || authorization.correlationId !== authorization.id
    ) {
      throw new RunEngineError(
        'RUN_ENGINE_AUTHORIZATION_BINDING_INVALID',
        `Authorization ${authorization.id} is not bound to Run ${run.id}`,
      );
    }

    const operation = this.dependencies.operationService.transitionWithinTransaction({
      workspaceId: run.workspaceId,
      operationId: authorization.id,
      expectedVersion: authorization.version,
      to: 'running',
    });
    const transition: RunLifecycleTransitionResult = this.dependencies.lifecycleTransactionService
      .transitionRunWithinTransaction({
        workspaceId: run.workspaceId,
        runId: run.id,
        expectedVersion: run.version,
        expectedFrom: 'queued',
        to: 'starting',
        correlationId: authorization.correlationId,
      });

    return {
      outcome: 'claimed',
      run: transition.run,
      operation,
      event: transition.event,
      outbox: transition.outbox,
    };
  }
}
