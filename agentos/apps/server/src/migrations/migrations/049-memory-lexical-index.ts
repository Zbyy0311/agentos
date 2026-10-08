import { createHash } from 'node:crypto';
import type { Migration } from '../types.js';

export const MEMORY_049_DDL = [
  `CREATE TABLE IF NOT EXISTS memory_lexical_entries (
    entry_id TEXT PRIMARY KEY REFERENCES memory_entries(id),
    entry_version INTEGER NOT NULL CHECK(entry_version >= 1),
    content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
    tokenizer_version TEXT NOT NULL
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_lexical_fts USING fts5(entry_id UNINDEXED,terms)`,
  `ALTER TABLE memory_semantic_quality_receipts ADD COLUMN selection_policy TEXT`,
] as const;

/** Empty, rebuildable cache. Canonical content and historical snapshots stay untouched. */
export const migration049: Migration = {
  id: '049', name: 'memory-lexical-index', destructive: false,
  checksum: createHash('sha256').update(MEMORY_049_DDL.join('\n')).digest('hex').slice(0,16),
  apply({db}) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_entries'").get()) throw new Error('MIGRATION_PREREQUISITE_MISSING: 049 requires memory_entries');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_semantic_quality_receipts'").get()) throw new Error('MIGRATION_PREREQUISITE_MISSING: 049 requires memory_semantic_quality_receipts');
    for (const ddl of MEMORY_049_DDL.slice(0, 2)) db.prepare(ddl).run();
    const columns = db.prepare('PRAGMA table_info(memory_semantic_quality_receipts)').all() as {name: string}[];
    if (!columns.some(column => column.name === 'selection_policy')) db.prepare(MEMORY_049_DDL[2]).run();
  },
};
