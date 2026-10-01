import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { MemoryExecutionContextRepository } from './MemoryExecutionContextRepository.js';
import type { TransactionDatabase } from './Transaction.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS) migration.apply({db});
  db.prepare("INSERT INTO conversations(id,workspace_id,conversation_type,title,created_at,updated_at) VALUES('c','w','direct','chat','now','now')").run();
  db.prepare("INSERT INTO messages(id,conversation_id,workspace_id,sender_type,content,created_at) VALUES('m','c','w','user','goal','now')").run();
  db.prepare("INSERT INTO agent_runs(id,conversation_id,workspace_id,source_message_id,objective,status,created_at,updated_at) VALUES('r','c','w','m','goal','running','now','now')").run();
  db.prepare("INSERT INTO executions(id,run_id,conversation_id,workspace_id,source_message_id,agent_id,status,mode,created_at,updated_at) VALUES('e','r','c','w','m','a','queued','mock','now','now')").run();
  const repo = new MemoryExecutionContextRepository(db as TransactionDatabase);
  const input = { workspaceId:'w',runId:'r',executionId:'e',conversationId:'c',agentId:'a',
    contextText:'### First\nfrozen contents',queryHash:createHash('sha256').update('goal').digest('hex'),
    selected:[{memoryId:'entry',memoryVersion:1,store:'canonical' as const,rank:1,reasons:['fts-match'],tokenCost:8}],
    exclusions:[],retrievalDegraded:false,truncated:false,createdAt:'now' };
  return {db,repo,input};
}

test('execution context freezes once, isolates workspace/owner and survives later selection changes',()=>{
  const fx=fixture();
  try {
    const frozen=fx.repo.freeze(fx.input);
    assert.equal(fx.repo.freeze({...fx.input,contextText:'different now'}).contextText,frozen.contextText);
    assert.equal(fx.repo.findForExecution('foreign','e'),undefined);
    assert.throws(()=>fx.repo.freeze({...fx.input,runId:'another'}),/OWNER_INVALID/);
    assert.throws(()=>fx.db.exec("UPDATE memory_execution_contexts SET context_text='new'"),/IMMUTABLE/);
    assert.throws(()=>fx.db.exec('DELETE FROM memory_execution_contexts'),/IMMUTABLE/);
    assert.equal(fx.repo.findForExecution('w','e')?.selected[0].memoryVersion,1);
    fx.db.exec("DELETE FROM executions WHERE id='e'");
    assert.equal(fx.repo.findForExecution('w','e'),undefined,'explicit owning execution deletion cascades');
  } finally {fx.db.close();}
});

test('unsafe payload or aborted parent transaction leaves no partial execution context',()=>{
  const fx=fixture();
  try {
    assert.throws(()=>fx.repo.freeze({...fx.input,contextText:'Authorization: Bearer secret'}),/INPUT_INVALID/);
    assert.equal(fx.repo.findForExecution('w','e'),undefined);
    fx.db.exec('BEGIN');
    assert.throws(()=>fx.repo.freeze(fx.input),/transaction/i);
    fx.db.exec('ROLLBACK');
    assert.equal(fx.repo.findForExecution('w','e'),undefined);
  } finally {fx.db.close();}
});
