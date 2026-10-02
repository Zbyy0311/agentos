import assert from 'node:assert/strict';
import test from 'node:test';
import { collaborationCandidateContentHash } from './CollaborationCandidateContentHash.js';

const diffHash = 'a'.repeat(64);
const entry = {
  path: 'assets/image.bin', sizeBytes: 20, sha256: 'b'.repeat(64), gitObjectId: '1'.repeat(40),
  baseSizeBytes: 18, baseSha256: 'c'.repeat(64), baseObjectId: '2'.repeat(40), binary: true,
};

test('canonical candidate content hash binds patch digest and every candidate and baseline manifest field', () => {
  const original = collaborationCandidateContentHash({ diffHash, snapshotVersion: 2, manifestVersion: 2, manifest: [entry] });
  assert.equal(collaborationCandidateContentHash({ diffHash, snapshotVersion: 2, manifestVersion: 2, manifest: [{ ...entry }] }), original);
  assert.notEqual(collaborationCandidateContentHash({ diffHash, snapshotVersion: 2, manifestVersion: 2, manifest: [{ ...entry, baseSha256: 'd'.repeat(64) }] }), original);
  assert.notEqual(collaborationCandidateContentHash({ diffHash, snapshotVersion: 2, manifestVersion: 2, manifest: [{ ...entry, sha256: 'e'.repeat(64) }] }), original);
  assert.notEqual(collaborationCandidateContentHash({ diffHash, snapshotVersion: 2, manifestVersion: 2, manifest: [{ ...entry, binary: false }] }), original);
  assert.notEqual(collaborationCandidateContentHash({ diffHash: 'f'.repeat(64), snapshotVersion: 2, manifestVersion: 2, manifest: [entry] }), original);
  assert.notEqual(collaborationCandidateContentHash({ diffHash, snapshotVersion: 1, manifestVersion: 2, manifest: [entry] }), original);
  assert.notEqual(collaborationCandidateContentHash({ diffHash, snapshotVersion: 2, manifestVersion: 1, manifest: [entry] }), original);
});
