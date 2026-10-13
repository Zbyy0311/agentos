import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import test from 'node:test';

import type {
  AgentSnapshotV1,
  ProviderConfigurationSnapshotV1,
  RunSnapshotPayloadV2,
} from '@agentos/shared';
import type {
  ProviderStartInput,
  ProviderValidationInput,
  ProviderValidationResult,
  RuntimeProviderAdapter,
} from '@agentos/agent-core/providers';
import { WorkspaceManager } from '../../managers/WorkspaceManager.js';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../../migrations/migrations/013-workflow-creation-metadata-v2.js';
import { createEntityId } from '../../store/Identity.js';
import { RunSnapshotRepository } from '../../store/RunSnapshotRepository.js';
import { SqliteStore } from '../../store/SqliteStore.js';
import { WorkspaceAdmissionRepository } from '../../store/WorkspaceAdmissionRepository.js';
import { createProviderExecutionChain, type ProviderExecutionChain } from './providerExecutionChain.js';
import type { StageExecutionInput } from './StageExecutionCoordinator.js';
import { createCanonicalRunEventRoutes } from '../../routes/canonicalRunEvents.js';

const SECRET = 'CedarDelta92_OrchidQ7-419';
const NOW = '2026-10-13T00:00:00.000Z';
const STAGE_KEYS = ['codex_manager', 'kimi_worker', 'opencode_reviewer', 'codex_final_review'] as const;
const STAGE_KEY = STAGE_KEYS[3];
const ADAPTER_ID = 'builtin.custom-cli';
const ADAPTER_VERSION = '1.0.0';

interface SeededRun {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly operationId: string;
  readonly agentSnapshot: AgentSnapshotV1;
  readonly providerSnapshot: ProviderConfigurationSnapshotV1;
}

interface Fixture {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly store: SqliteStore;
  readonly manager: WorkspaceManager;
  readonly workspaceId: string;
  readonly chain: ProviderExecutionChain;
  readonly close: () => Promise<void>;
}

function safeTestEnvironment(secret = SECRET): Readonly<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    AGENTOS_TEST_TOKEN: secret,
    NODE_ENV: 'test',
  };
  return result;
}

async function createFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-environment-secret-registration-'));
  const workspaceRoot = join(root, 'workspace-a');
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(root, 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  const store = new SqliteStore(root);
  try {
    const manager = new WorkspaceManager(store);
    const workspace = await manager.create('Environment secret registration test', workspaceRoot, {
      git: false,
      memory: false,
      readme: false,
      docs: false,
    });
    const chain = createProviderExecutionChain({
      store,
      artifactRoot: join(root, 'artifacts'),
      workspaceRootFor: workspaceId => store.workspaceRepo.findById(workspaceId)?.rootPath ?? workspaceRoot,
      environment: safeTestEnvironment(),
    });
    return {
      root,
      workspaceRoot,
      store,
      manager,
      workspaceId: workspace.id,
      chain,
      close: async () => {
        try { store.close(); } catch { /* preserve the assertion result */ }
        try { rmSync(root, { recursive: true, force: true }); } catch { /* SQLite may release files asynchronously on Windows */ }
      },
    };
  } catch (error) {
    try { store.close(); } catch { /* preserve the original error */ }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* SQLite may release files asynchronously on Windows */ }
    throw error;
  }
}

