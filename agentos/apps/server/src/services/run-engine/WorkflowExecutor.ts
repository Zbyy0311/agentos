import {
  M3_STAGE_STATUSES,
  getM3StageTransitionEventContract,
} from '@agentos/shared';
import type { Run, RunSnapshot, RunSnapshotPayloadV2, RunStage } from '@agentos/shared';

export interface WorkflowExecutorInput {
  readonly run: Run;
  readonly snapshot: RunSnapshot<RunSnapshotPayloadV2>;
  readonly stages: readonly RunStage[];
}

export interface WorkflowStageSelection {
  readonly stage: RunStage;
  readonly dependenciesCompleted: readonly string[];
  readonly reason: 'active' | 'ready' | 'pending';
}

export class WorkflowExecutorError extends Error {
  readonly code = 'WORKFLOW_EXECUTOR_INVALID_GRAPH' as const;

  constructor(message: string) {
    super(`WORKFLOW_EXECUTOR_INVALID_GRAPH: ${message}`);
    this.name = 'WorkflowExecutorError';
  }
}

interface ValidatedGraph {
  readonly stages: RunStage[];
  readonly stageById: Map<string, RunStage>;
  readonly stageByKey: Map<string, RunStage>;
  readonly dependenciesByKey: Map<string, readonly string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonBlank(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkflowExecutorError(`${field} must be a non-blank string`);
  }
}

function sortedStages(stages: readonly RunStage[]): RunStage[] {
  return [...stages].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function assertDenseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new WorkflowExecutorError(`${field} must be an array`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) {
      throw new WorkflowExecutorError(`${field} contains unsupported fields`);
    }
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index) || typeof value[index] !== 'string' || value[index].length === 0) {
      throw new WorkflowExecutorError(`${field} must be a dense non-empty string array`);
    }
    result.push(value[index]);
  }
  return result;
}

function assertRunBinding(input: WorkflowExecutorInput): void {
  const { run, snapshot } = input;
  if (
    !isRecord(snapshot)
    || !isRecord(snapshot.payload)
    || snapshot.payload.schemaVersion !== 2
    || !isRecord(snapshot.payload.workflow)
  ) {
    throw new WorkflowExecutorError('Snapshot is not a V2 payload');
  }
  const payload = snapshot.payload;
  if (
    payload.schemaVersion !== 2
    || snapshot.snapshotSchemaVersion !== 2
    || snapshot.workspaceId !== run.workspaceId
    || snapshot.runId !== run.id
    || snapshot.workflowDefinitionId !== payload.workflow.definitionId
    || payload.run.workspaceId !== run.workspaceId
    || payload.run.taskId !== run.taskId
    || payload.run.origin !== run.origin
    || payload.run.reason !== run.reason
    || payload.run.parentRunId !== (run.parentRunId ?? null)
    || payload.run.rootRunId !== run.rootRunId
  ) {
    throw new WorkflowExecutorError('Snapshot is not bound to the persisted Run');
  }
}

