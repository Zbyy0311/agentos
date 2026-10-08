import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MemoryBudgetPolicyV1 } from '@agentos/shared';
import { migration017 } from '../migrations/migrations/017-mf1-memory-entry-persistence.js';
import { migration048 } from '../migrations/migrations/048-memory-vectors.js';
import { migration049 } from '../migrations/migrations/049-memory-lexical-index.js';
import { MEMORY_RELEVANCE_POLICY } from './MemoryLexicalIndex.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { inTransaction } from '../store/Transaction.js';
import { applyBudget } from './MemoryContextBudgetSelector.js';
import { DEFAULT_MEMORY_BUDGET_POLICY_V1 } from './MemoryContextResolver.js';
import { MemoryRetrievalService, type RetrievedMemoryEntry } from './MemoryRetrievalService.js';
import {
  HttpMemoryEmbeddingPort,
  MemoryEmbeddingError,
  MemorySemanticRetrieval,
  type MemoryEmbeddingPort,
  type MemorySemanticReason,
} from './MemorySemanticRetrieval.js';

export const MEMORY_SEMANTIC_QUALITY_WORKSPACE_ID = '*';
const MINIMUM_QUERY_COUNT = 80;
const EVALUATION_WORKSPACE_ID = 'memory-semantic-quality-evaluation';
const INTENTS = new Set([
  'exact-en', 'exact-zh', 'paraphrase-en', 'paraphrase-zh', 'mixed', 'no-match',
]);

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
  readonly intent: string;
  readonly text: string;
  readonly relevantIds: readonly string[];
}

interface EvaluationCorpus {
  readonly formatVersion: number;
  readonly entries: readonly CorpusEntry[];
  readonly queries: readonly CorpusQuery[];
}

interface SqliteStatement {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): unknown;
}

interface SqliteDatabase extends TransactionDatabase {
  close(): void;
}

interface CorpusSnapshot {
  readonly corpus: EvaluationCorpus;
  readonly hash: string;
}

export interface MemorySemanticQualityReport {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly corpusHash: string;
  readonly queryCount: number;
  readonly relevantQueryCount: number;
  readonly paraphraseQueryCount: number;
  readonly noMatchQueryCount: number;
  readonly baselineRecallAt5: number;
  readonly hybridRecallAt5: number;
  readonly baselineParaphraseRecallAt5: number;
  readonly hybridParaphraseRecallAt5: number;
  readonly baselineNoMatchFalsePositives: number;
  readonly hybridNoMatchFalsePositives: number;
  readonly passed: boolean;
  readonly receiptWritten?: boolean;
}

export interface MemorySemanticQualityEvaluationOptions {
  /** Remote text transfer must be separately opted into by the invoking CLI. */
  readonly remoteEnabled?: boolean;
}

export interface RecordMemorySemanticQualityReceiptOptions extends MemorySemanticQualityEvaluationOptions {
  /** Git revision against which this evaluation was run. */
  readonly evaluatedHead: string;
  readonly createdAt?: string;
}

export class MemorySemanticQualityGateError extends Error {
  constructor(
    readonly code: string,
    readonly semanticReason?: MemorySemanticReason,
  ) {
    super(code);
    this.name = 'MemorySemanticQualityGateError';
  }
}

function corpusCandidates(): string[] {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return [
    // Prefer the repository source fixture in both src and dist so edits to
    // that file invalidate receipts immediately, including before a rebuild.
    resolve(moduleDirectory, '..', '..', 'src', 'services', 'fixtures', 'memory-retrieval-queries.json'),
    // A packaged dist-only deployment may ship the fixture beside compiled JS.
    resolve(moduleDirectory, 'fixtures', 'memory-retrieval-queries.json'),
  ];
}

