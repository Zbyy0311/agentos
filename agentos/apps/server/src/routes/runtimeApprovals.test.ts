import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSnapshotV1, ProviderConfigurationSnapshotV1, RunSnapshotPayloadV2 } from '@agentos/shared';
import type { ProviderLaunchPlan } from '@agentos/agent-core/providers';

import {
  M3_013_LEGACY_DEFINITION_HASH,
  M3_013_LEGACY_WORKFLOW_KEY,
  M3_013_LEGACY_WORKFLOW_NAME,
  M3_013_LEGACY_WORKFLOW_V2_ID,
} from '../migrations/migrations/013-workflow-creation-metadata-v2.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { RuntimeApprovalGate } from '../services/RuntimeApprovalGate.js';
import type { StageExecutionInput } from '../services/run-engine/StageExecutionCoordinator.js';
import { createEntityId } from '../store/Identity.js';
import { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { createRuntimeApprovalRoutes } from './runtimeApprovals.js';

const NOW = '2026-09-12T10:30:00.000Z';
const EXPIRED = '2026-09-12T10:31:00.000Z';
const TASK_ID = createEntityId('task');
const RUN_ID = createEntityId('run');
const STAGE_ID = createEntityId('stage');
const OPERATION_ID = createEntityId('operation');

interface RouteFixture {
  readonly root: string;
  readonly store: SqliteStore;
  readonly workspaceManager: WorkspaceManager;
  readonly gate: RuntimeApprovalGate;
  readonly server: ReturnType<express.Express['listen']>;
  readonly workspaceId: string;
  readonly otherWorkspaceId: string;
  readonly workspaceRoot: string;
  now: string;
  setNow(now: string): void;
  baseUrl(workspaceId?: string): string;
}

interface JsonResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function withServer(run: (fixture: RouteFixture) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-runtime-approval-route-'));
  const store = new SqliteStore(root);
  const workspaceManager = new WorkspaceManager(store);
  const workspace = workspaceManager.create('Runtime Approval Workspace', join(root, 'workspace-a'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const otherWorkspace = workspaceManager.create('Other Workspace', join(root, 'workspace-b'), {
    git: false, memory: false, readme: false, docs: false,
  });
  seedRun(store, workspace.id);

  const clock = { value: NOW };
  const gate = new RuntimeApprovalGate(store, {
    now: () => clock.value,
    ttlMs: 30_000,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId', createRuntimeApprovalRoutes(store, workspaceManager, gate));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  if (!address || typeof address.port !== 'number' || address.port <= 0) throw new Error('test server did not acquire a port');
  const fixture: RouteFixture = {
    root,
    store,
    workspaceManager,
    gate,
    server,
    workspaceId: workspace.id,
    otherWorkspaceId: otherWorkspace.id,
    workspaceRoot: workspace.rootPath,
    now: NOW,
    setNow(now: string): void {
      clock.value = now;
      this.now = now;
    },
    baseUrl(workspaceId = workspace.id): string {
      return `http://127.0.0.1:${address.port}/api/workspaces/${workspaceId}`;
    },
  };

  try {
    await run(fixture);
  } finally {
    await new Promise<void>(resolve => fixture.server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function seedRun(store: SqliteStore, workspaceId: string): void {
  const db = store.getDatabase();
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, 'runtime approval', 'open', 'normal', 'test', ?, ?)
  `).run(TASK_ID, workspaceId, NOW, NOW);
  db.prepare(`
    INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'running', 'initial', 'v2_api', 'test', ?, ?)
  `).run(RUN_ID, workspaceId, TASK_ID, RUN_ID, NOW, NOW);
  const snapshot = new RunSnapshotRepository(db).insert({
    workspaceId,
    runId: RUN_ID,
    workflowDefinitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
    payload: snapshotPayload(workspaceId),
  });
  db.prepare(`
    INSERT INTO run_stages (
      id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
      sequence, attempt, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'codex_manager', 'codex_manager', 1, 1, 'running', ?, ?)
  `).run(STAGE_ID, workspaceId, RUN_ID, snapshot.id, NOW, NOW);
  db.prepare(`
    INSERT INTO operations (
      id, type, status, workspace_id, aggregate_type, aggregate_id, run_id,
      correlation_id, started_at, completed_at, created_at, updated_at
    ) VALUES (?, 'run.start', 'completed', ?, 'run', ?, ?, ?, ?, ?, ?, ?)
  `).run(OPERATION_ID, workspaceId, RUN_ID, RUN_ID, OPERATION_ID, NOW, NOW, NOW, NOW);
}

function agentSnapshot(): AgentSnapshotV1 {
  return {
    agentId: 'runtime-approval-agent',
    name: 'Runtime Approval Agent',
    role: 'codex',
    roleTitle: 'Executor',
    systemPrompt: 'Execute the task.',
    permissions: ['read', 'write'],
    providerConfigId: 'runtime-approval-provider',
    enabled: true,
    version: 1,
  };
}

function snapshotPayload(workspaceId: string): RunSnapshotPayloadV2 {
  const stages = [
    { workflowStageKey: 'codex_manager', name: 'codex_manager', sequence: 1, dependsOn: [] },
    { workflowStageKey: 'kimi_worker', name: 'kimi_worker', sequence: 2, dependsOn: ['codex_manager'] },
    { workflowStageKey: 'opencode_reviewer', name: 'opencode_reviewer', sequence: 3, dependsOn: ['kimi_worker'] },
    { workflowStageKey: 'codex_final_review', name: 'codex_final_review', sequence: 4, dependsOn: ['opencode_reviewer'] },
  ].map(stage => ({ ...stage, agent: agentSnapshot(), provider: providerSnapshot() }));
  return {
    schemaVersion: 2,
    capturedAt: NOW,
    run: {
      workspaceId,
      taskId: TASK_ID,
      origin: 'v2_api',
      reason: 'initial',
      parentRunId: null,
      rootRunId: RUN_ID,
    },
    workflow: {
      definitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
      definitionKey: M3_013_LEGACY_WORKFLOW_KEY,
      definitionVersion: 2,
      name: M3_013_LEGACY_WORKFLOW_NAME,
      definitionHash: M3_013_LEGACY_DEFINITION_HASH,
      worktreeMode: 'preferred',
      stages,
    },
    security: { redactionApplied: false },
  };
}

function providerSnapshot(): ProviderConfigurationSnapshotV1 {
  return {
    providerConfigId: 'runtime-approval-provider',
    name: 'Runtime Approval Provider',
    providerType: 'custom-cli',
    adapterId: 'builtin.custom-cli',
    runtimeMode: 'cli',
    executable: 'provider',
    argsTemplate: [],
    model: null,
    environmentProfileId: null,
    secretProfileId: null,
    workingDirectoryMode: 'workspace',
    workspaceRelativeWorkingDirectory: null,
    capabilities: {
      sessionResume: false,
      structuredEvents: true,
      nativeApprovals: false,
      subagents: false,
      toolEvents: true,
      fileEvents: false,
      usageEvents: true,
      reasoningStream: false,
      interactiveInput: false,
      pause: false,
      cancellation: true,
      modelSelection: true,
      workspaceAwareness: true,
      nativeSandbox: false,
      outputContracts: false,
    },
    timeoutPolicy: {
      discoveryTimeoutMs: 10_000,
      validationTimeoutMs: 30_000,
      startupTimeoutMs: 60_000,
      idleTimeoutMs: null,
      totalTimeoutMs: null,
      cancelGracePeriodMs: 5_000,
      approvalTimeoutMs: null,
    },
    approvalMode: 'agentos',
    outputMode: 'structured',
    enabled: true,
    version: 1,
  };
}

function launchPlan(workspaceRoot: string): ProviderLaunchPlan {
  return {
    runtimeMode: 'cli',
    executable: 'provider',
    args: ['--safe'],
    cwd: workspaceRoot,
    environment: {},
    redactedEnvironmentKeys: [],
    secretRefs: [],
    stdinMode: 'none',
    promptDelivery: 'argument',
    structuredOutput: 'text',
    cleanupFiles: [],
    shell: false,
    metadata: {},
  };
}

function stageInput(fixture: RouteFixture): StageExecutionInput {
  return {
    workspaceId: fixture.workspaceId,
    taskId: TASK_ID,
    runId: RUN_ID,
    stageId: STAGE_ID,
    stageAttempt: 1,
    workflowStageKey: 'codex_manager',
    agentSnapshot: agentSnapshot(),
    providerSnapshot: providerSnapshot(),
    workspaceRoot: fixture.workspaceRoot,
    prompt: 'perform the approved operation',
    operationId: OPERATION_ID,
  };
}

function createPending(fixture: RouteFixture) {
  const result = fixture.gate.beforeLaunch(stageInput(fixture), launchPlan(fixture.workspaceRoot));
  assert.equal(result.kind, 'wait');
  if (result.kind !== 'wait') throw new Error('test fixture did not create a pending request');
  const request = fixture.gate.list(fixture.workspaceId).find(item => item.id === result.requestId);
  if (!request) throw new Error('test fixture request was not persisted');
  return request;
}

async function getJson(url: string): Promise<JsonResponse> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function resolveJson(url: string, body: unknown): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function rowCount(fixture: RouteFixture, table: string, workspaceId = fixture.workspaceId): number {
  const row = fixture.store.getDatabase()
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`).get(workspaceId) as { count: number | bigint };
  return Number(row.count);
}

test('LITE-08-005/006: lists a request, reads it by id, and isolates it across workspaces', async () => {
  await withServer(async fixture => {
    const request = createPending(fixture);

    const list = await getJson(`${fixture.baseUrl()}/runtime-approvals`);
    assert.equal(list.status, 200);
    const requests = list.body.requests as Array<{ id: string; status: string; version: number }>;
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.id, request.id);
    assert.equal(requests[0]?.status, 'pending');
    assert.equal(requests[0]?.version, request.version);

    const detail = await getJson(`${fixture.baseUrl()}/runtime-approvals/${request.id}`);
    assert.equal(detail.status, 200);
    assert.equal((detail.body.request as { id: string }).id, request.id);
    assert.equal((detail.body.request as { workspaceId: string }).workspaceId, fixture.workspaceId);

    const crossWorkspace = await getJson(`${fixture.baseUrl(fixture.otherWorkspaceId)}/runtime-approvals/${request.id}`);
    assert.equal(crossWorkspace.status, 404);
    assert.equal(crossWorkspace.body.error, 'RUNTIME_APPROVAL_NOT_FOUND');
  });
});

test('LITE-08-006: missing expectedVersion or decision returns 400 without resolving the request', async () => {
  await withServer(async fixture => {
    const request = createPending(fixture);

    const missingVersion = await resolveJson(`${fixture.baseUrl()}/runtime-approvals/${request.id}/resolve`, {
      decision: 'approve_once', decidedBy: 'test-user',
    });
    assert.equal(missingVersion.status, 400);
    assert.equal(missingVersion.body.error, 'RUNTIME_APPROVAL_INPUT_INVALID');

    const missingDecision = await resolveJson(`${fixture.baseUrl()}/runtime-approvals/${request.id}/resolve`, {
      expectedVersion: request.version, decidedBy: 'test-user',
    });
    assert.equal(missingDecision.status, 400);
    assert.equal(missingDecision.body.error, 'RUNTIME_APPROVAL_INPUT_INVALID');
    assert.equal(rowCount(fixture, 'approval_decisions'), 0);
    assert.equal(fixture.gate.list(fixture.workspaceId)[0]?.status, 'pending');
  });
});

test('LITE-08-006: approve succeeds and the same request/version retries as replayed without new decision or Candidate', async () => {
  await withServer(async fixture => {
    const request = createPending(fixture);
    const resolveUrl = `${fixture.baseUrl()}/runtime-approvals/${request.id}/resolve`;
    const body = { expectedVersion: request.version, decision: 'approve_once', decidedBy: 'test-user' };

    const first = await resolveJson(resolveUrl, body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const firstBody = first.body as {
      replayed: boolean;
      request: { id: string; status: string; resolution: string; candidateId: string | null };
      candidateId: string | null;
    };
    assert.equal(firstBody.replayed, false);
    assert.equal(firstBody.request.status, 'approved');
    assert.equal(firstBody.request.resolution, 'approve_once');
    assert.notEqual(firstBody.candidateId, null);
    assert.equal(firstBody.request.candidateId, firstBody.candidateId);
    assert.equal(rowCount(fixture, 'approval_decisions'), 1);
    assert.equal(rowCount(fixture, 'memory_candidate_entries'), 1);

    const replay = await resolveJson(resolveUrl, body);
    assert.equal(replay.status, 200);
    const replayBody = replay.body as {
      replayed: boolean;
      request: { id: string; status: string; candidateId: string | null };
      candidateId: string | null;
    };
    assert.equal(replayBody.replayed, true);
    assert.equal(replayBody.request.id, firstBody.request.id);
    assert.equal(replayBody.request.status, 'approved');
    assert.equal(replayBody.candidateId, firstBody.candidateId);
    assert.equal(rowCount(fixture, 'approval_decisions'), 1);
    assert.equal(rowCount(fixture, 'memory_candidate_entries'), 1);
  });
});

test('LITE-08-006: reject succeeds and does not create an accepted-decision Candidate', async () => {
  await withServer(async fixture => {
    const request = createPending(fixture);
    const response = await resolveJson(`${fixture.baseUrl()}/runtime-approvals/${request.id}/resolve`, {
      expectedVersion: request.version, decision: 'reject', decidedBy: 'test-user',
    });

    assert.equal(response.status, 201, JSON.stringify(response.body));
    const body = response.body as {
      replayed: boolean;
      request: { status: string; resolution: string };
      candidateId: string | null;
    };
    assert.equal(body.replayed, false);
    assert.equal(body.request.status, 'rejected');
    assert.equal(body.request.resolution, 'reject');
    assert.equal(body.candidateId, null);
    assert.equal(rowCount(fixture, 'approval_decisions'), 1);
    assert.equal(rowCount(fixture, 'memory_candidate_entries'), 0);
  });
});

test('LITE-08-006: a stale request version returns 409 and leaves the request pending', async () => {
  await withServer(async fixture => {
    const request = createPending(fixture);
    const response = await resolveJson(`${fixture.baseUrl()}/runtime-approvals/${request.id}/resolve`, {
      expectedVersion: request.version - 1, decision: 'approve_once', decidedBy: 'test-user',
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error, 'RUNTIME_APPROVAL_CONFLICT');
    assert.equal(rowCount(fixture, 'approval_decisions'), 0);
    const current = fixture.gate.list(fixture.workspaceId)[0];
    assert.equal(current?.status, 'pending');
    assert.equal(current?.version, request.version);
  });
});

test('LITE-08-007: an expired pending request returns 410 without writing a decision', async () => {
  await withServer(async fixture => {
    const request = createPending(fixture);
    fixture.setNow(EXPIRED);

    const response = await resolveJson(`${fixture.baseUrl()}/runtime-approvals/${request.id}/resolve`, {
      expectedVersion: request.version, decision: 'approve_once', decidedBy: 'test-user',
    });

    assert.equal(response.status, 410);
    assert.equal(response.body.error, 'RUNTIME_APPROVAL_EXPIRED');
    assert.equal(rowCount(fixture, 'approval_decisions'), 0);
    const expired = fixture.gate.list(fixture.workspaceId)[0];
    assert.equal(expired?.status, 'expired');
    assert.equal(expired?.version, request.version + 1);
  });
});