function validateSnapshotStages(input: WorkflowExecutorInput): Map<string, readonly string[]> {
  const { snapshot } = input;
  const stageDefinitions = snapshot.payload.workflow.stages;
  if (!Array.isArray(stageDefinitions)) {
    throw new WorkflowExecutorError('Snapshot workflow stages are invalid');
  }
  const keys = new Set<string>();
  const sequenceByKey = new Map<string, number>();
  const dependenciesByKey = new Map<string, readonly string[]>();

  for (const definition of stageDefinitions) {
    if (!isRecord(definition)) throw new WorkflowExecutorError('Snapshot workflow stage is invalid');
    assertNonBlank(definition.workflowStageKey, 'Snapshot workflowStageKey');
    if (definition.name !== definition.workflowStageKey) throw new WorkflowExecutorError('Snapshot stage name binding is invalid');
    if (!Number.isSafeInteger(definition.sequence) || definition.sequence < 1) {
      throw new WorkflowExecutorError('Snapshot stage sequence is invalid');
    }
    if (keys.has(definition.workflowStageKey)) {
      throw new WorkflowExecutorError('Snapshot stage keys are duplicated');
    }
    const dependencies = assertDenseStringArray(
      definition.dependsOn,
      `Snapshot ${definition.workflowStageKey}.dependsOn`,
    );
    keys.add(definition.workflowStageKey);
    sequenceByKey.set(definition.workflowStageKey, definition.sequence);
    dependenciesByKey.set(definition.workflowStageKey, dependencies);
  }

  for (const [key, dependencies] of dependenciesByKey) {
    const unique = new Set<string>();
    for (const dependency of dependencies) {
      if (
        unique.has(dependency)
        || dependency === key
        || !sequenceByKey.has(dependency)
        || (sequenceByKey.get(dependency) ?? Number.MAX_SAFE_INTEGER) >= (sequenceByKey.get(key) ?? 0)
      ) {
        throw new WorkflowExecutorError(`Invalid dependency for ${key}`);
      }
      unique.add(dependency);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new WorkflowExecutorError('Workflow dependency cycle detected');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of dependenciesByKey.get(key) ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of dependenciesByKey.keys()) visit(key);
  return dependenciesByKey;
}

function validateStageRecords(input: WorkflowExecutorInput): {
  stages: RunStage[];
  stageById: Map<string, RunStage>;
  stageByKey: Map<string, RunStage>;
} {
  const definitions = input.snapshot.payload.workflow.stages;
  if (!Array.isArray(input.stages)) throw new WorkflowExecutorError('Persisted RunStage records are invalid');
  if (input.stages.length !== definitions.length) {
    throw new WorkflowExecutorError('Snapshot and RunStage counts do not match');
  }
  const definitionByKey = new Map(definitions.map(definition => [definition.workflowStageKey, definition]));
  const stages = sortedStages(input.stages);
  const stageById = new Map<string, RunStage>();
  const stageByKey = new Map<string, RunStage>();
  for (const stage of stages) {
    if (!isRecord(stage)) throw new WorkflowExecutorError('Persisted RunStage record is invalid');
    assertNonBlank(stage.id, 'RunStage id');
    if (
      stage.workspaceId !== input.run.workspaceId
      || stage.runId !== input.run.id
      || stage.runSnapshotId !== input.snapshot.id
      || stage.name !== stage.workflowStageKey
      || stageById.has(stage.id)
      || stageByKey.has(stage.workflowStageKey)
      || !M3_STAGE_STATUSES.includes(stage.status)
      || !Number.isSafeInteger(stage.sequence)
      || stage.sequence < 1
      || !Number.isSafeInteger(stage.attempt)
      || stage.attempt < 1
      || !Number.isSafeInteger(stage.version)
      || stage.version < 1
    ) {
      throw new WorkflowExecutorError('Persisted RunStage record is invalid');
    }
    const definition = definitionByKey.get(stage.workflowStageKey);
    if (!definition || stage.sequence !== definition.sequence) {
      throw new WorkflowExecutorError('RunStage does not match Snapshot stage metadata');
    }
    stageById.set(stage.id, stage);
    stageByKey.set(stage.workflowStageKey, stage);
  }
  if (stageByKey.size !== definitions.length) throw new WorkflowExecutorError('RunStage graph is incomplete');
  const active = stages.filter(stage => stage.status === 'starting' || stage.status === 'running');
  if (active.length > 1) throw new WorkflowExecutorError('Multiple active stages are not supported');
  return { stages, stageById, stageByKey };
}

export class WorkflowExecutor {
  private validate(input: WorkflowExecutorInput): ValidatedGraph {
    assertRunBinding(input);
    const dependenciesByKey = validateSnapshotStages(input);
    const records = validateStageRecords(input);
    return { ...records, dependenciesByKey };
  }

  selectNextStage(input: WorkflowExecutorInput): WorkflowStageSelection | undefined {
    const graph = this.validate(input);
    const active = graph.stages.find(stage => stage.status === 'starting' || stage.status === 'running');
    if (active) {
      return {
        stage: active,
        dependenciesCompleted: this.completedDependenciesFromGraph(graph, active.workflowStageKey),
        reason: 'active',
      };
    }
    const ready = graph.stages.find(stage => stage.status === 'ready');
    if (ready) {
      return {
        stage: ready,
        dependenciesCompleted: this.completedDependenciesFromGraph(graph, ready.workflowStageKey),
        reason: 'ready',
      };
    }
    const pending = graph.stages.find(stage => (
      stage.status === 'pending'
      && (graph.dependenciesByKey.get(stage.workflowStageKey) ?? [])
        .every(dependency => graph.stageByKey.get(dependency)?.status === 'completed')
    ));
    if (!pending) return undefined;
    return {
      stage: pending,
      dependenciesCompleted: this.completedDependenciesFromGraph(graph, pending.workflowStageKey),
      reason: 'pending',
    };
  }

  completedDependencies(input: WorkflowExecutorInput, workflowStageKey: string): string[] {
    const graph = this.validate(input);
    return this.completedDependenciesFromGraph(graph, workflowStageKey);
  }

  descendants(input: WorkflowExecutorInput, stageIdOrKey: string): RunStage[] {
    const graph = this.validate(input);
    const target = graph.stageById.get(stageIdOrKey) ?? graph.stageByKey.get(stageIdOrKey);
    if (!target) throw new WorkflowExecutorError('descendant root stage was not found');
    const descendants = graph.stages.filter(stage => (
      stage.id !== target.id && this.dependsTransitivelyOn(graph.dependenciesByKey, stage.workflowStageKey, target.workflowStageKey)
    ));
    return descendants;
  }

  skippableDescendants(input: WorkflowExecutorInput, stageIdOrKey: string): RunStage[] {
    return this.descendants(input, stageIdOrKey).filter(stage => (
      stage.status === 'pending' && getM3StageTransitionEventContract('pending', 'skipped') !== undefined
    ));
  }

  isRunCompletionSatisfied(input: WorkflowExecutorInput): boolean {
    const graph = this.validate(input);
    return graph.stages.every(stage => stage.status === 'completed' || stage.status === 'skipped');
  }

  private completedDependenciesFromGraph(graph: ValidatedGraph, workflowStageKey: string): string[] {
    const dependencies = graph.dependenciesByKey.get(workflowStageKey);
    if (!dependencies) throw new WorkflowExecutorError('stage key was not found');
    return dependencies.filter(dependency => graph.stageByKey.get(dependency)?.status === 'completed');
  }

  private dependsTransitivelyOn(
    dependenciesByKey: Map<string, readonly string[]>,
    candidate: string,
    target: string,
  ): boolean {
    const visited = new Set<string>();
    const visit = (key: string): boolean => {
      if (visited.has(key)) return false;
      visited.add(key);
      const dependencies = dependenciesByKey.get(key) ?? [];
      if (dependencies.includes(target)) return true;
      return dependencies.some(dependency => visit(dependency));
    };
    return visit(candidate);
  }
}