function readCorpusSnapshot(): CorpusSnapshot {
  const path = corpusCandidates().find(candidate => existsSync(candidate));
  if (path === undefined) throw new MemorySemanticQualityGateError('CORPUS_FIXTURE_MISSING');

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new MemorySemanticQualityGateError('CORPUS_FIXTURE_UNREADABLE');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new MemorySemanticQualityGateError('CORPUS_FIXTURE_INVALID');
  }
  const corpus = validateCorpus(parsed);
  return {
    corpus,
    // Hash the exact bytes so any corpus or evaluation-label edit invalidates
    // the receipt, including edits that preserve the parsed JSON values.
    hash: createHash('sha256').update(bytes).digest('hex'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCorpus(value: unknown): EvaluationCorpus {
  if (!isRecord(value) || value.formatVersion !== 1
    || !Array.isArray(value.entries) || !Array.isArray(value.queries)
    || value.entries.length !== 80 || value.queries.length !== 96) {
    throw new MemorySemanticQualityGateError('CORPUS_FIXTURE_INVALID');
  }

  const entries: CorpusEntry[] = [];
  const entryIds = new Set<string>();
  for (const item of value.entries) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.trim() === ''
      || typeof item.title !== 'string' || typeof item.summary !== 'string'
      || typeof item.content !== 'string' || !Array.isArray(item.tags)
      || !item.tags.every(tag => typeof tag === 'string')
      || (item.pinned !== undefined && typeof item.pinned !== 'boolean')
      || entryIds.has(item.id)) {
      throw new MemorySemanticQualityGateError('CORPUS_FIXTURE_INVALID');
    }
    entryIds.add(item.id);
    entries.push(item as unknown as CorpusEntry);
  }

  const queryIds = new Set<string>();
  const queries: CorpusQuery[] = [];
  for (const item of value.queries) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.trim() === ''
      || typeof item.intent !== 'string' || !INTENTS.has(item.intent)
      || typeof item.text !== 'string' || item.text.trim() === ''
      || !Array.isArray(item.relevantIds)
      || !item.relevantIds.every(id => typeof id === 'string' && entryIds.has(id))
      || (item.intent === 'no-match' ? item.relevantIds.length !== 0 : item.relevantIds.length === 0)
      || queryIds.has(item.id)) {
      throw new MemorySemanticQualityGateError('CORPUS_FIXTURE_INVALID');
    }
    queryIds.add(item.id);
    queries.push(item as unknown as CorpusQuery);
  }

  return { formatVersion: 1, entries, queries };
}

/** Return the current on-disk corpus hash used to key successful receipts. */
export function getMemorySemanticQualityCorpusHash(): string {
  return readCorpusSnapshot().hash;
}

function createFixtureDatabase(): SqliteDatabase {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY)');
  migration017.apply({ db: db as unknown as MinimalDatabaseSync });
  migration048.apply({ db: db as unknown as MinimalDatabaseSync });
  migration049.apply({ db: db as unknown as MinimalDatabaseSync });
  db.prepare('INSERT INTO workspaces (id) VALUES (?)').run(EVALUATION_WORKSPACE_ID);
  return db;
}

function insertCorpusEntry(repository: MemoryEntryRepository, item: CorpusEntry, index: number, createdAt: string): void {
  repository.createEntry({
    id: item.id,
    workspaceId: EVALUATION_WORKSPACE_ID,
    scope: 'workspace',
    category: 'knowledge',
    authority: 'system-verified',
    confidence: 0.9,
    importance: 0.5,
    title: item.title,
    summary: item.summary,
    content: item.content,
    tags: [...item.tags],
    status: 'active',
    pinned: item.pinned === true,
    sources: [{ kind: 'import', id: `memory-semantic-evaluation-${index}` }],
    createdAt,
  });
}

function selectedAfterProductionBudget(results: readonly RetrievedMemoryEntry[]) {
  return applyBudget(results, DEFAULT_MEMORY_BUDGET_POLICY_V1).selected.map(item => item.entry);
}

function recallAt5(ids: readonly string[], relevantIds: readonly string[]): number {
  if (relevantIds.length === 0) return 0;
  const selected = new Set(ids.slice(0, DEFAULT_MEMORY_BUDGET_POLICY_V1.maxEntries));
  return relevantIds.filter(id => selected.has(id)).length / relevantIds.length;
}

/**
 * Evaluate the supplied adapter against actual corpus text and SQLite FTS.
 * All fixture entries, FTS rows, and vector caches live in a separate in-memory
 * database; no production memories or semantic cache rows are read or changed.
 */
