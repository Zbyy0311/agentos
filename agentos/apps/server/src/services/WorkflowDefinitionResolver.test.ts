import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowDefinition, WorkflowDefinitionPayloadV2 } from '@agentos/shared';
import { WorkflowDefinitionResolver } from './WorkflowDefinitionResolver.js';

function definition(payload: WorkflowDefinitionPayloadV2): WorkflowDefinition {
  return {
    id: `workflow-${payload.definitionKey}`,
    definitionKey: payload.definitionKey,
    version: payload.version,
    name: payload.name,
    payload,
    definitionHash: 'a'.repeat(64),
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const legacyPayload = (): WorkflowDefinitionPayloadV2 => ({
  schemaVersion: 2,
  definitionKey: 'legacy-pipeline',
  version: 2,
  name: 'legacy-pipeline-v2',
  executionMode: 'legacy_pipeline',
  retryPolicy: null,
  worktreeMode: 'preferred',
  stages: [
    { key: 'codex_manager', sequence: 1, agentRole: 'codex', dependsOn: [] },
    { key: 'kimi_worker', sequence: 2, agentRole: 'kimi', dependsOn: ['codex_manager'] },
    { key: 'opencode_reviewer', sequence: 3, agentRole: 'opencode', dependsOn: ['kimi_worker'] },
    { key: 'codex_final_review', sequence: 4, agentRole: 'codex', dependsOn: ['opencode_reviewer'] },
  ],
});

const unboundPayload = (): WorkflowDefinitionPayloadV2 => ({
  schemaVersion: 2,
  definitionKey: 'unbound-task-run',
  version: 2,
  name: 'unbound-task-run-v2',
  executionMode: 'unbound',
  retryPolicy: null,
  worktreeMode: 'disabled',
  stages: [],
});

function resolverFor(values: Record<string, WorkflowDefinition | undefined>): WorkflowDefinitionResolver {
  return new WorkflowDefinitionResolver({
    findLatestAvailableByKey: (key: string) => values[key],
  } as never);
}

test('WorkflowDefinitionResolver resolves the latest available built-in definitions', () => {
  const legacy = definition(legacyPayload());
  const unbound = definition(unboundPayload());
  const resolver = resolverFor({ 'legacy-pipeline': legacy, 'unbound-task-run': unbound });

  assert.equal(resolver.resolveLegacyPipeline(), legacy);
  assert.equal(resolver.resolveUnboundTaskRun(), unbound);
  assert.equal(legacy.payload.stages.map(stage => stage.key).join(','), 'codex_manager,kimi_worker,opencode_reviewer,codex_final_review');
});

test('WorkflowDefinitionResolver treats missing, disabled, and archived definitions as unavailable', () => {
  for (const value of [undefined]) {
    const resolver = resolverFor({ 'legacy-pipeline': value, 'unbound-task-run': value });
    assert.throws(() => resolver.resolveLegacyPipeline(), (error: unknown) => (error as { code?: string }).code === 'WORKFLOW_NOT_AVAILABLE');
    assert.throws(() => resolver.resolveUnboundTaskRun(), (error: unknown) => (error as { code?: string }).code === 'WORKFLOW_NOT_AVAILABLE');
  }
});

test('WorkflowDefinitionResolver rejects a V1 definition instead of silently converting it', () => {
  const v1 = {
    ...legacyPayload(),
    schemaVersion: 1,
    version: 1,
    name: 'legacy-pipeline-v1',
    worktreeMode: undefined,
    stages: legacyPayload().stages.map(({ dependsOn: _dependsOn, ...stage }) => stage),
  } as never as WorkflowDefinition;
  assert.throws(
    () => resolverFor({ 'legacy-pipeline': v1 }).resolveLegacyPipeline(),
    (error: unknown) => (error as { code?: string }).code === 'RUN_SNAPSHOT_FAILED',
  );
});

test('WorkflowDefinitionResolver rejects incompatible built-in semantics without exposing definition JSON', () => {
  const wrong = definition({ ...legacyPayload(), executionMode: 'unbound', stages: [] });
  const resolver = resolverFor({ 'legacy-pipeline': wrong });
  assert.throws(
    () => resolver.resolveLegacyPipeline(),
    (error: unknown) => (error as { code?: string; message?: string }).code === 'RUN_SNAPSHOT_FAILED'
      && !(error as Error).message.includes('definition_json'),
  );
});

test('WorkflowDefinitionResolver rejects wrong legacy keys, roles, sequences, and non-empty unbound stages', () => {
  const wrongKey = definition({
    ...legacyPayload(),
    stages: [{ key: 'wrong', sequence: 1, agentRole: 'codex', dependsOn: [] }, ...legacyPayload().stages.slice(1)],
  });
  assert.throws(() => resolverFor({ 'legacy-pipeline': wrongKey }).resolveLegacyPipeline(), (error: unknown) => (error as { code?: string }).code === 'RUN_SNAPSHOT_FAILED');

  const wrongRole = definition({
    ...legacyPayload(),
    stages: [{ key: 'codex_manager', sequence: 1, agentRole: 'mimo', dependsOn: [] }, ...legacyPayload().stages.slice(1)],
  });
  assert.throws(() => resolverFor({ 'legacy-pipeline': wrongRole }).resolveLegacyPipeline(), (error: unknown) => (error as { code?: string }).code === 'RUN_SNAPSHOT_FAILED');

  const wrongSequence = definition({
    ...legacyPayload(),
    stages: [{ key: 'codex_manager', sequence: 2, agentRole: 'codex', dependsOn: [] }, ...legacyPayload().stages.slice(1)],
  });
  assert.throws(() => resolverFor({ 'legacy-pipeline': wrongSequence }).resolveLegacyPipeline(), (error: unknown) => (error as { code?: string }).code === 'RUN_SNAPSHOT_FAILED');

  const nonEmptyUnbound = definition({
    ...unboundPayload(),
    stages: [{ key: 'unexpected', sequence: 1, agentRole: null, dependsOn: [] }],
  });
  assert.throws(() => resolverFor({ 'unbound-task-run': nonEmptyUnbound }).resolveUnboundTaskRun(), (error: unknown) => (error as { code?: string }).code === 'RUN_SNAPSHOT_FAILED');
});
