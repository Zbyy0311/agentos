import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RUNTIME_EVENT_DOMAINS,
  RUNTIME_EVENT_SOURCES,
  WORKTREE_EVENT_DEFINITIONS,
  createM3RuntimeEventRegistry,
  isWorktreeAbandonedEventPayload,
  isWorktreeActivatedEventPayload,
  isWorktreeConflictedEventPayload,
  isWorktreeCreatedEventPayload,
  isWorktreeCommitCreatedEventPayload,
  isWorktreeDeletedEventPayload,
  isWorktreeMergeRequestedEventPayload,
  isWorktreeMergedEventPayload,
  isWorktreeOrphanedEventPayload,
  isWorktreeRecoveryStartedEventPayload,
  type RuntimeEventDraft,
} from './src/index.ts';

const TIMESTAMP = '2026-10-12T00:00:00.000Z';

const EXPECTED_TYPES = [
  'worktree.reserved',
  'worktree.created',
  'worktree.activated',
  'worktree.commit_created',
  'worktree.dirty',
  'worktree.ready_for_review',
  'worktree.merge_requested',
  'worktree.merged',
  'worktree.conflicted',
  'worktree.abandoned',
  'worktree.deleted',
  'worktree.recovery_started',
  'worktree.orphaned',
] as const;

const EXPECTED_METADATA: Record<string, { severity: string; visibility: string }> = {
  'worktree.reserved': { severity: 'info', visibility: 'internal' },
  'worktree.created': { severity: 'info', visibility: 'internal' },
  'worktree.activated': { severity: 'info', visibility: 'internal' },
  'worktree.commit_created': { severity: 'info', visibility: 'internal' },
  'worktree.dirty': { severity: 'notice', visibility: 'internal' },
  'worktree.ready_for_review': { severity: 'info', visibility: 'internal' },
  'worktree.merge_requested': { severity: 'info', visibility: 'internal' },
  'worktree.merged': { severity: 'info', visibility: 'internal' },
  'worktree.conflicted': { severity: 'warning', visibility: 'internal' },
  'worktree.abandoned': { severity: 'notice', visibility: 'internal' },
  'worktree.deleted': { severity: 'notice', visibility: 'internal' },
  'worktree.recovery_started': { severity: 'info', visibility: 'internal' },
  'worktree.orphaned': { severity: 'warning', visibility: 'restricted' },
};

function draft(type: string, payload: unknown, overrides: Record<string, unknown> = {}): RuntimeEventDraft {
  return {
    id: 'evt_worktree_fixture_01',
    schemaVersion: 1,
    type,
    workspaceId: 'ws_worktree_fixture',
    runId: 'run_worktree_fixture',
    sequence: 1,
    timestamp: TIMESTAMP,
    correlationId: 'corr-worktree-fixture',
    causationId: 'cause-worktree-fixture',
    payload: payload as Record<string, unknown>,
    ...overrides,
  } as RuntimeEventDraft;
}

test('worktree domain and worktree-manager source accepted additively', () => {
  assert.ok((RUNTIME_EVENT_DOMAINS as readonly string[]).includes('worktree'));
  assert.ok((RUNTIME_EVENT_SOURCES as readonly string[]).includes('worktree-manager'));
});

test('every worktree Event is registered with durable internal metadata and no stage scope', () => {
  const registry = createM3RuntimeEventRegistry();
  assert.deepEqual(WORKTREE_EVENT_DEFINITIONS.map(definition => definition.type), [...EXPECTED_TYPES]);
  for (const type of EXPECTED_TYPES) {
    const definition = registry.get(type);
    assert.ok(definition, type + ' must be registered');
    assert.equal(definition.domain, 'worktree');
    assert.equal(definition.source, 'worktree-manager');
    assert.equal(definition.schemaVersion, 1);
    assert.equal(definition.defaultDurability, 'durable');
    assert.equal(definition.forbidsStageId, true);
    assert.equal(definition.requiresStageId, undefined);
    const metadata = EXPECTED_METADATA[type];
    assert.equal(definition.defaultSeverity, metadata.severity, type + ' severity');
    assert.equal(definition.defaultVisibility, metadata.visibility, type + ' visibility');
    assert.deepEqual([...definition.payloadSchema.required].sort(), [...definition.payloadSchema.required].sort());
    assert.ok(definition.payloadSchema.required.length > 0, type + ' declares required payload fields');
  }
});

