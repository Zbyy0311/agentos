import { createHash } from 'node:crypto';
import type { Migration, MinimalDatabaseSync } from '../types.js';

/** Local, derived vectors only. Memory text and workspace metadata are not copied here. */
export const MEMORY_048_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS memory_semantic_entry_vectors (
    entry_id TEXT NOT NULL,
    entry_version INTEGER NOT NULL CHECK (entry_version >= 1),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    embedding_model_id TEXT NOT NULL CHECK (length(embedding_model_id) > 0),
    embedding_model_version TEXT NOT NULL CHECK (length(embedding_model_version) > 0),
    dimensions INTEGER NOT NULL CHECK (dimensions > 0 AND dimensions <= 8192),
    vector_json TEXT NOT NULL CHECK (json_valid(vector_json)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (entry_id, entry_version, content_hash, embedding_model_id, embedding_model_version)
  )`,
  `CREATE INDEX IF NOT EXISTS memory_semantic_entry_vectors_entry
    ON memory_semantic_entry_vectors(entry_id, embedding_model_id, embedding_model_version)`,
  `CREATE TABLE IF NOT EXISTS memory_semantic_query_vectors (
    workspace_id TEXT NOT NULL DEFAULT '',
    query_hash TEXT NOT NULL CHECK (length(query_hash) = 64),
    embedding_model_id TEXT NOT NULL CHECK (length(embedding_model_id) > 0),
    embedding_model_version TEXT NOT NULL CHECK (length(embedding_model_version) > 0),
    dimensions INTEGER NOT NULL CHECK (dimensions > 0 AND dimensions <= 8192),
    vector_json TEXT NOT NULL CHECK (json_valid(vector_json)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, query_hash, embedding_model_id, embedding_model_version)
  )`,
  `CREATE TABLE IF NOT EXISTS memory_semantic_quality_receipts (
    workspace_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_version TEXT NOT NULL,
    corpus_hash TEXT NOT NULL CHECK (length(corpus_hash) = 64),
    evaluated_head TEXT NOT NULL,
    baseline_recall REAL NOT NULL CHECK (baseline_recall BETWEEN 0 AND 1),
    hybrid_recall REAL NOT NULL CHECK (hybrid_recall BETWEEN 0 AND 1 AND hybrid_recall >= baseline_recall),
    baseline_paraphrase_recall REAL NOT NULL CHECK (baseline_paraphrase_recall BETWEEN 0 AND 1),
    hybrid_paraphrase_recall REAL NOT NULL CHECK (hybrid_paraphrase_recall BETWEEN 0 AND 1 AND hybrid_paraphrase_recall > baseline_paraphrase_recall),
    no_match_false_positives INTEGER NOT NULL CHECK (no_match_false_positives >= 0),
    query_count INTEGER NOT NULL CHECK (query_count >= 80),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, model_id, model_version, corpus_hash)
  )`,
] as const);

function assertPrerequisites(db: MinimalDatabaseSync): void {
  const memoryEntries = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'",
  ).get();
  if (memoryEntries === undefined) {
    throw new Error('MIGRATION_PREREQUISITE_MISSING: 048 requires memory_entries');
  }
}

export const migration048: Migration = {
  id: '048',
  name: 'memory-semantic-vectors',
  checksum: createHash('sha256').update(MEMORY_048_DDL.join('\n')).digest('hex').slice(0, 16),
  destructive: false,
  apply({ db }) {
    assertPrerequisites(db);
    for (const ddl of MEMORY_048_DDL) db.prepare(ddl).run();
  },
};
