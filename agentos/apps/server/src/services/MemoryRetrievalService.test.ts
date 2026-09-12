import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_RANKING_WEIGHTS_V1,
  rankMemoryCandidates,
  resolveMemoryReach,
  type MemoryRankingCandidate,
} from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { MemoryEntryRepository, type CreateMemoryEntryInput } from '../store/MemoryEntryRepository.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { MemoryRetrievalService, toSafeFtsQuery } from './MemoryRetrievalService.js';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};

const NOW = '2026-09-09T00:00:00.000Z';
const WS = 'ws_mf3';
const TASK = 'task_mf3';
const RUN = 'run_mf3';

interface Fx {
  db: SqliteDb;
  repo: MemoryEntryRepository;
  service: MemoryRetrievalService;
  close(): void;
}

function fixture(nowMs?: number): Fx {
  const root = mkdtempSync(join(tmpdir(), 'agentos-mf3-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(
    db as unknown as MinimalDatabaseSync,
    new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS),
    { backupProvider: createFileBackupProvider(join(root, 'backup')) },
  ).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_mf3', 'C:/tmp/ws_mf3', NOW, NOW, NOW);
  const repo = new MemoryEntryRepository(db as unknown as TransactionDatabase);
  const service = new MemoryRetrievalService(repo, () => nowMs ?? Date.now());
  return { db, repo, service, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

let seq = 0;
function entry(overrides: Partial<CreateMemoryEntryInput> = {}): CreateMemoryEntryInput {
  seq += 1;
  return {
    id: 'mem_' + String(seq).padStart(4, '0') + 'x'.repeat(20),
    workspaceId: WS,
    scope: 'task',
    ownerTaskId: TASK,
    category: 'decision',
    authority: 'system-verified',
    confidence: 0.8,
    importance: 0.5,
    title: `entry ${seq}`,
    summary: 'summary',
    content: 'content alpha',
    tags: ['a'],
    status: 'active',
    sources: [{ kind: 'run', id: RUN }],
    createdAt: NOW,
    ...overrides,
  };
}

const CONTEXT = { workspaceId: WS, taskId: TASK, runId: RUN };

// MF3-01 — reach resolution covers global/workspace and named owners only.
test('MF3-01 reach resolution is owner-bounded', () => {
  const reach = resolveMemoryReach({ workspaceId: WS });
  assert.deepEqual(reach, [{ scope: 'global', ownerId: null }, { scope: 'workspace', ownerId: null }]);
  const full = resolveMemoryReach(CONTEXT);
  assert.deepEqual(full, [
    { scope: 'global', ownerId: null },
    { scope: 'workspace', ownerId: null },
    { scope: 'task', ownerId: TASK },
    { scope: 'run', ownerId: RUN },
  ]);
  const noGlobal = resolveMemoryReach({ ...CONTEXT, includeGlobal: false });
  assert.ok(!noGlobal.some(item => item.scope === 'global'));
});

// MF3-02 — retrieval is limited to reachable Scope/owner pairs.
test('MF3-02 retrieval is scope-bounded', () => {
  const fx = fixture();
  try {
    fx.repo.createEntry(entry({ scope: 'task', ownerTaskId: TASK }));
    fx.repo.createEntry(entry({ scope: 'task', ownerTaskId: 'task_other' }));
    fx.repo.createEntry(entry({ scope: 'workspace', ownerTaskId: undefined } as Partial<CreateMemoryEntryInput>));
    fx.repo.createEntry(entry({ scope: 'global', ownerTaskId: undefined } as Partial<CreateMemoryEntryInput>));
    const results = fx.service.retrieve({ context: CONTEXT });
    assert.equal(results.length, 3);
    const scopes = results.map(result => result.entry.scope).sort();
    assert.deepEqual(scopes, ['global', 'task', 'workspace']);
  } finally { fx.close(); }
});

// MF3-03 — non-retrievable statuses are excluded.
test('MF3-03 non-retrievable statuses excluded', () => {
  const fx = fixture();
  try {
    fx.repo.createEntry(entry({ status: 'active' }));
    fx.repo.createEntry(entry({ status: 'archived' }));
    fx.repo.createEntry(entry({ status: 'rejected' }));
    fx.repo.createEntry(entry({ status: 'expired' }));
    const results = fx.service.retrieve({ context: CONTEXT });
    assert.equal(results.length, 1);
    assert.equal(results[0].entry.status, 'active');
  } finally { fx.close(); }
});

// MF3-04 — ranking is deterministic and independent of input order.
test('MF3-04 ranking is deterministic and order-independent', () => {
  const a: MemoryRankingCandidate = {
    memoryId: 'mem_a', memoryVersion: 1, scope: 'task', category: 'decision',
    authority: 'system-verified', confidence: 0.8, importance: 0.5, pinned: false,
    conflicted: false, updatedAt: NOW, ftsRank: null, tokenCost: 10,
  };
  const b: MemoryRankingCandidate = { ...a, memoryId: 'mem_b', importance: 0.9 };
  const forward = rankMemoryCandidates([a, b], { nowMs: Date.parse(NOW) });
  const reverse = rankMemoryCandidates([b, a], { nowMs: Date.parse(NOW) });
  assert.deepEqual(forward.map(r => r.memoryId), reverse.map(r => r.memoryId));
  assert.deepEqual(forward.map(r => r.score), reverse.map(r => r.score));
  // Higher importance wins.
  assert.equal(forward[0].memoryId, 'mem_b');
});

// MF3-05 — pin dominates and records the pin reason.
test('MF3-05 pin dominates and is explained', () => {
  const pinned: MemoryRankingCandidate = {
    memoryId: 'mem_pin', memoryVersion: 1, scope: 'task', category: 'decision',
    authority: 'unknown', confidence: 0.1, importance: 0.1, pinned: true,
    conflicted: false, updatedAt: NOW, ftsRank: null, tokenCost: 10,
  };
  const strong: MemoryRankingCandidate = {
    ...pinned, memoryId: 'mem_strong', pinned: false, authority: 'user-explicit',
    confidence: 1, importance: 1,
  };
  const ranked = rankMemoryCandidates([strong, pinned], { nowMs: Date.parse(NOW) });
  assert.equal(ranked[0].memoryId, 'mem_pin');
  assert.ok(ranked[0].reasons.includes('pin'));
});

// MF3-06 — conflict penalizes ranking and FTS relevance is explained.
test('MF3-06 conflict penalty and FTS reason', () => {
  const base: MemoryRankingCandidate = {
    memoryId: 'mem_x', memoryVersion: 1, scope: 'task', category: 'decision',
    authority: 'system-verified', confidence: 0.8, importance: 0.5, pinned: false,
    conflicted: false, updatedAt: NOW, ftsRank: null, tokenCost: 10,
  };
  const clean = rankMemoryCandidates([base], { nowMs: Date.parse(NOW) })[0];
  const conflicted = rankMemoryCandidates([{ ...base, conflicted: true }], { nowMs: Date.parse(NOW) })[0];
  assert.ok(conflicted.score < clean.score);
  const withFts = rankMemoryCandidates([{ ...base, ftsRank: -2 }], { nowMs: Date.parse(NOW) })[0];
  assert.ok(withFts.reasons.includes('fts-relevance'));
  assert.ok(withFts.score > clean.score);
});

// MF3-07 — ranking is stable for equal scores (id tie-break).
test('MF3-07 equal scores break by id ascending', () => {
  const base: MemoryRankingCandidate = {
    memoryId: 'mem_b', memoryVersion: 1, scope: 'task', category: 'decision',
    authority: 'system-verified', confidence: 0.8, importance: 0.5, pinned: false,
    conflicted: false, updatedAt: NOW, ftsRank: null, tokenCost: 10,
  };
  const ranked = rankMemoryCandidates([base, { ...base, memoryId: 'mem_a' }], { nowMs: Date.parse(NOW) });
  assert.deepEqual(ranked.map(r => r.memoryId), ['mem_a', 'mem_b']);
});

// MF3-08 — no wall clock: an explicit nowMs drives recency.
test('MF3-08 recency is driven by the supplied clock', () => {
  const recent: MemoryRankingCandidate = {
    memoryId: 'mem_recent', memoryVersion: 1, scope: 'task', category: 'decision',
    authority: 'system-verified', confidence: 0.8, importance: 0.5, pinned: false,
    conflicted: false, updatedAt: '2026-09-08T00:00:00.000Z', ftsRank: null, tokenCost: 10,
  };
  const stale: MemoryRankingCandidate = { ...recent, memoryId: 'mem_stale', updatedAt: '2020-01-01T00:00:00.000Z' };
  const ranked = rankMemoryCandidates([stale, recent], { nowMs: Date.parse(NOW) });
  assert.equal(ranked[0].memoryId, 'mem_recent');
  assert.ok(ranked[0].reasons.includes('recency'));
});

// MF3-09 — category and tag filters narrow candidates.
test('MF3-09 category and tag filters', () => {
  const fx = fixture();
  try {
    fx.repo.createEntry(entry({ category: 'decision', tags: ['x'] }));
    fx.repo.createEntry(entry({ category: 'failure', tags: ['y'] }));
    assert.equal(fx.service.retrieve({ context: CONTEXT, categoryFilter: ['failure'] }).length, 1);
    assert.equal(fx.service.retrieve({ context: CONTEXT, tagFilter: ['x'] }).length, 1);
    assert.equal(fx.service.retrieve({ context: CONTEXT, tagFilter: ['nope'] }).length, 0);
  } finally { fx.close(); }
});

// MF3-10 — FTS query narrows ranking but never drops structured candidates.
test('MF3-10 FTS relevance affects ranking, structured filters remain authoritative', () => {
  const fx = fixture();
  try {
    const match = fx.repo.createEntry(entry({ content: 'alpha beta gamma', title: 'alpha' }));
    const other = fx.repo.createEntry(entry({ content: 'delta epsilon', title: 'delta' }));
    const results = fx.service.retrieve({ context: CONTEXT, query: 'alpha' });
    assert.equal(results.length, 2);
    assert.equal(results[0].entry.id, match.id);
    assert.ok(results[0].reasons.includes('fts-relevance'));
    const otherResult = results.find(result => result.entry.id === other.id);
    assert.ok(otherResult !== undefined);
    assert.equal(otherResult.ftsRank, null);
  } finally { fx.close(); }
});

// MF3-11 — a hostile FTS query is neutralized, not executed as syntax.
test('MF3-11 hostile FTS query is neutralized', () => {
  assert.equal(toSafeFtsQuery('   '), null);
  const safe = toSafeFtsQuery('alpha" OR "beta* NEAR(x)');
  assert.ok(safe !== null);
  // Every token group is double-quoted, so FTS operators become literal terms.
  assert.ok(!safe.includes('*'));
  assert.ok(!safe.includes('('));
  assert.ok(!safe.includes(')'));
  assert.ok(!safe.includes('-'));
  assert.ok(!safe.includes(':'));
  // A bare (unquoted) operator would appear as a standalone token.
  assert.ok(!/(^|\s)OR(\s|$)/u.test(safe));
  assert.ok(!/(^|\s)NEAR(\s|$)/u.test(safe));
  const fx = fixture();
  try {
    fx.repo.createEntry(entry({ content: 'alpha beta' }));
    const results = fx.service.retrieve({ context: CONTEXT, query: 'alpha" OR 1=1 --' });
    assert.equal(results.length, 1);
  } finally { fx.close(); }
});

// MF3-12 — limit caps results without changing order.
test('MF3-12 limit caps results', () => {
  const fx = fixture();
  try {
    for (let i = 0; i < 5; i += 1) fx.repo.createEntry(entry());
    const all = fx.service.retrieve({ context: CONTEXT });
    const capped = fx.service.retrieve({ context: CONTEXT, limit: 2 });
    assert.equal(all.length, 5);
    assert.deepEqual(capped.map(r => r.entry.id), all.slice(0, 2).map(r => r.entry.id));
  } finally { fx.close(); }
});

// MF3-13 — invalid input fails closed.
test('MF3-13 invalid input fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(() => fx.service.retrieve({ context: { workspaceId: '' } }));
    assert.throws(() => fx.service.retrieve({ context: CONTEXT, limit: 0 }));
    assert.throws(() => fx.service.retrieve(null as never));
  } finally { fx.close(); }
});