test('lifecycle payloads validate and reject wrong shapes', () => {
  const valid = {
    worktreeId: 'wt_fixture',
    runId: 'run_worktree_fixture',
    workspaceId: 'ws_worktree_fixture',
    executionId: 'exec_fixture',
    agentId: 'agent_fixture',
    branchName: 'agentos/run-fixture',
    status: 'active',
  };
  assert.ok(isWorktreeActivatedEventPayload(valid));
  assert.ok(isWorktreeDeletedEventPayload(valid));
  assert.ok(!isWorktreeActivatedEventPayload({ ...valid, status: 'exploded' }), 'unknown status rejected');
  assert.ok(!isWorktreeActivatedEventPayload({ ...valid, extra: true }), 'extra key rejected');
  assert.ok(!isWorktreeActivatedEventPayload({ ...valid, runId: '' }), 'empty runId rejected');

  const created = { ...valid, baseCommit: 'abc123', pathLabel: 'worktree/w/r/e', controlledGitContent: false };
  assert.ok(isWorktreeCreatedEventPayload(created));
  assert.ok(!isWorktreeCreatedEventPayload({ ...created, controlledGitContent: 'yes' }), 'non-boolean rejected');

  const abandoned = { ...valid, reason: 'operator gave up' };
  assert.ok(isWorktreeAbandonedEventPayload(abandoned));
  assert.ok(isWorktreeAbandonedEventPayload(valid), 'reason is optional');
  assert.ok(!isWorktreeAbandonedEventPayload({ ...abandoned, reason: 7 }), 'non-string reason rejected');
});

test('merge event payloads follow §75/§76 shapes', () => {
  const refs = { worktreeId: 'wt_fixture', runId: 'run_worktree_fixture', workspaceId: 'ws_worktree_fixture' };
  const requested = {
    ...refs,
    sourceBranch: 'agentos/run-x',
    targetBranch: 'main',
    sourceHeadCommit: 'abc123',
    strategy: 'squash',
    requestedBy: 'api',
  };
  assert.ok(isWorktreeMergeRequestedEventPayload(requested));
  assert.ok(isWorktreeMergeRequestedEventPayload({ ...requested, expectedTargetCommit: 'def456' }));
  assert.ok(!isWorktreeMergeRequestedEventPayload({ ...requested, strategy: 'octopus' }), 'unknown strategy rejected');
  assert.ok(!isWorktreeMergeRequestedEventPayload({ ...requested, requestedBy: '' }), 'empty requestedBy rejected');

  const merged = {
    ...refs,
    mergeRecordId: 'worktreeMerge_fixture',
    sourceBranch: 'agentos/run-x',
    targetBranch: 'main',
    strategy: 'merge-commit',
    resultingTargetCommit: 'abc123',
  };
  assert.ok(isWorktreeMergedEventPayload(merged));
  assert.ok(isWorktreeMergedEventPayload({ ...merged, mergeCommit: 'abc123' }));
  assert.ok(!isWorktreeMergedEventPayload({ ...merged, resultingTargetCommit: '' }), 'empty commit rejected');

  const conflicted = { ...refs, operation: 'merge', conflictedFiles: ['a.ts'] };
  assert.ok(isWorktreeConflictedEventPayload(conflicted));
  assert.ok(isWorktreeConflictedEventPayload({ ...conflicted, mergeRecordId: 'm1', sourceBranch: 'a', targetBranch: 'b', conflictArtifactId: 'art1' }));
  assert.ok(!isWorktreeConflictedEventPayload({ ...conflicted, operation: 'force-push' }), 'unknown operation rejected');
  assert.ok(!isWorktreeConflictedEventPayload({ ...conflicted, conflictedFiles: [1] }), 'non-string files rejected');
  assert.ok(!isWorktreeConflictedEventPayload({ ...conflicted, conflictedFiles: 'a.ts' }), 'non-array files rejected');
});

