import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MemoryEntryRecord } from '../store/MemoryEntryRepository.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { migration017 } from '../migrations/migrations/017-mf1-memory-entry-persistence.js';
import { migration048 } from '../migrations/migrations/048-memory-vectors.js';
import {
  HttpMemoryEmbeddingPort,
  MemorySemanticRetrieval,
  type MemoryEmbeddingPort,
} from './MemorySemanticRetrieval.js';
import type { RetrievedMemoryEntry } from './MemoryRetrievalService.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryRetrievalService } from './MemoryRetrievalService.js';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};

const NOW = '2026-10-01T00:00:00.000Z';

function createDb(withMigration = true): SqliteDb {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
    sensitivity TEXT NOT NULL, valid_from TEXT, valid_until TEXT, expires_at TEXT,
    title TEXT NOT NULL, summary TEXT NOT NULL, content TEXT NOT NULL, tags_json TEXT NOT NULL
  )`);
  if (withMigration) migration048.apply({ db: db as unknown as MinimalDatabaseSync });
  return db;
}

function persistEntry(db: SqliteDb, entry: MemoryEntryRecord): void {
  db.prepare(`INSERT INTO memory_entries
    (id, workspace_id, version, status, sensitivity, valid_from, valid_until, expires_at, title, summary, content, tags_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id, version=excluded.version,
      status=excluded.status, sensitivity=excluded.sensitivity, valid_from=excluded.valid_from,
      valid_until=excluded.valid_until, expires_at=excluded.expires_at, title=excluded.title,
      summary=excluded.summary, content=excluded.content, tags_json=excluded.tags_json`).run(
    entry.id, entry.workspaceId, entry.version, entry.status, entry.sensitivity, entry.validFrom,
    entry.validUntil, entry.expiresAt, entry.title, entry.summary, entry.content, JSON.stringify(entry.tags),
  );
}

function record(id: string, overrides: Partial<MemoryEntryRecord> = {}): MemoryEntryRecord {
  return {
    id,
    workspaceId: 'ws-semantic',
    scope: 'workspace',
    ownerAgentId: null,
    ownerConversationId: null,
    ownerTaskId: null,
    ownerRunId: null,
    category: 'knowledge',
    authority: 'system-verified',
    confidence: 0.9,
    importance: 0.7,
    title: 'Release rollback procedure',
    summary: 'Deploy gradually and retain a rollback path.',
    content: 'Release rollout uses a canary before broad deployment.',
    tags: ['release', 'canary'],
    status: 'active',
    pinned: false,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
    exactContentHash: null,
    normalizedTextHash: null,
    tokenEstimate: 20,
    sensitivity: 'ordinary',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
    sources: overrides.sources ?? [],
  };
}

function retrieved(entry: MemoryEntryRecord, rank: number, score = 1 - rank / 10): RetrievedMemoryEntry {
  return { entry, rank, score, reasons: [], ftsRank: null };
}

class LocalTestEmbeddingPort implements MemoryEmbeddingPort {
  readonly modelId = 'fixture-local';
  readonly modelVersion = 'test-v1';
  readonly isRemote = false;
  readonly seen: string[] = [];
  fail = false;
  invalid = false;

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    this.seen.push(...texts);
    if (this.fail) throw new Error('provider detail must not escape');
    return texts.map(text => {
      if (this.invalid) return [Number.NaN, 0];
      const value = /release|rollout|canary|部署|发布|灰度/iu.test(text) ? [1, 0.1, 0] : [0, 1, 0.1];
      return value;
    });
  }
}

test('048 creates only derived vector caches and can be applied repeatedly', () => {
  const db = createDb(false);
  try {
    migration048.apply({ db: db as unknown as MinimalDatabaseSync });
    migration048.apply({ db: db as unknown as MinimalDatabaseSync });
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_semantic_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    assert.deepEqual(tables.map(row => row.name), [
      'memory_semantic_entry_vectors',
      'memory_semantic_quality_receipts',
      'memory_semantic_query_vectors',
    ]);
    const missingPrerequisite = new DatabaseSync(':memory:');
    try {
      assert.throws(
        () => migration048.apply({ db: missingPrerequisite as unknown as MinimalDatabaseSync }),
        /MIGRATION_PREREQUISITE_MISSING: 048 requires memory_entries/,
      );
    } finally { missingPrerequisite.close(); }
  } finally { db.close(); }
});

test('async prepare fills the local cache and synchronous hybrid rerank preserves the full FTS candidate set', async () => {
  const db = createDb();
  const port = new LocalTestEmbeddingPort();
  try {
    const service = new MemorySemanticRetrieval(db as unknown as TransactionDatabase, port, { clock: () => Date.parse(NOW) });
    const relevant = retrieved(record('release-entry'), 2, 0.5);
    const other = retrieved(record('unrelated-entry', {
      title: 'Conversation summary retention',
      summary: 'Compact old dialog into a short summary.',
      content: 'Keep the conversation context within the token budget.',
      tags: ['summary'],
      pinned: true,
    }), 1, 1);
    persistEntry(db, relevant.entry);
    persistEntry(db, other.entry);
    const baseline = [other, relevant];

    const prepared = await service.prepare('rollout canary', baseline);
    assert.deepEqual(prepared, { degraded: false, preparedEntryCount: 2 });
    const embeddedAfterFirstPrepare = port.seen.length;
    assert.deepEqual(await service.prepare('rollout canary', baseline), prepared);
    assert.equal(port.seen.length, embeddedAfterFirstPrepare, 'unchanged query and entries should reuse cached vectors');
    const ranked = service.rerank(baseline, 'rollout canary');
    assert.equal(ranked.degraded, false);
    assert.deepEqual(ranked.results.map(item => item.entry.id), ['unrelated-entry', 'release-entry']);
    assert.equal(ranked.results.length, baseline.length);

    // Pinning remains an explicit ordering constraint; semantic matching does not erase it.
    const unpinned = { ...other, entry: { ...other.entry, pinned: false } };
    const nearBaseline = { ...relevant, score: 0.8 };
    const lowBaseline = retrieved(record('low-baseline-entry', {
      title: 'Gardening notes', summary: 'Water plants weekly.', content: 'Use a sunny window for seedlings.', tags: ['garden'],
    }), 3, 0);
    persistEntry(db, lowBaseline.entry);
    const semanticCandidates = [unpinned, nearBaseline, lowBaseline];
    await service.prepare('rollout canary', semanticCandidates);
    const semanticOrder = service.rerank(semanticCandidates, 'rollout canary');
    assert.equal(semanticOrder.results[0]?.entry.id, 'release-entry');
    assert.ok(semanticOrder.results[0]?.reasons.includes('semantic-relevance'));
  } finally { db.close(); }
});

test('FTS exact matches retain their baseline positions when a semantic-only candidate scores higher', async () => {
  const db = createDb();
  const port = new LocalTestEmbeddingPort();
  try {
    const service = new MemorySemanticRetrieval(db as unknown as TransactionDatabase, port, { clock: () => Date.parse(NOW) });
    const exact = retrieved(record('lexical-hit', {
      title: 'Meeting agenda', summary: 'Unrelated notes.', content: 'Discuss quarterly hiring plans.', tags: ['meeting'],
    }), 1, 0.95);
    const semanticOnly = retrieved(record('semantic-hit'), 2, 0.4);
    const baseline = [{ ...exact, ftsRank: -2.5 }, semanticOnly];
    baseline.forEach(item => persistEntry(db, item.entry));
    await service.prepare('release rollout', baseline, 'ws-semantic');
    const ranked = service.rerank(baseline, 'release rollout', 'ws-semantic');
    assert.equal(ranked.degraded, false);
    assert.equal(ranked.results[0]?.entry.id, exact.entry.id);
    assert.equal(ranked.results[0]?.rank, exact.rank);
    assert.equal(ranked.results[0]?.score, exact.score);
  } finally { db.close(); }
});

test('no port is a byte-for-byte order-preserving no-op', () => {
  const db = createDb(false);
  try {
    const baseline = [retrieved(record('second'), 2), retrieved(record('first'), 1)];
    const service = new MemorySemanticRetrieval(db as unknown as TransactionDatabase);
    const result = service.rerank(baseline, 'anything');
    assert.equal(result.degraded, false);
    assert.deepEqual(result.results, baseline);
  } finally { db.close(); }
});

test('missing, stale-version, and stale-content caches visibly fall back to the input FTS order', async () => {
  const db = createDb();
  const port = new LocalTestEmbeddingPort();
  try {
    const service = new MemorySemanticRetrieval(db as unknown as TransactionDatabase, port, { clock: () => Date.parse(NOW) });
    const original = retrieved(record('same-entry'), 1);
    persistEntry(db, original.entry);
    assert.deepEqual(service.rerank([original], 'release').reason, 'CACHE_MISS');
    await service.prepare('release', [original]);
    assert.equal(service.rerank([original], 'release').degraded, false);

    const newVersion = retrieved(record('same-entry', { version: 2 }), 1);
    const staleVersionResult = service.rerank([newVersion], 'release');
    assert.equal(staleVersionResult.reason, 'CACHE_STALE');
    assert.deepEqual(staleVersionResult.results, [newVersion]);
    persistEntry(db, newVersion.entry);
    const countBeforeVersionPrepare = port.seen.length;
    await service.prepare('release', [newVersion]);
    assert.equal(port.seen.length, countBeforeVersionPrepare + 1, 'query vector should be reused while a changed entry is re-embedded');

    const changedContent = retrieved(record('same-entry', {
      version: 2,
      content: 'Changed after editing the memory entry.',
    }), 1);
    assert.equal(service.rerank([changedContent], 'release').reason, 'CACHE_STALE');
    persistEntry(db, changedContent.entry);
    await service.prepare('release', [changedContent]);
    assert.equal(service.rerank([changedContent], 'release').degraded, false);
    const count = db.prepare('SELECT COUNT(*) AS count FROM memory_semantic_entry_vectors WHERE entry_id = ?').get('same-entry') as { count: number };
    assert.equal(count.count, 1);
  } finally { db.close(); }
});

test('MF-3 candidate and conflicted statuses remain eligible while unsafe or restricted text never reaches embeddings', async () => {
  const db = createDb();
  const port = new LocalTestEmbeddingPort();
  try {
    const service = new MemorySemanticRetrieval(db as unknown as TransactionDatabase, port, { clock: () => Date.parse(NOW) });
    const allowed = retrieved(record('allowed-entry', { status: 'candidate' }), 1);
    const conflicted = retrieved(record('conflicted-entry', { status: 'conflicted' }), 2);
    const restricted = retrieved(record('restricted-entry', {
      sensitivity: 'restricted',
      content: 'SECRET EXCLUDED BODY',
    }), 3);
    const unsafe = retrieved(record('unsafe-entry', { content: 'Authorization: Bearer highly-sensitive-value' }), 4);
    for (const item of [allowed, conflicted, restricted, unsafe]) persistEntry(db, item.entry);
    const baseline = [allowed, conflicted, restricted, unsafe];
    const status = await service.prepare('release', baseline);
    assert.equal(status.degraded, true);
    assert.equal(status.reason, 'INELIGIBLE_CANDIDATE');
    assert.equal(status.preparedEntryCount, 2);
    assert.ok(!port.seen.some(text => text.includes('SECRET EXCLUDED BODY')));
    assert.ok(!port.seen.some(text => text.includes('highly-sensitive-value')));
    const ranked = service.rerank(baseline, 'release');
    assert.equal(ranked.reason, 'INELIGIBLE_CANDIDATE');
    assert.deepEqual(ranked.results.map(item => item.entry.id).sort(), baseline.map(item => item.entry.id).sort());
    for (const item of [restricted, unsafe]) {
      assert.equal(ranked.results.find(result => result.entry.id === item.entry.id)?.score, item.score,
        'locally excluded text keeps its baseline score');
    }
    const beforeUnsafeQuery = port.seen.length;
    const unsafeQuery = await service.prepare('Authorization: Bearer private-query-value', [allowed]);
    assert.equal(unsafeQuery.reason, 'INVALID_QUERY');
    assert.equal(port.seen.length, beforeUnsafeQuery, 'unsafe query text must not reach the embedding port');
  } finally { db.close(); }
});

test('authorized global origins may mix with request-workspace entries; foreign non-global candidates are rejected', async () => {
  const db = createDb();
  const port = new LocalTestEmbeddingPort();
  try {
    const service = new MemorySemanticRetrieval(db as unknown as TransactionDatabase, port, { clock: () => Date.parse(NOW) });
    const local = retrieved(record('request-entry', { workspaceId: 'request-workspace' }), 1);
    const global = retrieved(record('confirmed-global-entry', { workspaceId: 'preference-origin', scope: 'global' }), 2);
    persistEntry(db, local.entry);
    persistEntry(db, global.entry);
    const mixed = [local, global];
    const prepared = await service.prepare('release', mixed, 'request-workspace');
    assert.equal(prepared.degraded, false);
    assert.deepEqual(service.rerank(mixed, 'release', 'request-workspace').results.length, 2);
    const namespace = db.prepare('SELECT DISTINCT workspace_id FROM memory_semantic_query_vectors').all() as Array<{ workspace_id: string }>;
    assert.deepEqual(namespace.map(row => row.workspace_id), ['request-workspace']);

    const foreign = retrieved(record('foreign-workspace-entry', { workspaceId: 'other-workspace', content: 'FOREIGN CANDIDATE BODY' }), 3);
    persistEntry(db, foreign.entry);
    const before = port.seen.length;
    const refused = await service.prepare('release', [local, foreign], 'request-workspace');
    assert.equal(refused.reason, 'CROSS_WORKSPACE_CANDIDATES');
    assert.equal(port.seen.length, before, 'foreign workspace text must be rejected before embedding');
    assert.equal(service.rerank([local, foreign], 'release', 'request-workspace').reason, 'CROSS_WORKSPACE_CANDIDATES');
  } finally { db.close(); }
});

test('async prepare rechecks entry version, status, and content before committing vectors', async () => {
  const db = createDb();
  const candidate = retrieved(record('race-entry'), 1);
  persistEntry(db, candidate.entry);
  class MutatingPort extends LocalTestEmbeddingPort {
    private changed = false;
    override async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      const vectors = await super.embed(texts);
      if (!this.changed) {
        this.changed = true;
        db.prepare(`UPDATE memory_entries SET version = 2, status = 'conflicted', content = ? WHERE id = ?`)
          .run('updated during embed', candidate.entry.id);
      }
      return vectors;
    }
  }
  try {
    const service = new MemorySemanticRetrieval(db as unknown as TransactionDatabase, new MutatingPort(), { clock: () => Date.parse(NOW) });
    const status = await service.prepare('release', [candidate]);
    assert.deepEqual(status, { degraded: true, reason: 'CACHE_STALE', preparedEntryCount: 0 });
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM memory_semantic_query_vectors').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM memory_semantic_entry_vectors').get() as { count: number }).count, 0);
  } finally { db.close(); }
});

test('remote ports are gated by explicit opt-in and provider errors stay visible without leaking text', async () => {
  const db = createDb();
  const remote = new LocalTestEmbeddingPort();
  Object.defineProperty(remote, 'isRemote', { value: true });
  const candidate = retrieved(record('remote-entry'), 1);
  persistEntry(db, candidate.entry);
  try {
    const disabled = new MemorySemanticRetrieval(db as unknown as TransactionDatabase, remote);
    assert.equal((await disabled.prepare('release', [candidate])).reason, 'REMOTE_DISABLED');
    assert.equal(remote.seen.length, 0);

    const enabled = new MemorySemanticRetrieval(db as unknown as TransactionDatabase, remote, {
      remoteEnabled: true,
      clock: () => Date.parse(NOW),
    });
    remote.fail = true;
    const failed = await enabled.prepare('release', [candidate]);
    assert.equal(failed.degraded, true);
    assert.equal(failed.reason, 'EMBEDDING_FAILED');
    assert.equal(JSON.stringify(failed).includes('provider detail'), false);
  } finally { db.close(); }
});

test('invalid embeddings and a missing 048 schema produce a visible baseline fallback', async () => {
  const db = createDb();
  const port = new LocalTestEmbeddingPort();
  try {
    const service = new MemorySemanticRetrieval(db as unknown as TransactionDatabase, port, { clock: () => Date.parse(NOW) });
    const candidate = retrieved(record('invalid-entry'), 1);
    persistEntry(db, candidate.entry);
    port.invalid = true;
    assert.equal((await service.prepare('release', [candidate])).reason, 'INVALID_VECTOR');
    assert.equal(service.rerank([candidate], 'release').reason, 'CACHE_MISS');
  } finally { db.close(); }

  const noSchemaDb = createDb(false);
  try {
    const service = new MemorySemanticRetrieval(noSchemaDb as unknown as TransactionDatabase, new LocalTestEmbeddingPort());
    const status = await service.prepare('release', [retrieved(record('no-schema'), 1)]);
    assert.equal(status.reason, 'CACHE_UNAVAILABLE');
  } finally { noSchemaDb.close(); }
});

test('the optional HTTPS adapter parses OpenAI-compatible vectors and keeps request order', async () => {
  const port = new HttpMemoryEmbeddingPort({
    endpoint: 'https://embeddings.example.test/v1/embeddings',
    modelId: 'remote-model',
    modelVersion: '2026-01',
    apiKey: 'test-key',
    fetch: async (_input, init) => {
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
      assert.equal(body.model, 'remote-model');
      assert.deepEqual(body.input, ['first', 'second']);
      return new Response(JSON.stringify({ data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.deepEqual(await port.embed(['first', 'second']), [[1, 0], [0, 1]]);
  assert.throws(() => new HttpMemoryEmbeddingPort({
    endpoint: 'http://insecure.example.test', modelId: 'm', modelVersion: '1',
  }), /REMOTE_CONFIG_INVALID/);
});

test('loopback embedding redirects never transmit text to another endpoint', async () => {
  let redirectedRequests = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === '/redirected') {
      redirectedRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
    } else {
      response.writeHead(307, { location: '/redirected' });
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = new HttpMemoryEmbeddingPort({
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/embeddings`,
      modelId: 'loopback-test', modelVersion: '1',
    });
    await assert.rejects(port.embed(['test-memory-body']), /REMOTE_NETWORK_ERROR/u);
    assert.equal(redirectedRequests, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('prepared retrieval warms every post-eligibility candidate before limiting; cached sync path falls back visibly', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY)');
  migration017.apply({ db: db as unknown as MinimalDatabaseSync });
  migration048.apply({ db: db as unknown as MinimalDatabaseSync });
  db.prepare('INSERT INTO workspaces (id) VALUES (?)').run('ws-semantic');
  const port = new LocalTestEmbeddingPort();
  try {
    const repository = new MemoryEntryRepository(db as unknown as TransactionDatabase);
    const first = record('limited-first', { title: 'A release checklist', content: 'A rollback route for canary deploys.' });
    const second = record('limited-second', { title: 'B release checklist', content: 'Stage a safe rollout then verify.' });
    const createRepoEntry = (entry: MemoryEntryRecord) => repository.createEntry({
      id: entry.id,
      workspaceId: entry.workspaceId,
      scope: 'workspace',
      category: entry.category,
      authority: entry.authority,
      confidence: entry.confidence,
      importance: entry.importance,
      title: entry.title,
      summary: entry.summary,
      content: entry.content,
      tags: entry.tags,
      status: entry.status,
      sources: [{ kind: 'import', id: `source-${entry.id}` }],
      createdAt: entry.createdAt,
    });
    const persistedFirst = createRepoEntry(first);
    const persistedSecond = createRepoEntry(second);
    const service = new MemorySemanticRetrieval(db as unknown as TransactionDatabase, port, { clock: () => Date.parse(NOW) });
    const retrieval = new MemoryRetrievalService(repository, () => Date.parse(NOW), service);
    const prepared = await retrieval.retrievePrepared({ context: { workspaceId: 'ws-semantic' }, query: 'rollout canary', limit: 1 });
    assert.equal(prepared.semantic?.degraded, false);
    assert.equal(prepared.semantic?.preparedEntryCount, 2);
    assert.equal(prepared.results.length, 1);
    assert.ok(port.seen.some(text => text.includes(persistedFirst.content)));
    assert.ok(port.seen.some(text => text.includes(persistedSecond.content)));

    const input = { context: { workspaceId: 'ws-semantic' }, query: 'rollout canary' };
    const baseline = new MemoryRetrievalService(repository, () => Date.parse(NOW)).retrieveWithStatus(input);
    db.exec('DROP TABLE memory_semantic_query_vectors');
    const degraded = retrieval.retrieveWithStatus(input);
    assert.equal(degraded.degraded, true);
    assert.equal(degraded.semantic?.degraded, true);
    assert.equal(degraded.semantic?.reason, 'CACHE_UNAVAILABLE');
    assert.deepEqual(degraded.results.map(item => item.entry.id), baseline.results.map(item => item.entry.id));
  } finally { db.close(); }
});

