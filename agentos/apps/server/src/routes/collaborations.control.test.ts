import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listenFetchSafe } from '../test-support/listenFetchSafe.js';
import express from 'express';
import test from 'node:test';
import type { CollaborationTask } from '@agentos/shared';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { CollaborationRepositoryError } from '../store/CollaborationRepository.js';
import type { CollaborationWorkflowService } from '../services/CollaborationWorkflowService.js';
import { createCollaborationRoutes } from './collaborations.js';
import { WorktreeError } from '../services/WorktreeManager.js';

const WORKSPACE_ID = 'workspace-http-fixture';
const COLLABORATION_ID = 'collaboration-http-fixture';

type RouteService = Partial<Pick<CollaborationWorkflowService, 'createPlan' | 'confirm' | 'cancel' | 'apply'>>;

async function withServer<T>(service: RouteService, action: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  const workspaces = {
    get: (id: string) => id === WORKSPACE_ID ? ({ id, name: 'HTTP fixture' }) : undefined,
  } as unknown as WorkspaceManager;
  app.use('/workspaces/:workspaceId', createCollaborationRoutes(service as CollaborationWorkflowService, workspaces));

  const server = createServer(app);
  const address = await listenFetchSafe(server);
  try {
    return await action(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as Record<string, unknown>;
  return { response, payload };
}

const mutationPath = `/workspaces/${WORKSPACE_ID}/collaboration/tasks/${COLLABORATION_ID}/apply`;

for (const code of ['COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED', 'COLLABORATION_SNAPSHOT_SOURCE_CHANGED', 'COLLABORATION_GIT_CLEAN_MISMATCH']) {
  test(`F18 controlled Git refusal ${code} stays actionable without a 500`, async () => {
    await withServer({ apply: async () => { throw new Error(`${code}: controlled fixture refusal`); } }, async baseUrl => {
      const { response, payload } = await post(baseUrl, mutationPath, { expectedVersion: 4 }, { 'Idempotency-Key': 'controlled-git-' + code });
      assert.equal(response.status, 409); assert.equal(payload.code, code);
      assert.match(String(payload.detail), /controlled fixture refusal/);
    });
  });
}

for (let repetition = 1; repetition <= 3; repetition++) {
  for (const [code, status] of [['workspace_dirty', 409], ['not_git', 409], ['root_not_absolute', 400]] as const) {
    test(`F18 actual WorktreeError(${code}) exposes an actionable HTTP ${status} (${repetition}/3)`, async () => {
      await withServer({ createPlan: async () => { throw new WorktreeError(code, `${code}: fixture precondition failed`); } }, async baseUrl => {
        const { response, payload } = await post(baseUrl, `/workspaces/${WORKSPACE_ID}/collaboration/tasks`, {
          title: 'Valid fixture', objective: 'Exercise precondition response', scope: ['src/'], acceptanceCommands: ['node --test'],
          plannerAgentId: 'planner', implementerAgentId: 'implementer', reviewerAgentId: 'reviewer',
        });
        assert.equal(response.status, status); assert.equal(payload.code, code);
        assert.match(String(payload.detail), /fixture precondition failed/);
        assert.notEqual(response.status, 500);
      });
    });
  }
}

test('missing Idempotency-Key returns a stable 400 problem and never calls the service', async () => {
  let serviceCalls = 0;
  const service: RouteService = { apply: async () => { serviceCalls += 1; throw new Error('must not run'); } };
  await withServer(service, async baseUrl => {
    const { response, payload } = await post(baseUrl, mutationPath, { expectedVersion: 4 });
    assert.equal(response.status, 400);
    assert.equal(payload.status, 400);
    assert.equal(payload.code, 'COLLABORATION_IDEMPOTENCY_REQUIRED');
    assert.equal(payload.type, 'urn:agentos:error:collaboration-idempotency-required');
    assert.equal(serviceCalls, 0);
  });
});

for (const [repositoryCode, expectedStatus] of [
  ['CONFLICT', 409],
  ['STATE', 409],
  ['INVALID', 400],
] as const) {
  test(`actual CollaborationRepositoryError(${repositoryCode}) maps to HTTP ${expectedStatus}, not 500`, async () => {
    const service: RouteService = {
      apply: async () => { throw new CollaborationRepositoryError(repositoryCode); },
    };
    await withServer(service, async baseUrl => {
      const { response, payload } = await post(baseUrl, mutationPath, { expectedVersion: 4 }, { 'Idempotency-Key': `repo-${repositoryCode.toLowerCase()}` });
      assert.equal(response.status, expectedStatus);
      assert.equal(payload.status, expectedStatus);
      assert.equal(payload.code, `COLLABORATION_${repositoryCode}`);
      assert.notEqual(response.status, 500);
    });
  });
}

test('a pending cancel control returns 202 with the task version ETag and pending-control body', async () => {
  const pendingTask = {
    id: COLLABORATION_ID,
    workspaceId: WORKSPACE_ID,
    title: 'Pending control fixture',
    objective: 'Exercise the HTTP response contract',
    scope: ['./'],
    acceptanceCommands: [],
    plannerAgentId: 'planner',
    implementerAgentId: 'implementer',
    reviewerAgentId: 'reviewer',
    status: 'running',
    version: 8,
    controlEpoch: 3,
    pendingControl: { id: 'operation-http-fixture', action: 'cancel', state: 'running', epoch: 3 },
    planHash: 'fixture-plan',
    baseCommit: 'fixture-base',
    maxReworkRounds: 2,
    reworkRound: 0,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  } satisfies CollaborationTask;
  let receivedVersion: number | undefined;
  const service: RouteService = {
    cancel: async input => {
      receivedVersion = input.expectedVersion;
      return pendingTask;
    },
  };

  await withServer(service, async baseUrl => {
    const { response, payload } = await post(
      baseUrl,
      `/workspaces/${WORKSPACE_ID}/collaboration/tasks/${COLLABORATION_ID}/cancel`,
      { expectedVersion: 8 },
      { 'Idempotency-Key': 'pending-cancel-http-fixture' },
    );
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('etag'), '"v8"');
    assert.equal(receivedVersion, 8);
    assert.deepEqual((payload.task as CollaborationTask).pendingControl, pendingTask.pendingControl);
    assert.equal((payload.task as CollaborationTask).status, 'running');
  });
});
