import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunLifecycleRoutes } from './runLifecycle.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { TaskRunService } from '../services/TaskRunService.js';

interface Fx {
  root: string;
  store: SqliteStore;
  server: ReturnType<express.Express['listen']>;
  baseApi: string;
  runId: string;
  drives: string[];
}

async function makeFx(dispatchEnabled: boolean): Promise<Fx> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p6l1a-route-'));
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('L1A Workspace', join(root, 'workspace'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const service = new TaskRunService(store);
  const task = service.createTask(workspace.id, { title: 't', createdBy: 'test' });
  const run = service.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
  const drives: string[] = [];
  const app = express();
  app.use('/api', createRunLifecycleRoutes(store, {
    runtimeDispatch: {
      enabled: dispatchEnabled,
      drive: async (_workspaceId: string, runId: string) => {
        drives.push(runId);
      },
    },
  }));
  app.use(express.json());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  return { root, store, server, baseApi: `http://127.0.0.1:${port}/api`, runId: run.id, drives };
}

async function closeFx(fx: Fx): Promise<void> {
  await new Promise<void>(resolve => fx.server.close(() => resolve()));
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

async function postStart(
  fx: Fx,
  body: unknown,
  key?: string,
): Promise<{ status: number; json: Record<string, unknown> | null; replayed: string | null }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(`${fx.baseApi}/runs/${fx.runId}/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json, replayed: res.headers.get('idempotency-replayed') };
}

// L1A-24 — run.start V1 response shape is unchanged when requestedMutationClass
// is supplied: the body still carries exactly { operation } with no admission
// or mutation-class fields added.
test('L1A-24 run.start V1 response shape unchanged with requestedMutationClass', async () => {
  const fx = await makeFx(false);
  try {
    const res = await postStart(fx, { requestedMutationClass: 'MODIFYING' });
    assert.equal(res.status, 202);
    assert.ok(res.json);
    assert.deepEqual(Object.keys(res.json), ['operation']);
    const operation = res.json.operation as Record<string, unknown>;
    assert.equal(operation.type, 'run.start');
    assert.equal('admissionId' in res.json, false);
    assert.equal('admissionState' in res.json, false);
    assert.equal('effectiveMutationClass' in res.json, false);
  } finally {
    await closeFx(fx);
  }
});

// Omitted and explicit MODIFYING are the same request identity: the second
// call with the same key replays rather than conflicting.
test('L1A omitted vs explicit MODIFYING replay identically under one key', async () => {
  const fx = await makeFx(false);
  try {
    const key = 'l1a-start-key-0001';
    const live = await postStart(fx, {}, key);
    assert.equal(live.status, 202);
    assert.equal(live.replayed, null);
    const replay = await postStart(fx, { requestedMutationClass: 'MODIFYING' }, key);
    assert.equal(replay.status, 202);
    assert.equal(replay.replayed, 'true');
    assert.deepEqual(replay.json, live.json);
  } finally {
    await closeFx(fx);
  }
});

// Same key READ_ONLY vs MODIFYING -> conflict.
test('L1A same-key READ_ONLY vs MODIFYING -> IDEMPOTENCY_KEY_REUSED', async () => {
  const fx = await makeFx(false);
  try {
    const key = 'l1a-start-key-0002';
    const live = await postStart(fx, { requestedMutationClass: 'READ_ONLY' }, key);
    assert.equal(live.status, 202);
    const conflict = await postStart(fx, { requestedMutationClass: 'MODIFYING' }, key);
    assert.equal(conflict.status, 409);
    assert.equal((conflict.json as { code?: string } | null)?.code, 'IDEMPOTENCY_KEY_REUSED');
  } finally {
    await closeFx(fx);
  }
});

// L1A-25 — replayed V1 response shape is unchanged (byte-identical body).
test('L1A-25 replayed V1 response shape unchanged', async () => {
  const fx = await makeFx(false);
  try {
    const key = 'l1a-start-key-0003';
    const live = await postStart(fx, { requestedMutationClass: 'READ_ONLY' }, key);
    const replay = await postStart(fx, { requestedMutationClass: 'READ_ONLY' }, key);
    assert.equal(replay.replayed, 'true');
    assert.deepEqual(replay.json, live.json);
    assert.deepEqual(Object.keys(replay.json ?? {}), ['operation']);
  } finally {
    await closeFx(fx);
  }
});

// L1A-26 — runtime dispatch behavior unchanged: gate OFF never drives even
// when a requestedMutationClass is present; gate ON drives only a fresh accept.
test('L1A-26 runtime dispatch behavior unchanged', async () => {
  const off = await makeFx(false);
  try {
    await postStart(off, { requestedMutationClass: 'MODIFYING' });
    assert.deepEqual(off.drives, []);
  } finally {
    await closeFx(off);
  }
  const on = await makeFx(true);
  try {
    const key = 'l1a-start-key-0004';
    await postStart(on, {}, key);
    await postStart(on, {}, key); // replay must not re-dispatch
    assert.deepEqual(on.drives, [on.runId]);
  } finally {
    await closeFx(on);
  }
});

// Invalid requestedMutationClass is rejected with 400 VALIDATION_FAILED.
test('L1A invalid requestedMutationClass -> 400 VALIDATION_FAILED', async () => {
  const fx = await makeFx(false);
  try {
    const res = await postStart(fx, { requestedMutationClass: 'SIDEWAYS' });
    assert.equal(res.status, 400);
    assert.equal((res.json as { code?: string } | null)?.code, 'VALIDATION_FAILED');
  } finally {
    await closeFx(fx);
  }
});