function seedRunningRun(fx: Fixture, suffix: string, workspaceId = fx.workspaceId): SeededRun {
  const db = fx.store.getDatabase();
  const workspaceRoot = fx.store.workspaceRepo.findById(workspaceId)?.rootPath;
  if (!workspaceRoot) throw new Error(`test workspace ${workspaceId} is missing its root`);
  const taskId = createEntityId('task');
  const runId = createEntityId('run');
  const stageId = createEntityId('stage');
  const operationId = createEntityId('operation');
  const providerConfigId = createEntityId('provider');
  const agentId = createEntityId('agent');
  const agentSnapshot: AgentSnapshotV1 = {
    agentId,
    name: `Synthetic CLI ${suffix}`,
    role: 'opencode',
    roleTitle: 'Synthetic CLI worker',
    systemPrompt: 'Run the local synthetic CLI fixture.',
    permissions: ['read'],
    providerConfigId,
    enabled: true,
    version: 1,
  };
  const providerSnapshot: ProviderConfigurationSnapshotV1 = {
    providerConfigId,
    name: `Synthetic CLI ${suffix}`,
    providerType: 'custom-cli',
    adapterId: ADAPTER_ID,
    runtimeMode: 'cli',
    executable: process.execPath,
    argsTemplate: ['-e', `process.stdout.write(${JSON.stringify(SECRET)});`],
    model: null,
    environmentProfileId: null,
    secretProfileId: null,
    workingDirectoryMode: 'workspace',
    workspaceRelativeWorkingDirectory: null,
    capabilities: fx.chain.providerRegistry.get(ADAPTER_ID, ADAPTER_VERSION).getDefaultCapabilities({}),
    timeoutPolicy: {
      discoveryTimeoutMs: 5_000,
      validationTimeoutMs: 10_000,
      startupTimeoutMs: 10_000,
      idleTimeoutMs: null,
      totalTimeoutMs: 30_000,
      cancelGracePeriodMs: 2_000,
      approvalTimeoutMs: null,
    },
    approvalMode: 'disabled',
    outputMode: 'parsed-text',
    enabled: true,
    version: 1,
  };
  const payload: RunSnapshotPayloadV2 = {
    schemaVersion: 2,
    capturedAt: NOW,
    run: {
      workspaceId,
      taskId,
      origin: 'v2_api',
      reason: 'initial',
      parentRunId: null,
      rootRunId: runId,
    },
    workflow: {
      definitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
      definitionKey: 'legacy-pipeline',
      definitionVersion: 2,
      name: 'legacy-pipeline-v2',
      definitionHash: '9ea35ef455c5fefa45d0b28d1433933b2cc6b3fb9e412b4d4452afb7862a6b6d',
      worktreeMode: 'preferred',
      stages: STAGE_KEYS.map((key, index) => ({
        workflowStageKey: key,
        name: key,
        sequence: index + 1,
        agent: agentSnapshot,
        provider: providerSnapshot,
        dependsOn: index === 0 ? [] : [STAGE_KEYS[index - 1]!],
      })),
    },
    security: { redactionApplied: false },
  };

  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version)
    VALUES (?, ?, ?, 'open', 'environment-secret-test', ?, ?, 1)
  `).run(taskId, workspaceId, `Synthetic CLI ${suffix}`, NOW, NOW);
  db.prepare(`
    INSERT INTO provider_configurations (
      id, workspace_id, name, provider_type, adapter_id, runtime_mode,
      executable, args_template_json, capabilities_json, timeout_policy_json,
      approval_mode, output_mode, enabled, version, created_at, updated_at
    ) VALUES (?, ?, ?, 'custom-cli', ?, 'cli', ?, ?, ?, ?, 'disabled', 'parsed-text', 1, 1, ?, ?)
  `).run(
    providerConfigId,
    workspaceId,
    `Synthetic CLI ${suffix}`,
    ADAPTER_ID,
    process.execPath,
    JSON.stringify(providerSnapshot.argsTemplate),
    JSON.stringify(providerSnapshot.capabilities),
    JSON.stringify(providerSnapshot.timeoutPolicy),
    NOW,
    NOW,
  );
  db.prepare(`
    INSERT INTO agent_profiles (
      id, workspace_id, name, agent_role, role_title, system_prompt,
      permissions_json, enabled, cli_command, cli_args_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'opencode', 'Synthetic CLI worker', ?, ?, 1, ?, ?, ?, ?)
  `).run(
    agentId,
    workspaceId,
    `Synthetic CLI ${suffix}`,
    agentSnapshot.systemPrompt,
    JSON.stringify(agentSnapshot.permissions),
    process.execPath,
    JSON.stringify(providerSnapshot.argsTemplate),
    NOW,
    NOW,
  );
  db.prepare(`
    INSERT INTO runs (
      id, workspace_id, task_id, root_run_id, status, reason, origin,
      next_event_sequence, created_by, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, 'running', 'initial', 'v2_api', 1, 'environment-secret-test', ?, ?, 1)
  `).run(runId, workspaceId, taskId, runId, NOW, NOW);
  db.prepare(`
    INSERT INTO operations (
      id, type, status, workspace_id, aggregate_type, aggregate_id, run_id,
      correlation_id, created_at, started_at, completed_at, updated_at, version
    ) VALUES (?, 'run.start', 'completed', ?, 'run', ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(operationId, workspaceId, runId, runId, operationId, NOW, NOW, NOW, NOW);
  const snapshot = new RunSnapshotRepository(db).insert({
    workspaceId,
    runId,
    workflowDefinitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
    payload,
  });
  STAGE_KEYS.forEach((key, index) => {
    const active = index === STAGE_KEYS.length - 1;
    db.prepare(`
      INSERT INTO run_stages (
        id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
        sequence, attempt, status, started_at, completed_at, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 1)
    `).run(
      index === STAGE_KEYS.length - 1 ? stageId : createEntityId('stage'),
      workspaceId,
      runId,
      snapshot.id,
      key,
      key,
      index + 1,
      active ? 'running' : 'completed',
      NOW,
      active ? null : NOW,
      NOW,
      NOW,
    );
  });
  new WorkspaceAdmissionRepository(db).insertAdmission({
    id: `admission_${runId}`,
    workspaceId,
    subjectKind: 'CANONICAL_RUN',
    canonicalRunId: runId,
    legacyRunId: null,
    requestedMutationClass: 'MODIFYING',
    effectiveMutationClass: 'MODIFYING',
    enforcementEvidenceJson: null,
    requestOrder: 1,
    state: 'GRANTED',
    queueReason: null,
    releaseReason: null,
    requestedAt: NOW,
    grantedAt: NOW,
    releasedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  });
  return { workspaceId, workspaceRoot, taskId, runId, stageId, operationId, agentSnapshot, providerSnapshot };
}

