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
import { migration044 } from '../migrations/migrations/044-preference-confirmations.js';

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
  migration044.apply({ db: store.getDatabase() });
  const projection: PreferenceProjection = {
    id: 'projection-a', profileId: 'default', scope: 'workspace', workspaceId: 'workspace-a', dimension: 'response_detail',
    contextKind: 'coding', preferredValue: 'detailed', confidence: 80, score: 10, evidenceCount: 3, independentRunCount: 3,
    status: 'stable', lastSupportedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
  };
  store.upsertPreferenceProjection(projection);
  const preferenceService = new PreferenceService(store);
  preferenceService.confirmations.synchronizeProjection(projection);
  const app = express(); app.use(express.json()); const routes = createPreferenceRoutes(store, new WorkspaceManager(store), preferenceService); app.use('/api/workspaces/:workspaceId', routes); app.use('/api', routes);
  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('bind failed');
    const base = `http://127.0.0.1:${address.port}/api/workspaces`;
    const globalBase = `http://127.0.0.1:${address.port}/api`;
    const listed = await fetch(`${base}/workspace-a/preferences?context=coding`).then(response => response.json()) as { profile: { learningEnabled: boolean }; projections: PreferenceProjection[] };
    assert.equal(listed.profile.learningEnabled, true);
    assert.deepEqual(listed.projections.map(item => item.id), ['projection-a']);
    const alias = await fetch(`${globalBase}/preferences?workspaceId=workspace-a`).then(response => response.json()) as { projections: PreferenceProjection[] };
    assert.deepEqual(alias.projections.map(item => item.id), ['projection-a']);
    const suggestions = await fetch(`${globalBase}/preferences/suggestions?workspaceId=workspace-a`).then(response => response.json()) as {
      suggestions: Array<{ id: string; projectionId: string; workspaceId: string; status: string; version: number; entryId: string | null; preferredValue: string; dimension: string; contextKind: string; scope: string; confidence: number; evidenceCount: number }>;
    };
    assert.deepEqual(Object.keys(suggestions.suggestions[0] ?? {}).sort(), [
      'confidence', 'contextKind', 'dimension', 'entryId', 'evidenceCount', 'id', 'preferredValue',
      'projectionId', 'scope', 'status', 'version', 'workspaceId',
    ]);
    assert.deepEqual(suggestions.suggestions.map(item => ({ projectionId: item.projectionId, status: item.status, version: item.version })), [
      { projectionId: 'projection-a', status: 'pending', version: 1 },
    ]);
    assert.equal(suggestions.suggestions[0]?.workspaceId, 'workspace-a');
    assert.equal(suggestions.suggestions[0]?.entryId, null);
    assert.equal(suggestions.suggestions[0]?.preferredValue, 'detailed');
    assert.equal(suggestions.suggestions[0]?.dimension, 'response_detail');
    assert.equal(suggestions.suggestions[0]?.contextKind, 'coding');
    assert.equal(suggestions.suggestions[0]?.scope, 'workspace');
    assert.equal(suggestions.suggestions[0]?.confidence, 80);
    assert.equal(suggestions.suggestions[0]?.evidenceCount, 3);
    const foreignConfirm = await fetch(`${base}/workspace-b/preferences/projection-a/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'workspace-b', expectedVersion: 1 }),
    });
    assert.equal(foreignConfirm.status, 404);
    const confirmed = await fetch(`${globalBase}/preferences/projection-a/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'workspace-a', expectedVersion: 1 }),
    }).then(response => response.json()) as { suggestion: { status: string; version: number; entryId: string }; entry: { id: string; scope: string; authority: string; category: string } };
    assert.deepEqual(confirmed.suggestion, { ...suggestions.suggestions[0], status: 'confirmed', version: 2, entryId: confirmed.entry.id });
    assert.equal(confirmed.entry.scope, 'workspace');
    assert.equal(confirmed.entry.authority, 'user-explicit');
    assert.equal(confirmed.entry.category, 'preference');
    const revoked = await fetch(`${globalBase}/preferences/projection-a/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'workspace-a', expectedVersion: 2 }),
    }).then(response => response.json()) as { suggestion: { status: string; version: number }; entry: { id: string; status: string } };
    assert.deepEqual(revoked.suggestion, { ...confirmed.suggestion, status: 'revoked', version: 3 });
    assert.equal(revoked.entry.id, confirmed.entry.id);
    assert.equal(revoked.entry.status, 'archived');

    const rejectedProjection = { ...projection, id: 'projection-reject', dimension: 'execution_style' as const,
      preferredValue: 'direct_execution' as const, updatedAt: '2026-07-12T00:01:00.000Z' };
    store.upsertPreferenceProjection(rejectedProjection);
    preferenceService.confirmations.synchronizeProjection(rejectedProjection);
    const rejected = await fetch(`${globalBase}/preferences/projection-reject/reject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'workspace-a', expectedVersion: 1 }),
    }).then(response => response.json()) as { suggestion: { status: string; version: number; projectionId: string; preferredValue: string; dimension: string }; entry?: unknown };
    assert.equal(rejected.suggestion.projectionId, 'projection-reject');
    assert.equal(rejected.suggestion.preferredValue, 'direct_execution');
    assert.equal(rejected.suggestion.dimension, 'execution_style');
    assert.equal(rejected.suggestion.status, 'rejected');
    assert.equal(rejected.suggestion.version, 2);
    assert.equal(rejected.entry, undefined);
    assert.deepEqual((await fetch(`${base}/workspace-b/preferences`).then(response => response.json()) as { projections: PreferenceProjection[] }).projections, []);
    assert.equal((await fetch(`${base}/workspace-a/preferences/projection-a/sleep`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/workspace-a/preferences?status=dormant`).then(response => response.json()) as { projections: PreferenceProjection[] }).projections[0]?.status, 'dormant');
    const paused = await fetch(`${base}/workspace-a/preferences/learning`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }).then(response => response.json()) as { profile: { learningEnabled: boolean } };
    assert.equal(paused.profile.learningEnabled, false);
    const pausedAlias = await fetch(`${globalBase}/preferences/pause?workspaceId=workspace-a`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    assert.equal(pausedAlias.status, 200);
    assert.equal((await fetch(`${base}/workspace-a/preferences/clear`, { method: 'POST' })).status, 200);
    assert.deepEqual((await fetch(`${base}/workspace-a/preferences`).then(response => response.json()) as { projections: PreferenceProjection[] }).projections, []);
  } finally { server.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