export async function evaluateMemorySemanticQuality(
  embedding: MemoryEmbeddingPort,
  options: MemorySemanticQualityEvaluationOptions = {},
): Promise<MemorySemanticQualityReport> {
  const { corpus, hash: corpusHash } = readCorpusSnapshot();
  if (typeof embedding.modelId !== 'string' || embedding.modelId.trim() === ''
    || typeof embedding.modelVersion !== 'string' || embedding.modelVersion.trim() === '') {
    throw new MemorySemanticQualityGateError('MODEL_IDENTITY_INVALID');
  }
  if (embedding.isRemote && options.remoteEnabled !== true) {
    throw new MemorySemanticQualityGateError('REMOTE_OPT_IN_REQUIRED');
  }

  const db = createFixtureDatabase();
  try {
    const transactionDb = db as unknown as TransactionDatabase;
    const repository = new MemoryEntryRepository(transactionDb);
    const now = new Date().toISOString();
    corpus.entries.forEach((entry, index) => insertCorpusEntry(repository, entry, index, now));

    const clock = () => Date.parse(now);
    const baselineRetrieval = new MemoryRetrievalService(repository, clock);
    const semanticRetrieval = new MemorySemanticRetrieval(transactionDb, embedding, {
      clock,
      remoteEnabled: options.remoteEnabled === true,
    });
    const hybridRetrieval = new MemoryRetrievalService(repository, clock, semanticRetrieval);

    let baselineRelevantRecall = 0;
    let hybridRelevantRecall = 0;
    let relevantQueryCount = 0;
    let baselineParaphraseRecall = 0;
    let hybridParaphraseRecall = 0;
    let paraphraseQueryCount = 0;
    let noMatchQueryCount = 0;
    let baselineNoMatchFalsePositives = 0;
    let hybridNoMatchFalsePositives = 0;

    for (const query of corpus.queries) {
      const request = { context: { workspaceId: EVALUATION_WORKSPACE_ID }, query: query.text, selectionPolicy: MEMORY_RELEVANCE_POLICY };
      const baseline = baselineRetrieval.retrieveWithStatus(request);
      if (baseline.degraded) {
        throw new MemorySemanticQualityGateError('SQLITE_BASELINE_DEGRADED');
      }

      const hybrid = await hybridRetrieval.retrievePrepared(request);
      if (hybrid.degraded || hybrid.semantic?.degraded || hybrid.semantic?.prepared !== true) {
        throw new MemorySemanticQualityGateError(
          'SEMANTIC_EVALUATION_DEGRADED',
          hybrid.semantic?.reason,
        );
      }

      const baselineEntries = selectedAfterProductionBudget(baseline.results);
      const hybridEntries = selectedAfterProductionBudget(hybrid.results);
      const baselineSelected = baselineEntries.map(entry => entry.id);
      const hybridSelected = hybridEntries.map(entry => entry.id);
      if (query.intent === 'no-match') {
        noMatchQueryCount += 1;
        // Explicit pinned rules are defaults, recorded separately from query relevance.
        baselineNoMatchFalsePositives += baselineEntries.filter(entry => !entry.pinned).length;
        hybridNoMatchFalsePositives += hybridEntries.filter(entry => !entry.pinned).length;
        continue;
      }

      const baselineRecall = recallAt5(baselineSelected, query.relevantIds);
      const hybridRecall = recallAt5(hybridSelected, query.relevantIds);
      baselineRelevantRecall += baselineRecall;
      hybridRelevantRecall += hybridRecall;
      relevantQueryCount += 1;
      if (query.intent === 'paraphrase-en' || query.intent === 'paraphrase-zh') {
        baselineParaphraseRecall += baselineRecall;
        hybridParaphraseRecall += hybridRecall;
        paraphraseQueryCount += 1;
      }
    }

    if (relevantQueryCount === 0 || paraphraseQueryCount === 0
      || noMatchQueryCount === 0 || corpus.queries.length < MINIMUM_QUERY_COUNT) {
      throw new MemorySemanticQualityGateError('CORPUS_COVERAGE_INVALID');
    }

    const baselineRecallAt5 = baselineRelevantRecall / relevantQueryCount;
    const hybridRecallAt5 = hybridRelevantRecall / relevantQueryCount;
    const baselineParaphraseRecallAt5 = baselineParaphraseRecall / paraphraseQueryCount;
    const hybridParaphraseRecallAt5 = hybridParaphraseRecall / paraphraseQueryCount;
    const passed = corpus.queries.length >= MINIMUM_QUERY_COUNT
      && hybridRecallAt5 >= baselineRecallAt5
      && hybridParaphraseRecallAt5 > baselineParaphraseRecallAt5
      && hybridNoMatchFalsePositives === 0;

    return {
      modelId: embedding.modelId,
      modelVersion: embedding.modelVersion,
      corpusHash,
      queryCount: corpus.queries.length,
      relevantQueryCount,
      paraphraseQueryCount,
      noMatchQueryCount,
      baselineRecallAt5,
      hybridRecallAt5,
      baselineParaphraseRecallAt5,
      hybridParaphraseRecallAt5,
      baselineNoMatchFalsePositives,
      hybridNoMatchFalsePositives,
      passed,
    };
  } finally {
    db.close();
  }
}

