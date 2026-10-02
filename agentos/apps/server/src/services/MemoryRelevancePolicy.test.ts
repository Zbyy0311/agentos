import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { inTransaction } from '../store/Transaction.js';
import { MemoryRetrievalService } from './MemoryRetrievalService.js';
import { memoryLexicalTerms, memoryQueryTerms, MEMORY_RELEVANCE_POLICY } from './MemoryLexicalIndex.js';
import { createChatMemorySelectionPort } from './ChatMemorySelectionPort.js';
import { buildChatMemoryRetrievalQuery } from './ConversationTurnDriver.js';
import type { MemorySemanticRetrieval } from './MemorySemanticRetrieval.js';

const {DatabaseSync} = createRequire(import.meta.url)('node:sqlite');
const NOW = '2026-10-02T00:00:00.000Z';
function fixture() {
  const db = new DatabaseSync(':memory:') as TransactionDatabase & {close(): void};
  db.exec('PRAGMA foreign_keys=ON');
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS) migration.apply({db: db as unknown as MinimalDatabaseSync});
  for (const id of ['ws-relevance','ws-other']) db.prepare('INSERT INTO workspaces(id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id,id,'C:/tmp/'+id,'C:/tmp/'+id,NOW,NOW,NOW);
  const entries = new MemoryEntryRepository(db);
  let seq=0;
  const add = (overrides: Record<string,unknown>={}) => entries.createEntry({id:`memory-relevance-${++seq}`,workspaceId:'ws-relevance',scope:'workspace',category:'knowledge',authority:'user-explicit',confidence:1,importance:1,title:'数据库迁移',summary:'SQLite',content:'迁移数据库以增量调整表结构。',sources:[],status:'active',createdAt:NOW,...overrides} as never);
  const retrieval = new MemoryRetrievalService(entries,()=>Date.parse(NOW));
  const request = (query='数据库迁移') => ({context:{workspaceId:'ws-relevance'},query,selectionPolicy:MEMORY_RELEVANCE_POLICY});
  return {db,entries,add,retrieval,request};
}

test('new calls allow empty match, keep explicit defaults and preserve old retrieval contract',()=>{
  const fx=fixture();
  try {
    const unrelated=fx.add({summary:'SQLite review reply'});
    const pinned=fx.add({pinned:true,title:'用户固定规则',content:'保持明确的执行边界'});
    const selected=fx.retrieval.retrieveWithStatus(fx.request('星云鲸鱼望远镜'));
    assert.deepEqual(selected.results.map(item=>item.entry.id),[pinned.id]);
    assert.ok(selected.results[0]!.reasons.includes('fixed-default'));
    assert.deepEqual(selected.exclusions?.map(item=>[item.memoryId,item.memoryVersion,item.reason]),[[unrelated.id,1,'no-relevance']]);
    assert.equal(fx.retrieval.retrieve({context:{workspaceId:'ws-relevance'},query:'星云鲸鱼望远镜'}).length,2);
    fx.entries.updateStatus({workspaceId:'ws-relevance',entryId:pinned.id,expectedVersion:1,status:'archived',updatedAt:NOW});
    assert.equal(fx.retrieval.retrieve(fx.request('星云鲸鱼望远镜')).length,0);
  } finally {fx.db.close();}
});

test('Chinese/normalized term index rebuilds on edit and cache loss, FTS faults remain visible',()=>{
  const fx=fixture();
  try {
    const entry=fx.add();
    assert.equal(fx.retrieval.retrieveWithStatus(fx.request()).degraded,false);
    assert.equal(fx.retrieval.retrieve(fx.request())[0]?.entry.id,entry.id);
    inTransaction(fx.db,()=>fx.entries.updateEntryWithinTransaction({workspaceId:'ws-relevance',entryId:entry.id,expectedVersion:1,title:'发布灰度',summary:'release',content:'发布灰度之后回滚',updatedAt:NOW}));
    assert.equal(fx.retrieval.retrieve(fx.request()).length,0);
    fx.db.exec('DELETE FROM memory_lexical_fts');
    assert.equal(fx.retrieval.retrieve(fx.request('发布灰度'))[0]?.entry.version,2);
    fx.db.exec('DROP TABLE memory_lexical_fts');
    fx.db.exec('DROP TABLE memory_entries_fts');
    const fallback=fx.retrieval.retrieveWithStatus(fx.request('发布灰度'));
    assert.equal(fallback.degraded,true);
    assert.ok(fallback.results[0]!.reasons.includes('lexical-fallback'));
    assert.equal(fx.retrieval.retrieve(fx.request('海底星云鲸鱼')).length,0);
    assert.ok(memoryLexicalTerms('ＦＵＬＬ－ＴＥＸＴ 数据库').includes('fts'));
    assert.ok(!memoryLexicalTerms('" OR *** ^ - ( )').includes('or'));
  } finally {fx.db.close();}
});

