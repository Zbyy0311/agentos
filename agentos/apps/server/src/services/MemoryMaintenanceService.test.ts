import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { migration045 } from '../migrations/migrations/045-memory-lifecycle-audit.js';
import { migration047 } from '../migrations/migrations/047-memory-version-feedback.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { MemoryMaintenanceService } from './MemoryMaintenanceService.js';

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

const NOW = Date.parse('2026-10-02T00:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const OLD = new Date(NOW - 200 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(NOW - 1000).toISOString();
const FUTURE = new Date(NOW + 60_000).toISOString();

function fixture(withFeedback = true) {
  const db = new DatabaseSync(':memory:');
  db.prepare('PRAGMA foreign_keys = ON').run();
  const migrationDb = db as unknown as MinimalDatabaseSync;
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS) migration.apply({ db: migrationDb });
  migration045.apply({ db: migrationDb });
  if (withFeedback) migration047.apply({ db: migrationDb });
  for (const id of ['ws-maintenance', 'ws-maintenance-other']) {
    db.prepare(`INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(id, id, `C:/tmp/${id}`, `C:/tmp/${id}`, NOW_ISO, NOW_ISO, NOW_ISO);
  }
  const tx = db as unknown as TransactionDatabase;
  const entries = new MemoryEntryRepository(tx);
  const create = (id: string, options: Record<string, unknown> = {}, workspaceId = 'ws-maintenance') => entries.createEntry({
    id,
    workspaceId,
    scope: 'workspace',
    category: 'knowledge',
    authority: 'agent-derived',
    confidence: 0.8,
    importance: 0.8,
    status: 'active',
    title: `title-${id}`,
    content: `body-${id}`,
    createdAt: NOW_ISO,
    sources: [{ kind: 'user', id: `source-${id}` }],
    ...options,
  } as Parameters<typeof entries.createEntry>[0]);
  const service = new MemoryMaintenanceService(tx, () => NOW);
  return { db, tx, entries, create, service, close: () => db.close() };
}

function count(db: Db, table: string): number {
  return Number((db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function snapshotEntry(fx: ReturnType<typeof fixture>, id: string) {
  return fx.db.prepare(`SELECT id,version,status,title,valid_from,valid_until,expires_at,updated_at
    FROM memory_entries WHERE workspace_id='ws-maintenance' AND id=?`).get(id);
}

test('maintenance returns workspace-scoped expiration and pending outdated feedback suggestions without writes', () => {
  const fx = fixture();
  try {
    fx.create('expired-pinned', { pinned: true, validUntil: PAST });
    fx.create('expired-status', { status: 'expired', pinned: true });
    fx.create('future', { validFrom: FUTURE, expiresAt: new Date(NOW + 86_400_000).toISOString() });
    fx.create('foreign-expired', { validUntil: PAST }, 'ws-maintenance-other');
    fx.create('outdated', { title: 'safe outdated title' });
    fx.create('stale-version', { title: 'stale feedback' });

    fx.db.prepare(`INSERT INTO memory_version_feedback (
      id,workspace_id,entry_id,entry_version,current_entry_version,context_kind,context_id,context_hash,kind,comment,created_at
    ) VALUES ('fb-outdated','ws-maintenance','outdated',1,1,'turn','context-outdated',?,'outdated','','${NOW_ISO}')`).run('a'.repeat(64));
    fx.db.prepare(`INSERT INTO memory_feedback_actions (
      id,feedback_id,workspace_id,entry_id,entry_version,action,status,version,created_at
    ) VALUES ('action-outdated','fb-outdated','ws-maintenance','outdated',1,'revalidation','pending',1,'${NOW_ISO}')`).run();
    fx.db.prepare(`INSERT INTO memory_version_feedback (
      id,workspace_id,entry_id,entry_version,current_entry_version,context_kind,context_id,context_hash,kind,comment,created_at
    ) VALUES ('fb-stale','ws-maintenance','stale-version',1,2,'turn','context-stale',?,'outdated','','${NOW_ISO}')`).run('b'.repeat(64));
    fx.db.prepare(`INSERT INTO memory_feedback_actions (
      id,feedback_id,workspace_id,entry_id,entry_version,action,status,version,created_at
    ) VALUES ('action-stale','fb-stale','ws-maintenance','stale-version',1,'revalidation','pending',1,'${NOW_ISO}')`).run();

    const beforeEntries = ['expired-pinned', 'expired-status', 'future', 'outdated', 'stale-version']
      .map(id => snapshotEntry(fx, id));
    const beforeCounts = ['memory_lifecycle_actions', 'memory_version_feedback', 'memory_feedback_actions',
      'memory_context_snapshots', 'memory_execution_contexts', 'cr_turn_context_snapshots', 'cr_turn_memory_payloads']
      .map(table => count(fx.db, table));
    const result = fx.service.list('ws-maintenance');

    assert.equal(result.available, true);
    assert.equal(result.evaluatedAt, NOW_ISO);
    assert.deepEqual(result.suggestions.map(item => item.entryId).sort(), ['expired-pinned', 'expired-status', 'outdated']);
    assert.equal(result.suggestions.find(item => item.entryId === 'expired-pinned')?.proposedLifecycleAction, 'revalidate');
    assert.equal(result.suggestions.find(item => item.entryId === 'expired-status')?.proposedLifecycleAction, 'set-validity');
    assert.equal(result.suggestions.find(item => item.entryId === 'outdated')?.reasonCode, 'outdated-feedback');
    assert.equal(result.suggestions.find(item => item.entryId === 'outdated')?.proposedLifecycleAction, 'revalidate');
    assert.ok(result.suggestions.every(item => item.version === 1 && item.title.startsWith('title-') || item.entryId === 'outdated'));
    assert.deepEqual(['expired-pinned', 'expired-status', 'future', 'outdated', 'stale-version'].map(id => snapshotEntry(fx, id)), beforeEntries);
    assert.deepEqual(['memory_lifecycle_actions', 'memory_version_feedback', 'memory_feedback_actions',
      'memory_context_snapshots', 'memory_execution_contexts', 'cr_turn_context_snapshots', 'cr_turn_memory_payloads']
      .map(table => count(fx.db, table)), beforeCounts);
  } finally { fx.close(); }
});

test('low-value heuristic is conservative and stable-time; pinned, preference, global, recent and strong entries are excluded', () => {
  const fx = fixture(false);
  try {
    fx.create('low-old', { importance: 0.1, confidence: 0.2, createdAt: OLD });
    fx.create('pinned-old', { importance: 0.1, confidence: 0.2, pinned: true, createdAt: OLD });
    fx.create('preference-old', { category: 'preference', importance: 0.1, confidence: 0.2, createdAt: OLD });
    fx.create('tagged-preference-old', { tags: ['preference'], importance: 0.1, confidence: 0.2, createdAt: OLD });
    fx.create('recent-low', { importance: 0.1, confidence: 0.2, createdAt: new Date(NOW - 10 * 86_400_000).toISOString() });
    fx.create('strong-old', { importance: 0.6, confidence: 0.2, createdAt: OLD });
    fx.create('global-old', { scope: 'global', importance: 0.1, confidence: 0.2, createdAt: OLD });
    fx.create('archived-old', { status: 'archived', importance: 0.1, confidence: 0.2, createdAt: OLD });
    fx.create('deleted-old', { status: 'deleted', importance: 0.1, confidence: 0.2, createdAt: OLD });
    let clockReads = 0;
    const service = new MemoryMaintenanceService(fx.tx, () => {
      clockReads += 1;
      return NOW + clockReads * 1000;
    });

    const result = service.list('ws-maintenance');
    assert.equal(clockReads, 1, 'one timestamp is used for every threshold in a response');
    assert.deepEqual(result.suggestions.map(item => item.entryId), ['low-old']);
    assert.equal(result.suggestions[0]?.proposedLifecycleAction, 'archive');
    assert.match(result.suggestions[0]?.reason ?? '', /importance.*confidence.*180 days/u);
    const repeated = service.list('ws-maintenance');
    assert.equal(clockReads, 2, 'each read captures exactly one timestamp');
    assert.equal(repeated.evaluatedAt, new Date(NOW + 2000).toISOString());
    assert.deepEqual(repeated.suggestions, result.suggestions);
  } finally { fx.close(); }
});

test('secret-bearing labels are filtered, results are capped at 100, and old schemas report unavailable', () => {
  const fx = fixture(false);
  try {
    fx.create('sensitive-title', { expiresAt: PAST });
    fx.db.prepare(`UPDATE memory_entries SET title='Authorization: Bearer never-return-this',version=version+1,updated_at=?
      WHERE id='sensitive-title'`).run(NOW_ISO);
    for (let index = 0; index < 125; index++) {
      fx.create(`expired-${String(index).padStart(3, '0')}`, { expiresAt: PAST });
    }
    const result = fx.service.list('ws-maintenance');
    assert.equal(result.available, true);
    assert.equal(result.suggestions.length, 100);
    assert.ok(result.suggestions.every(item => item.entryId !== 'sensitive-title'));
    assert.ok(result.suggestions.every(item => !JSON.stringify(item).includes('never-return-this')));

    const oldDb = new DatabaseSync(':memory:');
    try {
      oldDb.exec(`CREATE TABLE memory_entries (
        id TEXT, workspace_id TEXT, scope TEXT, category TEXT, tags_json TEXT, status TEXT,
        pinned INTEGER, valid_from TEXT, valid_until TEXT, expires_at TEXT, confidence REAL,
        importance REAL, sensitivity TEXT, version INTEGER, title TEXT, updated_at TEXT
      )`);
      const oldService = new MemoryMaintenanceService(oldDb as unknown as TransactionDatabase, () => NOW);
      assert.deepEqual(oldService.list('ws-maintenance'), { available: false, evaluatedAt: NOW_ISO, suggestions: [] });
    } finally { oldDb.close(); }
  } finally { fx.close(); }
});

test('maintenance input and clock errors are data-free', () => {
  const fx = fixture(false);
  try {
    assert.throws(() => fx.service.list('  '), /MEMORY_MAINTENANCE_INPUT_INVALID/u);
    const invalidClock = new MemoryMaintenanceService(fx.tx, () => Number.NaN);
    assert.throws(() => invalidClock.list('ws-maintenance'), /MEMORY_MAINTENANCE_CLOCK_INVALID/u);
  } finally { fx.close(); }
});
