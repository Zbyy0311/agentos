import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createApprovalDecisionRoutes } from './approvalDecisions.js';

const WS = 'workspace-a';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-apd-route-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: WS, name: 'Workspace A', rootPath: join(root, 'ws-a'), gitEnabled: true, memoryEnabled: true,
      agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
      lastOpenedAt: '2026-09-11T00:00:00.000Z', createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z',
    }],
  }), 'utf8');
  return root;
}

async function withServer(run: (baseUrl: string, store: SqliteStore) => Promise<void>): Promise<void> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  try {
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId', createApprovalDecisionRoutes(store, new WorkspaceManager(store)));
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
const VALID = {
  decision: 'allow_once', riskLevel: 'low', agentId: 'codex', provider: 'codex',
  toolName: 'shell', actionFingerprint: 'shell:ls',
};

test('AP-04: an accepted decision records the durable row and generates one review-required Candidate', async () => {
  await withServer(async (baseUrl, store) => {
    const res = await postJson(`${baseUrl}/approval-decisions`, VALID);
    assert.equal(res.status, 201);
    const body = res.json as {
      decision: { id: string; decision: string; riskLevel: string };
      candidate: { id: string; outcome: string; status: string };
    };
    assert.equal(body.decision.decision, 'allow_once');
    assert.ok(body.candidate !== null);
    assert.equal(body.candidate.outcome, 'review-required');

    const db = store.getDatabase();
    const decisions = db.prepare('SELECT COUNT(*) AS n FROM approval_decisions WHERE workspace_id = ?').get(WS) as { n: number | bigint };
    assert.equal(Number(decisions.n), 1);
    const candidateRow = db.prepare('SELECT outcome FROM memory_candidate_entries WHERE workspace_id = ? AND id = ?')
      .get(WS, body.candidate.id) as { outcome: string };
    assert.equal(candidateRow.outcome, 'review-required');
  });
});

test('AP-05: a denied decision records the durable row and generates no Candidate', async () => {
  await withServer(async (baseUrl, store) => {
    const res = await postJson(`${baseUrl}/approval-decisions`, { ...VALID, decision: 'deny' });
    assert.equal(res.status, 201);
    const body = res.json as { candidate: unknown };
    assert.equal(body.candidate, null);
    const db = store.getDatabase();
    const candidates = db.prepare('SELECT COUNT(*) AS n FROM memory_candidate_entries WHERE workspace_id = ?').get(WS) as { n: number | bigint };
    assert.equal(Number(candidates.n), 0);
    const decisions = db.prepare('SELECT COUNT(*) AS n FROM approval_decisions WHERE workspace_id = ?').get(WS) as { n: number | bigint };
    assert.equal(Number(decisions.n), 1);
  });
});

test('AP: invalid input fails closed with 400 and writes nothing', async () => {
  await withServer(async (baseUrl, store) => {
    for (const body of [
      { ...VALID, decision: 'maybe' },
      { ...VALID, riskLevel: 'extreme' },
      { ...VALID, toolName: '' },
      { ...VALID, actionFingerprint: '' },
    ]) {
      const res = await postJson(`${baseUrl}/approval-decisions`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const db = store.getDatabase();
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM approval_decisions').get() as { n: number | bigint }).n), 0);
  });
});
