import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMaintenanceRoutes, createMaintenanceWriteBarrier } from './maintenance.js';
import { MaintenanceBarrier } from '../services/MaintenanceBarrier.js';

test('maintenance rejects new API writes while allowing its bounded control endpoint', async () => {
  const app = express();
  const barrier = new MaintenanceBarrier();
  let writes = 0;
  let backupControls = 0;
  let unknownMaintenanceWrites = 0;
  app.use(createMaintenanceWriteBarrier(barrier));
  app.post('/api/write', (_req, res) => { writes += 1; res.status(204).end(); });
  app.post('/api/maintenance/backup', (_req, res) => { backupControls += 1; res.status(200).json({ ok: true }); });
  app.post('/api/maintenance/future-write', (_req, res) => { unknownMaintenanceWrites += 1; res.status(204).end(); });
  const server = await new Promise<ReturnType<typeof app.listen>>(resolvePromise => {
    const listening = app.listen(0, '127.0.0.1', () => resolvePromise(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  barrier.begin();
  try {
    const rejected = await fetch(`http://127.0.0.1:${address.port}/api/write`, { method: 'POST' });
    assert.equal(rejected.status, 503);
    assert.equal(writes, 0);
    const control = await fetch(`http://127.0.0.1:${address.port}/api/maintenance/backup`, { method: 'POST' });
    assert.equal(control.status, 200);
    assert.equal(backupControls, 1);
    const unknownMaintenance = await fetch(`http://127.0.0.1:${address.port}/api/maintenance/future-write`, { method: 'POST' });
    assert.equal(unknownMaintenance.status, 503, 'only explicit maintenance controls bypass the mutation fence');
    assert.equal(unknownMaintenanceWrites, 0);
  } finally {
    barrier.end();
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
  }
});

test('cleanup apply route runs the hash-preview payload inside maintenance coordination', async () => {
  const app = express();
  app.use(express.json());
  const request = { previewVersion: 'a'.repeat(64), generatedAt: '2026-10-02T00:00:00.000Z', candidates: [] };
  let operationKind = '';
  let applied = false;
  const coordinator = {
    async run<T>(kind: string, operation: (context: { signal: AbortSignal }) => Promise<T>) {
      operationKind = kind;
      return { result: await operation({ signal: new AbortController().signal }), operationId: 'cleanup-test', drain: {} };
    },
    status: { active: false, quiescing: false, recoveredAfterRestart: false },
    async releaseExpiredLease() { return false; },
  };
  app.use('/api/maintenance', createMaintenanceRoutes({
    coordinator: coordinator as any,
    diagnostics: { async readiness() { return { ok: true }; } } as any,
    service: {
      async applyCleanup(received: unknown, instanceId: string, signal: AbortSignal) {
        assert.deepEqual(received, request);
        assert.equal(instanceId, 'test-instance');
        assert.equal(signal.aborted, false);
        applied = true;
        return { previewVersion: request.previewVersion, deletedCount: 0, deletedBytes: 0, deleted: [] };
      },
      async previewCleanup() { return { previewVersion: request.previewVersion, generatedAt: request.generatedAt, candidates: [] }; },
      async inspectStorage() { return {}; },
    } as any,
    instanceId: 'test-instance',
  }));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolvePromise => {
    const listening = app.listen(0, '127.0.0.1', () => resolvePromise(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/maintenance/cleanup/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    assert.equal(response.status, 200);
    assert.equal(operationKind, 'cleanup');
    assert.equal(applied, true);
  } finally {
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
  }
});
