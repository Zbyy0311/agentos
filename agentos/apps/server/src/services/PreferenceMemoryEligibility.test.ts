import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryRetrievalService } from './MemoryRetrievalService.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const NOW = '2026-10-01T00:00:00.000Z';
test('M2 confirmed Entry binding filters scene, duplicates and global overrides before ranking', () => {
  const db = new DatabaseSync(':memory:') as TransactionDatabase & { close(): void };
  try {
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS) migration.apply({ db: db as MinimalDatabaseSync });
    for (const id of ['a','b']) db.prepare(`INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(id,id,`C:/tmp/${id}`,`C:/tmp/${id}`,NOW,NOW,NOW);
    const entries = new MemoryEntryRepository(db);
    const create = (id: string, workspaceId: string, scope: 'workspace' | 'global', scene: string, value: string,
      bind = true, includeContextTag = true) => {
      entries.createEntry({ id,workspaceId,scope,category:'preference',authority:'user-explicit',status:'active',confidence:1,importance:1,
        title:id,content:value,tags:['preference',`dimension:response_detail`,...(includeContextTag ? [`context:${scene}`] : []),`value:${value}`],sources:[],createdAt:NOW });
      if (bind) db.prepare(`INSERT INTO preference_confirmations (id,projection_id,profile_id,projection_scope,projection_workspace_id,workspace_id,
        status,version,preferred_value,dimension,context_kind,scope,confidence,evidence_count,evidence_json,entry_id,entry_workspace_id,entry_version,created_at,updated_at)
        VALUES (?,?,'default','workspace',?,?,'confirmed',1,?,'response_detail',?,?,100,1,'[]',?,?,1,?,?)`)
        .run(`binding-${id}`,id,workspaceId,workspaceId,value,scene,scope,id,workspaceId,NOW,NOW);
    };
    create('global-general','a','global','general','detailed');
    create('global-coding','a','global','coding','verbose');
    create('local-coding','b','workspace','coding','concise');
    create('local-general','b','workspace','general','balanced');
    create('unconfirmed-global','a','global','general','unsafe',false);
    const retrieval = new MemoryRetrievalService(entries, () => Date.parse(NOW));
    const ids = (query: string, includeGlobal = true) => retrieval.retrieve({ context:{workspaceId:'b',includeGlobal},query }).map(row => row.entry.id);
    assert.deepEqual(ids('implement feature'), ['local-coding']);
    entries.updateStatusWithinTransaction({ workspaceId:'b',entryId:'local-coding',expectedVersion:1,status:'archived',updatedAt:NOW });
    assert.deepEqual(ids('implement feature'), ['local-general'], 'workspace general outranks global scene-specific');
    assert.deepEqual(ids('explain the feature'), ['local-general']);
    entries.updateStatusWithinTransaction({ workspaceId:'b',entryId:'local-general',expectedVersion:1,status:'archived',updatedAt:NOW });
    assert.deepEqual(ids('explain feature'), ['global-general']);
    assert.deepEqual(ids('explain feature',false), []);
    db.prepare("UPDATE preference_confirmations SET status='revoked' WHERE entry_id='global-general'").run();
    assert.deepEqual(ids('explain feature'), []);
  } finally { db.close(); }
});

test('unbound manual preferences and preserved terminal-binding Entries obey their current context tags', () => {
  const db = new DatabaseSync(':memory:') as TransactionDatabase & { close(): void };
  try {
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS) migration.apply({ db: db as MinimalDatabaseSync });
    for (const id of ['a','b']) db.prepare(`INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(id,id,`C:/tmp/${id}`,`C:/tmp/${id}`,NOW,NOW,NOW);
    const entries = new MemoryEntryRepository(db);
    const create = (id: string, scene: string, bind: boolean) => {
      entries.createEntry({ id,workspaceId:'b',scope:'workspace',category:'preference',authority:'user-explicit',status:'active',confidence:1,importance:1,
        title:id,content:id,tags:['preference','dimension:response_detail',`context:${scene}`,`value:${id}`],sources:[],createdAt:NOW });
      if (bind) db.prepare(`INSERT INTO preference_confirmations (id,projection_id,profile_id,projection_scope,projection_workspace_id,workspace_id,
        status,version,preferred_value,dimension,context_kind,scope,confidence,evidence_count,evidence_json,entry_id,entry_workspace_id,entry_version,created_at,updated_at)
        VALUES (?,?,'default','workspace',?,'b','confirmed',1,?,'response_detail',?,'workspace',100,1,'[]',?,'b',1,?,?)`)
        .run(`binding-${id}`,id,'b',id,scene,id,NOW,NOW);
    };
    create('manual-coding','coding',false);
    create('manual-debugging','debugging',false);
    entries.createEntry({ id:'manual-untagged',workspaceId:'b',scope:'workspace',category:'preference',authority:'user-explicit',status:'active',confidence:1,importance:1,
      title:'manual-untagged',content:'manual-untagged',tags:['preference','dimension:response_detail','value:manual'],sources:[],createdAt:NOW });

    create('revoked-edited','coding',true);
    entries.updateEntryWithinTransaction({ workspaceId:'b',entryId:'revoked-edited',expectedVersion:1,updatedAt:NOW,
      content:'Updated coding preference',tags:['preference','dimension:response_detail','context:coding','value:updated'] });
    db.prepare("UPDATE preference_confirmations SET status='revoked' WHERE entry_id='revoked-edited'").run();

    create('revoked-stale','coding',true);
    db.prepare("UPDATE preference_confirmations SET status='revoked' WHERE entry_id='revoked-stale'").run();

    create('rejected-edited','debugging',true);
    entries.updateEntryWithinTransaction({ workspaceId:'b',entryId:'rejected-edited',expectedVersion:1,updatedAt:NOW,
      content:'Updated debugging preference',tags:['preference','dimension:response_detail','context:debugging','value:updated'] });
    db.prepare("UPDATE preference_confirmations SET status='rejected' WHERE entry_id='rejected-edited'").run();

    const retrieval = new MemoryRetrievalService(entries, () => Date.parse(NOW));
    const ids = (query: string) => retrieval.retrieve({ context:{workspaceId:'b'},query,categoryFilter:['preference'] }).map(row => row.entry.id);
    const coding = ids('implement feature');
    assert.ok(coding.includes('manual-coding'));
    assert.ok(coding.includes('manual-untagged'), 'manual preference without a context tag remains generally eligible');
    assert.ok(coding.includes('revoked-edited'), 'newer canonical Entry behind a revoked binding is treated as manual');
    assert.ok(!coding.includes('revoked-stale'), 'terminal binding does not detach until the Entry version advances');
    assert.ok(!coding.includes('manual-debugging'));
    assert.ok(!coding.includes('rejected-edited'));
    const debugging = ids('debug this error');
    assert.ok(debugging.includes('manual-debugging'));
    assert.ok(debugging.includes('manual-untagged'));
    assert.ok(debugging.includes('rejected-edited'), 'newer canonical Entry behind a rejected binding is treated as manual');
    assert.ok(!debugging.includes('revoked-edited'));
  } finally { db.close(); }
});