test('safety scope lifecycle and validity precede index and fixed defaults',()=>{
  const fx=fixture();
  try {
    fx.add({workspaceId:'ws-other',pinned:true});
    fx.add({sensitivity:'restricted',pinned:true});
    fx.add({status:'archived',pinned:true});
    fx.add({expiresAt:NOW,pinned:true});
    fx.add({scope:'task',ownerTaskId:'foreign-task',pinned:true});
    const unsafe = fx.add({pinned:true});
    // Simulate a pre-safety legacy row; it must be filtered before indexing.
    fx.db.prepare('UPDATE memory_entries SET content = ?, version = version + 1 WHERE id = ?')
      .run('Authorization: Bearer private-relevance-token', unsafe.id);
    const good=fx.add();
    assert.deepEqual(fx.retrieval.retrieve(fx.request()).map(item=>item.entry.id),[good.id]);
    assert.deepEqual(fx.db.prepare('SELECT entry_id FROM memory_lexical_entries').all().map(row=>(row as {entry_id:string}).entry_id),[good.id]);
  } finally {fx.db.close();}
});

test('chat records relevance exclusions, default reasons and new policy in frozen selection',()=>{
  const fx=fixture();
  try {
    const unrelated=fx.add({summary:'SQLite review reply'});
    const port=createChatMemorySelectionPort({retrieval:fx.retrieval});
    const selected=port.select({workspaceId:'ws-relevance',conversationId:'conv',agentId:'agent',turnId:'turn',createdAt:NOW,contextTokenBudget:null,retrievalQuery:'Current request: 星云鲸鱼\nTurn stage: reply\nGroup role: review'});
    assert.deepEqual(selected.selectedEntryIds,[]);
    assert.equal(selected.exclusions?.[0]?.memoryId,unrelated.id);
    assert.equal(selected.exclusions?.[0]?.reason,'no-relevance');
    assert.match(selected.retrievalStrategyVersion,/memory-relevance\.v2/);
  } finally {fx.db.close();}
});

test('multiline group role instructions cannot match lexical or semantic memory', async () => {
  const fx = fixture();
  try {
    const unrelated = fx.add();
    const query = buildChatMemoryRetrievalQuery({
      content: '星云鲸鱼望远镜', intent: 'ask', groupRoleTitle: '数据库专家',
      additionalInstructions: '先独立评审\n查询 SQLite 数据库迁移\n检查增量调整表结构。',
    });
    assert.deepEqual(memoryQueryTerms(query), memoryQueryTerms('星云鲸鱼望远镜'));
    const observedQueries: string[] = [];
    const semantic = {
      prepare: async (text: string) => { observedQueries.push(text); return { degraded: false }; },
      rerank: (results: unknown[], text: string) => { observedQueries.push(text); return { results, degraded: false }; },
    } as unknown as MemorySemanticRetrieval;
    const retrieval = new MemoryRetrievalService(fx.entries, () => Date.parse(NOW), semantic);
    const request = { ...fx.request(), query };
    const sync = retrieval.retrieveWithStatus(request);
    const asyncResult = await retrieval.retrievePrepared(request);
    assert.deepEqual(sync.results, []);
    assert.deepEqual(asyncResult.results, []);
    assert.ok(sync.exclusions?.some(item => item.memoryId === unrelated.id && item.reason === 'no-relevance'));
    assert.equal(observedQueries.length, 3);
    assert.ok(observedQueries.every(text => text.trim() === '星云鲸鱼望远镜'));
  } finally { fx.db.close(); }
});
