import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { migration045 } from '../migrations/migrations/045-memory-lifecycle-audit.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryRetrievalService } from './MemoryRetrievalService.js';
import { MemoryLifecycleService } from './MemoryLifecycleService.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as {DatabaseSync:new(path:string)=>TransactionDatabase&{close():void}};
const NOW='2026-10-01T00:00:00Z';
function fixture() {
  const db=new DatabaseSync(':memory:');
  for(const migration of DEFAULT_REGISTRY_MIGRATIONS) migration.apply({db:db as MinimalDatabaseSync});
  migration045.apply({db:db as MinimalDatabaseSync});
  db.prepare("INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES ('ws','ws','C:/tmp/life','C:/tmp/life',?,?,?)").run(NOW,NOW,NOW);
  const entries=new MemoryEntryRepository(db);
  entries.createEntry({id:'entry',workspaceId:'ws',scope:'workspace',category:'knowledge',status:'active',authority:'user-explicit',confidence:1,importance:1,title:'knowledge',content:'Original content',sources:[],createdAt:NOW});
  return {db,entries,service:new MemoryLifecycleService(db,()=>NOW),retrieve:new MemoryRetrievalService(entries,()=>Date.parse(NOW))};
}
test('M2 archive, restore, validity, revalidation and soft deletion change future eligibility while preserving audit versions',()=>{
  const fx=fixture();try {
    const update=(action:'archive'|'restore'|'delete'|'revalidate'|'set-validity',expectedVersion:number,dates={})=>fx.service.apply({workspaceId:'ws',entryId:'entry',action,expectedVersion,...dates});
    assert.equal(update('archive',1).version,2);
    assert.equal(fx.retrieve.retrieve({context:{workspaceId:'ws'}}).length,0);
    assert.equal(update('restore',2).status,'active');
    assert.equal(fx.retrieve.retrieve({context:{workspaceId:'ws'}}).length,1);
    update('set-validity',3,{expiresAt:'2026-09-30T00:00:00Z'});
    assert.equal(fx.retrieve.retrieve({context:{workspaceId:'ws'}}).length,0);
    update('revalidate',4);
    assert.equal(fx.retrieve.retrieve({context:{workspaceId:'ws'}}).length,0,'reverification cannot silently remove expiry');
    update('set-validity',5,{expiresAt:null});
    assert.equal(fx.retrieve.retrieve({context:{workspaceId:'ws'}}).length,1);
    const entry=update('delete',6);assert.equal(entry.status,'deleted');
    assert.equal(fx.entries.findById('ws','entry')?.content,'Original content');
    assert.equal(fx.retrieve.retrieve({context:{workspaceId:'ws'}}).length,0);
    const audit=fx.db.prepare('SELECT from_version,to_version,before_json,after_json FROM memory_lifecycle_actions ORDER BY to_version').all() as {from_version:number;to_version:number;before_json:string;after_json:string}[];
    assert.equal(audit.length,6);assert.equal(JSON.parse(audit[0].before_json).version,1);
    assert.equal(JSON.parse(audit[0].after_json).status,'archived');
    assert.throws(()=>fx.db.exec("DELETE FROM memory_lifecycle_actions"),/IMMUTABLE/);
    assert.throws(()=>update('revalidate',7),/NOT_UPDATABLE/);
    assert.equal(update('restore',7).version,8);
    assert.equal(fx.retrieve.retrieve({context:{workspaceId:'ws'}}).length,1,'soft deletion is recoverable');
  }finally{fx.db.close();}
});
test('M2 lifecycle CAS and foreign workspace reject; audit/event failures roll back the Entry mutation',()=>{
  const fx=fixture();try {
    const input={workspaceId:'ws',entryId:'entry',expectedVersion:1,action:'archive' as const};
    assert.throws(()=>fx.service.apply({...input,workspaceId:'foreign'}),/NOT_FOUND/);
    assert.throws(()=>fx.service.apply({...input,expectedVersion:2}),/VERSION_CONFLICT/);
    assert.throws(()=>fx.service.apply(input,()=>{throw new Error('event failed');}),/event failed/);
    assert.equal(fx.entries.findById('ws','entry')?.version,1);
    assert.equal(fx.db.prepare('SELECT count(*) AS n FROM memory_lifecycle_actions').get() && (fx.db.prepare('SELECT count(*) AS n FROM memory_lifecycle_actions').get() as {n:number}).n,0);
    fx.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON memory_lifecycle_actions BEGIN SELECT RAISE(ABORT,'audit failed');END");
    assert.throws(()=>fx.service.apply(input),/audit failed/);
    assert.equal(fx.entries.findById('ws','entry')?.status,'active');
    assert.throws(()=>fx.service.apply({...input,action:'set-validity',validFrom:'2026-11-01T00:00:00Z',validUntil:NOW}),/INPUT_INVALID/);
  }finally{fx.db.close();}
});
