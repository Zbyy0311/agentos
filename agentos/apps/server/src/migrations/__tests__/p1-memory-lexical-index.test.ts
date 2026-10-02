import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { MinimalDatabaseSync } from '../types.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration049 } from '../migrations/049-memory-lexical-index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

test('049 preserves canonical rows and pre-policy receipts and can rebuild its derived tables', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  try {
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(item => item.id <= '048')) {
      migration.apply({db: db as MinimalDatabaseSync});
    }
    db.prepare(`INSERT INTO memory_semantic_quality_receipts
      (workspace_id,model_id,model_version,corpus_hash,evaluated_head,baseline_recall,
       hybrid_recall,baseline_paraphrase_recall,hybrid_paraphrase_recall,
       no_match_false_positives,query_count,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('*','old-model','v1','a'.repeat(64),'old-commit',0.2,0.3,0.1,0.2,64,96,'2026-10-01T00:00:00Z');
    const before = db.prepare('SELECT * FROM memory_semantic_quality_receipts').get();
    migration049.apply({db: db as MinimalDatabaseSync});
    const after = db.prepare('SELECT * FROM memory_semantic_quality_receipts').get();
    assert.deepEqual({...after,selection_policy:undefined}, {...before,selection_policy:undefined});
    assert.equal(after.selection_policy,null,'old receipt must not silently approve the new selection policy');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_lexical_entries').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_context_snapshots').get().n,0);
    db.exec('DROP TABLE memory_lexical_fts');
    migration049.apply({db: db as MinimalDatabaseSync});
    migration049.apply({db: db as MinimalDatabaseSync});
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_lexical_fts'").get());
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {db.close();}
});