function stageInput(fx: Fixture, run: SeededRun): StageExecutionInput {
  return {
    workspaceId: run.workspaceId,
    taskId: run.taskId,
    runId: run.runId,
    stageId: run.stageId,
    stageAttempt: 1,
    workflowStageKey: STAGE_KEY,
    agentSnapshot: run.agentSnapshot,
    providerSnapshot: run.providerSnapshot,
    workspaceRoot: run.workspaceRoot,
    prompt: 'Run the local synthetic CLI fixture.',
    operationId: run.operationId,
  };
}

async function listenForRoutes(store: SqliteStore): Promise<{ server: Server; baseApi: string }> {
  const app = express();
  app.use('/api', createCanonicalRunEventRoutes(store));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  if (address === null || typeof address === 'string') throw new Error('test route server did not bind');
  return { server, baseApi: `http://127.0.0.1:${address.port}/api` };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function serializedRuntimeEvents(fx: Fixture, workspaceId: string, runId: string): string {
  const rows = fx.store.getDatabase().prepare(`
    SELECT payload_json, metadata_json FROM runtime_events
    WHERE workspace_id = ? AND run_id = ? ORDER BY sequence
  `).all(workspaceId, runId) as Array<{ payload_json: string; metadata_json: string | null }>;
  return JSON.stringify(rows);
}

async function readSseFrames(response: Response, expectedDataFrames: number): Promise<string> {
  assert.ok(response.body, 'SSE endpoint returns a readable response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: string[] = [];
  const deadline = Date.now() + 10_000;
  try {
    while (frames.filter(frame => frame.includes('\ndata:')).length < expectedDataFrames) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${expectedDataFrames} SSE event frames`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timed out reading canonical Run SSE')), remaining);
        }),
      ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        frames.push(buffer.slice(0, boundary + 2));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames.join('');
}

function assertNoRawSecret(serialized: string): void {
  assert.equal(serialized.includes(SECRET), false, 'the synthetic secret must not appear in persisted or streamed event data');
}

test('F1 real provider chain registers the captured environment before validation and redacts secret-bearing failure events through SQLite, query, and HTTP SSE', { timeout: 90_000 }, async () => {
  const fx = await createFixture();
  let server: Server | undefined;
  try {
    const validationEnvironments: Array<Readonly<Record<string, string | undefined>> | undefined> = [];
    const launchEnvironments: Array<Readonly<Record<string, string | undefined>> | undefined> = [];
    const launchPlans: Array<Awaited<ReturnType<RuntimeProviderAdapter['buildLaunchPlan']>>> = [];
    const parsedCliOutputs: string[] = [];
    let failNextValidation = false;
    const adapter = fx.chain.providerRegistry.get(ADAPTER_ID, ADAPTER_VERSION);
    const originalValidate = adapter.validate.bind(adapter);
    const originalBuildLaunchPlan = adapter.buildLaunchPlan.bind(adapter);
    const originalFinalize = adapter.finalize.bind(adapter);
    adapter.validate = async (input: ProviderValidationInput): Promise<ProviderValidationResult> => {
      validationEnvironments.push(input.environment);
      const result = await originalValidate(input);
      if (!failNextValidation) return result;
      failNextValidation = false;
      return {
        ...result,
        valid: false,
        errors: [{
          code: 'PROVIDER_CONFIG_INVALID',
          phase: 'validation',
          message: `Synthetic CLI validation output included ${SECRET}`,
          retryable: false,
        }],
      };
    };
    adapter.buildLaunchPlan = async (input: ProviderStartInput) => {
      launchEnvironments.push(input.environment);
      const plan = await originalBuildLaunchPlan(input);
      launchPlans.push(plan);
      return plan;
    };
    adapter.finalize = async input => {
      parsedCliOutputs.push(input.parsedEvents
        .filter((event): event is Extract<typeof event, { type: 'assistant.message' }> => event.type === 'assistant.message')
        .map(event => event.text)
        .join('\n'));
      return originalFinalize(input);
    };

    const outputRun = seedRunningRun(fx, 'output');
    const outputDrive = await fx.chain.dispatcher.drive(outputRun.workspaceId, outputRun.runId);
    assert.equal(outputDrive.outcome, 'claimed-and-progressed');
    assert.equal(fx.store.runRepository().findById(outputRun.workspaceId, outputRun.runId)?.status, 'completed');
    assert.equal(fx.store.runStageRepository().listByRun(outputRun.workspaceId, outputRun.runId)[0]?.status, 'completed');
    assert.deepEqual(parsedCliOutputs, [SECRET], 'the local Node CLI actually emitted the non-generic sentinel on stdout');
    const outputProcessCount = fx.store.getDatabase()
      .prepare('SELECT COUNT(*) AS count FROM runtime_processes WHERE run_id = ?')
      .get(outputRun.runId) as { count: number };
    assert.equal(outputProcessCount.count, 1, 'the production chain launched only the local synthetic Node CLI');
    assert.equal(validationEnvironments.length, 1);
    assert.equal(launchEnvironments.length, 1);
    assert.strictEqual(launchEnvironments[0], validationEnvironments[0], 'validation and launch share the same captured environment object');
    assert.ok(validationEnvironments[0] && Object.isFrozen(validationEnvironments[0]));
    assert.equal(validationEnvironments[0]?.AGENTOS_TEST_TOKEN, SECRET);
    assert.equal(validationEnvironments[0]?.NODE_ENV, 'test');
    assert.equal(launchPlans[0]?.environment.AGENTOS_TEST_TOKEN, undefined, 'the launch plan retains Custom CLI secret filtering');
    assert.equal(launchPlans[0]?.environment.NODE_ENV, 'test');
    assertNoRawSecret(serializedRuntimeEvents(fx, outputRun.workspaceId, outputRun.runId));

    const redactor = fx.store.eventRedactionService();
    assert.equal(redactor.detectSecretInText(fx.workspaceId, `output ${SECRET}`), 'known-value');
    const secondWorkspace = await fx.manager.create('Isolated environment secret workspace', join(fx.root, 'workspace-b'), {
      git: false,
      memory: false,
      readme: false,
      docs: false,
    });
    assert.equal(redactor.detectSecretInText(secondWorkspace.id, `output ${SECRET}`), undefined,
      'an environment secret registered for one workspace is not registered in another');

    const diagnosticRun = seedRunningRun(fx, 'validation-diagnostic', secondWorkspace.id);
    failNextValidation = true;
    const failedDrive = await fx.chain.dispatcher.drive(diagnosticRun.workspaceId, diagnosticRun.runId);
    assert.equal(failedDrive.outcome, 'claimed-and-progressed');
    assert.equal(fx.store.runRepository().findById(diagnosticRun.workspaceId, diagnosticRun.runId)?.status, 'failed');
    assert.equal(fx.store.runStageRepository().listByRun(diagnosticRun.workspaceId, diagnosticRun.runId)[0]?.failureMessage,
      undefined, 'failure detail is recorded in canonical events rather than copied onto the Stage row');
    const databaseJson = serializedRuntimeEvents(fx, diagnosticRun.workspaceId, diagnosticRun.runId);
    assertNoRawSecret(databaseJson);
    assert.ok(databaseJson.includes('Synthetic CLI validation output included [REDACTED]'),
      'stage failure event stores a redacted version of the secret-bearing validation message');
    const queried = fx.store.runtimeEventRepository().queryByRun({
      workspaceId: diagnosticRun.workspaceId,
      runId: diagnosticRun.runId,
      afterSequence: 0,
      limit: 200,
    });
    const queriedJson = JSON.stringify(queried);
    assertNoRawSecret(queriedJson);
    assert.ok(queriedJson.includes('[REDACTED]'));

    const routes = await listenForRoutes(fx.store);
    server = routes.server;
    const eventResponse = await fetch(`${routes.baseApi}/runs/${diagnosticRun.runId}/events?limit=200`);
    assert.equal(eventResponse.status, 200);
    const eventPage = await eventResponse.json() as { events: unknown[] };
    assert.ok(eventPage.events.length > 0);
    const eventPageJson = JSON.stringify(eventPage);
    assertNoRawSecret(eventPageJson);
    assert.ok(eventPageJson.includes('[REDACTED]'));

    const sseResponse = await fetch(`${routes.baseApi}/runs/${diagnosticRun.runId}/stream`);
    assert.equal(sseResponse.status, 200);
    assert.match(sseResponse.headers.get('content-type') ?? '', /^text\/event-stream/i);
    const sse = await readSseFrames(sseResponse, eventPage.events.length);
    assertNoRawSecret(sse);
    assert.ok(sse.includes('[REDACTED]'), 'actual HTTP SSE replay carries only the redacted validation detail');
    assert.ok(sse.includes('stage.failed'));
  } finally {
    if (server) await closeServer(server);
    await fx.close();
  }
});

test('F1 registration callback failure is data-free and reserves no startup state; retry succeeds and registers secrets only in its workspace', { timeout: 90_000 }, async () => {
  const fx = await createFixture();
  try {
    const run = seedRunningRun(fx, 'registration-retry');
    const input = stageInput(fx, run);
    const redactor = fx.store.eventRedactionService();
    const originalRegister = redactor.registerEnvironmentSecrets.bind(redactor);
    let callbackAttempts = 0;
    redactor.registerEnvironmentSecrets = (workspaceId, environment) => {
      callbackAttempts += 1;
      if (callbackAttempts === 1) throw new Error(`private callback failure ${SECRET}`);
      originalRegister(workspaceId, environment);
    };

    try {
      const blocked = await fx.chain.coordinator.execute(input);
      assert.equal(blocked.kind, 'failed');
      if (blocked.kind !== 'failed') throw new Error('expected callback failure');
      assert.equal(blocked.problem.code, 'ENVIRONMENT_SECRET_REGISTRATION_FAILED');
      assert.equal(blocked.problem.detail, 'Environment secret registration failed');
      assertNoRawSecret(JSON.stringify(blocked));
      const db = fx.store.getDatabase();
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM provider_sessions WHERE run_id = ?').get(run.runId) as { count: number }).count, 0);
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM runtime_processes WHERE run_id = ?').get(run.runId) as { count: number }).count, 0);
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM process_output_references WHERE run_id = ?').get(run.runId) as { count: number }).count, 0);
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?').get(run.runId) as { count: number }).count, 0);

      const retried = await fx.chain.coordinator.execute(input);
      assert.equal(retried.kind, 'completed');
      assert.equal(callbackAttempts, 2, 'retry re-enters the environment registration callback');
      assert.equal(redactor.detectSecretInText(fx.workspaceId, `synthetic output ${SECRET}`), 'known-value');
      assertNoRawSecret(serializedRuntimeEvents(fx, run.workspaceId, run.runId));
      const isolatedWorkspace = await fx.manager.create('Retry isolation workspace', join(fx.root, 'workspace-c'), {
        git: false,
        memory: false,
        readme: false,
        docs: false,
      });
      assert.equal(redactor.detectSecretInText(isolatedWorkspace.id, `synthetic output ${SECRET}`), undefined);
    } finally {
      redactor.registerEnvironmentSecrets = originalRegister;
    }
  } finally {
    await fx.close();
  }
});
