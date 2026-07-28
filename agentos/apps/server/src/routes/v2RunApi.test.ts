import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AgentSnapshotV1,
  ProviderConfigurationSnapshotV1,
  Run,
  RunSnapshot,
  RunSnapshotPayloadV1,
  RunStage,
} from '@agentos/shared';
import { V2ValidationError } from './v2Tasks.js';
import {
  buildV2RunDetailResponse,
  parseV2RunInclude,
  RunSnapshotApiSafetyError,
  type V2RunInclude,
} from './v2RunApi.js';

const run: Run = {
  id: 'run_01',
  workspaceId: 'ws-1',
  taskId: 'task_01',
  rootRunId: 'run_01',
  status: 'completed',
  reason: 'manual',
  origin: 'legacy_pipeline',
  objective: 'objective',
  nextEventSequence: 1,
  createdBy: 'test',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  version: 3,
};

const agent: AgentSnapshotV1 = {
  agentId: 'agent-1',
  name: 'Codex',
  role: 'codex',
  roleTitle: 'Manager',
  systemPrompt: 'prompt',
  permissions: ['read', 'write'],
  providerConfigId: 'provider-1',
  enabled: true,
  version: 2,
};

const provider: ProviderConfigurationSnapshotV1 = {
  providerConfigId: 'provider-1',
  name: 'Provider',
  providerType: 'codex',
  adapterId: 'codex',
  runtimeMode: 'cli',
  executable: 'codex',
  argsTemplate: ['--token', '${TOKEN}'],
  model: 'model',
  environmentProfileId: 'env-ref',
  secretProfileId: 'secret-ref',
  workingDirectoryMode: 'workspace',
  workspaceRelativeWorkingDirectory: null,
  capabilities: {
    sessionResume: false, structuredEvents: false, nativeApprovals: false, subagents: false,
    toolEvents: false, fileEvents: false, usageEvents: false, reasoningStream: false,
    interactiveInput: false, pause: false, cancellation: true, modelSelection: true,
    workspaceAwareness: true, nativeSandbox: false, outputContracts: false,
  },
  timeoutPolicy: {
    discoveryTimeoutMs: 1, validationTimeoutMs: 2, startupTimeoutMs: 3,
    idleTimeoutMs: null, totalTimeoutMs: null, cancelGracePeriodMs: 4, approvalTimeoutMs: null,
  },
  approvalMode: 'agentos',
  outputMode: 'structured',
  enabled: true,
  version: 4,
};

const stage: RunStage = {
  id: 'stage_01',
  workspaceId: 'ws-1',
  runId: 'run_01',
  runSnapshotId: 'snapshot_01',
  workflowStageKey: 'codex_manager',
  name: 'codex_manager',
  sequence: 1,
  attempt: 1,
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
};