test('new selection rechecks archive, expiry and updated versions after a slow embedding failure', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY)');
  migration017.apply({ db: db as unknown as MinimalDatabaseSync });
  migration048.apply({ db: db as unknown as MinimalDatabaseSync });
  db.prepare('INSERT INTO workspaces VALUES (?)').run('ws-semantic');
  let now = Date.parse(NOW);
  try {
    const repository = new MemoryEntryRepository(db as unknown as TransactionDatabase);
    for (const id of ['archived-during-await', 'expired-during-await', 'edited-during-await']) repository.createEntry({
      id, workspaceId: 'ws-semantic', scope: 'workspace', category: 'knowledge', authority: 'user-explicit',
      confidence: 1, importance: 1, title: id, content: 'old rollout text', status: 'active', createdAt: NOW,
      sources: [{ kind: 'import', id: 'test-only' }],
      ...(id === 'expired-during-await' ? { expiresAt: new Date(now + 1000).toISOString() } : {}),
    });
    const port: MemoryEmbeddingPort = { modelId: 'slow-fixture', modelVersion: 'v1', isRemote: false,
      async embed() {
        db.prepare("UPDATE memory_entries SET status='archived',version=version+1 WHERE id=?").run('archived-during-await');
        db.prepare('UPDATE memory_entries SET content=?,version=version+1 WHERE id=?').run('current rollout text', 'edited-during-await');
        now += 1000;
        throw new Error('unavailable');
      } };
    const semantic = new MemorySemanticRetrieval(db as unknown as TransactionDatabase, port, { clock: () => now });
    const result = await new MemoryRetrievalService(repository, () => now, semantic)
      .retrievePrepared({ context: { workspaceId: 'ws-semantic' }, query: 'rollout' });
    assert.equal(result.degraded, true);
    assert.deepEqual(result.results.map(item => item.entry.id), ['edited-during-await']);
    assert.equal(result.results[0].entry.version, 2);
    assert.equal(result.results[0].entry.content, 'current rollout text');
  } finally { db.close(); }
});

test('real quality gate refusal prevents both embeddings and cache-only semantic reuse', async () => {
  const db = createDb();
  const port = new LocalTestEmbeddingPort();
  let approved = true;
  try {
    const entry = record('gated-entry');
    persistEntry(db, entry);
    const eligible = [retrieved(entry, 1)];
    const semantic = new MemorySemanticRetrieval(db as unknown as TransactionDatabase, port,
      { clock: () => Date.parse(NOW), qualityGate: () => approved });
    assert.equal((await semantic.prepare('rollout', eligible)).degraded, false);
    const calls = port.seen.length;
    approved = false;
    assert.equal((await semantic.prepare('rollout', eligible)).reason, 'SEMANTIC_QUALITY_GATE_REQUIRED');
    assert.equal(semantic.rerank(eligible, 'rollout').reason, 'SEMANTIC_QUALITY_GATE_REQUIRED');
    assert.equal(port.seen.length, calls);
  } finally { db.close(); }
});
