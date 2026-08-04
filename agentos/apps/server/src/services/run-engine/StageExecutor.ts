import type { ApiProblem } from '@agentos/shared';
import { isValidApiProblem } from '../../store/OperationRepository.js';

export interface StageExecutorInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly workflowStageKey: string;
  readonly attempt: number;
}

export type StageExecutorResult =
  | { readonly outcome: 'active' }
  | {
      readonly outcome: 'completed';
      readonly durationMs: number;
      readonly artifactIds: string[];
      readonly outputContractSatisfied: boolean;
      readonly summaryArtifactId?: string;
    }
  | {
      readonly outcome: 'failed';
      readonly problem: ApiProblem;
      readonly phase: string;
      readonly retryScheduled: false;
    };

export type StageExecutorResolver = (input: StageExecutorInput) => StageExecutorResult;

export class StageExecutorError extends Error {
  readonly code = 'STAGE_EXECUTOR_INVALID_RESULT' as const;

  constructor(message: string) {
    super(`STAGE_EXECUTOR_INVALID_RESULT: ${message}`);
    this.name = 'StageExecutorError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonBlank(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StageExecutorError(`${field} must be a non-blank string`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new StageExecutorError(`unsupported result field: ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new StageExecutorError(`missing result field: ${key}`);
  }
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new StageExecutorError(`${field} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index) || typeof value[index] !== 'string') {
      throw new StageExecutorError(`${field} must be a dense string array`);
    }
  }
}

function validateInput(input: StageExecutorInput): void {
  assertNonBlank(input.workspaceId, 'workspaceId');
  assertNonBlank(input.runId, 'runId');
  assertNonBlank(input.stageId, 'stageId');
  assertNonBlank(input.workflowStageKey, 'workflowStageKey');
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new StageExecutorError('attempt must be a positive safe integer');
  }
}

function validateResult(result: unknown): asserts result is StageExecutorResult {
  if (!isRecord(result) || typeof result.outcome !== 'string') {
    throw new StageExecutorError('outcome is required');
  }
  if (result.outcome === 'active') {
    assertExactKeys(result, ['outcome']);
    return;
  }
  if (result.outcome === 'completed') {
    assertExactKeys(
      result,
      ['outcome', 'durationMs', 'artifactIds', 'outputContractSatisfied'],
      ['summaryArtifactId'],
    );
    if (typeof result.durationMs !== 'number' || !Number.isFinite(result.durationMs) || result.durationMs < 0) {
      throw new StageExecutorError('durationMs must be a non-negative finite number');
    }
    assertStringArray(result.artifactIds, 'artifactIds');
    if (typeof result.outputContractSatisfied !== 'boolean') {
      throw new StageExecutorError('outputContractSatisfied must be boolean');
    }
    if (result.summaryArtifactId !== undefined) assertNonBlank(result.summaryArtifactId, 'summaryArtifactId');
    return;
  }
  if (result.outcome === 'failed') {
    assertExactKeys(result, ['outcome', 'problem', 'phase', 'retryScheduled']);
    if (!isValidApiProblem(result.problem)) throw new StageExecutorError('problem is malformed');
    assertNonBlank(result.phase, 'phase');
    if (result.retryScheduled !== false) throw new StageExecutorError('retryScheduled must be false');
    return;
  }
  throw new StageExecutorError('outcome is invalid');
}

export class StageExecutor {
  constructor(private readonly resolve: StageExecutorResolver) {}

  execute(input: StageExecutorInput): StageExecutorResult {
    validateInput(input);
    const result: unknown = this.resolve({ ...input });
    validateResult(result);
    return result;
  }
}