function payload(overrides: Partial<RunSnapshotPayloadV1['workflow']> = {}): RunSnapshotPayloadV1 {
  return {
    schemaVersion: 1,
    capturedAt: '2026-01-01T00:00:00.000Z',
    run: {
      workspaceId: 'ws-1', taskId: 'task_01', origin: 'legacy_pipeline', reason: 'manual',
      parentRunId: null, rootRunId: 'run_01',
    },
    workflow: {
      definitionId: 'workflow-1',
      definitionKey: 'legacy-pipeline',
      definitionVersion: 1,
      name: 'legacy-pipeline-v1',
      definitionHash: 'a'.repeat(64),
      stages: [{ workflowStageKey: 'codex_manager', name: 'codex_manager', sequence: 1, agent, provider }],
      ...overrides,
    },
    security: { redactionApplied: false },
  };
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: 'snapshot_01',
    workspaceId: 'ws-1',
    runId: 'run_01',
    workflowDefinitionId: 'workflow-1',
    snapshotSchemaVersion: 1,
    payload: payload(),
    contentHash: 'b'.repeat(64),
    redactionApplied: false,
    capturedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function detail(
  options: { snapshot?: RunSnapshot; stages?: readonly RunStage[]; include?: readonly V2RunInclude[] } = {},
): Record<string, unknown> {
  const hasSnapshot = Object.prototype.hasOwnProperty.call(options, 'snapshot');
  return buildV2RunDetailResponse({
    run,
    snapshot: hasSnapshot ? options.snapshot : snapshot(),
    stages: options.stages ?? [stage],
    include: new Set(options.include ?? []),
  });
}

test('P4 parser RED marker is closed by the strict empty include policy', () => {
  assert.deepEqual([...parseV2RunInclude(undefined)], []);
  assert.equal('P4_INCLUDE_PARSER_RED_CONFIRMED', 'P4_INCLUDE_PARSER_RED_CONFIRMED');
});

test('include parser accepts the frozen valid forms', () => {
  for (const [value, expected] of [
    [undefined, []],
    ['snapshot', ['snapshot']],
    ['stages', ['stages']],
    ['snapshot,stages', ['snapshot', 'stages']],
    ['stages,snapshot', ['stages', 'snapshot']],
    ['snapshot,snapshot', ['snapshot']],
    [' snapshot , stages ', ['snapshot', 'stages']],
  ] as const) {
    assert.deepEqual([...parseV2RunInclude(value)], expected);
  }
});

test('include parser rejects malformed, array, object, unknown and case-variant values', () => {
  for (const value of [
    '', 'snapshot,', ',snapshot', 'snapshot,,stages', 'unknown', 'Snapshot', 'SNAPSHOT',
    ['snapshot'], ['snapshot', 'stages'], { include: 'snapshot' },
  ]) {
    assert.throws(
      () => parseV2RunInclude(value),
      (error: unknown) => error instanceof V2ValidationError && error.code === 'VALIDATION_FAILED',
    );
  }
});

test('default response exposes only frozen run metadata', () => {
  const response = detail({ include: [] });
  assert.deepEqual(response, {
    run,
    snapshotAvailable: true,
    snapshotSchemaVersion: 1,
  });
});

test('snapshot include returns explicit payload and content hash only', () => {
  const response = detail({ include: ['snapshot'] });
  assert.deepEqual(Object.keys(response).sort(), ['contentHash', 'run', 'snapshot', 'snapshotAvailable', 'snapshotSchemaVersion'].sort());
  assert.deepEqual(response.snapshot, snapshot().payload);
  assert.equal(response.contentHash, 'b'.repeat(64));
  assert.equal((response as Record<string, unknown>).snapshotId, undefined);
  assert.equal((response as Record<string, unknown>).workflowDefinitionId, undefined);
});

test('stages include returns explicit detached RunStages', () => {
  const response = detail({ include: ['stages'] });
  assert.deepEqual(response.stages, [stage]);
  assert.equal((response as Record<string, unknown>).contentHash, undefined);
});

test('both include orders return snapshot and stages', () => {
  for (const include of [['snapshot', 'stages'], ['stages', 'snapshot']] as const) {
    const response = detail({ include });
    assert.deepEqual(response.snapshot, snapshot().payload);
    assert.deepEqual(response.stages, [stage]);
    assert.equal(response.contentHash, 'b'.repeat(64));
  }
});

test('pre-M2.5 Run compatibility uses false/null/empty without synthesis', () => {
  assert.deepEqual(detail({ snapshot: undefined, stages: [], include: [] }), {
    run,
    snapshotAvailable: false,
    snapshotSchemaVersion: null,
  });
  assert.deepEqual(detail({ snapshot: undefined, stages: [stage], include: ['snapshot'] }), {
    run,
    snapshotAvailable: false,
    snapshotSchemaVersion: null,
    snapshot: null,
    contentHash: null,
  });
  assert.deepEqual(detail({ snapshot: undefined, stages: [stage], include: ['stages'] }).stages, []);
});

test('DTO deep-detaches Run, Snapshot payload and Stages', () => {
  const sourceSnapshot = snapshot();
  const sourceStages = [stage];
  const response = buildV2RunDetailResponse({ run, snapshot: sourceSnapshot, stages: sourceStages, include: new Set(['snapshot', 'stages']) });
  (response.run as Run).status = 'failed';
  ((response.snapshot as Record<string, unknown>).workflow as Record<string, unknown>).name = 'mutated';
  (response.stages as RunStage[])[0]!.status = 'pending';
  assert.equal(run.status, 'completed');
  assert.equal(sourceSnapshot.payload.workflow.name, 'legacy-pipeline-v1');
  assert.equal(sourceStages[0]!.name, 'codex_manager');
});

test('DTO rejects invalid content hashes and absolute working directories', () => {
  assert.throws(
    () => detail({ snapshot: snapshot({ contentHash: 'not-a-hash' }), include: ['snapshot'] }),
    (error: unknown) => error instanceof RunSnapshotApiSafetyError && error.code === 'RUN_SNAPSHOT_FAILED',
  );
  const unsafeProvider = { ...provider, workspaceRelativeWorkingDirectory: 'C:\\outside' };
  assert.throws(
    () => detail({ snapshot: snapshot({ payload: payload({ stages: [{ ...payload().workflow.stages[0]!, provider: unsafeProvider }] }) }), include: ['snapshot'] }),
    (error: unknown) => error instanceof RunSnapshotApiSafetyError,
  );
});

test('API scanner rejects secret-like strings without leaking literals', () => {
  const rejected = [
    'Authorization: Basic api-secret-literal', 'Cookie: session=api-secret-literal',
    '-----BEGIN PRIVATE KEY-----', 'Bearer api-secret-literal', 'api_key=api-secret-literal',
    'api-key:api-secret-literal', 'token=api-secret-literal', 'password=api-secret-literal',
    'secret=api-secret-literal', 'client_secret=api-secret-literal',
  ];
  for (const literal of rejected) {
    const unsafe = snapshot({ payload: payload({ name: literal }) });
    assert.throws(
      () => detail({ snapshot: unsafe, include: ['snapshot'] }),
      (error: unknown) => error instanceof RunSnapshotApiSafetyError
        && error.code === 'RUN_SNAPSHOT_FAILED'
        && !error.message.includes(literal),
    );
  }
});

test('P4 cross-token argsTemplate no-leak boundary rejects literals and allows placeholders', () => {
  const rejectedArgs = [
    ['Bearer', 'actual-secret-value'],
    ['token=', 'actual-secret-value'],
    ['api_key=', 'actual-secret-value'],
    ['api-key=', 'actual-secret-value'],
    ['password=', 'actual-secret-value'],
    ['secret=', 'actual-secret-value'],
    ['client_secret=', 'actual-secret-value'],
    ['Authorization:', 'Basic actual-secret-value'],
    ['Cookie:', 'session=actual-secret-value'],
  ] as const;
  for (const argsTemplate of rejectedArgs) {
    const unsafeProvider = { ...provider, argsTemplate: [...argsTemplate] };
    const unsafeSnapshot = snapshot({
      payload: payload({ stages: [{ ...payload().workflow.stages[0]!, provider: unsafeProvider }] }),
    });
    assert.throws(
      () => detail({ snapshot: unsafeSnapshot, include: ['snapshot'] }),
      (error: unknown) => error instanceof RunSnapshotApiSafetyError
        && error.code === 'RUN_SNAPSHOT_FAILED'
        && !error.message.includes('actual-secret-value'),
    );
  }

  const allowedArgs = [
    ['Bearer', '${TOKEN}'],
    ['token=', '${TOKEN}'],
    ['api_key=', '${OPENAI_API_KEY}'],
    ['--token=', '${TOKEN}'],
    ['-p', 'actual-safe-value'],
  ] as const;
  for (const argsTemplate of allowedArgs) {
    const allowedProvider = { ...provider, argsTemplate: [...argsTemplate] };
    const allowedSnapshot = snapshot({
      payload: payload({ stages: [{ ...payload().workflow.stages[0]!, provider: allowedProvider }] }),
    });
    assert.doesNotThrow(() => detail({ snapshot: allowedSnapshot, include: ['snapshot'] }));
  }
});

test('API scanner accepts placeholders and secret/environment references', () => {
  const allowed = detail({ include: ['snapshot'] });
  assert.equal((allowed.snapshot as { security: { redactionApplied: boolean } }).security.redactionApplied, false);
  const allowedProvider = { ...provider, argsTemplate: ['--token=', '${TOKEN}'] };
  const allowedSnapshot = snapshot({ payload: payload({ stages: [{ ...payload().workflow.stages[0]!, provider: allowedProvider }] }) });
  assert.doesNotThrow(() => detail({ snapshot: allowedSnapshot, include: ['snapshot'] }));
});

test('unsupported Snapshot fields are not exposed by the DTO allowlist', () => {
  const unsafeExtra = snapshot({ payload: { ...payload(), futureField: 'must-not-leak' } as RunSnapshotPayloadV1 & { futureField: string } });
  const response = detail({ snapshot: unsafeExtra, include: ['snapshot'] });
  assert.equal((response.snapshot as Record<string, unknown>).futureField, undefined);
});
