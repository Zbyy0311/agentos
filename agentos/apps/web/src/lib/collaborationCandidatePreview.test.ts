import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collaborationCandidatePreviewFileDiffMatches,
  collaborationCandidatePreviewFilePath,
  collaborationCandidatePreviewKey,
  collaborationCandidatePreviewMatches,
  collaborationCandidatePreviewPath,
  COLLABORATION_CANDIDATE_PREVIEW_PAGE_SIZE,
  fetchCollaborationCandidatePreview,
  fetchCollaborationCandidatePreviewFileDiff,
  type CollaborationCandidatePreview,
  type CollaborationCandidatePreviewFileDiff,
} from './collaborationCandidatePreview.js';

const identity = { workspaceId: 'ws/one', taskId: 'task one', candidateId: 'cand/one', baseCommit: 'b'.repeat(40), diffHash: 'a'.repeat(64), contentHash: 'e'.repeat(64) };
const preview: CollaborationCandidatePreview = {
  workspaceId: 'ws/one', collaborationTaskId: 'task one', candidateId: 'cand/one',
  baseCommit: 'b'.repeat(40), headCommit: 'c'.repeat(40), snapshotVersion: 2, manifestVersion: 2,
  diffHash: 'a'.repeat(64), contentHash: 'e'.repeat(64), offset: 0, totalFiles: 1, totalAdditions: 1, totalDeletions: 0,
  files: [{ fileIndex: 0, path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, binary: false, withheld: false }],
  withheldContent: false, withheldReasons: [],
};

test('preview and per-file paths carry the candidate, base, and content hash', () => {
  const path = collaborationCandidatePreviewPath(identity);
  assert.ok(path.startsWith('/api/workspaces/ws%2Fone/collaboration/tasks/task%20one/candidates/cand%2Fone/preview?'));
  assert.match(path, /candidateBaseCommit=b{40}/u);
  assert.match(path, /candidateContentHash=e{64}/u);
  assert.match(path, /offset=0/u);
  assert.match(path, new RegExp(`limit=${COLLABORATION_CANDIDATE_PREVIEW_PAGE_SIZE}`, 'u'));
  const pagePath = collaborationCandidatePreviewPath(identity, { offset: 50, limit: 25 });
  assert.match(pagePath, /offset=50/u);
  assert.match(pagePath, /limit=25/u);
  const filePath = collaborationCandidatePreviewFilePath(identity, 12);
  assert.match(filePath, /\/preview\/files\/12\?/u);
  assert.match(filePath, /candidateBaseCommit=b{40}/u);
  assert.match(filePath, /candidateContentHash=e{64}/u);
});

test('preview identity includes workspace, task, candidate, base, and exact frozen content hash', () => {
  assert.ok(collaborationCandidatePreviewMatches(identity, preview));
  assert.notEqual(collaborationCandidatePreviewKey(identity), collaborationCandidatePreviewKey({ ...identity, taskId: 'other-task' }));
  assert.notEqual(collaborationCandidatePreviewKey(identity), collaborationCandidatePreviewKey({ ...identity, baseCommit: 'e'.repeat(40) }));
  assert.notEqual(collaborationCandidatePreviewKey(identity), collaborationCandidatePreviewKey({ ...identity, diffHash: 'd'.repeat(64) }));
  assert.notEqual(collaborationCandidatePreviewKey(identity), collaborationCandidatePreviewKey({ ...identity, contentHash: 'd'.repeat(64) }));
  assert.equal(collaborationCandidatePreviewMatches({ ...identity, candidateId: 'other' }, preview), false);
  assert.equal(collaborationCandidatePreviewMatches({ ...identity, baseCommit: 'e'.repeat(40) }, preview), false);
});

test('on-demand preview GET is uncached, cancellable, paginated, and reports problem details', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(JSON.stringify(preview), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const result = await fetchCollaborationCandidatePreview('http://localhost:3000', identity, controller.signal, { offset: 0, limit: 25 });
    assert.deepEqual(result, preview);
    assert.equal(requestedUrl, `http://localhost:3000${collaborationCandidatePreviewPath(identity, { offset: 0, limit: 25 })}`);
    assert.equal(requestedInit?.method, 'GET');
    assert.equal(requestedInit?.cache, 'no-store');
    assert.equal(requestedInit?.signal, controller.signal);
    assert.equal(result.files[0]?.fileIndex, 0);

    globalThis.fetch = (async () => new Response(JSON.stringify({ detail: '候选已过期' }), { status: 409 })) as typeof fetch;
    await assert.rejects(fetchCollaborationCandidatePreview('http://localhost:3000', identity, controller.signal), /候选已过期/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('one-file diff requests remain bound to the current candidate and requested file index', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const diff: CollaborationCandidatePreviewFileDiff = {
    workspaceId: 'ws/one', collaborationTaskId: 'task one', candidateId: 'cand/one',
    baseCommit: 'b'.repeat(40), diffHash: 'a'.repeat(64), contentHash: 'e'.repeat(64), fileIndex: 12, path: 'src/one.ts',
    diffText: '+frozen line\n', withheld: false,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(JSON.stringify(diff), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const result = await fetchCollaborationCandidatePreviewFileDiff('http://localhost:3000', identity, 12, controller.signal);
    assert.deepEqual(result, diff);
    assert.equal(requestedUrl, `http://localhost:3000${collaborationCandidatePreviewFilePath(identity, 12)}`);
    assert.equal(requestedInit?.cache, 'no-store');
    assert.equal(requestedInit?.signal, controller.signal);
    assert.equal(collaborationCandidatePreviewFileDiffMatches(identity, 12, result), true);
    assert.equal(collaborationCandidatePreviewFileDiffMatches(identity, 11, result), false);
    assert.equal(collaborationCandidatePreviewFileDiffMatches({ ...identity, diffHash: 'e'.repeat(64) }, 12, result), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
