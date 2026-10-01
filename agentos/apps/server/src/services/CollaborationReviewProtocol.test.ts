import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCollaborationReviewPrompt, collaborationReviewMatchesBinding, parseCollaborationReview, validateCollaborationReview } from './CollaborationReviewProtocol.js';

const binding = {
  candidateId: 'artifact_candidate_1',
  candidateHash: 'a'.repeat(64),
  runId: 'run_1',
  stageAttempt: 2,
  reviewerAgentId: 'opencode',
} as const;

function review(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ agentosCollaborationReview: {
    version: 1,
    ...binding,
    conclusion: 'approved',
    summary: 'Reviewed the frozen diff and the recorded passing test evidence.',
    ...overrides,
  } });
}

function artifactReview(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ agentosArtifact: {
    version: 1,
    type: 'review',
    ...binding,
    conclusion: 'approved',
    summary: 'Reviewed the frozen diff and the recorded passing test evidence.',
    ...overrides,
  } });
}

const validReview = {
  version: 1,
  ...binding,
  conclusion: 'approved',
  summary: 'Reviewed the frozen diff and the recorded passing test evidence.',
};

test('parses the exact collaboration review JSON contract', () => {
  assert.deepEqual(parseCollaborationReview(review()), {
    ...binding,
    conclusion: 'approved',
    summary: 'Reviewed the frozen diff and the recorded passing test evidence.',
  });
});

test('accepts the shared AgentOS review artifact envelope only with all collaboration bindings', () => {
  assert.equal(parseCollaborationReview(artifactReview())?.candidateHash, binding.candidateHash);
  assert.equal(parseCollaborationReview(JSON.stringify({ agentosArtifact: {
    version: 1, type: 'review', conclusion: 'approved', summary: 'Looks good.',
  } })), undefined);
  assert.equal(parseCollaborationReview(artifactReview({ type: 'test' })), undefined);
  assert.equal(parseCollaborationReview(artifactReview({ evidence: { testExitCode: 0 } }))?.candidateHash, binding.candidateHash);
});

test('accepts one complete review object when it is fenced or surrounded by prose', () => {
  const payload = review();
  assert.equal(parseCollaborationReview(`\n\`\`\`json\n${payload}\n\`\`\`\n`)?.candidateId, binding.candidateId);
  assert.equal(parseCollaborationReview(`Review complete:\n\n\`\`\`json\n${payload}\n\`\`\``)?.candidateId, binding.candidateId);
  assert.equal(parseCollaborationReview(`Review complete: ${payload}\nApproved.`)?.candidateId, binding.candidateId);
  assert.equal(parseCollaborationReview(`Review complete: ${payload}\n\n${artifactReview()}`), undefined);
});

test('rejects invalid conclusions, missing bindings, and malformed JSON while ignoring non-binding metadata', () => {
  assert.equal(parseCollaborationReview(review({ conclusion: 'approved|changes_requested' })), undefined);
  assert.equal(parseCollaborationReview(JSON.stringify({ agentosCollaborationReview: { ...validReview, evidence: { testExitCode: 0 } } }))?.candidateId, binding.candidateId);
  assert.equal(parseCollaborationReview(JSON.stringify({ agentosCollaborationReview: { ...validReview, candidateHash: undefined } })), undefined);
  assert.equal(parseCollaborationReview('{not json'), undefined);
});

test('returns a safe schema diagnostic naming missing fields without exposing submitted values', () => {
  const result = validateCollaborationReview(JSON.stringify({ agentosArtifact: {
    version: 1,
    type: 'review',
    candidateId: binding.candidateId,
    conclusion: 'approved',
  } }), binding);
  assert.deepEqual(result, { valid: false, reason: '评审结论缺少必需字段：candidateHash、reviewerAgentId、runId、stageAttempt、summary' });
  assert.ok(!result.reason.includes(binding.candidateId));
});

test('requires every review binding to match the frozen candidate and exact attempt', () => {
  const parsed = parseCollaborationReview(review());
  assert.ok(parsed);
  assert.equal(collaborationReviewMatchesBinding(parsed, binding), true);
  assert.equal(collaborationReviewMatchesBinding(parsed, { ...binding, candidateHash: 'b'.repeat(64) }), false);
  assert.equal(collaborationReviewMatchesBinding(parsed, { ...binding, candidateId: 'artifact_other' }), false);
  assert.equal(collaborationReviewMatchesBinding(parsed, { ...binding, runId: 'run_other' }), false);
  assert.equal(collaborationReviewMatchesBinding(parsed, { ...binding, stageAttempt: 3 }), false);
  assert.equal(collaborationReviewMatchesBinding(parsed, { ...binding, reviewerAgentId: 'codex' }), false);
});

test('reports only the safe name of a mismatched binding, never the untrusted value', () => {
  const mismatchedHash = 'b'.repeat(64);
  const result = validateCollaborationReview(artifactReview({ candidateHash: mismatchedHash }), binding);
  assert.deepEqual(result, { valid: false, reason: '评审结论的候选哈希与冻结执行不匹配' });
  assert.ok(!result.reason.includes(mismatchedHash));
  assert.deepEqual(validateCollaborationReview(artifactReview(), binding).valid, true);
});

test('review prompt supplies concrete immutable bindings and no illegal conclusion enum literal', () => {
  const prompt = buildCollaborationReviewPrompt(binding);
  assert.ok(prompt.includes(binding.candidateId));
  assert.ok(prompt.includes(binding.candidateHash));
  assert.ok(prompt.includes(binding.runId));
  assert.ok(prompt.includes(String(binding.stageAttempt)));
  assert.ok(prompt.includes(binding.reviewerAgentId));
  assert.ok(prompt.includes('exactly "approved" or "changes_requested"'));
  assert.ok(prompt.includes('top-level key named agentosArtifact'));
  assert.ok(prompt.includes('candidateHash'));
  assert.ok(prompt.includes('authoritative frozen patch digest'));
  assert.ok(!prompt.includes('"approved|changes_requested"'));
  assert.ok(prompt.includes('strict validator'));
});
