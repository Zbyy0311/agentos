import assert from 'node:assert/strict';
import test from 'node:test';
import type { MemoryContextRecord, MemoryContextSelection } from './memoryContexts.js';
import type { MemoryEntryDto } from './memoryEntries.js';
import {
  canProvideMemoryVersionFeedback,
  isMemoryAutoAcceptPolicyDto,
  joinMemoryFeedbackActions,
  memoryAutoAcceptPolicyPath,
  memoryAutoAcceptPolicyPayload,
  memoryFeedbackActionResolutionPayload,
  memoryFeedbackActionApplyPayload,
  memoryFeedbackActionResolvePath,
  memoryFeedbackActionsPath,
  memoryFeedbackPath,
  memoryFeedbackResponseIsCurrent,
  submitMemoryVersionFeedback,
  type MemoryFeedbackActionDto,
  type MemoryFeedbackRequester,
  type MemoryVersionFeedbackDto,
} from './memoryFeedback.js';

const context: Pick<MemoryContextRecord, 'id' | 'kind'> = { id: 'run/one', kind: 'run' };
const selection: Pick<MemoryContextSelection, 'memoryId' | 'memoryVersion' | 'store'> = {
  memoryId: 'entry/one', memoryVersion: 4, store: 'canonical',
};
const entry: MemoryEntryDto = {
  id: 'entry/one', workspaceId: 'ws one', scope: 'workspace', ownerAgentId: null,
  ownerConversationId: null, ownerTaskId: null, ownerRunId: null,
  category: 'knowledge', authority: 'system-verified', confidence: 0.9, importance: 0.7,
  title: 'Deployment constraint', summary: 'Use a local database', content: 'Full entry content',
  tags: [], status: 'active', pinned: false, validFrom: null, validUntil: null, expiresAt: null,
  exactContentHash: null, normalizedTextHash: null, tokenEstimate: 8, sensitivity: 'ordinary', version: 11,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', sources: [],
};

const action: MemoryFeedbackActionDto = {
  id: 'action-1', feedbackId: 'feedback-1', workspaceId: 'ws one', memoryId: 'entry/one',
  memoryVersion: 4, action: 'correction', status: 'pending', version: 3,
  createdAt: '2026-10-01T00:00:00.000Z',
};
const feedback: MemoryVersionFeedbackDto = {
  id: 'feedback-1', workspaceId: 'ws one', memoryId: 'entry/one', memoryVersion: 4,
  currentEntryVersion: 11, contextKind: 'run', contextId: 'run/one', contextHash: 'hash-1',
  kind: 'wrong', comment: 'This is no longer accurate', createdAt: action.createdAt, action,
};

test('feedback paths encode workspace, Entry, and action IDs', () => {
  assert.equal(memoryFeedbackPath('ws one'), '/api/workspaces/ws%20one/memory/feedback');
  assert.equal(memoryFeedbackActionsPath('ws one'), '/api/workspaces/ws%20one/memory/feedback-actions');
  assert.equal(memoryFeedbackActionResolvePath('ws one', 'action/1'), '/api/workspaces/ws%20one/memory/feedback-actions/action%2F1/resolve');
  assert.equal(memoryAutoAcceptPolicyPath('ws one'), '/api/workspaces/ws%20one/memory/auto-accept-policy');
});

test('auto-accept policy payloads carry the expected version including the default version zero', () => {
  assert.deepEqual(memoryAutoAcceptPolicyPayload({ enabled: true, version: 0 }, false), { expectedVersion: 0, enabled: false });
  assert.deepEqual(memoryAutoAcceptPolicyPayload({ enabled: false, version: 4 }, true), { expectedVersion: 4, enabled: true });
  assert.equal(isMemoryAutoAcceptPolicyDto({ enabled: true, version: 0 }), true);
  assert.equal(isMemoryAutoAcceptPolicyDto({ enabled: false, version: 2 }), true);
  assert.equal(isMemoryAutoAcceptPolicyDto({ enabled: 1, version: 2 }), false);
  assert.equal(isMemoryAutoAcceptPolicyDto({ enabled: true, version: -1 }), false);
});

test('only versioned canonical frozen selections can receive feedback', () => {
  assert.equal(canProvideMemoryVersionFeedback('run', selection), true);
  assert.equal(canProvideMemoryVersionFeedback('run', { ...selection, store: 'legacy' }), false);
  assert.equal(canProvideMemoryVersionFeedback('run', { ...selection, memoryVersion: null }), false);
  assert.equal(canProvideMemoryVersionFeedback('legacy-execution', { ...selection, store: undefined }), false);
  assert.equal(canProvideMemoryVersionFeedback('legacy-execution', selection), true);
});

test('submission reads the current Entry first and posts its expectedVersion with the frozen selection', async () => {
  const calls: Array<{ path: string; options?: { method?: string; body?: unknown } }> = [];
  const requester: MemoryFeedbackRequester = async <T>(path: string, options?: { method?: 'GET' | 'POST'; body?: unknown }) => {
    calls.push({ path, options });
    return (calls.length === 1 ? { entry } : { feedback }) as T;
  };
  const result = await submitMemoryVersionFeedback(requester, 'ws one', context, selection, 'wrong', '  This changed.  ');

  assert.equal(result, feedback);
  assert.deepEqual(calls.map(call => call.path), [
    '/api/workspaces/ws%20one/memory/entries/entry%2Fone',
    '/api/workspaces/ws%20one/memory/feedback',
  ]);
  assert.deepEqual(calls[1]?.options, {
    method: 'POST',
    body: {
      expectedVersion: 11, memoryId: 'entry/one', memoryVersion: 4,
      contextId: 'run/one', contextKind: 'run', kind: 'wrong', comment: 'This changed.',
    },
  });
});

