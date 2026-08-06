import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import type {
  AgentSnapshotV1,
  ProviderConfigurationSnapshotV1,
  Run,
  RunSnapshot,
  RunSnapshotPayloadV2,
  RunStage,
  WorkflowDefinition,
  Workspace,
} from '@agentos/shared';
import type { ProviderConfiguration } from '../store/ProviderConfigurationRepository.js';
import type { AgentSnapshotSourceRecord } from '../store/SqliteStore.js';
import {
  AgentNotAvailableError,
  ProviderConfigNotAvailableError,
  RunSnapshotFailedError,
  SnapshotService,
  type SnapshotServiceDeps,
} from './SnapshotService.js';

const legacyWorkflow: WorkflowDefinition = {
  id: 'workflow-legacy',
  definitionKey: 'legacy-pipeline',
  version: 1,
  name: 'legacy-pipeline-v1',
  definitionHash: 'a'.repeat(64),
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  payload: {
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
  },
};

const unboundWorkflow: WorkflowDefinition = {
  ...legacyWorkflow,
  id: 'workflow-unbound',
  definitionKey: 'unbound-task-run',
  name: 'unbound-task-run-v1',
  payload: {
    schemaVersion: 2,
    definitionKey: 'unbound-task-run',
    version: 2,
    name: 'unbound-task-run-v2',
    executionMode: 'unbound',
    retryPolicy: null,
    worktreeMode: 'disabled',
    stages: [],
  },
};

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  const workspaceRoot = resolve('snapshot-workspace-root');
  return {
    id: 'ws-1',
    name: 'Workspace',
    rootPath: workspaceRoot,
    gitEnabled: false,
    memoryEnabled: false,
    agents: [
      { id: 'agent-codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'old-codex', cliArgs: ['old'], thinkingEffort: 'high' },
      { id: 'agent-kimi', name: 'Kimi', role: 'kimi', enabled: true, cliCommand: 'old-kimi', cliArgs: ['old'] },
      { id: 'agent-opencode', name: 'OpenCode', role: 'opencode', enabled: true, cliCommand: 'old-opencode', cliArgs: ['old'] },
    ],
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function provider(id: string, overrides: Partial<ProviderConfiguration> = {}): ProviderConfiguration {
  return {
    id,
    workspaceId: 'ws-1',
    name: id,
    providerType: id === 'provider-kimi' ? 'kimicode' : id === 'provider-opencode' ? 'opencode' : 'codex',
    adapterId: id,
    runtimeMode: 'cli',
    executable: `${id}.exe`,
    argsTemplate: ['run', '${OPENAI_API_KEY}'],
    model: `${id}-model`,
    environmentProfileId: 'env-profile',
    secretProfileId: 'secret-profile',
    workingDirectoryMode: 'workspace',
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
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function source(id: string, role: AgentSnapshotSourceRecord['role'], providerConfigId: string | null): AgentSnapshotSourceRecord {
  return {
    workspaceId: 'ws-1',
    id,
    name: id,
    role,
    roleTitle: `${role} title`,
    systemPrompt: `${role} system prompt`,
    permissions: ['read', 'write'],
    enabled: true,
    providerConfigId,
    version: 7,
  };
}

function makeDeps(options: {
  workflow?: WorkflowDefinition;
  providers?: Record<string, ProviderConfiguration>;
  sources?: Record<string, AgentSnapshotSourceRecord>;
  now?: () => string;
  onSnapshot?: (payload: unknown) => void;
  onStage?: (key: string) => void;
  findSnapshot?: () => RunSnapshot;
  verifySnapshot?: () => boolean;
  listStages?: () => RunStage[];
} = {}): SnapshotServiceDeps {
  return {
    workflowDefinitionResolver: {
      resolveLegacyPipeline: () => options.workflow ?? legacyWorkflow,
      resolveUnboundTaskRun: () => options.workflow ?? unboundWorkflow,
    } as never,
    runSnapshotRepository: () => ({
      findByRunId: () => options.findSnapshot?.(),
      verifyHash: () => options.verifySnapshot?.() ?? true,
      insert: (input: { payload: unknown; runId: string; workspaceId: string; workflowDefinitionId: string }) => {
        options.onSnapshot?.(input.payload);
        return {
          id: 'snapshot-1', workspaceId: input.workspaceId, runId: input.runId,
          workflowDefinitionId: input.workflowDefinitionId, snapshotSchemaVersion: 2,
          payload: input.payload as never, contentHash: 'b'.repeat(64), redactionApplied: false,
          capturedAt: '2026-01-01T00:00:00.000Z',
        } as RunSnapshot;
      },
    } as never),
    runStageRepository: () => ({
      listByRun: () => options.listStages?.() ?? [],
      insertInitial: (input: { workflowStageKey: string; sequence: number; runId?: string; runSnapshotId?: string; workspaceId?: string }) => {
        options.onStage?.(input.workflowStageKey);
        return {
          id: `stage-${input.sequence}`, workspaceId: input.workspaceId ?? 'ws-1', runId: input.runId ?? 'run-1', runSnapshotId: input.runSnapshotId ?? 'snapshot-1',
          workflowStageKey: input.workflowStageKey, name: input.workflowStageKey, sequence: input.sequence,
          attempt: 1, status: 'pending', createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z', version: 1,
        } as RunStage;
      },
    } as never),
    providerConfigurationRepository: () => ({
      findById: (id: string) => options.providers?.[id],
    } as never),
    findAgentSnapshotSource: (_workspaceId, agentId) => options.sources?.[agentId],
    ...(options.now ? { now: options.now } : {}),
  };
}

function legacySources(): Record<string, AgentSnapshotSourceRecord> {
  return {
    'agent-codex': source('agent-codex', 'codex', 'provider-codex'),
    'agent-kimi': source('agent-kimi', 'kimi', 'provider-kimi'),
    'agent-opencode': source('agent-opencode', 'opencode', 'provider-opencode'),
  };
}

function legacyProviders(): Record<string, ProviderConfiguration> {
  return {
    'provider-codex': provider('provider-codex'),
    'provider-kimi': provider('provider-kimi'),
    'provider-opencode': provider('provider-opencode'),
  };
}

const run: Run = {
  id: 'run-1', workspaceId: 'ws-1', taskId: 'task-1', rootRunId: 'run-1', status: 'queued',
  reason: 'initial', origin: 'legacy_pipeline', nextEventSequence: 1, createdBy: 'test',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1,
};

test('SnapshotService resolves an unbound run without agent/provider bindings', () => {
  const service = new SnapshotService(makeDeps());
  const resolved = service.resolveUnbound('ws-1');
  assert.equal(resolved.workflow.definitionKey, 'unbound-task-run');
  assert.deepEqual(resolved.stages, []);
  assert.equal(resolved.worktreeMode, 'disabled');
  assert.equal(resolved.redactionApplied, false);
});

test('SnapshotService resolves Legacy stages once and projects one runner binding per agent', () => {
  const service = new SnapshotService(makeDeps({ providers: legacyProviders(), sources: legacySources() }));
  const resolved = service.resolveLegacy(workspace());
  assert.deepEqual(resolved.stages.map(stage => stage.workflowStageKey), [
    'codex_manager', 'kimi_worker', 'opencode_reviewer', 'codex_final_review',
  ]);
  assert.equal(resolved.stages.length, 4);
  assert.deepEqual(resolved.stages.map(stage => stage.dependsOn), [
    [], ['codex_manager'], ['kimi_worker'], ['opencode_reviewer'],
  ]);
  assert.equal(resolved.worktreeMode, 'preferred');
  assert.equal(resolved.stages[0]!.agent?.version, 7);
  assert.equal(resolved.stages[0]!.provider?.version, 1);
  assert.equal(resolved.stages[0]!.provider?.secretProfileId, 'secret-profile');
  assert.equal(resolved.stages[0]!.provider?.workspaceRelativeWorkingDirectory, null);
  assert.deepEqual(resolved.stages[0]!.runnerAgent?.cliArgs, resolved.stages[0]!.provider?.argsTemplate);
  assert.equal(resolved.stages[0]!.runnerAgent?.cliCommand, resolved.stages[0]!.provider?.executable);
  assert.equal(resolved.stages[0]!.runnerAgent?.model, resolved.stages[0]!.provider?.model);
  assert.equal(resolved.stages[0]!.runnerAgent?.thinkingEffort, 'high');
  assert.equal(resolved.stages[0]!.agent?.agentId, resolved.stages[3]!.agent?.agentId);
  assert.equal(resolved.stages[0]!.provider?.providerConfigId, resolved.stages[3]!.provider?.providerConfigId);

  const runnerWorkspace = service.buildLegacyRunnerWorkspace(workspace(), resolved);
  assert.deepEqual(runnerWorkspace.agents.map(agent => agent.id), ['agent-codex', 'agent-kimi', 'agent-opencode']);
  assert.notEqual(runnerWorkspace, workspace());
  assert.equal(runnerWorkspace.agents[0]!.cliCommand, resolved.stages[0]!.provider!.executable);
});

test('SnapshotService persists one immutable payload and four initial Legacy stages', () => {
  const captured: unknown[] = [];
  const stageKeys: string[] = [];
  const service = new SnapshotService(makeDeps({
    providers: legacyProviders(), sources: legacySources(), now: () => '2026-01-02T00:00:00.000Z',
    onSnapshot: payload => captured.push(payload), onStage: key => stageKeys.push(key),
  }));
  const resolved = service.resolveLegacy(workspace());
  const persisted = service.persistResolvedRun(run, resolved);
  assert.equal(captured.length, 1);
  assert.equal(persisted.stages.length, 4);
  if (persisted.snapshot.payload.schemaVersion !== 2) throw new Error('expected a V2 Snapshot');
  assert.equal(persisted.snapshot.payload.workflow.worktreeMode, 'preferred');
  assert.deepEqual(stageKeys, ['codex_manager', 'kimi_worker', 'opencode_reviewer', 'codex_final_review']);
  const payload = captured[0] as {
    schemaVersion: number;
    capturedAt: string;
    security: { redactionApplied: boolean };
    workflow: { worktreeMode: string; stages: Array<{ dependsOn: string[] }> };
  };
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.workflow.worktreeMode, 'preferred');
  assert.equal(payload.capturedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(payload.security.redactionApplied, false);
  assert.equal(payload.workflow.stages.length, 4);
  assert.deepEqual(payload.workflow.stages.map(stage => stage.dependsOn), [
    [], ['codex_manager'], ['kimi_worker'], ['opencode_reviewer'],
  ]);
});

test('SnapshotService fails closed for agent/provider availability and secret-like values', () => {
  const missingAgent = new SnapshotService(makeDeps({ providers: legacyProviders(), sources: {} }));
  assert.throws(() => missingAgent.resolveLegacy(workspace()), (error: unknown) => error instanceof AgentNotAvailableError);

  const missingProvider = new SnapshotService(makeDeps({
    providers: legacyProviders(), sources: { ...legacySources(), 'agent-codex': source('agent-codex', 'codex', null) },
  }));
  assert.throws(() => missingProvider.resolveLegacy(workspace()), (error: unknown) => error instanceof ProviderConfigNotAvailableError);

  const unsafe = provider('provider-codex', { argsTemplate: ['--token', 'actual-secret-value'] });
  const service = new SnapshotService(makeDeps({
    providers: { ...legacyProviders(), 'provider-codex': unsafe }, sources: legacySources(),
  }));
  assert.throws(
    () => service.resolveLegacy(workspace()),
    (error: unknown) => error instanceof RunSnapshotFailedError && !(error as Error).message.includes('actual-secret-value'),
  );

  const approved = provider('provider-codex', { argsTemplate: ['--token', '${OPENAI_API_KEY}'] });
  const allowed = new SnapshotService(makeDeps({
    providers: { ...legacyProviders(), 'provider-codex': approved }, sources: legacySources(),
  }));
  assert.doesNotThrow(() => allowed.resolveLegacy(workspace()));
});

test('M2.5 P3 RED: split-equals secret arguments fail closed before Snapshot/Stage insertion', () => {
  for (const flag of ['token', 'api-key', 'password', 'client-secret']) {
    const literal = `split-${flag}-literal`;
    let snapshotInserts = 0;
    let stageInserts = 0;
    const service = new SnapshotService(makeDeps({
      providers: {
        ...legacyProviders(),
        'provider-codex': provider('provider-codex', { argsTemplate: [`--${flag}=`, literal] }),
      },
      sources: legacySources(),
      onSnapshot: () => { snapshotInserts += 1; },
      onStage: () => { stageInserts += 1; },
    }));
    assert.throws(
      () => service.resolveLegacy(workspace()),
      (error: unknown) => error instanceof RunSnapshotFailedError && !(error as Error).message.includes(literal),
    );
    assert.equal(snapshotInserts, 0);
    assert.equal(stageInserts, 0);
  }
});

test('SnapshotService rejects secret-like text and every sensitive flag form while allowing references', () => {
  const rejectedText = [
    ['Authorization: Basic literal', 'authorization-literal'],
    ['Cookie: session=literal', 'cookie-literal'],
    ['-----BEGIN PRIVATE KEY-----', 'private-key-literal'],
    ['Bearer literal', 'bearer-literal'],
    ['api_key=literal', 'api-key-assignment'],
    ['api-key:literal', 'api-key-colon'],
    ['token=literal', 'token-assignment'],
    ['password=literal', 'password-assignment'],
    ['secret=literal', 'secret-assignment'],
    ['client_secret=literal', 'client-secret-assignment'],
  ] as const;
  for (const [value, literal] of rejectedText) {
    let snapshotInserts = 0;
    let stageInserts = 0;
    const service = new SnapshotService(makeDeps({
      sources: { ...legacySources(), 'agent-codex': { ...legacySources()['agent-codex']!, name: value } },
      providers: legacyProviders(),
      onSnapshot: () => { snapshotInserts += 1; },
      onStage: () => { stageInserts += 1; },
    }));
    assert.throws(
      () => service.resolveLegacy(workspace()),
      (error: unknown) => error instanceof RunSnapshotFailedError && !(error as Error).message.includes(literal),
    );
    assert.equal(snapshotInserts, 0);
    assert.equal(stageInserts, 0);
  }

  for (const argsTemplate of [
    ['--api-key', 'literal'], ['--token', 'literal'], ['--access-token', 'literal'],
    ['--password', 'literal'], ['--secret', 'literal'], ['--client-secret', 'literal'],
    ['--api-key=literal'], ['--token=literal'], ['--access-token=literal'],
    ['--password=literal'], ['--secret=literal'], ['--client-secret=literal'],
    ['--api-key=', 'next-array-literal'], ['--token=', 'next-array-literal'],
    ['--access-token=', 'next-array-literal'], ['--password=', 'next-array-literal'],
    ['--secret=', 'next-array-literal'], ['--client-secret=', 'next-array-literal'],
  ]) {
    const service = new SnapshotService(makeDeps({
      providers: { ...legacyProviders(), 'provider-codex': provider('provider-codex', { argsTemplate }) },
      sources: legacySources(),
    }));
    assert.throws(() => service.resolveLegacy(workspace()), (error: unknown) => error instanceof RunSnapshotFailedError);
  }

  for (const argsTemplate of [
    ['--token', '${TOKEN}'], ['--token=${TOKEN}'], ['--token=', '${TOKEN}'],
  ]) {
    const service = new SnapshotService(makeDeps({
      providers: { ...legacyProviders(), 'provider-codex': provider('provider-codex', { argsTemplate }) },
      sources: legacySources(),
    }));
    assert.doesNotThrow(() => service.resolveLegacy(workspace()));
  }
  assert.doesNotThrow(() => new SnapshotService(makeDeps({ providers: legacyProviders(), sources: legacySources() })).resolveLegacy(workspace()));
  assert.doesNotThrow(() => new SnapshotService(makeDeps({
    providers: { ...legacyProviders(), 'provider-kimi': provider('provider-kimi', { argsTemplate: ['-p', 'kimi-profile'] }) },
    sources: legacySources(),
  })).resolveLegacy(workspace()));
});

test('SnapshotService rejects disabled/mismatched Agent sources and disabled/archived/cross-workspace Providers', () => {
  const duplicateAgent = workspace();
  duplicateAgent.agents[1] = { ...duplicateAgent.agents[1]!, id: duplicateAgent.agents[0]!.id };
  assert.throws(
    () => new SnapshotService(makeDeps({ providers: legacyProviders(), sources: legacySources() })).resolveLegacy(duplicateAgent),
    (error: unknown) => error instanceof AgentNotAvailableError,
  );
  const disabledAgent = { ...legacySources(), 'agent-codex': { ...legacySources()['agent-codex']!, enabled: false } };
  assert.throws(
    () => new SnapshotService(makeDeps({ providers: legacyProviders(), sources: disabledAgent })).resolveLegacy(workspace()),
    (error: unknown) => error instanceof AgentNotAvailableError,
  );
  const mismatchedRole = { ...legacySources(), 'agent-codex': source('agent-codex', 'kimi', 'provider-codex') };
  assert.throws(
    () => new SnapshotService(makeDeps({ providers: legacyProviders(), sources: mismatchedRole })).resolveLegacy(workspace()),
    (error: unknown) => error instanceof AgentNotAvailableError,
  );
  const oldAgent = { ...legacySources(), 'agent-codex': { ...legacySources()['agent-codex']!, version: 0 } };
  assert.throws(
    () => new SnapshotService(makeDeps({ providers: legacyProviders(), sources: oldAgent })).resolveLegacy(workspace()),
    (error: unknown) => error instanceof AgentNotAvailableError,
  );

  for (const invalidProvider of [
    { enabled: false },
    { archivedAt: '2026-01-02T00:00:00.000Z' },
    { workspaceId: 'other-workspace' },
  ] satisfies Array<Partial<ProviderConfiguration>>) {
    const providers = { ...legacyProviders(), 'provider-codex': provider('provider-codex', invalidProvider) };
    assert.throws(
      () => new SnapshotService(makeDeps({ providers, sources: legacySources() })).resolveLegacy(workspace()),
      (error: unknown) => error instanceof ProviderConfigNotAvailableError,
    );
  }
});

test('SnapshotService projects only workspace-contained custom directories', () => {
  const workspaceRoot = resolve('snapshot-workspace-root');
  const inside = new SnapshotService(makeDeps({
    providers: {
      ...legacyProviders(),
      'provider-codex': provider('provider-codex', { workingDirectoryMode: 'custom', customWorkingDirectory: join(workspaceRoot, 'nested') }),
    },
    sources: legacySources(),
  }));
  assert.equal(inside.resolveLegacy(workspace()).stages[0]!.provider?.workspaceRelativeWorkingDirectory, 'nested');

  const outside = new SnapshotService(makeDeps({
    providers: {
      ...legacyProviders(),
      'provider-codex': provider('provider-codex', { workingDirectoryMode: 'custom', customWorkingDirectory: resolve(workspaceRoot, '..', 'outside') }),
    },
    sources: legacySources(),
  }));
  assert.throws(() => outside.resolveLegacy(workspace()), (error: unknown) => error instanceof RunSnapshotFailedError);
});

test('SnapshotService exposes the two-phase persisted Retry clone seams', () => {
  const service = new SnapshotService(makeDeps());
  assert.equal(typeof service.prepareRetryClone, 'function');
  assert.equal(typeof service.persistRetryClone, 'function');
});

test('SnapshotService clones persisted V2 Snapshot and Stage Graph without current resolution', () => {
  const parent: Run = {
    ...run,
    id: 'parent-1',
    reason: 'initial',
    origin: 'v2_api',
  };
  const sourcePayload: RunSnapshotPayloadV2 = {
    schemaVersion: 2,
    capturedAt: '2026-01-02T00:00:00.000Z',
    run: {
      workspaceId: parent.workspaceId,
      taskId: parent.taskId,
      origin: parent.origin,
      reason: parent.reason,
      parentRunId: null,
      rootRunId: parent.rootRunId,
    },
    workflow: {
      definitionId: legacyWorkflow.id,
      definitionKey: legacyWorkflow.definitionKey,
      definitionVersion: legacyWorkflow.version,
      name: legacyWorkflow.name,
      definitionHash: legacyWorkflow.definitionHash,
      worktreeMode: 'preferred',
      stages: [
        {
          workflowStageKey: 'first', name: 'first', sequence: 1, dependsOn: [],
          agent: { ...legacySources()['agent-codex']!, providerConfigId: 'provider-codex' } as never,
          provider: null,
        },
        {
          workflowStageKey: 'second', name: 'second', sequence: 2, dependsOn: ['first'],
          agent: null,
          provider: null,
        },
      ],
    },
    security: { redactionApplied: true },
  };
  const sourceSnapshot: RunSnapshot<RunSnapshotPayloadV2> = {
    id: 'parent-snapshot',
    workspaceId: parent.workspaceId,
    runId: parent.id,
    workflowDefinitionId: legacyWorkflow.id,
    snapshotSchemaVersion: 2,
    payload: sourcePayload,
    contentHash: 'a'.repeat(64),
    redactionApplied: true,
    capturedAt: sourcePayload.capturedAt,
  };
  const sourceStages: RunStage[] = [
    {
      id: 'parent-stage-1', workspaceId: parent.workspaceId, runId: parent.id,
      runSnapshotId: sourceSnapshot.id, workflowStageKey: 'first', name: 'first', sequence: 1,
      attempt: 2, status: 'completed', createdAt: sourcePayload.capturedAt,
      updatedAt: sourcePayload.capturedAt, version: 4,
    },
    {
      id: 'parent-stage-2', workspaceId: parent.workspaceId, runId: parent.id,
      runSnapshotId: sourceSnapshot.id, workflowStageKey: 'second', name: 'second', sequence: 2,
      attempt: 3, status: 'failed', createdAt: sourcePayload.capturedAt,
      updatedAt: sourcePayload.capturedAt, version: 5,
    },
  ];
  const captured: unknown[] = [];
  const service = new SnapshotService(makeDeps({
    now: () => '2026-01-03T00:00:00.000Z',
    findSnapshot: () => sourceSnapshot,
    listStages: () => sourceStages,
    onSnapshot: payload => captured.push(payload),
  }));
  const plan = service.prepareRetryClone(parent);
  const child: Run = {
    ...parent,
    id: 'child-1',
    parentRunId: parent.id,
    reason: 'retry',
    nextEventSequence: 1,
    status: 'queued',
    version: 1,
  };
  const persisted = service.persistRetryClone(child, plan);
  assert.equal(persisted.snapshot.payload.schemaVersion, 2);
  assert.equal(persisted.snapshot.payload.capturedAt, '2026-01-03T00:00:00.000Z');
  assert.equal(persisted.snapshot.payload.run.workspaceId, child.workspaceId);
  assert.equal(persisted.snapshot.payload.run.parentRunId, parent.id);
  assert.equal(persisted.snapshot.payload.workflow.worktreeMode, 'preferred');
  assert.deepEqual(persisted.snapshot.payload.workflow.stages.map(stage => stage.dependsOn), [[], ['first']]);
  assert.equal(persisted.stages[0]!.attempt, 1);
  assert.equal(persisted.stages[0]!.status, 'pending');
  assert.equal(persisted.stages[0]!.version, 1);
  assert.equal(persisted.stages[0]!.runId, child.id);
  assert.notEqual(persisted.snapshot.id, sourceSnapshot.id);
  assert.notEqual(persisted.stages[0]!.id, sourceStages[0]!.id);
  assert.notEqual(persisted.snapshot.payload.workflow.stages[0]!.agent, sourcePayload.workflow.stages[0]!.agent);
  assert.equal(captured.length, 1);
});

function retryCloneFixture(): {
  parent: Run;
  snapshot: RunSnapshot<RunSnapshotPayloadV2>;
  stages: RunStage[];
} {
  const parent: Run = {
    ...run,
    id: 'retry-parent',
    origin: 'v2_api',
    reason: 'initial',
  };
  const payload: RunSnapshotPayloadV2 = {
    schemaVersion: 2,
    capturedAt: '2026-01-02T00:00:00.000Z',
    run: {
      workspaceId: parent.workspaceId,
      taskId: parent.taskId,
      origin: parent.origin,
      reason: parent.reason,
      parentRunId: null,
      rootRunId: parent.rootRunId,
    },
    workflow: {
      definitionId: legacyWorkflow.id,
      definitionKey: legacyWorkflow.definitionKey,
      definitionVersion: legacyWorkflow.version,
      name: legacyWorkflow.name,
      definitionHash: legacyWorkflow.definitionHash,
      worktreeMode: 'preferred',
      stages: [
        { workflowStageKey: 'first', name: 'first', sequence: 1, dependsOn: [], agent: null, provider: null },
        { workflowStageKey: 'second', name: 'second', sequence: 2, dependsOn: ['first'], agent: null, provider: null },
      ],
    },
    security: { redactionApplied: false },
  };
  const snapshot: RunSnapshot<RunSnapshotPayloadV2> = {
    id: 'retry-parent-snapshot',
    workspaceId: parent.workspaceId,
    runId: parent.id,
    workflowDefinitionId: legacyWorkflow.id,
    snapshotSchemaVersion: 2,
    payload,
    contentHash: 'a'.repeat(64),
    redactionApplied: false,
    capturedAt: payload.capturedAt,
  };
  const stages: RunStage[] = payload.workflow.stages.map((stage, index) => ({
    id: `retry-parent-stage-${index + 1}`,
    workspaceId: parent.workspaceId,
    runId: parent.id,
    runSnapshotId: snapshot.id,
    workflowStageKey: stage.workflowStageKey,
    name: stage.name,
    sequence: stage.sequence,
    attempt: index + 2,
    status: index === 0 ? 'completed' : 'failed',
    createdAt: payload.capturedAt,
    updatedAt: payload.capturedAt,
    version: index + 3,
  }));
  return { parent, snapshot, stages };
}

test('SnapshotService Retry prepare rejects missing, V1, hash-invalid, and graph-invalid persisted state', () => {
  const missing = retryCloneFixture();
  assert.throws(
    () => new SnapshotService(makeDeps()).prepareRetryClone(missing.parent),
    (error: unknown) => error instanceof RunSnapshotFailedError,
  );

  const source = retryCloneFixture();
  const v1 = structuredClone(source.snapshot) as RunSnapshot;
  v1.snapshotSchemaVersion = 1;
  v1.payload = { ...source.snapshot.payload, schemaVersion: 1 } as never;
  assert.throws(
    () => new SnapshotService(makeDeps({ findSnapshot: () => v1 })).prepareRetryClone(source.parent),
    (error: unknown) => error instanceof RunSnapshotFailedError,
  );

  assert.throws(
    () => new SnapshotService(makeDeps({ findSnapshot: () => source.snapshot, verifySnapshot: () => false, listStages: () => source.stages })).prepareRetryClone(source.parent),
    (error: unknown) => error instanceof RunSnapshotFailedError,
  );

  const graphCases: Array<{ label: string; snapshot: RunSnapshot<RunSnapshotPayloadV2>; stages: RunStage[] }> = [
    { label: 'missing stage', snapshot: source.snapshot, stages: [source.stages[0]!] },
    { label: 'extra stage', snapshot: source.snapshot, stages: [...source.stages, { ...source.stages[1]!, id: 'extra-stage', workflowStageKey: 'extra', name: 'extra', sequence: 3 }] },
    {
      label: 'duplicate key',
      snapshot: { ...source.snapshot, payload: { ...source.snapshot.payload, workflow: { ...source.snapshot.payload.workflow, stages: [{ ...source.snapshot.payload.workflow.stages[0]! }, { ...source.snapshot.payload.workflow.stages[1]!, workflowStageKey: 'first', name: 'first' }] } } },
      stages: source.stages,
    },
    {
      label: 'duplicate sequence',
      snapshot: { ...source.snapshot, payload: { ...source.snapshot.payload, workflow: { ...source.snapshot.payload.workflow, stages: [{ ...source.snapshot.payload.workflow.stages[0]! }, { ...source.snapshot.payload.workflow.stages[1]!, sequence: 1 }] } } },
      stages: source.stages,
    },
    {
      label: 'forward dependency',
      snapshot: { ...source.snapshot, payload: { ...source.snapshot.payload, workflow: { ...source.snapshot.payload.workflow, stages: [{ ...source.snapshot.payload.workflow.stages[0]!, dependsOn: ['second'] }, { ...source.snapshot.payload.workflow.stages[1]! }] } } },
      stages: source.stages,
    },
    {
      label: 'duplicate dependency',
      snapshot: { ...source.snapshot, payload: { ...source.snapshot.payload, workflow: { ...source.snapshot.payload.workflow, stages: [{ ...source.snapshot.payload.workflow.stages[0]! }, { ...source.snapshot.payload.workflow.stages[1]!, dependsOn: ['first', 'first'] }] } } },
      stages: source.stages,
    },
  ];
  for (const item of graphCases) {
    assert.throws(
      () => new SnapshotService(makeDeps({ findSnapshot: () => item.snapshot, listStages: () => item.stages })).prepareRetryClone(source.parent),
      (error: unknown) => error instanceof RunSnapshotFailedError,
      item.label,
    );
  }
});

test('SnapshotService Retry prepare never resolves current Workflow, Agent, or Provider configuration', () => {
  const source = retryCloneFixture();
  let resolverCalls = 0;
  const service = new SnapshotService({
    ...makeDeps({ findSnapshot: () => source.snapshot, listStages: () => source.stages }),
    workflowDefinitionResolver: {
      resolveLegacyPipeline: () => { resolverCalls += 1; throw new Error('current workflow read'); },
      resolveUnboundTaskRun: () => { resolverCalls += 1; throw new Error('current workflow read'); },
    } as never,
  });
  const plan = service.prepareRetryClone(source.parent);
  assert.equal(plan.payload.workflow.definitionId, legacyWorkflow.id);
  assert.equal(resolverCalls, 0);
});
