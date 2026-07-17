import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreferenceProjection } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { PreferenceService } from '../services/PreferenceService.js';
import { createPreferenceRoutes } from './preferences.js';

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-preference-routes-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [
    { id: 'workspace-a', name: 'A', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' },
    { id: 'workspace-b', name: 'B', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' },
  ] }), 'utf8');
  return root;
}

test('lists and controls scoped preference projections without exposing another workspace', async () => {
  const root = createRoot();
  const store = new SqliteStore(root);
  const projection: PreferenceProjection = {
    id: 'projection-a', profileId: 'default', scope: 'workspace', workspaceId: 'workspace-a', dimension: 'response_detail',
    contextKind: 'coding', preferredValue: 'detailed', confidence: 80, score: 10, evidenceCount: 3, independentRunCount: 3,
    status: 'stable', lastSupportedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
  };
  store.upsertPreferenceProjection(projection);
  const app = express(); app.use(express.json()); app.use('/api/workspaces/:workspaceId', createPreferenceRoutes(store, new WorkspaceManager(store), new PreferenceService(store)));
  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('bind failed');
    const base = `http://127.0.0.1:${address.port}/api/workspaces`;
    const listed = await fetch(`${base}/workspace-a/preferences?context=coding`).then(response => response.json()) as { profile: { learningEnabled: boolean }; projections: PreferenceProjection[] };
    assert.equal(listed.profile.learningEnabled, true);
    assert.deepEqual(listed.projections.map(item => item.id), ['projection-a']);
    assert.deepEqual((await fetch(`${base}/workspace-b/preferences`).then(response => response.json()) as { projections: PreferenceProjection[] }).projections, []);
    assert.equal((await fetch(`${base}/workspace-a/preferences/projection-a/sleep`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/workspace-a/preferences?status=dormant`).then(response => response.json()) as { projections: PreferenceProjection[] }).projections[0]?.status, 'dormant');
    const paused = await fetch(`${base}/workspace-a/preferences/learning`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }).then(response => response.json()) as { profile: { learningEnabled: boolean } };
    assert.equal(paused.profile.learningEnabled, false);
    assert.equal((await fetch(`${base}/workspace-a/preferences/clear`, { method: 'POST' })).status, 200);
    assert.deepEqual((await fetch(`${base}/workspace-a/preferences`).then(response => response.json()) as { projections: PreferenceProjection[] }).projections, []);
  } finally { server.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
