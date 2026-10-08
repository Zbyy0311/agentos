import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createMemoryImportRoutes } from './memoryImport.js';
import { createMemoryRuntimeRoutes } from './memoryRuntime.js';

const WS = 'ws_import_route';
const NOW = '2026-09-12T18:30:00.000Z';
const MARKDOWN = ['# Notes', 'body one', '', '## Second', 'body two'].join('\n');

async function withServer(run: (baseUrl: string, store: SqliteStore) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-import-route-'));
  const store = new SqliteStore(root);
  store.getDatabase().prepare(
    'INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(WS, WS, root, root, NOW, NOW, NOW);
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/workspaces/:workspaceId', createMemoryImportRoutes(store, new WorkspaceManager(store)));
  app.use('/api/workspaces/:workspaceId', createMemoryRuntimeRoutes(store, new WorkspaceManager(store)));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    await run(`http://127.0.0.1:${port}/api/workspaces/${WS}`, store);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const post = (url: string, body: unknown) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('S7 route: preview -> confirm -> review queue -> accept creates an Entry with the import source', async () => {
  await withServer(async base => {
    const preview = await post(`${base}/memory/import/preview`, { fileName: 'notes.md', content: MARKDOWN });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json() as { preview: { fragmentCount: number; sourceHash: string; fragments: Array<{ title: string }> } };
    assert.equal(previewBody.preview.fragmentCount, 2);
    assert.deepEqual(previewBody.preview.fragments.map(fragment => fragment.title), ['Notes', 'Second']);

    const confirm = await post(`${base}/memory/import/confirm`, { fileName: 'notes.md', content: MARKDOWN });
    assert.equal(confirm.status, 201);
    const confirmBody = await confirm.json() as { imported: Array<{ candidateId: string }>; converged: unknown[]; sourceHash: string };
    assert.equal(confirmBody.imported.length, 2);
    assert.equal(confirmBody.converged.length, 0);

    const queue = await fetch(`${base}/memory/candidates?outcome=review-required`).then(r => r.json()) as { candidates: Array<{ id: string; scope: string; category: string; authority: string }> };
    for (const item of confirmBody.imported) {
      const candidate = queue.candidates.find(entry => entry.id === item.candidateId);
      assert.ok(candidate, 'imported candidate must appear in the review queue');
      assert.equal(candidate!.scope, 'workspace');
      assert.equal(candidate!.category, 'knowledge');
      assert.equal(candidate!.authority, 'imported-verified');
    }

    const accepted = await post(`${base}/memory/candidates/${confirmBody.imported[0]!.candidateId}/review`, { expectedVersion: 1, outcome: 'accept' });
    assert.equal(accepted.status, 200);
    const entry = await accepted.json() as { candidate?: { mergedIntoEntryId?: string } };
    assert.ok(entry.candidate?.mergedIntoEntryId);

    // replay converges: no new Candidate, no new Event
    const replay = await post(`${base}/memory/import/confirm`, { fileName: 'notes.md', content: MARKDOWN });
    assert.equal(replay.status, 200);
    const replayBody = await replay.json() as { imported: unknown[]; converged: unknown[] };
    assert.equal(replayBody.imported.length, 0);
    assert.equal(replayBody.converged.length, 2);

    const listed = await fetch(`${base}/memory/imports`).then(r => r.json()) as { imports: Array<{ candidateId: string; sourceHash: string }> };
    assert.equal(listed.imports.length, 2);
    assert.equal(listed.imports[0]!.sourceHash, confirmBody.sourceHash);
  });
});

test('S7 route: oversize and malformed input fail with stable status codes', async () => {
  await withServer(async base => {
    const oversize = await post(`${base}/memory/import/preview`, { fileName: 'big.md', content: 'a'.repeat(1024 * 1024 + 1) });
    assert.equal(oversize.status, 413);
    assert.equal(((await oversize.json()) as { error: string }).error, 'IMPORT_TOO_LARGE');
    const malformed = await post(`${base}/memory/import/preview`, { fileName: 'x.md' });
    assert.equal(malformed.status, 400);
    const missingWorkspace = await fetch(`http://127.0.0.1:1/api/workspaces/nope/memory/imports`).catch(() => undefined);
    assert.equal(missingWorkspace, undefined);
  });
});