/** Persist a receipt atomically only after the real-adapter evaluation passes. */
export async function evaluateAndRecordMemorySemanticQualityReceipt(
  receiptDb: TransactionDatabase,
  embedding: MemoryEmbeddingPort,
  options: RecordMemorySemanticQualityReceiptOptions,
): Promise<MemorySemanticQualityReport> {
  // Test adapters can exercise evaluation but cannot mint durable production
  // receipts. The production CLI constructs this concrete HTTP adapter.
  if (!(embedding instanceof HttpMemoryEmbeddingPort)) {
    throw new MemorySemanticQualityGateError('REAL_EMBEDDING_ADAPTER_REQUIRED');
  }
  if (typeof options.evaluatedHead !== 'string' || options.evaluatedHead.trim() === '') {
    throw new MemorySemanticQualityGateError('SOURCE_REVISION_REQUIRED');
  }
  const report = await evaluateMemorySemanticQuality(embedding, options);
  if (!report.passed) return { ...report, receiptWritten: false };

  const createdAt = options.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new MemorySemanticQualityGateError('RECEIPT_TIMESTAMP_INVALID');
  }
  inTransaction(receiptDb, () => {
    receiptDb.prepare(
      `INSERT INTO memory_semantic_quality_receipts
        (workspace_id, model_id, model_version, corpus_hash, evaluated_head,
         baseline_recall, hybrid_recall, baseline_paraphrase_recall,
         hybrid_paraphrase_recall, no_match_false_positives, query_count, created_at, selection_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, model_id, model_version, corpus_hash) DO UPDATE SET
         evaluated_head = excluded.evaluated_head,
         baseline_recall = excluded.baseline_recall,
         hybrid_recall = excluded.hybrid_recall,
         baseline_paraphrase_recall = excluded.baseline_paraphrase_recall,
         hybrid_paraphrase_recall = excluded.hybrid_paraphrase_recall,
         no_match_false_positives = excluded.no_match_false_positives,
         query_count = excluded.query_count,
         created_at = excluded.created_at,
         selection_policy = excluded.selection_policy`,
    ).run(
      MEMORY_SEMANTIC_QUALITY_WORKSPACE_ID,
      report.modelId,
      report.modelVersion,
      report.corpusHash,
      options.evaluatedHead.trim(),
      report.baselineRecallAt5,
      report.hybridRecallAt5,
      report.baselineParaphraseRecallAt5,
      report.hybridParaphraseRecallAt5,
      report.hybridNoMatchFalsePositives,
      report.queryCount,
      createdAt,
      MEMORY_RELEVANCE_POLICY,
    );
  });
  return { ...report, receiptWritten: true };
}

/** Fail closed if the receipt table, current fixture, model, or pass proof is absent. */
export function requireMemorySemanticQualityReceipt(
  db: TransactionDatabase,
  modelId: string,
  modelVersion: string,
): boolean {
  if (typeof modelId !== 'string' || modelId.trim() === ''
    || typeof modelVersion !== 'string' || modelVersion.trim() === '') return false;

  let corpusHash: string;
  try {
    corpusHash = getMemorySemanticQualityCorpusHash();
  } catch {
    return false;
  }
  try {
    return db.prepare(
      `SELECT 1 AS approved FROM memory_semantic_quality_receipts
       WHERE workspace_id = ? AND model_id = ? AND model_version = ? AND corpus_hash = ?
         AND length(trim(evaluated_head)) > 0 AND length(trim(created_at)) > 0
         AND query_count >= ? AND hybrid_recall >= baseline_recall
         AND hybrid_paraphrase_recall > baseline_paraphrase_recall
         AND no_match_false_positives = 0 AND selection_policy = ?
       LIMIT 1`,
    ).get(
      MEMORY_SEMANTIC_QUALITY_WORKSPACE_ID,
      modelId,
      modelVersion,
      corpusHash,
      MINIMUM_QUERY_COUNT,
      MEMORY_RELEVANCE_POLICY,
    ) !== undefined;
  } catch {
    return false;
  }
}

/** Defense in depth for runtime factories: check the receipt before each embed call. */
export function createQualityGatedEmbeddingPort(
  db: TransactionDatabase,
  embedding: MemoryEmbeddingPort,
): MemoryEmbeddingPort {
  return {
    get modelId() { return embedding.modelId; },
    get modelVersion() { return embedding.modelVersion; },
    get isRemote() { return embedding.isRemote; },
    async embed(texts) {
      if (!requireMemorySemanticQualityReceipt(db, embedding.modelId, embedding.modelVersion)) {
        throw new MemoryEmbeddingError('SEMANTIC_QUALITY_GATE_REQUIRED');
      }
      return embedding.embed(texts);
    },
  };
}
