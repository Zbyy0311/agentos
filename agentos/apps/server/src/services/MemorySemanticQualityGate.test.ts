import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { TransactionDatabase } from '../store/Transaction.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { migration017 } from '../migrations/migrations/017-mf1-memory-entry-persistence.js';
import { migration048 } from '../migrations/migrations/048-memory-vectors.js';
import { migration049 } from '../migrations/migrations/049-memory-lexical-index.js';
import { MEMORY_RELEVANCE_POLICY } from './MemoryLexicalIndex.js';
import {
  createQualityGatedEmbeddingPort,
  evaluateAndRecordMemorySemanticQualityReceipt,
  evaluateMemorySemanticQuality,
  getMemorySemanticQualityCorpusHash,
  MEMORY_SEMANTIC_QUALITY_WORKSPACE_ID,
  requireMemorySemanticQualityReceipt,
} from './MemorySemanticQualityGate.js';
import type { MemoryEmbeddingPort } from './MemorySemanticRetrieval.js';

interface SqliteStatement {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): unknown;
}

interface SqliteDatabase extends TransactionDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

const corpus = JSON.parse(readFileSync(
  new URL('./fixtures/memory-retrieval-queries.json', import.meta.url), 'utf8',
)) as {
  entries: readonly { id: string; title: string; summary: string; content: string; tags: readonly string[] }[];
  queries: readonly { text: string }[];
};

/** Test-only text hash: vectors come from input characters, never corpus labels. */
class TextHashTestEmbeddingPort implements MemoryEmbeddingPort {
  readonly modelId = 'test-only-text-hash';
  readonly modelVersion = 'test-only-v1';
  readonly isRemote = false;
  readonly inputs: string[] = [];

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    this.inputs.push(...texts);
    return texts.map(text => {
      const vector = Array(128).fill(0) as number[];
      const tokens = text.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [];
      for (const token of tokens) {
        let hash = 0x811c9dc5;
        for (const character of token) {
          hash ^= character.codePointAt(0)!;
          hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        vector[hash % vector.length]! += (hash & 1) === 0 ? 1 : -1;
      }
      if (vector.reduce((sum, value) => sum + Math.abs(value), 0) === 0) vector[0] = 1;
      return vector;
    });
  }
}

function createReceiptDatabase(): SqliteDatabase {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY)');
  migration017.apply({ db: db as unknown as MinimalDatabaseSync });
  migration048.apply({ db: db as unknown as MinimalDatabaseSync });
  migration049.apply({ db: db as unknown as MinimalDatabaseSync });
  db.prepare('INSERT INTO workspaces (id) VALUES (?)').run('test-semantic-quality');
  return db;
}

// Test-only row in an isolated in-memory database; it never passes through the
// production writer or represents an evaluated model receipt.
function insertTestReceipt(db: SqliteDatabase, corpusHash: string): void {
  db.prepare(
    `INSERT INTO memory_semantic_quality_receipts
      (workspace_id, model_id, model_version, corpus_hash, evaluated_head,
       baseline_recall, hybrid_recall, baseline_paraphrase_recall,
       hybrid_paraphrase_recall, no_match_false_positives, query_count, created_at,selection_policy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    MEMORY_SEMANTIC_QUALITY_WORKSPACE_ID,
    'test-only-gated-model',
    'test-only-version',
    corpusHash,
    'test-only-source-revision',
    0.2,
    0.2,
    0.1,
    0.2,
    0,
    96,
    new Date().toISOString(),
    MEMORY_RELEVANCE_POLICY,
  );
}

test('evaluates corpus text through a test-only port and uses production SQLite and budget paths', async () => {
  const db = createReceiptDatabase();
  const embedding = new TextHashTestEmbeddingPort();
  try {
    const report = await evaluateMemorySemanticQuality(embedding);

    assert.equal(report.queryCount, 96);
    assert.equal(report.noMatchQueryCount, 16);
    assert.equal(report.relevantQueryCount, 80);
    assert.equal(report.paraphraseQueryCount, 32);
    await assert.rejects(
      evaluateAndRecordMemorySemanticQualityReceipt(
        db as unknown as TransactionDatabase,
        embedding,
        { evaluatedHead: 'test-only-source-revision' },
      ),
      /REAL_EMBEDDING_ADAPTER_REQUIRED/u,
    );

    const embeddedInputs = new Set(embedding.inputs);
    for (const entry of corpus.entries) {
      assert.ok(embeddedInputs.has([entry.title, entry.summary, entry.content, ...entry.tags].join('\n')),
        `entry text was not sent to the test adapter: ${entry.id}`);
    }
    for (const query of corpus.queries) {
      assert.ok(embeddedInputs.has(query.text.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')),
        'query text was not sent to the test adapter');
    }

    const receiptCount = (db.prepare(
      'SELECT COUNT(*) AS count FROM memory_semantic_quality_receipts',
    ).get() as { count: number }).count;
    assert.equal(receiptCount, 0, 'a synthetic test port must never write a durable receipt');
    assert.equal(
      requireMemorySemanticQualityReceipt(db as unknown as TransactionDatabase, embedding.modelId, embedding.modelVersion),
      false,
    );
  } finally {
    db.close();
  }
});

test('receipt lookup binds the current corpus and exact model identity before any embedding call', async () => {
  const db = createReceiptDatabase();
  const delegate = new TextHashTestEmbeddingPort();
  try {
    insertTestReceipt(db, getMemorySemanticQualityCorpusHash());
    assert.equal(requireMemorySemanticQualityReceipt(
      db as unknown as TransactionDatabase,
      'test-only-gated-model',
      'test-only-version',
    ), true);
    db.prepare('UPDATE memory_semantic_quality_receipts SET selection_policy = NULL').run();
    assert.equal(requireMemorySemanticQualityReceipt(db, 'test-only-gated-model','test-only-version'),false,'old receipts cannot approve a new selection policy');
    db.prepare('UPDATE memory_semantic_quality_receipts SET selection_policy = ?, no_match_false_positives = 1').run(MEMORY_RELEVANCE_POLICY);
    assert.equal(requireMemorySemanticQualityReceipt(db, 'test-only-gated-model','test-only-version'),false,'unrelated injection fails the gate');
    db.prepare('UPDATE memory_semantic_quality_receipts SET no_match_false_positives = 0').run();
    assert.equal(requireMemorySemanticQualityReceipt(
      db as unknown as TransactionDatabase,
      'test-only-gated-model',
      'different-version',
    ), false);

    const gated = createQualityGatedEmbeddingPort(db as unknown as TransactionDatabase, {
      get modelId() { return 'test-only-gated-model'; },
      get modelVersion() { return 'test-only-version'; },
      isRemote: false,
      embed: texts => delegate.embed(texts),
    });
    await gated.embed(['a test query']);
    assert.equal(delegate.inputs.length, 1);

    db.prepare(
      `UPDATE memory_semantic_quality_receipts SET corpus_hash = ?
       WHERE workspace_id = ? AND model_id = ? AND model_version = ?`,
    ).run('0'.repeat(64), MEMORY_SEMANTIC_QUALITY_WORKSPACE_ID, 'test-only-gated-model', 'test-only-version');
    assert.equal(requireMemorySemanticQualityReceipt(
      db as unknown as TransactionDatabase,
      'test-only-gated-model',
      'test-only-version',
    ), false);
    await assert.rejects(gated.embed(['must not be sent']), /SEMANTIC_QUALITY_GATE_REQUIRED/u);
    assert.equal(delegate.inputs.length, 1);
  } finally {
    db.close();
  }
});