// MF3-14 — ranking weights are frozen.
test('MF3-14 ranking weights are frozen', () => {
  assert.deepEqual(MEMORY_RANKING_WEIGHTS_V1, {
    pin: 100, authority: 8, importance: 20, confidence: 20,
    scopeProximity: 4, ftsRelevance: 15, recency: 10, conflictPenalty: 10,
  });
});

// MF3-15 — no cross-Workspace leakage.
test('MF3-15 no cross-workspace leakage', () => {
  const fx = fixture();
  try {
    fx.db.prepare(
      'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('ws_other', 'ws_other', 'C:/tmp/ws_other', 'C:/tmp/ws_other', NOW, NOW, NOW);
    fx.repo.createEntry(entry({ workspaceId: 'ws_other', scope: 'global', ownerTaskId: undefined } as Partial<CreateMemoryEntryInput>));
    const results = fx.service.retrieve({ context: CONTEXT });
    assert.equal(results.length, 0);
  } finally { fx.close(); }
});

test('LITE-07-109: validity is inclusive at start and exclusive at end or expiry', () => {
  const clock = Date.parse(NOW);
  const before = new Date(clock - 1).toISOString();
  const after = new Date(clock + 1).toISOString();
  const fx = fixture(clock);
  try {
    const visible = [
      fx.repo.createEntry(entry()),
      fx.repo.createEntry(entry({ validFrom: NOW })),
      fx.repo.createEntry(entry({ validUntil: after })),
      fx.repo.createEntry(entry({ expiresAt: after })),
      fx.repo.createEntry(entry({ validFrom: before, validUntil: after, expiresAt: after })),
    ];
    const hidden = [
      fx.repo.createEntry(entry({ validFrom: after })),
      fx.repo.createEntry(entry({ validUntil: NOW })),
      fx.repo.createEntry(entry({ expiresAt: NOW })),
      fx.repo.createEntry(entry({ validUntil: before })),
      fx.repo.createEntry(entry({ expiresAt: before })),
      fx.repo.createEntry(entry({ validFrom: before, validUntil: after, expiresAt: NOW })),
    ];
    const actual = fx.service.retrieve({ context: CONTEXT }).map(result => result.entry.id).sort();
    assert.deepEqual(actual, visible.map(row => row.id).sort());
    // Eligibility is a read-time decision, not mutation or deletion.
    for (const row of hidden) assert.deepEqual(fx.repo.findById(WS, row.id), row);
  } finally { fx.close(); }
});

test('LITE-07-109: malformed persisted dates fail closed and the clock is captured once', () => {
  const fx = fixture();
  try {
    const good = fx.repo.createEntry(entry());
    for (const fields of [
      { validFrom: 'not-a-date' }, { validUntil: '' }, { expiresAt: 'invalid' },
      { validFrom: '2099-01-01T00:00:00.000Z', validUntil: NOW },
    ]) fx.repo.createEntry(entry(fields));
    let calls = 0;
    const service = new MemoryRetrievalService(fx.repo, () => { calls += 1; return Date.parse(NOW); });
    assert.deepEqual(service.retrieve({ context: CONTEXT }).map(row => row.entry.id), [good.id]);
    assert.equal(calls, 1);
    assert.throws(() => new MemoryRetrievalService(fx.repo, () => NaN).retrieve({ context: CONTEXT }),
      /MEMORY_RETRIEVAL_INPUT_INVALID/);
  } finally { fx.close(); }
});

test('LITE-07-109: restricted pinned matches cannot consume a limit or leak through retrieval', () => {
  const fx = fixture(Date.parse(NOW));
  try {
    const marker = 'restricted-fixture-value-no-real-secret';
    const restricted = fx.repo.createEntry(entry({ sensitivity: 'restricted', pinned: true,
      title: marker, content: marker, authority: 'user-explicit' }));
    const good = fx.repo.createEntry(entry({ content: 'ordinary allowed content' }));
    const result = fx.service.retrieveWithStatus({ context: CONTEXT, query: marker, limit: 1 });
    assert.deepEqual(result.results.map(row => row.entry.id), [good.id]);
    assert.equal(JSON.stringify(result).includes(marker), false);
    assert.deepEqual(fx.repo.findById(WS, restricted.id), restricted);
  } finally { fx.close(); }
});
