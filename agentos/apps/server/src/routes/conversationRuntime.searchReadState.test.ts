import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createConversationRuntimeRoutes } from './conversationRuntime.js';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-cr-search-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [
      {
        id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
        agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
        lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
      },
      {
        id: 'workspace-b', name: 'Workspace B', rootPath: join(root, 'ws-b-root'), gitEnabled: true, memoryEnabled: false,
        agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
        lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
      },
    ],
  }), 'utf-8');
  return root;
}

async function withServer(run: (baseUrl: (workspaceId: string) => string, store: SqliteStore) => Promise<void>): Promise<void> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  try {
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId/runtime', createConversationRuntimeRoutes(store, new WorkspaceManager(store)));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    await run(workspaceId => `http://127.0.0.1:${address.port}/api/workspaces/${workspaceId}/runtime`, store);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close?.();
    rmSync(root, { recursive: true, force: true });
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

interface SearchResult {
  messageId: string;
  conversationId: string;
  sequence: number;
  senderType: string;
  senderDisplayName: string;
  snippet: string;
  matchedTerms: string[];
  createdAt: string;
}

type BaseUrl = (workspaceId: string) => string;

async function seedConversation(baseUrl: BaseUrl, workspaceId: string): Promise<string> {
  const created = await postJson(`${baseUrl(workspaceId)}/conversations`, { kind: 'direct', agentId: 'codex' });
  assert.equal(created.status, 201);
  return (created.json as { conversation: { id: string } }).conversation.id;
}

async function send(baseUrl: BaseUrl, workspaceId: string, conversationId: string, content: string): Promise<void> {
  const sent = await postJson(`${baseUrl(workspaceId)}/conversations/${conversationId}/messages`, { content });
  assert.equal(sent.status, 201);
}

test('message search: multi-filter, snippet, limit cap, and workspace isolation', async () => {
  await withServer(async (baseUrl) => {
    const a = await seedConversation(baseUrl, 'workspace-a');
    const other = await seedConversation(baseUrl, 'workspace-a');
    await send(baseUrl, 'workspace-a', a, 'alpha deployment runbook for the release train');
    await send(baseUrl, 'workspace-a', a, 'alpha rollback notes');
    await send(baseUrl, 'workspace-a', other, 'alpha unrelated discussion');
    const b = await seedConversation(baseUrl, 'workspace-b');
    await send(baseUrl, 'workspace-b', b, 'alpha secret workspace text');

    const base = baseUrl('workspace-a');
    // Global search across the workspace.
    const global = await fetch(`${base}/conversations/search?query=alpha`).then(r => r.json()) as { results: SearchResult[] };
    assert.equal(global.results.length, 3);

    // Conversation-scoped search.
    const scoped = await fetch(`${base}/conversations/${a}/search?query=alpha`).then(r => r.json()) as { results: SearchResult[] };
    assert.equal(scoped.results.length, 2);
    assert.ok(scoped.results.every(result => result.conversationId === a));
    assert.ok(scoped.results[0]!.snippet.includes('<mark>'));
    assert.deepEqual(scoped.results[0]!.matchedTerms, ['alpha']);

    // Sender filter.
    const agentOnly = await fetch(`${base}/conversations/search?query=alpha&sender=agent`).then(r => r.json()) as { results: SearchResult[] };
    assert.equal(agentOnly.results.length, 0);

    // Limit cap: ask for 500, get at most 3.
    const limited = await fetch(`${base}/conversations/search?query=alpha&limit=500`).then(r => r.json()) as { results: SearchResult[] };
    assert.equal(limited.results.length, 3);

    // No results / missing query / invalid limit.
    const empty = await fetch(`${base}/conversations/search?query=zzz-not-present`).then(r => r.json()) as { results: SearchResult[] };
    assert.equal(empty.results.length, 0);
    const missingQuery = await fetch(`${base}/conversations/search`);
    assert.equal(missingQuery.status, 400);
    const badLimit = await fetch(`${base}/conversations/search?query=alpha&limit=0`);
    assert.equal(badLimit.status, 400);
    const badSender = await fetch(`${base}/conversations/search?query=alpha&sender=nobody`);
    assert.equal(badSender.status, 400);

    // Workspace B cannot see Workspace A's messages and vice versa.
    const inB = await fetch(`${baseUrl('workspace-b')}/conversations/search?query=alpha`).then(r => r.json()) as { results: SearchResult[] };
    assert.equal(inB.results.length, 1);
    assert.equal(inB.results[0]!.conversationId, b);
  });
});

test('read state: advance, monotone no-regression, unread and mention counts, batch endpoint', async () => {
  await withServer(async (baseUrl) => {
    const a = await seedConversation(baseUrl, 'workspace-a');
    await send(baseUrl, 'workspace-a', a, 'first message');
    await send(baseUrl, 'workspace-a', a, 'second @codex please review');
    await send(baseUrl, 'workspace-a', a, 'third @codex ping');

    const base = baseUrl('workspace-a');

    // Fresh user: everything is unread; mentions counted from message text.
    const fresh = await fetch(`${base}/conversations/${a}/read-state?userId=u1`).then(r => r.json()) as {
      readState: { unreadCount: number; mentionCount: number; approvalCount: number; lastReadMessageSequence: number };
    };
    assert.equal(fresh.readState.unreadCount, 3);
    assert.equal(fresh.readState.mentionCount, 2);
    assert.equal(fresh.readState.approvalCount, 0);
    assert.equal(fresh.readState.lastReadMessageSequence, 0);

    // Advance to sequence 1.
    const mark1 = await postJson(`${base}/conversations/${a}/read`, { userId: 'u1', lastReadMessageSequence: 1 });
    assert.equal(mark1.status, 200);
    assert.equal((mark1.json as { readState: { unreadCount: number } }).readState.unreadCount, 2);

    // Monotone: a lower sequence does not regress the stored position.
    const regress = await postJson(`${base}/conversations/${a}/read`, { userId: 'u1', lastReadMessageSequence: 0 });
    assert.equal((regress.json as { readState: { lastReadMessageSequence: number; unreadCount: number } }).readState.lastReadMessageSequence, 1);
    assert.equal((regress.json as { readState: { unreadCount: number } }).readState.unreadCount, 2);

    // A client cannot advance past the server's current sequence and hide future messages.
    const future = await postJson(`${base}/conversations/${a}/read`, { userId: 'u1', lastReadMessageSequence: 99 });
    assert.equal(future.status, 400);
    const unchanged = await fetch(`${base}/conversations/${a}/read-state?userId=u1`).then(r => r.json()) as {
      readState: { lastReadMessageSequence: number; unreadCount: number };
    };
    assert.equal(unchanged.readState.lastReadMessageSequence, 1);
    assert.equal(unchanged.readState.unreadCount, 2);

    // Latest converges on the max sequence.
    const latest = await postJson(`${base}/conversations/${a}/read`, { userId: 'u1', latest: true });
    assert.equal((latest.json as { readState: { unreadCount: number; lastReadMessageSequence: number } }).readState.unreadCount, 0);
    assert.equal((latest.json as { readState: { lastReadMessageSequence: number } }).readState.lastReadMessageSequence, 3);

    // New message bumps unread again.
    await send(baseUrl, 'workspace-a', a, 'fourth');
    const afterNew = await fetch(`${base}/conversations/${a}/read-state?userId=u1`).then(r => r.json()) as {
      readState: { unreadCount: number };
    };
    assert.equal(afterNew.readState.unreadCount, 1);

    // Per-user isolation: u2 still sees everything unread.
    const u2 = await fetch(`${base}/conversations/${a}/read-state?userId=u2`).then(r => r.json()) as {
      readState: { unreadCount: number };
    };
    assert.equal(u2.readState.unreadCount, 4);

    // Batch endpoint covers every conversation of the workspace for the user.
    const batch = await fetch(`${base}/conversations/read-state?userId=u1`).then(r => r.json()) as {
      readStates: Array<{ conversationId: string; unreadCount: number }>;
    };
    const row = batch.readStates.find(state => state.conversationId === a);
    assert.ok(row);
    assert.equal(row!.unreadCount, 1);

    // Unknown conversation: 404 on read-state, 404 on mark-read.
    const missing = await fetch(`${base}/conversations/nope/read-state`);
    assert.equal(missing.status, 404);
    const markMissing = await postJson(`${base}/conversations/nope/read`, { latest: true });
    assert.equal(markMissing.status, 404);

    // Invalid body: neither latest nor a sequence.
    const invalid = await postJson(`${base}/conversations/${a}/read`, {});
    assert.equal(invalid.status, 400);
  });
});
