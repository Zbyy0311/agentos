import type { WorkflowDefinition, WorkflowStageDefinitionV1 } from '@agentos/shared';
import type { WorkflowDefinitionRepository } from '../store/WorkflowDefinitionRepository.js';

const LEGACY_KEY = 'legacy-pipeline';
const UNBOUND_KEY = 'unbound-task-run';

export class WorkflowNotAvailableError extends Error {
  readonly code = 'WORKFLOW_NOT_AVAILABLE' as const;

  constructor(definitionKey: string) {
    super(`Workflow is not available: ${definitionKey}`);
    this.name = 'WorkflowNotAvailableError';
  }
}

function snapshotFailure(message: string): Error & { code: 'RUN_SNAPSHOT_FAILED' } {
  const error = new Error(message) as Error & { code: 'RUN_SNAPSHOT_FAILED' };
  error.code = 'RUN_SNAPSHOT_FAILED';
  return error;
}

function assertLegacyPayload(definition: WorkflowDefinition): void {
  const expected: readonly WorkflowStageDefinitionV1[] = [
    { key: 'codex_manager', sequence: 1, agentRole: 'codex' },
    { key: 'kimi_worker', sequence: 2, agentRole: 'kimi' },
    { key: 'opencode_reviewer', sequence: 3, agentRole: 'opencode' },
    { key: 'codex_final_review', sequence: 4, agentRole: 'codex' },
  ];
  const payload = definition.payload;
  if (
    payload.executionMode !== 'legacy_pipeline'
    || payload.retryPolicy !== null
    || payload.stages.length !== expected.length
    || payload.definitionKey !== LEGACY_KEY
  ) {
    throw snapshotFailure('RUN_SNAPSHOT_FAILED: legacy workflow definition is incompatible');
  }
  for (const [index, stage] of payload.stages.entries()) {
    const expectedStage = expected[index];
    if (
      stage.key !== expectedStage.key
      || stage.sequence !== expectedStage.sequence
      || stage.agentRole !== expectedStage.agentRole
    ) {
      throw snapshotFailure('RUN_SNAPSHOT_FAILED: legacy workflow definition is incompatible');
    }
  }
}

function assertUnboundPayload(definition: WorkflowDefinition): void {
  const payload = definition.payload;
  if (
    payload.executionMode !== 'unbound'
    || payload.retryPolicy !== null
    || payload.stages.length !== 0
    || payload.definitionKey !== UNBOUND_KEY
  ) {
    throw snapshotFailure('RUN_SNAPSHOT_FAILED: unbound workflow definition is incompatible');
  }
}

export class WorkflowDefinitionResolver {
  constructor(private readonly repository: WorkflowDefinitionRepository) {}

  resolveLegacyPipeline(): WorkflowDefinition {
    try {
      const definition = this.repository.findLatestAvailableByKey(LEGACY_KEY);
      if (!definition) throw new WorkflowNotAvailableError(LEGACY_KEY);
      assertLegacyPayload(definition);
      return definition;
    } catch (error) {
      if (error instanceof WorkflowNotAvailableError || (error as { code?: string } | null)?.code === 'RUN_SNAPSHOT_FAILED') {
        throw error;
      }
      throw snapshotFailure('RUN_SNAPSHOT_FAILED: legacy workflow definition could not be resolved');
    }
  }

  resolveUnboundTaskRun(): WorkflowDefinition {
    try {
      const definition = this.repository.findLatestAvailableByKey(UNBOUND_KEY);
      if (!definition) throw new WorkflowNotAvailableError(UNBOUND_KEY);
      assertUnboundPayload(definition);
      return definition;
    } catch (error) {
      if (error instanceof WorkflowNotAvailableError || (error as { code?: string } | null)?.code === 'RUN_SNAPSHOT_FAILED') {
        throw error;
      }
      throw snapshotFailure('RUN_SNAPSHOT_FAILED: unbound workflow definition could not be resolved');
    }
  }
}
