import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureDraftSubmission,
  createConversationDraftIdentityKey,
  enqueueDraftSubmission,
  createEmptyConversationDraft,
  isCurrentConversationGeneration,
  serializeConversationDraft,
  settleDraftSubmission,
  type ConversationDraftIdentity,
} from './conversationDraftState.ts';
import { ConversationDraftRepository } from './conversationDraftRepository.ts';

const identity = (storageSource: 'workspace' | 'runtime', conversationId: string): ConversationDraftIdentity => ({
  workspaceId: 'workspace-1', storageSource, conversationId,
});

test('draft identity includes workspace, verified storage source, and conversation', () => {
  assert.notEqual(createConversationDraftIdentityKey(identity('workspace', 'same-id')), createConversationDraftIdentityKey(identity('runtime', 'same-id')));
  assert.notEqual(createConversationDraftIdentityKey(identity('workspace', 'conversation-a')), createConversationDraftIdentityKey(identity('workspace', 'conversation-b')));
});

test('late completion is fenced by identity and selection generation', () => {
  assert.equal(isCurrentConversationGeneration('conversation-b', 8, 'conversation-a', 7), false);
  assert.equal(isCurrentConversationGeneration('conversation-a', 8, 'conversation-a', 7), false);
  assert.equal(isCurrentConversationGeneration('conversation-a', 7, 'conversation-a', 7), true);
});

test('send settlement clears only the submitted text revision and attachment ids', () => {
  const scope = createConversationDraftIdentityKey(identity('workspace', 'conversation-a'));
  const submitted = {
    ...createEmptyConversationDraft(),
    revision: 4,
    text: 'submitted text',
    attachments: [
      { id: 'submitted-image', name: 'a.png', mimeType: 'image/png', size: 1, dataUrl: 'data:image/png;base64,AA==', previewUrl: 'blob:a' },
    ],
  };
  const snapshot = captureDraftSubmission(scope, submitted);
  const editedDuringSend = {
    ...submitted,
    revision: 5,
    textRevision: 5,
    text: 'new text while sending',
    attachments: [...submitted.attachments, { id: 'new-image', name: 'b.png', mimeType: 'image/png', size: 1, dataUrl: 'data:image/png;base64,AQ==', previewUrl: 'blob:b' }],
  };
  const settled = settleDraftSubmission(scope, editedDuringSend, snapshot, 'committed');
  assert.equal(settled.text, 'new text while sending');
  assert.deepEqual(settled.attachments.map(item => item.id), ['new-image']);

  const unchanged = settleDraftSubmission(scope, submitted, snapshot, 'committed');
  assert.equal(unchanged.text, '');
  assert.deepEqual(unchanged.attachments, []);
  assert.equal(settleDraftSubmission(scope, submitted, snapshot, 'ambiguous').text, 'submitted text');
  assert.equal(settleDraftSubmission('another-scope', submitted, snapshot, 'committed').text, 'submitted text');
});

test('queue item freezes mentions, mode and attachment ids under its conversation identity', () => {
  const identityKey = 'group-key';
  const attachment = { id: 'image-1', name: 'plan.png', mimeType: 'image/png', size: 3, previewUrl: 'blob:1', blob: new Blob(['img']) };
  const current = {
    ...createEmptyConversationDraft(),
    text: 'queue me',
    textRevision: 4,
    mentionedAgentIds: ['agent-a'],
    mentionsRevision: 2,
    runIntent: 'review' as const,
    attachments: [attachment],
  };
  const queued = enqueueDraftSubmission(identityKey, current, 'queue-1');
  assert.equal(queued.text, '');
  assert.deepEqual(queued.attachments, []);
  assert.equal(queued.queue[0]?.identityKey, identityKey);
  assert.equal(queued.queue[0]?.content, 'queue me');
  assert.deepEqual(queued.queue[0]?.mentionedAgentIds, ['agent-a']);
  assert.equal(queued.queue[0]?.runIntent, 'review');
  assert.deepEqual(queued.queue[0]?.attachments.map(item => item.id), ['image-1']);
});

test('persisted draft JSON never contains image data URLs, Blob objects, or preview URLs', () => {
  const draft = {
    ...createEmptyConversationDraft(),
    text: 'draft',
    attachments: [{ id: 'image-1', name: 'secret.png', mimeType: 'image/png', size: 4, dataUrl: 'data:image/png;base64,SECRETDATA', previewUrl: 'blob:secret', blob: new Blob(['secret']) }],
  };
  const serialized = serializeConversationDraft(draft);
  assert.equal(serialized.includes('SECRETDATA'), false);
  assert.equal(serialized.includes('blob:secret'), false);
  assert.equal(serialized.includes('secret.png'), true);
});

test('IndexedDB write failure keeps text and missing-image references so refresh cannot silently reduce the submission', async () => {
  const values = new Map<string, string>();
  const repository = new ConversationDraftRepository({
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => { values.delete(key); },
  }, {
    get: async () => undefined,
    put: async () => { throw new Error('quota denied'); },
    delete: async () => undefined,
  });
  const scope = identity('workspace', 'conversation-a');
  const key = createConversationDraftIdentityKey(scope);
  const result = await repository.save(scope, {
    ...createEmptyConversationDraft(),
    text: 'keep this text',
    attachments: [{ id: 'image-1', name: 'screen.png', mimeType: 'image/png', size: 3, blob: new Blob(['img']), previewUrl: 'blob:image' }],
  });
  assert.match(result.warning ?? '', /刷新可能丢失/);
  const loaded = await repository.load(scope);
  assert.equal(loaded.draft.text, 'keep this text');
  assert.deepEqual(loaded.draft.attachments.map(item => item.id), ['image-1']);
  assert.equal(loaded.draft.attachments[0]?.blob, undefined);
  assert.match(loaded.warning ?? '', /不可用/);
  assert.match(values.get(`agentos:conversation-draft:v1:${encodeURIComponent(key)}`) ?? '', /keep this text/);
  assert.equal((values.get(`agentos:conversation-draft:v1:${encodeURIComponent(key)}`) ?? '').includes('screen.png'), true);
});

test('successful send can settle its original persisted identity without clearing newer edits', async () => {
  const values = new Map<string, string>();
  const blobs = new Map<string, Blob>();
  const repository = new ConversationDraftRepository({
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => { values.delete(key); },
  }, {
    get: async key => blobs.get(key),
    put: async (key, value) => { blobs.set(key, value); },
    delete: async key => { blobs.delete(key); },
  });
  const scope = identity('runtime', 'group-a');
  const identityKey = createConversationDraftIdentityKey(scope);
  const attachment = (id: string) => ({ id, name: `${id}.png`, mimeType: 'image/png', size: 1, previewUrl: `blob:${id}`, blob: new Blob([id]) });
  const original = { ...createEmptyConversationDraft(), text: 'sent', textRevision: 1, attachments: [attachment('sent-image')] };
  await repository.save(scope, original);
  const submitted = captureDraftSubmission(identityKey, original);
  await repository.save(scope, { ...original, text: 'new draft', textRevision: 2, attachments: [attachment('sent-image'), attachment('new-image')] });
  await repository.settleSubmission(scope, submitted, 'committed');
  const loaded = await repository.load(scope);
  assert.equal(loaded.draft.text, 'new draft');
  assert.deepEqual(loaded.draft.attachments.map(item => item.id), ['new-image']);
  assert.equal(blobs.has(`${identityKey}:sent-image`), false);
});
