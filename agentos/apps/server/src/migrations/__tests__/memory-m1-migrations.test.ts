import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration042 } from '../migrations/042-memory-turn-payloads.js';
import { migration043 } from '../migrations/043-memory-execution-contexts.js';
import type { MinimalDatabaseSync } from '../types.js';
import type { TransactionDatabase } from '../../store/Transaction.js';
import { ConversationRepository } from '../../store/ConversationRepository.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

test('M1 upgrades 041 additively, preserves historical headers and never fabricates payloads', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(m => m.id <= '041')) migration.apply({ db });
    db.prepare("INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES ('ws','ws','C:/tmp/m1','C:/tmp/m1','now','now','now')").run();
    new ConversationRepository(db as unknown as TransactionDatabase).createConversation({id:'conv',workspaceId:'ws',kind:'direct',title:'Historical',createdAt:'2026-10-01T00:00:00Z'});
    const before = db.prepare('SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all() as { name:string }[];
    db.prepare(`INSERT INTO cr_turn_context_snapshots (id,workspace_id,conversation_id,agent_id,budget_json,selected_entry_ids_json,total_tokens,truncated,retrieval_strategy_version,created_at)
      VALUES ('historical','ws','conv','agent','{}','["old-entry"]',5,0,'old','2026-10-01T00:00:00Z')`).run();
    const header = db.prepare('SELECT * FROM cr_turn_context_snapshots').get();
    migration042.apply({ db });
    migration043.apply({ db });
    for (const row of before) assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=?').get(row.name),row);
    assert.deepEqual(db.prepare('SELECT * FROM cr_turn_context_snapshots').get(),header);
    assert.deepEqual(db.prepare('SELECT * FROM cr_turn_memory_payloads').all(),[]);
    assert.deepEqual(db.prepare('SELECT * FROM memory_execution_contexts').all(),[]);
    migration042.apply({ db });
    migration043.apply({ db });
    assert.equal((db.prepare('SELECT count(*) AS n FROM cr_turn_context_snapshots').get() as { n:number }).n,1);
  } finally { db.close(); }
});

test('M1 migrations reject incomplete prerequisites without creating partial stores', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => migration042.apply({ db }), /PREREQUISITE_MISSING/);
    assert.throws(() => migration043.apply({ db }), /PREREQUISITE_MISSING/);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='cr_turn_memory_payloads'").get(),undefined);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='memory_execution_contexts'").get(),undefined);
  } finally { db.close(); }
});
