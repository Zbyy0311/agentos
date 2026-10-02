import assert from 'node:assert/strict';
import test from 'node:test';
import {
  confirmedMemoryEntryLifecyclePayload,
  isMemoryVersionConflict,
  memoryDateTimeLocalValue,
  memoryDateTimeToIso,
  memoryEntryLifecyclePath,
  memoryEntryLifecyclePayload,
  memoryEntryWorkspacePromotionPath,
  memoryEntryWorkspacePromotionPayload,
  memoryCandidateReviewPath,
  memoryCandidatesPath,
  memoryConflictsPath,
  memoryConflictResolutionPath,
  memoryConflictResolutionPayload,
  memoryVersionConflictGuidance,
  preferenceEvidencePath,
  preferenceSuggestionActionPath,
  preferenceSuggestionActionPayload,
  preferenceSuggestionsPath,
  workspaceResponseIsCurrent,
} from './memoryManagement.js';

test('lifecycle requests carry the current entry version and only date edits carry validity fields', () => {
  assert.equal(memoryEntryLifecyclePath('workspace/a', 'entry 1'), '/api/workspaces/workspace%2Fa/memory/entries/entry%201/lifecycle');
  assert.deepEqual(memoryEntryLifecyclePayload({ version: 7 }, 'archive'), { expectedVersion: 7, action: 'archive' });
  assert.deepEqual(memoryEntryLifecyclePayload({ version: 11 }, 'revalidate'), { expectedVersion: 11, action: 'revalidate' });
  assert.equal(confirmedMemoryEntryLifecyclePayload({ version: 7 }, 'delete', false), undefined);
  assert.deepEqual(confirmedMemoryEntryLifecyclePayload({ version: 7 }, 'delete', true), { expectedVersion: 7, action: 'delete' });
  assert.deepEqual(memoryEntryLifecyclePayload({ version: 7 }, 'set-validity', {
    validFrom: null, expiresAt: '2027-01-01T00:00:00.000Z',
  }), { expectedVersion: 7, action: 'set-validity', validFrom: null, expiresAt: '2027-01-01T00:00:00.000Z' });
  assert.throws(() => memoryEntryLifecyclePayload({ version: 7 }, 'set-validity'), /至少指定/);
  assert.throws(() => memoryEntryLifecyclePayload({ version: 7 }, 'restore', { expiresAt: null }), /只有设置有效期/);
});

test('workspace promotion uses a workspace-scoped path and current Entry version', () => {
  assert.equal(memoryEntryWorkspacePromotionPath('workspace/a', 'entry 1'),
    '/api/workspaces/workspace%2Fa/memory/entries/entry%201/promote-to-workspace-knowledge');
  assert.deepEqual(memoryEntryWorkspacePromotionPayload({ version: 7 }), { expectedVersion: 7 });
});

test('preference suggestion paths and actions use projection identity, workspace and expected version', () => {
  assert.equal(memoryCandidatesPath('workspace/a'), '/api/workspaces/workspace%2Fa/memory/candidates?outcome=review-required');
  assert.equal(memoryCandidateReviewPath('workspace/a', 'candidate/1'), '/api/workspaces/workspace%2Fa/memory/candidates/candidate%2F1/review');
  assert.equal(preferenceSuggestionsPath('workspace/a b'), '/api/preferences/suggestions?workspaceId=workspace%2Fa+b');
  assert.equal(preferenceEvidencePath('workspace/a', 'projection/1'), '/api/workspaces/workspace%2Fa/preferences/evidence?projectionId=projection%2F1');
  assert.equal(preferenceSuggestionActionPath('projection/1', 'confirm'), '/api/preferences/projection%2F1/confirm');
  const suggestion = { version: 4 };
  assert.deepEqual(preferenceSuggestionActionPayload(suggestion, 'workspace-a', 'reject'), {
    workspaceId: 'workspace-a', expectedVersion: 4,
  });
  assert.deepEqual(preferenceSuggestionActionPayload(suggestion, 'workspace-a', 'confirm', true), {
    workspaceId: 'workspace-a', expectedVersion: 4, confirmGlobal: true,
  });
  assert.deepEqual(preferenceSuggestionActionPayload(suggestion, 'workspace-a', 'confirm', false), {
    workspaceId: 'workspace-a', expectedVersion: 4,
  });
});

test('conflict requests use workspace paths and resolution carries the fetched conflict version', () => {
  assert.equal(memoryConflictsPath('workspace/a'), '/api/workspaces/workspace%2Fa/memory/conflicts?status=open');
  assert.equal(memoryConflictsPath('workspace/a', 'resolved'), '/api/workspaces/workspace%2Fa/memory/conflicts?status=resolved');
  assert.equal(memoryConflictResolutionPath('workspace/a', 'conflict/1'), '/api/workspaces/workspace%2Fa/memory-conflicts/conflict%2F1/resolve');
  assert.deepEqual(memoryConflictResolutionPayload({ version: 6 }, 'supersede-earlier'), {
    expectedVersion: 6,
    disposition: 'supersede-earlier',
  });
  assert.deepEqual(memoryConflictResolutionPayload({ version: 2 }, 'keep-both'), {
    expectedVersion: 2,
    disposition: 'keep-both',
  });
});

test('workspace responses are ignored after workspace or request generation changes', () => {
  assert.equal(workspaceResponseIsCurrent('workspace-a', 'workspace-a', 3, 3), true);
  assert.equal(workspaceResponseIsCurrent('workspace-a', 'workspace-b', 3, 3), false);
  assert.equal(workspaceResponseIsCurrent('workspace-a', 'workspace-a', 2, 3), false);
});

test('validity date helpers map local date-time controls to ISO values and preserve clears', () => {
  assert.equal(memoryDateTimeLocalValue(null), '');
  assert.equal(memoryDateTimeToIso(''), null);
  assert.equal(memoryDateTimeToIso('not-a-date'), undefined);
  const iso = memoryDateTimeToIso('2026-10-01T12:30');
  assert.equal(iso, new Date('2026-10-01T12:30').toISOString());
  assert.equal(memoryDateTimeLocalValue(iso ?? null), '2026-10-01T12:30');
});

test('version conflicts offer reload guidance for version and HTTP 409 errors', () => {
  assert.equal(isMemoryVersionConflict(new Error('MEMORY_ENTRY_VERSION_CONFLICT')), true);
  assert.equal(isMemoryVersionConflict(new Error('MEMORY_CANDIDATE_CANDIDATE_NOT_REVIEWABLE')), true);
  assert.equal(isMemoryVersionConflict(new Error('MEMORY_CANDIDATE_CONFLICT_NOT_RESOLVABLE')), true);
  assert.equal(isMemoryVersionConflict(new Error('HTTP 409')), true);
  assert.equal(isMemoryVersionConflict(new Error('network unavailable')), false);
  assert.match(memoryVersionConflictGuidance(new Error('MEMORY_ENTRY_VERSION_CONFLICT')) ?? '', /重新加载最新版本/);
  assert.equal(memoryVersionConflictGuidance(new Error('not found')), undefined);
});
