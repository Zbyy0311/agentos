import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { migration045 } from '../migrations/migrations/045-memory-lifecycle-audit.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { createMemoryMaintenanceRoutes } from './memoryMaintenance.js';

interface Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new(path: string) => Db };

const NOW = new Date().toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

async function listen(app: express.Express): Promise<import('node:http').Server> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  return server;
}

test('GET maintenance is workspace-bound, read-only, and returns safe suggestions', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const migrationDb = db as unknown as MinimalDatabaseSync;
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS) migration.apply({ db: migrationDb });
    migration045.apply({ db: migrationDb });
    for (const id of ['ws-route', 'ws-route-other']) {
      db.prepare(`INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(id, id, `C:/tmp/${id}`, `C:/tmp/${id}`, NOW, NOW, NOW);
    }
    const tx = db as unknown as TransactionDatabase;
    const entries = new MemoryEntryRepository(tx);
    const create = (id: string, workspaceId: string, options: Record<string, unknown> = {}) => entries.createEntry({
      id,
      workspaceId,
      scope: 'workspace',
      category: 'knowledge',
      authority: 'agent-derived',
      confidence: 0.8,
      importance: 0.8,
      status: 'active',
      title: `safe-${id}`,
      content: 'Private body must not be returned',
      sources: [{ kind: 'user', id: `source-${id}` }],
      createdAt: NOW,
      ...options,
    } as Parameters<typeof entries.createEntry>[0]);
    create('expired-pinned', 'ws-route', { pinned: true, expiresAt: PAST });
    create('future', 'ws-route', { validFrom: FUTURE, expiresAt: new Date(Date.now() + 172_800_000).toISOString() });
    create('foreign-expired', 'ws-route-other', { expiresAt: PAST });
    create('secret-title', 'ws-route', { expiresAt: PAST });
    db.prepare(`UPDATE memory_entries SET title='Authorization: Bearer do-not-return',version=version+1,updated_at=?
      WHERE id='secret-title'`).run(NOW);

    const beforeEntry = db.prepare(`SELECT version,status,title,expires_at FROM memory_entries
      WHERE workspace_id='ws-route' AND id='expired-pinned'`).get();
    const beforeLifecycle = Number((db.prepare('SELECT count(*) AS n FROM memory_lifecycle_actions').get() as { n: number }).n);
    const beforeContexts = Number((db.prepare('SELECT count(*) AS n FROM memory_context_snapshots').get() as { n: number }).n);
    const app = express();
    const store = { getDatabase: () => tx } as unknown as SqliteStore;
    const workspaceDouble = { get: (id: string) => id === 'ws-route' || id === 'ws-route-other' ? { id } : undefined };
    const workspaces = workspaceDouble as unknown as WorkspaceManager;
    app.use('/api/workspaces/:workspaceId', createMemoryMaintenanceRoutes(store, workspaces));
    const server = await listen(app);
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/workspaces/ws-route/memory/maintenance`);
      const body = await response.json() as {
        available: boolean;
        evaluatedAt: string;
        suggestions: Array<{ entryId: string; version: number; title: string; reason: string; proposedLifecycleAction: string }>;
      };
      assert.equal(response.status, 200);
      assert.equal(body.available, true);
      assert.ok(Number.isFinite(Date.parse(body.evaluatedAt)));
      assert.deepEqual(body.suggestions.map(item => item.entryId), ['expired-pinned']);
      assert.deepEqual(body.suggestions[0], {
        entryId: 'expired-pinned',
        version: 1,
        title: 'safe-expired-pinned',
        reasonCode: 'expired',
        reason: 'This entry is already ineligible for retrieval because its validity ended. Revalidation leaves the expired dates unchanged; a human must explicitly review and update validity before the entry can be retrieved again.',
        proposedLifecycleAction: 'revalidate',
      });
      assert.ok(!JSON.stringify(body).includes('do-not-return'));
      assert.ok(!JSON.stringify(body).includes('Private body'));
      const missingWorkspace = await fetch(`http://127.0.0.1:${address.port}/api/workspaces/missing/memory/maintenance`);
      assert.equal(missingWorkspace.status, 404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    assert.deepEqual(db.prepare(`SELECT version,status,title,expires_at FROM memory_entries
      WHERE workspace_id='ws-route' AND id='expired-pinned'`).get(), beforeEntry);
    assert.equal(Number((db.prepare('SELECT count(*) AS n FROM memory_lifecycle_actions').get() as { n: number }).n), beforeLifecycle);
    assert.equal(Number((db.prepare('SELECT count(*) AS n FROM memory_context_snapshots').get() as { n: number }).n), beforeContexts);
  } finally { db.close(); }
});

test('GET maintenance stays available as an explicit unavailable result on a pre-M1 schema', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const app = express();
    const store = { getDatabase: () => db as unknown as TransactionDatabase } as unknown as SqliteStore;
    const workspaces = { get: (id: string) => id === 'legacy' ? { id } : undefined } as unknown as WorkspaceManager;
    app.use('/api/workspaces/:workspaceId', createMemoryMaintenanceRoutes(store, workspaces));
    const server = await listen(app);
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/workspaces/legacy/memory/maintenance`);
      assert.equal(response.status, 200);
      const body = await response.json() as { available: boolean; evaluatedAt: string; suggestions: unknown[] };
      assert.equal(body.available, false);
      assert.ok(Number.isFinite(Date.parse(body.evaluatedAt)));
      assert.deepEqual(body.suggestions, []);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  } finally { db.close(); }
});