test('commit facts publish only a full Git SHA and scoped path count', () => {
  const payload = {
    worktreeId: 'wt_fixture', runId: 'run_worktree_fixture', workspaceId: 'ws_worktree_fixture',
    commitSha: 'a'.repeat(40), message: 'Selected change', filesChanged: 1,
  };
  assert.ok(isWorktreeCommitCreatedEventPayload(payload));
  assert.ok(isWorktreeCommitCreatedEventPayload({ ...payload, author: 'Fixture <fixture@example.invalid>' }));
  assert.ok(!isWorktreeCommitCreatedEventPayload({ ...payload, commitSha: 'abc123' }));
  assert.ok(!isWorktreeCommitCreatedEventPayload({ ...payload, filesChanged: 0 }));
  assert.ok(!isWorktreeCommitCreatedEventPayload({ ...payload, absolutePath: '/workspace' }));
  const published = createM3RuntimeEventRegistry().publish(draft('worktree.commit_created', payload));
  assert.equal(published.type, 'worktree.commit_created');
});

test('recovery and orphan payloads validate with §53.3/§56 preserve semantics', () => {
  assert.ok(isWorktreeRecoveryStartedEventPayload({ runId: 'r', workspaceId: 'w', scannedCount: 3 }));
  assert.ok(!isWorktreeRecoveryStartedEventPayload({ runId: 'r', workspaceId: 'w', scannedCount: -1 }));
  assert.ok(!isWorktreeRecoveryStartedEventPayload({ runId: 'r', scannedCount: 1 }), 'missing workspaceId rejected');

  const orphan = { path: '/wt/orphan', classification: 'untracked-by-database', action: 'preserve' };
  assert.ok(isWorktreeOrphanedEventPayload(orphan));
  assert.ok(isWorktreeOrphanedEventPayload({ ...orphan, branch: 'b', headCommit: 'h', workspaceId: 'w', runId: 'r' }));
  assert.ok(!isWorktreeOrphanedEventPayload({ ...orphan, classification: 'missing-directory' }), 'only untracked-by-database is an orphan');
  assert.ok(!isWorktreeOrphanedEventPayload({ ...orphan, action: 'cleanup' }), 'orphans are never auto-cleaned');
  assert.ok(!isWorktreeOrphanedEventPayload({ path: '', classification: 'untracked-by-database', action: 'preserve' }), 'empty path rejected');
});

test('registry publishes a created event and rejects a stageId envelope', () => {
  const registry = createM3RuntimeEventRegistry();
  const published = registry.publish(draft('worktree.created', {
    worktreeId: 'wt_fixture',
    runId: 'run_worktree_fixture',
    workspaceId: 'ws_worktree_fixture',
    executionId: 'exec_fixture',
    agentId: 'agent_fixture',
    branchName: 'agentos/run-x',
    status: 'creating',
    baseCommit: 'abc123',
    pathLabel: 'worktree/w/r/e',
    controlledGitContent: true,
  }));
  assert.equal(published.type, 'worktree.created');
  assert.equal(published.visibility, 'internal');
  assert.equal(published.durability, 'durable');

  assert.throws(
    () => registry.publish(draft('worktree.created', {
      worktreeId: 'wt_fixture',
      runId: 'run_worktree_fixture',
      workspaceId: 'ws_worktree_fixture',
      executionId: 'exec_fixture',
      agentId: 'agent_fixture',
      branchName: 'b',
      status: 'active',
      baseCommit: 'abc',
      pathLabel: 'l',
      controlledGitContent: false,
    }, { stageId: 'stage_fixture' })),
    /stageId|STAGE/i,
    'worktree events forbid a stageId envelope',
  );
});