test('workspace changes after Entry lookup prevent a feedback POST', async () => {
  const paths: string[] = [];
  const requester: MemoryFeedbackRequester = async <T>(path: string) => {
    paths.push(path);
    return { entry } as T;
  };
  const result = await submitMemoryVersionFeedback(requester, 'ws one', context, selection, 'helpful', '', () => false);
  assert.equal(result, undefined);
  assert.deepEqual(paths, ['/api/workspaces/ws%20one/memory/entries/entry%2Fone']);
});

test('feedback rejects an Entry response from a different workspace before POST', async () => {
  let postCount = 0;
  const requester: MemoryFeedbackRequester = async <T>(_path: string, options?: { method?: 'GET' | 'POST' }) => {
    if (options?.method === 'POST') postCount += 1;
    return { entry: { ...entry, workspaceId: 'other-workspace' } } as T;
  };
  await assert.rejects(submitMemoryVersionFeedback(requester, 'ws one', context, selection, 'helpful'), /不匹配/);
  assert.equal(postCount, 0);
});

test('a globally scoped Entry returned by the current workspace read can receive feedback', async () => {
  const calls: Array<{ path: string; options?: { method?: string; body?: unknown } }> = [];
  const globalEntry = { ...entry, workspaceId: 'owner-workspace', scope: 'global' as const };
  const requester: MemoryFeedbackRequester = async <T>(path: string, options?: { method?: 'GET' | 'POST'; body?: unknown }) => {
    calls.push({ path, options });
    return (calls.length === 1 ? { entry: globalEntry } : { feedback }) as T;
  };
  const result = await submitMemoryVersionFeedback(requester, 'ws one', context, selection, 'helpful');
  assert.equal(result, feedback);
  assert.equal(calls.length, 2);
  assert.equal((calls[1]?.options?.body as { expectedVersion: number }).expectedVersion, globalEntry.version);
});

test('an Entry 404 explains that the formal memory is unavailable and preserves global authorization guidance', async () => {
  const requester: MemoryFeedbackRequester = async () => { throw new Error('MEMORY_ENTRY_NOT_FOUND'); };
  await assert.rejects(
    submitMemoryVersionFeedback(requester, 'ws one', context, selection, 'helpful'),
    /当前工作区无法读取或反馈这条正式记忆（404）.*未提交反馈.*全局记忆.*已授权当前工作区读取并反馈/,
  );
});

test('a feedback POST 404 explains that the current workspace cannot yet use the global Entry', async () => {
  let calls = 0;
  const globalEntry = { ...entry, workspaceId: 'owner-workspace', scope: 'global' as const };
  const requester: MemoryFeedbackRequester = async <T>() => {
    calls += 1;
    if (calls === 1) return { entry: globalEntry } as T;
    throw new Error('MEMORY_FEEDBACK_ENTRY_UNAVAILABLE');
  };
  await assert.rejects(
    submitMemoryVersionFeedback(requester, 'ws one', context, selection, 'helpful'),
    /当前工作区无法读取或反馈这条正式记忆（404）.*服务端已授权当前工作区读取并反馈/,
  );
  assert.equal(calls, 2);
});

test('action rejection payload uses the action version as the compare-and-swap version', () => {
  assert.deepEqual(memoryFeedbackActionResolutionPayload(action, 'rejected'), { expectedVersion: 3, status: 'rejected' });
});

test('evidenced action apply payload binds the current action and Entry versions', () => {
  assert.deepEqual(memoryFeedbackActionApplyPayload(action, entry, {
    resolution: 'corrected',
    conclusion: 'The entry was corrected after review.',
    evidence: 'Checked the current operational source.',
    correctedEntry: { title: 'Updated deployment constraint', content: 'Use the local database.' },
  }), {
    expectedActionVersion: 3,
    expectedEntryVersion: 11,
    resolution: 'corrected',
    conclusion: 'The entry was corrected after review.',
    evidence: 'Checked the current operational source.',
    correctedEntry: { title: 'Updated deployment constraint', content: 'Use the local database.' },
  });
});

test('action views join feedback by feedback ID and tolerate missing feedback', () => {
  assert.deepEqual(joinMemoryFeedbackActions([action], [feedback]), [{ action, feedback }]);
  assert.deepEqual(joinMemoryFeedbackActions([action], []), [{ action, feedback: null }]);
});

test('workspace response guard rejects changed workspaces and superseded generations', () => {
  assert.equal(memoryFeedbackResponseIsCurrent('ws one', 'ws one', 5, 5), true);
  assert.equal(memoryFeedbackResponseIsCurrent('ws one', 'ws two', 5, 5), false);
  assert.equal(memoryFeedbackResponseIsCurrent('ws one', 'ws one', 4, 5), false);
});
