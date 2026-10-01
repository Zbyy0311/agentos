import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationDraftController } from './conversationDraftController.ts';
import { ConversationDraftRepository } from './conversationDraftRepository.ts';
import { captureDraftSubmission, createConversationDraftIdentityKey, createEmptyConversationDraft, enqueueDraftSubmission, type ConversationDraftIdentity } from './conversationDraftState.ts';
import { completeDirectConversationSubmission } from './conversationDraftLifecycle.ts';

function memoryRepository(options: { readonly failTextWrite?: boolean } = {}) {
  const text = new Map<string, string>();
  const blobs = new Map<string, Blob>();
  return new ConversationDraftRepository({
    getItem: key => text.get(key) ?? null,
    setItem: (key, value) => {
      if (options.failTextWrite) throw new Error('storage denied');
      text.set(key, value);
    },
    removeItem: key => { text.delete(key); },
  }, {
    get: async key => blobs.get(key),
    put: async (key, blob) => { blobs.set(key, blob); },
    delete: async key => { blobs.delete(key); },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const pendingA: ConversationDraftIdentity = { workspaceId: 'workspace-1', storageSource: 'workspace', pendingAgentId: 'agent-a' };
const directA: ConversationDraftIdentity = { workspaceId: 'workspace-1', storageSource: 'workspace', conversationId: 'conversation-a' };
const directB: ConversationDraftIdentity = { workspaceId: 'workspace-1', storageSource: 'workspace', conversationId: 'conversation-b' };

test('late direct completion migrates and settles A after selection moved to B without selecting A', async () => {
  const controller = new ConversationDraftController(memoryRepository());
  await controller.load(pendingA);
  const ownerKey = createConversationDraftIdentityKey(pendingA);
  const submittedBlob = new Blob(['submitted-image']);
  const submittedAttachment = { id: 'submitted-image', name: 'submitted.png', mimeType: 'image/png', size: submittedBlob.size, blob: submittedBlob, previewUrl: URL.createObjectURL(submittedBlob) };
  controller.updateDraft(ownerKey, draft => ({
    ...draft,
    text: 'message submitted to A',
    textRevision: draft.textRevision + 1,
    mentionedAgentIds: ['agent-a'],
    mentionsRevision: draft.mentionsRevision + 1,
    attachments: [submittedAttachment],
  }));
  await controller.flushPersistence();
  const originalDraft = controller.getSnapshot(ownerKey)?.draft ?? createEmptyConversationDraft();
  const submitted = captureDraftSubmission(ownerKey, originalDraft);
  const networkResponse = deferred<void>();
  let selectedIdentityKey = ownerKey;
  let selectionCalls = 0;
  const completion = networkResponse.promise.then(() => completeDirectConversationSubmission({
    sourceIdentity: pendingA,
    submitted,
    createdConversationIdentity: directA,
    migrateTo: (target, source) => controller.migrateTo(source, target),
    settleSubmission: (identity, snapshot, outcome) => controller.settleSubmission(identity, snapshot, outcome),
    isCurrentScope: () => selectedIdentityKey === ownerKey,
    onCurrentScopeSettled: () => { selectionCalls += 1; selectedIdentityKey = createConversationDraftIdentityKey(directA); },
  }));

  const unsentBlob = new Blob(['new-image']);
  const unsentAttachment = { id: 'new-image', name: 'new.png', mimeType: 'image/png', size: unsentBlob.size, blob: unsentBlob, previewUrl: URL.createObjectURL(unsentBlob) };
  controller.updateDraft(ownerKey, draft => ({
    ...draft,
    text: 'new A text while request is pending',
    textRevision: draft.textRevision + 1,
    attachments: [...draft.attachments, unsentAttachment],
  }));
  await controller.load(directB);
  selectedIdentityKey = createConversationDraftIdentityKey(directB);
  const bBeforeCompletion = controller.getSnapshot(selectedIdentityKey)?.draft;
  networkResponse.resolve(undefined);
  const result = await completion;
  await controller.flushPersistence();

  assert.equal(result.currentScope, false);
  assert.equal(result.settledIdentityKey, createConversationDraftIdentityKey(directA));
  assert.equal(selectionCalls, 0);
  assert.equal(selectedIdentityKey, createConversationDraftIdentityKey(directB));
  const aAfterCompletion = controller.getSnapshot(ownerKey)?.draft;
  assert.equal(aAfterCompletion?.text, 'new A text while request is pending');
  assert.deepEqual(aAfterCompletion?.mentionedAgentIds, []);
  assert.deepEqual(aAfterCompletion?.attachments.map(item => item.id), ['new-image']);
  assert.deepEqual(controller.getSnapshot(selectedIdentityKey)?.draft, bBeforeCompletion);
});

test('failed browser persistence keeps the draft in memory and exposes refresh-loss warning', async () => {
  const controller = new ConversationDraftController(memoryRepository({ failTextWrite: true }));
  await controller.load(directA);
  const key = createConversationDraftIdentityKey(directA);
  controller.updateDraft(key, draft => ({ ...draft, text: 'keep in memory' }));
  await controller.flushPersistence();

  const snapshot = controller.getSnapshot(key);
  assert.equal(snapshot?.draft.text, 'keep in memory');
  assert.match(snapshot?.warning ?? '', /刷新可能丢失/);
});

test('pending private migration retargets queued ownership and persists it for refresh', async () => {
  const repository = memoryRepository();
  const controller = new ConversationDraftController(repository);
  await controller.load(pendingA);
  const pendingKey = createConversationDraftIdentityKey(pendingA);
  const targetKey = createConversationDraftIdentityKey(directA);
  controller.updateDraft(pendingKey, draft => enqueueDraftSubmission(pendingKey, { ...draft, text: 'next A message' }, 'queue-a'));
  await controller.migrateTo(pendingA, directA);
  await controller.flushPersistence();
  const restored = await repository.load(directA);
  assert.equal(restored.draft.queue[0]?.identityKey, targetKey);
  assert.equal(restored.draft.queue[0]?.id, 'queue-a');
  assert.equal(restored.draft.queue[0]?.content, 'next A message');
});
