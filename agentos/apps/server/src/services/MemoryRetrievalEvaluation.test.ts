import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { MemoryBudgetPolicyV1 } from '@agentos/shared';
import type { MemoryEntryRecord } from '../store/MemoryEntryRepository.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { migration017 } from '../migrations/migrations/017-mf1-memory-entry-persistence.js';
import { migration048 } from '../migrations/migrations/048-memory-vectors.js';
import { applyBudget } from './MemoryContextBudgetSelector.js';
import { MemoryRetrievalService, type RetrievedMemoryEntry } from './MemoryRetrievalService.js';
import { MemorySemanticRetrieval, type MemoryEmbeddingPort } from './MemorySemanticRetrieval.js';

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

interface CorpusEntry {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly pinned?: boolean;
}
interface CorpusQuery {
  readonly id: string;
  readonly topic: string;
  readonly intent: 'exact-en' | 'exact-zh' | 'paraphrase-en' | 'paraphrase-zh' | 'mixed' | 'no-match';
  readonly text: string;
  readonly relevantIds: readonly string[];
}
interface RetrievalCorpus {
  readonly formatVersion: number;
  readonly entries: readonly CorpusEntry[];
  readonly queries: readonly CorpusQuery[];
}

const corpus = JSON.parse(readFileSync(new URL('./fixtures/memory-retrieval-queries.json', import.meta.url), 'utf8')) as RetrievalCorpus;
const EVAL_NOW = '2026-10-01T00:00:00.000Z';
const WS = 'ws-retrieval-evaluation';
const BUDGET: MemoryBudgetPolicyV1 = {
  maxTokens: 6000,
  maxEntries: 5,
  perScopeLimits: {},
  perCategoryLimits: {},
  minConfidence: 0.5,
  minImportance: 0.3,
  maxTruncation: 0,
  requireDiversity: false,
};

/**
 * Fixed fixture-label vector lookup. It exercises storage, cache, and ranking
 * behavior only: there is no text heuristic, external model, or production
 * quality claim. Labeled query vectors intentionally stand in for known-topic
 * and reviewed-paraphrase answers in this synthetic gate harness.
 */
function normalizeEmbeddingInput(text: string): string {
  return text.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

const topicNames = [...new Set(corpus.entries.map(entry => entry.id.slice(0, entry.id.indexOf('-'))))];
const topicIndex = new Map(topicNames.map((topic, index) => [topic, index]));
const TEST_VECTORS = new Map<string, readonly number[]>();
function fixtureVector(index: number): readonly number[] {
  const vector = Array(topicNames.length + 1).fill(0) as number[];
  vector[index] = 1;
  return vector;
}
for (const entry of corpus.entries) {
  const topic = entry.id.slice(0, entry.id.indexOf('-'));
  TEST_VECTORS.set(normalizeEmbeddingInput([entry.title, entry.summary, entry.content, ...entry.tags].join('\n')),
    fixtureVector(topicIndex.get(topic)!));
}
for (const query of corpus.queries) {
  const index = query.intent === 'no-match' ? topicNames.length : topicIndex.get(query.topic)!;
  TEST_VECTORS.set(normalizeEmbeddingInput(query.text), fixtureVector(index));
}

class FixedLabelEmbeddingPort implements MemoryEmbeddingPort {
  readonly modelId = 'evaluation-simulator';
  readonly modelVersion = 'fixed-labels-v1';
  readonly isRemote = false;

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map(text => {
      const vector = TEST_VECTORS.get(normalizeEmbeddingInput(text));
      if (!vector) throw new Error('FIXED_TEST_VECTOR_NOT_FOUND');
      return vector;
    });
  }
}

function createDb(): SqliteDb {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY)');
  migration017.apply({ db: db as unknown as MinimalDatabaseSync });
  migration048.apply({ db: db as unknown as MinimalDatabaseSync });
  db.prepare('INSERT INTO workspaces (id) VALUES (?)').run(WS);
  return db;
}

function insertCorpusEntry(repository: MemoryEntryRepository, item: CorpusEntry, index: number): void {
  repository.createEntry({
    id: item.id,
    workspaceId: WS,
    scope: 'workspace',
    category: 'knowledge',
    authority: 'system-verified',
    confidence: 0.9,
    importance: 0.5,
    title: item.title,
    summary: item.summary,
    content: item.content,
    tags: item.tags,
    status: 'active',
    pinned: item.pinned === true,
    sources: [{ kind: 'import', id: `evaluation-${index}` }],
    createdAt: EVAL_NOW,
  });
}

function selectedFromBudget(results: readonly RetrievedMemoryEntry[]) {
  return applyBudget(results, BUDGET).selected.map(item => item.entry);
}

