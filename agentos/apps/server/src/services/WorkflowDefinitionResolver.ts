import type { WorkflowDefinition, WorkflowDefinitionPayloadV2, WorkflowStageDefinitionV2 } from '@agentos/shared';
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

type V2WorkflowDefinition = WorkflowDefinition & { payload: WorkflowDefinitionPayloadV2 };

function requireV2(definition: WorkflowDefinition): V2WorkflowDefinition {
  if (definition.payload.schemaVersion !== 2) {
    throw snapshotFailure('RUN_SNAPSHOT_FAILED: workflow definition V2 is required');
  }
  return definition as V2WorkflowDefinition;
}

function assertLegacyPayload(definition: V2WorkflowDefinition): void {
  const expected: readonly WorkflowStageDefinitionV2[] = [
    { key: 'codex_manager', sequence: 1, agentRole: 'codex', dependsOn: [] },
    { key: 'kimi_worker', sequence: 2, agentRole: 'kimi', dependsOn: ['codex_manager'] },
    { key: 'opencode_reviewer', sequence: 3, agentRole: 'opencode', dependsOn: ['kimi_worker'] },
    { key: 'codex_final_review', sequence: 4, agentRole: 'codex', dependsOn: ['opencode_reviewer'] },
  ];
  const payload = definition.payload;
  if (
    payload.executionMode !== 'legacy_pipeline'
    || payload.retryPolicy !== null
    || payload.worktreeMode !== 'preferred'
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
      || JSON.stringify(stage.dependsOn) !== JSON.stringify(expectedStage.dependsOn)
    ) {
      throw snapshotFailure('RUN_SNAPSHOT_FAILED: legacy workflow definition is incompatible');
    }
  }
}

function assertUnboundPayload(definition: V2WorkflowDefinition): void {
  const payload = definition.payload;
  if (
    payload.executionMode !== 'unbound'
    || payload.retryPolicy !== null
    || payload.worktreeMode !== 'disabled'
    || payload.stages.length !== 0
    || payload.definitionKey !== UNBOUND_KEY
  ) {
    throw snapshotFailure('RUN_SNAPSHOT_FAILED: unbound workflow definition is incompatible');
  }
}

export class WorkflowDefinitionResolver {
  constructor(private readonly repository: WorkflowDefinitionRepository) {}

  resolveLegacyPipeline(): V2WorkflowDefinition {
    try {
      const definition = this.repository.findLatestAvailableByKey(LEGACY_KEY);
      if (!definition) throw new WorkflowNotAvailableError(LEGACY_KEY);
      const v2 = requireV2(definition);
      assertLegacyPayload(v2);
      return v2;
    } catch (error) {
      if (error instanceof WorkflowNotAvailableError || (error as { code?: string } | null)?.code === 'RUN_SNAPSHOT_FAILED') {
        throw error;
      }
      throw snapshotFailure('RUN_SNAPSHOT_FAILED: legacy workflow definition could not be resolved');
    }
  }

  resolveUnboundTaskRun(): V2WorkflowDefinition {
    try {
      const definition = this.repository.findLatestAvailableByKey(UNBOUND_KEY);
      if (!definition) throw new WorkflowNotAvailableError(UNBOUND_KEY);
      const v2 = requireV2(definition);
      assertUnboundPayload(v2);
      return v2;
    } catch (error) {
      if (error instanceof WorkflowNotAvailableError || (error as { code?: string } | null)?.code === 'RUN_SNAPSHOT_FAILED') {
        throw error;
      }
      throw snapshotFailure('RUN_SNAPSHOT_FAILED: unbound workflow definition could not be resolved');
    }
  }
}
