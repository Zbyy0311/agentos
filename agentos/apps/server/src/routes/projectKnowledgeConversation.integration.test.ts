import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { EventBus } from '../events/EventBus.js';
import { createConversationRoutes } from './conversations.js';
import { createMemoryRuntimeRoutes } from './memoryRuntime.js';
import type { ModelDiscoveryService } from '../services/CliModelDiscovery.js';
import type { MemoryEntryRecord } from '../store/MemoryEntryRepository.js';

test('project knowledge HTTP saves reach the default single-agent SSE path and the real child prompt; edits and archive update future invocations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-default-memory-chain-'));
  const capture = join(root, 'captured-prompts.jsonl');
  // A real local child process, not a vendor/model call: the normal workspace
  // SSE route passes its assembled prompt directly to a native executable.
  const script = join(root, 'capture.cjs');
  writeFileSync(script, `const fs=require('node:fs');const prompt=process.argv.slice(2).join('\\n');fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(prompt)+'\\n');console.log('default prompt captured');`);
  mkdirSync(join(root, 'workspace'));
  const timestamp = '2026-10-01T00:00:00.000Z';
  writeFileSync(join(root, 'workspace/workspaces.json'), JSON.stringify({ workspaces: [{
    id: 'default-memory-workspace', name: 'Default memory chain', rootPath: root,
    gitEnabled: false, memoryEnabled: true, createdAt: timestamp, updatedAt: timestamp, lastOpenedAt: timestamp,
    agents: [{ id: 'codex', name: 'Capture', role: 'codex', provider: 'codex', enabled: true,
      cliCommand: process.execPath, cliArgs: [script] }],
  }] }));
  const oldMock = process.env.AGENTOS_FORCE_MOCK;
  process.env.AGENTOS_FORCE_MOCK = 'false';
  const store = new SqliteStore(root);
  store.updateAgentProfile('default-memory-workspace', 'codex', {
    roleTitle: 'Capture', systemPrompt: 'Capture the supplied context.', permissions: ['read', 'write'], enabled: true,
  });
  const manager = new WorkspaceManager(store);
  const bus = new EventBus();
  bus.subscribe(event => store.appendAgentEvent(event));
  const discovery: ModelDiscoveryService = { async discover() {
    return { cliKind: 'codex', models: [], source: 'live', stale: false, discoveredAt: timestamp };
  } };
  const app = express();
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId', createMemoryRuntimeRoutes(store, manager));
  app.use('/api/workspaces/:workspaceId', createConversationRoutes(store, manager, discovery, bus));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/default-memory-workspace`;
    async function write(path: string, body: unknown, method = 'POST') {
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    }
    const { conversation } = await write('/conversations', { agentId: 'codex' }) as { conversation: { id: string } };
    const { entry } = await write('/memory/entries', { scope: 'workspace', category: 'constraint',
      title: 'Default deployment constraint', content: 'default-canonical-marker explicit deployment validation', confidence: 0.9, importance: 0.9 }) as { entry: MemoryEntryRecord };
    async function send() {
      const response = await fetch(`${base}/conversations/${conversation.id}/messages/stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Check deployment constraints', intent: 'execute' }),
      });
      assert.equal(response.status, 200);
      const stream = await response.text();
      assert.ok(stream.includes('default prompt captured'), stream);
      const prompts = readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string);
      const run = store.listRuns('default-memory-workspace', conversation.id)[0];
      assert.equal(run.status, 'completed');
      assert.equal(store.listRunCliInvocations('default-memory-workspace', run.id).length, 1);
      assert.deepEqual(store.listMemoryUsage('default-memory-workspace', run.id), [], 'canonical IDs are never written into legacy MemoryUsage FKs');
      return { prompt: prompts.at(-1)!, events: store.listAgentEvents('default-memory-workspace', run.id) };
    }
    const first = await send();
    assert.ok(first.prompt.includes('default-canonical-marker'), first.prompt);
    assert.ok(first.events.some(event => event.type === 'memory.used' && event.payload.memoryEntryId === entry.id && event.payload.version === 1));
    await write('/memory/entries/' + entry.id, { expectedVersion: 1, content: 'default-edited-marker explicit deployment validation' }, 'PATCH');
    const second = await send();
    assert.ok(second.prompt.includes('default-edited-marker'));
    assert.ok(!second.prompt.includes('default-canonical-marker'));
    assert.ok(second.events.some(event => event.type === 'memory.used' && event.payload.memoryEntryId === entry.id && event.payload.version === 2));
    await write('/memory/entries/' + entry.id + '/archive', { expectedVersion: 2 });
    const third = await send();
    // Prior turns remain in ordinary history; the project-memory section of a
    // new invocation must no longer contain the archived Entry.
    assert.ok(!third.events.some(event => event.type === 'memory.used' && event.payload.memoryEntryId === entry.id));
    assert.ok(!third.prompt.includes('### Default deployment constraint'));
    assert.equal((store.getDatabase().prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n, 0);
    await write('/memory/entries', { scope: 'workspace', category: 'constraint', title: 'Degraded retrieval',
      content: 'degraded-canonical-marker deployment validation', confidence: 0.9, importance: 0.9 });
    store.getDatabase().exec('DROP TABLE memory_entries_fts');
    const degraded = await send();
    assert.ok(degraded.prompt.includes('degraded-canonical-marker'), 'eligible structured retrieval remains usable');
    assert.ok(degraded.events.some(event => event.type === 'execution.diagnostic'
      && event.payload.code === 'memory.retrieval_degraded' && event.payload.level === 'warning'), 'FTS degradation is observable in the default run event stream');
    const contextsResponse = await fetch(base + '/memory/contexts?kind=legacy-execution');
    assert.equal(contextsResponse.status, 200);
    const { contexts } = await contextsResponse.json() as { contexts: Array<{
      id: string; ownerId: string; contextText: string; selected: { memoryId: string; memoryVersion: number }[];
      retrievalDegraded: boolean; kind: string;
    }> };
    assert.equal(contexts.length, 4);
    assert.ok(contexts.some(context => context.contextText.includes('default-canonical-marker')
      && context.selected.some(selection => selection.memoryId === entry.id && selection.memoryVersion === 1)),
    'historical payload still freezes the first version after edit/archive');
    assert.ok(contexts.some(context => context.retrievalDegraded));
    const exact = await (await fetch(base + '/memory/contexts?kind=legacy-execution&ownerId=' + contexts[0].ownerId)).json() as { contexts: unknown[] };
    assert.equal(exact.contexts.length, 1);
    assert.equal((await fetch(base + '/memory/contexts?kind=invalid')).status, 400);
    const promptsBefore = readFileSync(capture, 'utf8');
    store.getDatabase().exec(`CREATE TRIGGER reject_execution_memory BEFORE INSERT ON memory_execution_contexts
      BEGIN SELECT RAISE(ABORT,'forced memory freeze failure'); END`);
    const blocked = await fetch(`${base}/conversations/${conversation.id}/messages/stream`, {
      method: 'POST',headers: {'Content-Type':'application/json'},body:JSON.stringify({content:'Check deployment constraints',intent:'execute'}),
    });
    await blocked.text();
    assert.equal(readFileSync(capture, 'utf8'), promptsBefore, 'snapshot failure never calls the child Provider');
    assert.equal(store.listRuns('default-memory-workspace',conversation.id)[0].status,'failed');
    assert.equal((store.getDatabase().prepare('SELECT COUNT(*) AS n FROM memory_execution_contexts').get() as {n:number}).n, 4);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    if (oldMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = oldMock;
    rmSync(root, { recursive: true, force: true });
  }
});
