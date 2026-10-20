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
  const root = mkdtempSync(join(tmpdir(), 'agentos-cr-msgedit-'));
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

interface MessageDto {
  id: string;
  conversationId: string;
  sequence: number;
  status: string;
  content: string;
  version: number;
}

interface RevisionDto {
  id: string;
  messageId: string;
  revision: number;
  content: string;
  editedAt: string;
}

type BaseUrl = (workspaceId: string) => string;

async function withServer(run: (baseUrl: BaseUrl, store: SqliteStore) => Promise<void>): Promise<void> {
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

async function patchJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function deleteJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function seedConversation(baseUrl: BaseUrl, workspaceId: string): Promise<string> {
  const created = await postJson(`${baseUrl(workspaceId)}/conversations`, { kind: 'direct', agentId: 'codex' });
  assert.equal(created.status, 201);
  return (created.json as { conversation: { id: string } }).conversation.id;
}

async function send(baseUrl: BaseUrl, workspaceId: string, conversationId: string, content: string): Promise<MessageDto> {
  const sent = await postJson(`${baseUrl(workspaceId)}/conversations/${conversationId}/messages`, { content });
  assert.equal(sent.status, 201);
  return (sent.json as { message: MessageDto }).message;
}

test('edit: revision retained, search follows new content, idempotent retry', async () => {
  await withServer(async (baseUrl) => {
    const conversationId = await seedConversation(baseUrl, 'workspace-a');
    const original = await send(baseUrl, 'workspace-a', conversationId, 'alpha original wording');
    const base = baseUrl('workspace-a');

    const edited = await patchJson(`${base}/messages/${original.id}`, { content: 'alpha revised wording', expectedVersion: original.version });
    assert.equal(edited.status, 200);
    const editedMessage = (edited.json as { message: MessageDto }).message;
    assert.equal(editedMessage.content, 'alpha revised wording');
    assert.equal(editedMessage.status, 'edited');
    assert.equal(editedMessage.version, original.version + 1);
    assert.equal(editedMessage.sequence, original.sequence);

    // Revisions endpoint exposes the append-only history.
    const revisions = await fetch(`${base}/messages/${original.id}/revisions`).then(r => r.json()) as { revisions: RevisionDto[] };
    assert.equal(revisions.revisions.length, 1);
    assert.equal(revisions.revisions[0]!.revision, 1);
    assert.equal(revisions.revisions[0]!.content, 'alpha revised wording');
    assert.equal(revisions.revisions[0]!.messageId, original.id);

    // Search observes the edited content through messages_fts (063 triggers).
    const hits = await fetch(`${base}/conversations/search?query=revised`).then(r => r.json()) as { results: Array<{ messageId: string }> };
    assert.deepEqual(hits.results.map(result => result.messageId), [original.id]);
    const stale = await fetch(`${base}/conversations/search?query=original`).then(r => r.json()) as { results: unknown[] };
    assert.equal(stale.results.length, 0);

    // Idempotent retry of the identical edit converges without a new revision.
    const retry = await patchJson(`${base}/messages/${original.id}`, { content: 'alpha revised wording', expectedVersion: editedMessage.version });
    assert.equal(retry.status, 200);
    assert.equal((retry.json as { message: MessageDto }).message.version, editedMessage.version);
    const revisionsAfter = await fetch(`${base}/messages/${original.id}/revisions`).then(r => r.json()) as { revisions: RevisionDto[] };
    assert.equal(revisionsAfter.revisions.length, 1);
  });
});

test('edit: stale version conflicts 409, invalid body 400, missing message 404', async () => {
  await withServer(async (baseUrl) => {
    const conversationId = await seedConversation(baseUrl, 'workspace-a');
    const message = await send(baseUrl, 'workspace-a', conversationId, 'hello conflict');
    const base = baseUrl('workspace-a');

    const stale = await patchJson(`${base}/messages/${message.id}`, { content: 'newer', expectedVersion: message.version + 5 });
    assert.equal(stale.status, 409);
    assert.equal((stale.json as { code: string }).code, 'MESSAGE_VERSION_CONFLICT');

    const noContent = await patchJson(`${base}/messages/${message.id}`, { expectedVersion: message.version });
    assert.equal(noContent.status, 400);
    const noVersion = await patchJson(`${base}/messages/${message.id}`, { content: 'x' });
    assert.equal(noVersion.status, 400);
    const blankContent = await patchJson(`${base}/messages/${message.id}`, { content: '   ', expectedVersion: message.version });
    assert.equal(blankContent.status, 400);

    const missing = await patchJson(`${base}/messages/msg_missing`, { content: 'x', expectedVersion: 1 });
    assert.equal(missing.status, 404);
    assert.equal((missing.json as { code: string }).code, 'MESSAGE_NOT_FOUND');
  });
});

test('delete: soft delete keeps row, hides from list/search, converges on retry', async () => {
  await withServer(async (baseUrl) => {
    const conversationId = await seedConversation(baseUrl, 'workspace-a');
    const kept = await send(baseUrl, 'workspace-a', conversationId, 'alpha keep me');
    const doomed = await send(baseUrl, 'workspace-a', conversationId, 'alpha remove me');
    const base = baseUrl('workspace-a');

    const before = await fetch(`${base}/conversations/search?query=alpha`).then(r => r.json()) as { results: Array<{ messageId: string }> };
    assert.equal(before.results.length, 2);

    const stale = await deleteJson(`${base}/messages/${doomed.id}`, { expectedVersion: doomed.version + 3 });
    assert.equal(stale.status, 409);
    assert.equal((stale.json as { code: string }).code, 'MESSAGE_VERSION_CONFLICT');

    const deleted = await deleteJson(`${base}/messages/${doomed.id}`, { expectedVersion: doomed.version });
    assert.equal(deleted.status, 200);
    const deletedMessage = (deleted.json as { message: MessageDto }).message;
    assert.equal(deletedMessage.status, 'deleted');
    assert.equal(deletedMessage.version, doomed.version + 1);
    assert.equal(deletedMessage.content, 'alpha remove me');

    // Idempotent retry with the bumped version is not an error.
    const retry = await deleteJson(`${base}/messages/${doomed.id}`, { expectedVersion: deletedMessage.version });
    assert.equal(retry.status, 200);
    assert.equal((retry.json as { message: MessageDto }).message.version, deletedMessage.version);

    // FTS/search stays consistent: the deleted Message drops out, edit untouched.
    const after = await fetch(`${base}/conversations/search?query=alpha`).then(r => r.json()) as { results: Array<{ messageId: string }> };
    assert.deepEqual(after.results.map(result => result.messageId), [kept.id]);

    // The row itself is still retrievable and stays out of subsequent edits.
    const editDeleted = await patchJson(`${base}/messages/${doomed.id}`, { content: 'resurrect', expectedVersion: deletedMessage.version });
    assert.equal(editDeleted.status, 409);
    assert.equal((editDeleted.json as { code: string }).code, 'MESSAGE_DELETED');
  });
});

test('workspace isolation: other workspace cannot edit/delete/read revisions', async () => {
  await withServer(async (baseUrl) => {
    const conversationId = await seedConversation(baseUrl, 'workspace-a');
    const message = await send(baseUrl, 'workspace-a', conversationId, 'private to workspace a');
    const foreignBase = baseUrl('workspace-b');

    const edited = await patchJson(`${foreignBase}/messages/${message.id}`, { content: 'tampered', expectedVersion: message.version });
    assert.equal(edited.status, 404);
    assert.equal((edited.json as { code: string }).code, 'MESSAGE_NOT_FOUND');

    const deleted = await deleteJson(`${foreignBase}/messages/${message.id}`, { expectedVersion: message.version });
    assert.equal(deleted.status, 404);

    const revisions = await fetch(`${foreignBase}/messages/${message.id}/revisions`);
    assert.equal(revisions.status, 404);
    assert.equal((await revisions.json() as { code: string }).code, 'MESSAGE_NOT_FOUND');

    // The home workspace still sees the untouched Message.
    const base = baseUrl('workspace-a');
    const home = await fetch(`${base}/conversations/search?query=private`).then(r => r.json()) as { results: Array<{ messageId: string }> };
    assert.deepEqual(home.results.map(result => result.messageId), [message.id]);
  });
});
