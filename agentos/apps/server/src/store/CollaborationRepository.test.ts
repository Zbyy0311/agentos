import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './SqliteStore.js';
import { CollaborationRepository, CollaborationRepositoryError } from './CollaborationRepository.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-collaboration-repository-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
    id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: false, memoryEnabled: false,
    agents: [], lastOpenedAt: '2026-09-20T00:00:00.000Z', createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
  }] }), 'utf8');
  const store = new SqliteStore(root);
  return { store, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('collaboration repository persists the plan, candidate, review and version fences', () => {
  const fx = fixture();
  try {
    const repository = new CollaborationRepository(fx.store.getDatabase());
    const plan = repository.create({
      workspaceId: 'workspace-a', title: 'Repository collaboration', objective: 'Make a bounded change',
      scope: ['apps/server/src'], acceptanceCommands: ['pnpm test'], plannerAgentId: 'codex',
      implementerAgentId: 'kimi', reviewerAgentId: 'opencode', planHash: 'plan-hash', baseCommit: 'base-sha',
      maxReworkRounds: 2, createdAt: '2026-09-20T00:00:00.000Z',
    });
    assert.equal(plan.status, 'awaiting_confirmation');
    assert.equal(plan.version, 1);

    const canonicalTask = fx.store.taskRepository().insert({ workspaceId: 'workspace-a', title: plan.title, createdBy: 'test' });
    const canonicalRun = fx.store.runRepository().insert({ workspaceId: 'workspace-a', taskId: canonicalTask.id, origin: 'v2_api', createdBy: 'test' });
    const queued = repository.confirm({ workspaceId: 'workspace-a', id: plan.id, expectedVersion: 1, canonicalTaskId: canonicalTask.id, canonicalRunId: canonicalRun.id, confirmedAt: '2026-09-20T00:01:00.000Z', idempotencyKey: 'confirm-1' });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.version, 2);
    assert.throws(() => repository.confirm({ workspaceId: 'workspace-a', id: plan.id, expectedVersion: 1, canonicalTaskId: canonicalTask.id, canonicalRunId: canonicalRun.id, confirmedAt: '2026-09-20T00:02:00.000Z' }), (error: unknown) => error instanceof CollaborationRepositoryError && error.code === 'CONFLICT');

    const candidate = repository.createCandidate({
      id: 'candidate_1', collaborationTaskId: plan.id, workspaceId: 'workspace-a', canonicalRunId: canonicalRun.id,
      round: 0, baseCommit: 'base-sha', headCommit: 'head-sha', diffHash: 'diff-hash', diffText: '', manifest: [],
      testStatus: 'passed', testCommand: 'pnpm test', testExitCode: 0, testOutput: 'ok', status: 'created', createdAt: '2026-09-20T00:03:00.000Z',
    });
    assert.equal(candidate.status, 'created');
    const reviewed = repository.reviewCandidate({ workspaceId: 'workspace-a', candidateId: candidate.id, conclusion: 'approved', summary: 'Evidence is sufficient', reviewerAgentId: 'opencode', artifactId: 'artifact_review' });
    assert.equal(reviewed.status, 'reviewed');
    repository.createReview({ id: 'review_1', collaborationTaskId: plan.id, candidateId: candidate.id, workspaceId: 'workspace-a', canonicalRunId: canonicalRun.id, stageId: 'stage_review', stageAttempt: 1, reviewerAgentId: 'opencode', candidateDiffHash: 'diff-hash', conclusion: 'approved', summary: 'Evidence is sufficient', artifactId: 'artifact_review', createdAt: '2026-09-20T00:04:00.000Z' });
    assert.equal(repository.listReviews('workspace-a', plan.id).length, 1);
    assert.equal(repository.findReviewForCandidate('workspace-a', candidate.id)?.candidateDiffHash, 'diff-hash');

    const stageOutput = repository.recordStageOutput({
      workspaceId: 'workspace-a', collaborationTaskId: plan.id, runId: canonicalRun.id,
      stageId: 'stage_review', stageAttempt: 1, agentId: 'opencode', role: 'reviewer',
      status: 'available', publicOutput: 'Reviewed this exact candidate.', outputHash: 'output-hash',
      reviewCandidateId: candidate.id, reviewCandidateHash: 'diff-hash', reviewConclusion: 'approved',
      createdAt: '2026-09-20T00:05:00.000Z',
    });
    assert.equal(stageOutput.reviewCandidateId, candidate.id);
    assert.equal(repository.findStageOutput('workspace-a', canonicalRun.id, 'stage_review', 1)?.reviewCandidateHash, 'diff-hash');
    assert.throws(() => repository.recordStageOutput({
      workspaceId: 'workspace-a', collaborationTaskId: plan.id, runId: canonicalRun.id,
      stageId: 'stage_review', stageAttempt: 1, agentId: 'opencode', role: 'reviewer',
      status: 'available', publicOutput: 'Different output', outputHash: 'different-hash',
      reviewCandidateId: candidate.id, reviewCandidateHash: 'wrong-hash', reviewConclusion: 'approved',
      createdAt: '2026-09-20T00:06:00.000Z',
    }), (error: unknown) => error instanceof CollaborationRepositoryError && error.code === 'CONFLICT');

    fx.store.getDatabase().prepare("UPDATE runs SET status = 'failed', version = version + 1 WHERE workspace_id = ? AND id = ?")
      .run('workspace-a', canonicalRun.id);
    const retryRun = fx.store.runRepository().insert({
      workspaceId: 'workspace-a', taskId: canonicalTask.id, parentRunId: canonicalRun.id, reason: 'retry', origin: 'v2_api', createdBy: 'test',
    });
    fx.store.getDatabase().prepare('UPDATE collaboration_tasks SET canonical_run_id = ?, version = version + 1 WHERE workspace_id = ? AND id = ?')
      .run(retryRun.id, 'workspace-a', plan.id);
    assert.throws(() => repository.recordStageOutput({
      workspaceId: 'workspace-a', collaborationTaskId: plan.id, runId: canonicalRun.id,
      stageId: 'stage_implement', stageAttempt: 2, agentId: 'kimi', role: 'implementer',
      status: 'available', publicOutput: 'Late output from the prior Run.', outputHash: 'late-output-hash',
      createdAt: '2026-09-20T00:07:00.000Z',
    }), (error: unknown) => error instanceof CollaborationRepositoryError && error.code === 'CONFLICT');
    assert.equal(repository.findStageOutput('workspace-a', canonicalRun.id, 'stage_implement', 2), undefined,
      'a late prior-Run output is fenced after the recovery Run becomes canonical');
  } finally { fx.close(); }
});
