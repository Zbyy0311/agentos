import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createArtifactCompletionRoutes } from './artifactCompletions.js';

const WS = 'workspace-a';
const NOW = '2026-09-11T00:00:00.000Z';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-arcomp-route-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: WS, name: 'Workspace A', rootPath: join(root, 'ws-a'), gitEnabled: true, memoryEnabled: true,
      agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
      lastOpenedAt: NOW, createdAt: NOW, updatedAt: NOW,
    }],
  }), 'utf8');
  return root;
}

// A review Artifact needs a canonical Run chain (task -> run -> artifact).
function seedArtifact(store: SqliteStore, artifactId: string, type: 'review' | 'test'): void {
  const db = store.getDatabase();
  db.prepare("INSERT INTO tasks (id, workspace_id, title, created_by, created_at, updated_at) VALUES ('task_1', ?, 'T', 'codex', ?, ?)")
    .run(WS, NOW, NOW);
  db.prepare("INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at) VALUES ('run_1', ?, 'task_1', 'run_1', 'completed', 'initial', 'v2_api', 'codex', ?, ?)")
    .run(WS, NOW, NOW);
  db.prepare("INSERT INTO runtime_artifacts (id, workspace_id, provenance_kind, canonical_run_id, agent_id, artifact_type, title, summary, size_bytes, content_available, created_at) VALUES (?, ?, 'CANONICAL', 'run_1', 'codex', ?, 'A', 's', 12, 0, ?)")
    .run(artifactId, WS, type, NOW);
}

async function withServer(run: (baseUrl: string, store: SqliteStore) => Promise<void>): Promise<void> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  try {
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId', createArtifactCompletionRoutes(store, new WorkspaceManager(store)));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/api/workspaces/${WS}`, store);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close?.();
    rmSync(root, { recursive: true, force: true });
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test('AR-03: a completed review Artifact writes the completion record and one review-required Candidate', async () => {
  await withServer(async (baseUrl, store) => {
    seedArtifact(store, 'art_review_1', 'review');
    const res = await postJson(`${baseUrl}/artifact-completions`, {
      artifactId: 'art_review_1', artifactType: 'review', conclusion: 'approved',
    });
    assert.equal(res.status, 201);
    const body = res.json as {
      completion: { id: string; conclusion: string; artifactType: string };
      candidate: { id: string; outcome: string };
    };
    assert.equal(body.completion.conclusion, 'approved');
    assert.equal(body.candidate.outcome, 'review-required');
    const db = store.getDatabase();
    const completions = db.prepare('SELECT COUNT(*) AS n FROM artifact_completions WHERE workspace_id = ?').get(WS) as { n: number | bigint };
    assert.equal(Number(completions.n), 1);
    const candidateRow = db.prepare('SELECT outcome FROM memory_candidate_entries WHERE workspace_id = ? AND id = ?')
      .get(WS, body.candidate.id) as { outcome: string };
    assert.equal(candidateRow.outcome, 'review-required');
  });
});

test('AR-02 boundary: input validation fails closed with 400 and writes nothing', async () => {
  await withServer(async (baseUrl, store) => {
    seedArtifact(store, 'art_review_1', 'review');
    for (const body of [
      { artifactId: 'art_review_1', artifactType: 'file', conclusion: 'approved' },
      { artifactId: 'art_review_1', artifactType: 'review', conclusion: 'maybe' },
      { artifactId: '', artifactType: 'review', conclusion: 'approved' },
    ]) {
      const res = await postJson(`${baseUrl}/artifact-completions`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const db = store.getDatabase();
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM artifact_completions').get() as { n: number | bigint }).n), 0);
  });
});