function recallAtK(results: readonly MemoryEntryRecord[], relevantIds: readonly string[], k: number): number {
  if (relevantIds.length === 0) return 0;
  const selected = new Set(results.slice(0, k).map(item => item.id));
  return relevantIds.filter(id => selected.has(id)).length / relevantIds.length;
}

test('fixed bilingual corpus evaluates real MF-3 SQLite retrieval and its production budget gate', async t => {
  assert.equal(corpus.formatVersion, 1);
  assert.ok(corpus.entries.length >= 80, `expected >=80 entries, got ${corpus.entries.length}`);
  assert.ok(corpus.queries.length >= 80, `expected >=80 queries, got ${corpus.queries.length}`);
  for (const intent of ['exact-en', 'exact-zh', 'paraphrase-en', 'paraphrase-zh', 'no-match'] as const) {
    assert.ok(corpus.queries.some(query => query.intent === intent), `missing ${intent} queries`);
  }

  const db = createDb();
  try {
    const repository = new MemoryEntryRepository(db as unknown as TransactionDatabase);
    corpus.entries.forEach((item, index) => insertCorpusEntry(repository, item, index));
    const retrieval = new MemoryRetrievalService(repository, () => Date.parse(EVAL_NOW));
    const semantic = new MemorySemanticRetrieval(
      db as unknown as TransactionDatabase,
      new FixedLabelEmbeddingPort(),
      { clock: () => Date.parse(EVAL_NOW) },
    );
    const retrievalWithSidecar = new MemoryRetrievalService(
      repository,
      () => Date.parse(EVAL_NOW),
      semantic,
    );
    let baselineRecall = 0;
    let hybridRecall = 0;
    let measuredQueries = 0;
    let baselineParaphraseRecall = 0;
    let hybridParaphraseRecall = 0;
    let paraphrases = 0;
    let noMatchSelected = 0;
    let noMatchNonPinned = 0;
    let noMatchPinned = 0;
    let noMatchBaselineSelected = 0;
    let noMatchBaselinePinned = 0;
    let noMatchBaselineNonPinnedFalsePositives = 0;
    let noMatchHybridNonPinnedFalsePositives = 0;
    let noMatchQueries = 0;
    let exactChineseQueries = 0;
    let exactChineseFtsMatches = 0;
    const k = BUDGET.maxEntries;

    for (const query of corpus.queries) {
      // This is the real repository-backed retrieval path, including FTS5 and
      // MF-3 eligibility/ranking; no test-local lexical ordering is substituted.
      const baseline = retrieval.retrieveWithStatus({ context: { workspaceId: WS }, query: query.text });
      assert.equal(baseline.degraded, false, `${query.id} FTS retrieval unexpectedly degraded`);
      assert.ok(baseline.results.length > 0, `${query.id} should still receive the ordinary default memory set`);
      if (query.intent === 'exact-en') {
        assert.ok(baseline.results.some(item => item.ftsRank !== null), `${query.id} produced no real SQLite FTS5 match`);
      }
      if (query.intent === 'exact-zh') {
        exactChineseQueries += 1;
        if (baseline.results.some(item => item.ftsRank !== null)) exactChineseFtsMatches += 1;
      }
      if (query.intent === 'no-match') {
        assert.ok(baseline.results.every(item => item.ftsRank === null), `${query.id} unexpectedly matched FTS5`);
      }

      const beforeBudget = selectedFromBudget(baseline.results);
      const ranked = await retrievalWithSidecar.retrievePrepared({ context: { workspaceId: WS }, query: query.text });
      assert.equal(ranked.degraded, false, `${query.id} prepared retrieval degraded: ${ranked.semantic?.reason ?? 'unknown'}`);
      assert.equal(ranked.semantic?.prepared, true, `${query.id} did not use async preparation`);
      assert.equal(ranked.semantic?.preparedEntryCount, baseline.results.length,
        `${query.id} prepared after a result cap or skipped an eligible candidate`);
      assert.equal(ranked.results.length, baseline.results.length, `${query.id} removed baseline candidates`);
      const syncLimited = retrievalWithSidecar.retrieveWithStatus({ context: { workspaceId: WS }, query: query.text, limit: k });
      assert.equal(syncLimited.semantic?.degraded, false, `${query.id} sync cached ranking degraded`);
      assert.deepEqual(syncLimited.results.map(item => item.entry.id), ranked.results.slice(0, k).map(item => item.entry.id),
        `${query.id} applied its limit before cached reranking`);
      baseline.results.slice(0, k).forEach((item, index) => {
        if (item.ftsRank !== null) assert.equal(syncLimited.results[index]?.entry.id, item.entry.id,
          `${query.id} demoted an exact FTS match from baseline slot ${index + 1}`);
      });
      const afterBudget = selectedFromBudget(ranked.results);
      assert.ok(afterBudget.length <= BUDGET.maxEntries);

      if (query.relevantIds.length > 0) {
        const ftsRecall = recallAtK(beforeBudget, query.relevantIds, k);
        const semanticRecall = recallAtK(afterBudget, query.relevantIds, k);
        baselineRecall += ftsRecall;
        hybridRecall += semanticRecall;
        measuredQueries += 1;
        if (query.intent === 'paraphrase-en' || query.intent === 'paraphrase-zh') {
          baselineParaphraseRecall += ftsRecall;
          hybridParaphraseRecall += semanticRecall;
          paraphrases += 1;
        }
      } else {
        noMatchQueries += 1;
        // With an empty gold set, every selected item is a false positive for
        // retrieval evaluation, including pinned defaults. Keep the pin count
        // separately so intentional runtime defaults remain visible.
        noMatchBaselineSelected += beforeBudget.length;
        noMatchBaselinePinned += beforeBudget.filter(entry => entry.pinned).length;
        noMatchBaselineNonPinnedFalsePositives += beforeBudget.filter(entry => !entry.pinned).length;
        noMatchHybridNonPinnedFalsePositives += afterBudget.filter(entry => !entry.pinned).length;
        noMatchSelected += afterBudget.length;
        noMatchPinned += afterBudget.filter(entry => entry.pinned).length;
        noMatchNonPinned += afterBudget.filter(entry => !entry.pinned).length;
      }
    }

    assert.ok(measuredQueries > 0 && paraphrases > 0 && noMatchQueries > 0);
    assert.equal(measuredQueries + noMatchQueries, corpus.queries.length,
      'all fixed queries must be accounted for; no-match queries are excluded from relevance recall');
    assert.ok(hybridRecall / measuredQueries + 1e-12 >= baselineRecall / measuredQueries,
      `budgeted hybrid recall@${k} ${(hybridRecall / measuredQueries).toFixed(3)} fell below MF-3+budget ${(baselineRecall / measuredQueries).toFixed(3)}`);
    assert.ok(hybridParaphraseRecall / paraphrases > baselineParaphraseRecall / paraphrases,
      `budgeted paraphrase recall@${k} did not improve: baseline=${(baselineParaphraseRecall / paraphrases).toFixed(3)}, hybrid=${(hybridParaphraseRecall / paraphrases).toFixed(3)}`);

    // No-match queries still follow the frozen default memory selection; every
    // selected item is a false positive for the empty gold set, with pins also
    // called out separately as deliberate runtime defaults.
    assert.ok(noMatchSelected > 0);
    assert.equal(noMatchNonPinned + noMatchPinned, noMatchSelected);
    assert.equal(noMatchBaselineSelected, noMatchBaselineNonPinnedFalsePositives + noMatchBaselinePinned,
      'every baseline selection for an empty gold set must be reported as a false positive');
    assert.equal(noMatchSelected, noMatchNonPinned + noMatchPinned,
      'every hybrid selection for an empty gold set must be reported as a false positive');
    assert.ok(noMatchBaselineNonPinnedFalsePositives > 0 && noMatchHybridNonPinnedFalsePositives > 0);
    assert.ok(noMatchHybridNonPinnedFalsePositives <= noMatchBaselineNonPinnedFalsePositives,
      'semantic reranking should not increase non-pinned no-match selections');
    assert.ok(noMatchPinned >= noMatchQueries && noMatchBaselinePinned >= noMatchQueries,
      'the default pinned memory should remain an intentional no-match selection');
    t.diagnostic(`queries=${corpus.queries.length}; relevant-label queries=${measuredQueries}; no-match queries=${noMatchQueries}; budgeted recall@${k} relevant-only baseline=${(baselineRecall / measuredQueries).toFixed(3)}, hybrid=${(hybridRecall / measuredQueries).toFixed(3)}; paraphrase baseline=${(baselineParaphraseRecall / paraphrases).toFixed(3)}, hybrid=${(hybridParaphraseRecall / paraphrases).toFixed(3)}.`);
    t.diagnostic(`no-match@${k}: every selected item is a false positive (empty gold set); baseline/hybrid total selections=${noMatchBaselineSelected}/${noMatchSelected}; non-pinned false positives=${noMatchBaselineNonPinnedFalsePositives}/${noMatchHybridNonPinnedFalsePositives}; pinned defaults=${noMatchBaselinePinned}/${noMatchPinned} (reported separately, never counted as relevant hits).`);
    t.diagnostic(`Chinese exact-query SQLite FTS5 hits=${exactChineseFtsMatches}/${exactChineseQueries}; remaining cases still exercise semantic/fallback ranking.`);
  } finally { db.close(); }
});
