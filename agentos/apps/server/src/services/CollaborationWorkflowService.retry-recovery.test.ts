import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { CollaborationRepository } from '../store/CollaborationRepository.js';
import { CollaborationControlRepository } from '../store/CollaborationControlRepository.js';
import { WorkspaceAdmissionRepository } from '../store/WorkspaceAdmissionRepository.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { CollaborationWorkflowService } from './CollaborationWorkflowService.js';
import { WorkspaceAdmissionAuthority } from './WorkspaceAdmissionAuthority.js';
import { WorkspaceAdmissionStartupReconciler } from './WorkspaceAdmissionStartupReconciler.js';
import { TaskRunService } from './TaskRunService.js';
import { recoverInterruptedTaskRuntime } from '../taskRecovery.js';
import { recoverInterruptedRuns } from '../runRecovery.js';
import { WorktreeManager } from './WorktreeManager.js';
import { NOW, fixture, preparePortableWorkspace, createMappedCleanClone, grantRecoveryFixturePermissions, productionServiceFor, recoverFullStartup, admitFollowerToApproval } from './CollaborationWorkflowService.test-fixture.js';


test('P2 recovery review: deterministic failure duplicate continue creates one canonical retry Run', async () => {
  const fx = fixture({ runtimeDispatchEnabled: false });
  try {
    grantRecoveryFixturePermissions(fx);
    const { run, collaboration } = fx.runningWithCompletedStart();
    const failed = fx.store.runRepository().transitionStatus('workspace-a', run.id, run.version, 'failed', {
      failureCode: 'RUN_CONFIGURATION_INVALID', failureMessage: 'Deterministic pre-Provider configuration rejection',
    });
    const blocked = fx.repository.progress({ workspaceId: 'workspace-a', id: fx.plan.id,
      expectedVersion: collaboration.version, status: 'blocked', expectedRunId: run.id });
    const input = {
      workspaceId: 'workspace-a', collaborationId: fx.plan.id,
      expectedTaskVersion: blocked.version, expectedRunId: failed.id, expectedRunVersion: failed.version,
      idempotencyKey: 'p2-known-failure-review-01', action: 'retry-known-failure' as const,
    };

    const [first, duplicate] = await Promise.all([fx.service.recover(input), fx.service.recover(input)]);
    assert.equal([first, duplicate].filter(result => result.pending).length, 1,
      'the duplicate observes the in-flight canonical claim instead of retrying it');
    const accepted = first.pending ? duplicate : first;
    assert.ok(accepted.newRunId);
    const retry = await fx.service.recover(input);
    assert.equal(retry.replayed, true);
    assert.ok(retry.newRunId);
    assert.equal(retry.newRunId, accepted.newRunId);
    assert.equal(fx.store.runRepository().findById('workspace-a', retry.newRunId!)?.parentRunId, failed.id);
    assert.equal(fx.store.runRepository().findById('workspace-a', failed.id)?.version, failed.version,
      'the failed parent Run remains immutable');
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ?').get('workspace-a') as { n: number }).n, 2,
      'duplicate continue creates exactly one child Run');
    assert.equal(fx.store.operationService().listByRun('workspace-a', failed.id).filter(item => item.type === 'run.retry').length, 1);

    await assert.rejects(() => fx.service.recover({ ...input, expectedRunVersion: failed.version + 1 }), error =>
      (error as { code?: string }).code === 'COLLABORATION_RECOVERY_IDEMPOTENCY_CONFLICT');
    await assert.rejects(() => fx.service.recover({ ...input, expectedTaskVersion: blocked.version + 1,
      idempotencyKey: 'p2-known-failure-stale-01' }), error =>
      (error as { code?: string }).code === 'COLLABORATION_RECOVERY_STALE');
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ?').get('workspace-a') as { n: number }).n, 2);
  } finally { await fx.close(); }
});

test('P2 retry recovery uses one mapped clean Git root while preserving portable workspace content', async () => {
  let mappedGitRoot: string | undefined;
  let dispatchCalls = 0;
  const fx = fixture({
    runtimeDispatchEnabled: false,
    workspaceGitRootFor: workspaceId => workspaceId === 'workspace-a' ? mappedGitRoot : undefined,
    dispatchRun: async () => { dispatchCalls++; },
  });
  try {
    const { portableRoot, markerPath } = preparePortableWorkspace(fx);
    const cleanClone = createMappedCleanClone(fx);
    mappedGitRoot = cleanClone;
    let switchMappingAfterNextPreflight = false;
    assert.throws(() => execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: portableRoot, encoding: 'utf8', windowsHide: true, stdio: 'ignore',
    }), 'the restored workspace root is portable content, not a Git repository');
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: cleanClone, encoding: 'utf8', windowsHide: true,
    }).trim(), fx.plan.baseCommit);

    const checkedRoots: string[] = [];
    const leaseRoots: string[] = [];
    const realPreflight = fx.worktrees.preflight.bind(fx.worktrees);
    const realCreateLease = fx.worktrees.createLease.bind(fx.worktrees);
    fx.worktrees.preflight = async (workspaceRoot, options) => {
      const checked = await realPreflight(workspaceRoot, options);
      checkedRoots.push(workspaceRoot);
      if (switchMappingAfterNextPreflight) {
        switchMappingAfterNextPreflight = false;
        mappedGitRoot = join(fx.root, 'mapping-changed-during-retry');
      }
      return checked;
    };
    fx.worktrees.createLease = async leaseInput => {
      leaseRoots.push(leaseInput.workspaceRoot);
      return realCreateLease(leaseInput);
    };
    grantRecoveryFixturePermissions(fx);
    const { run, collaboration } = fx.runningWithCompletedStart();
    const failed = fx.store.runRepository().transitionStatus('workspace-a', run.id, run.version, 'failed', {
      failureCode: 'RUN_CONFIGURATION_INVALID', failureMessage: 'Deterministic pre-Provider configuration rejection',
    });
    const blocked = fx.repository.progress({ workspaceId: 'workspace-a', id: fx.plan.id,
      expectedVersion: collaboration.version, status: 'blocked', expectedRunId: run.id });
    const input = {
      workspaceId: 'workspace-a', collaborationId: fx.plan.id,
      expectedTaskVersion: blocked.version, expectedRunId: failed.id, expectedRunVersion: failed.version,
      idempotencyKey: 'p2-retry-mapped-git-root-01', action: 'retry-known-failure' as const,
    };

    const options = await fx.service.getRecoveryOptions('workspace-a', fx.plan.id);
    assert.equal(options.actions.retryKnownFailure, true, 'recovery inspection must check the mapped clean clone');
    assert.equal(options.checkedBaseCommit, fx.plan.baseCommit);
    assert.deepEqual(checkedRoots, [cleanClone]);

    checkedRoots.length = 0;
    switchMappingAfterNextPreflight = true;
    const retried = await fx.service.recover(input);
    assert.ok(retried.newRunId);
    assert.equal(retried.checkedBaseCommit, fx.plan.baseCommit);
    assert.deepEqual(leaseRoots, [cleanClone], 'the retry lease must be created from the captured mapped root');
    assert.ok(checkedRoots.includes(cleanClone), 'retry preflight rechecks the captured clone before Start authorization');
    assert.ok(!checkedRoots.includes(portableRoot));
    assert.ok(!checkedRoots.includes(join(fx.root, 'mapping-changed-during-retry')),
      'a mapping change during the action does not redirect later Git checks');
    assert.equal(fx.store.runRepository().findById('workspace-a', retried.newRunId)?.parentRunId, failed.id);
    const replay = await fx.service.recover(input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.newRunId, retried.newRunId, 'the same body-bound idempotency key reuses the canonical child');
    assert.equal((fx.store.getDatabase().prepare('SELECT checked_base_commit FROM p2_collaboration_recoveries WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as { checked_base_commit: string }).checked_base_commit, fx.plan.baseCommit);
    assert.equal(dispatchCalls, 0, 'the fixture never invokes a Provider');
    assert.equal(fx.workspaces.get('workspace-a')?.rootPath, portableRoot);
    assert.equal(readFileSync(markerPath, 'utf8'), 'portable restored content must remain untouched\n');
    assert.equal(execFileSync('git', ['status', '--porcelain'], {
      cwd: cleanClone, encoding: 'utf8', windowsHide: true,
    }), '', 'recovery checks do not change the mapped clean clone');
  } finally { await fx.close(); }
});

test('P2 linked recovery preflights the mapped clone and preserves restored workspace content', async () => {
  let mappedGitRoot: string | undefined;
  const fx = fixture({
    runtimeDispatchEnabled: false,
    workspaceGitRootFor: workspaceId => workspaceId === 'workspace-a' ? mappedGitRoot : undefined,
  });
  try {
    const { portableRoot, markerPath } = preparePortableWorkspace(fx);
    const cleanClone = createMappedCleanClone(fx);
    mappedGitRoot = cleanClone;
    const checkedRoots: string[] = [];
    const realPreflight = fx.worktrees.preflight.bind(fx.worktrees);
    fx.worktrees.preflight = async (workspaceRoot, options) => {
      checkedRoots.push(workspaceRoot);
      return realPreflight(workspaceRoot, options);
    };

    grantRecoveryFixturePermissions(fx);
    const { run, collaboration } = fx.runningWithCompletedStart();
    const unresolved = fx.store.runInTransaction(() => fx.store.runRepository().markRecoveryRequiredWithinTransaction({
      workspaceId: 'workspace-a', runId: run.id, expectedStatus: 'running', expectedVersion: run.version, timestamp: NOW,
    }));
    const blocked = fx.repository.progress({ workspaceId: 'workspace-a', id: fx.plan.id,
      expectedVersion: collaboration.version, status: 'blocked', expectedRunId: run.id });
    const input = {
      workspaceId: 'workspace-a', collaborationId: fx.plan.id,
      expectedTaskVersion: blocked.version, expectedRunId: unresolved.id, expectedRunVersion: unresolved.version,
      idempotencyKey: 'p2-linked-mapped-git-root-01', action: 'new-linked-task' as const,
    };

    const options = await fx.service.getRecoveryOptions('workspace-a', fx.plan.id);
    assert.equal(options.actions.newLinkedTask, true, 'unknown effects can only create a separately confirmed linked task');
    assert.equal(options.checkedBaseCommit, fx.plan.baseCommit);
    const linked = await fx.service.recover(input);
    assert.equal(linked.checkedBaseCommit, fx.plan.baseCommit);
    assert.equal(linked.task.baseCommit, fx.plan.baseCommit);
    assert.equal(linked.task.status, 'awaiting_confirmation');
    assert.deepEqual(checkedRoots, [cleanClone, cleanClone], 'inspection and linked-task creation both use the mapped clone');
    assert.ok(!checkedRoots.includes(portableRoot));
    assert.equal(fx.workspaces.get('workspace-a')?.rootPath, portableRoot);
    assert.equal(readFileSync(markerPath, 'utf8'), 'portable restored content must remain untouched\n');
  } finally { await fx.close(); }
});

test('P2 recovery review: baseline change during lease creation fences retry before Provider start', async () => {
  let dispatchCalls = 0;
  const fx = fixture({ runtimeDispatchEnabled: false, dispatchRun: async () => { dispatchCalls++; } });
  try {
    grantRecoveryFixturePermissions(fx);
    const { run, collaboration } = fx.runningWithCompletedStart();
    const failed = fx.store.runRepository().transitionStatus('workspace-a', run.id, run.version, 'failed', {
      failureCode: 'RUN_CONFIGURATION_INVALID', failureMessage: 'Deterministic pre-Provider configuration rejection',
    });
    const blocked = fx.repository.progress({ workspaceId: 'workspace-a', id: fx.plan.id,
      expectedVersion: collaboration.version, status: 'blocked', expectedRunId: run.id });
    const input = {
      workspaceId: 'workspace-a', collaborationId: fx.plan.id,
      expectedTaskVersion: blocked.version, expectedRunId: failed.id, expectedRunVersion: failed.version,
      idempotencyKey: 'p2-baseline-cas-review-01', action: 'retry-known-failure' as const,
    };
    const createLease = fx.worktrees.createLease.bind(fx.worktrees);
    let changedBaseCommit: string | undefined;
    fx.worktrees.createLease = async leaseInput => {
      writeFileSync(join(fx.repositoryRoot, 'README.md'), 'baseline changed between recovery checks\n');
      execFileSync('git', ['add', 'README.md'], { cwd: fx.repositoryRoot, windowsHide: true });
      execFileSync('git', ['commit', '-qm', 'advance baseline before retry lease'], { cwd: fx.repositoryRoot, windowsHide: true });
      changedBaseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fx.repositoryRoot, encoding: 'utf8', windowsHide: true,
      }).trim();
      return createLease(leaseInput);
    };

    await assert.rejects(() => fx.service.recover(input), error =>
      (error as { code?: string }).code === 'COLLABORATION_BASE_CHANGED');
    assert.ok(changedBaseCommit);
    const unchangedTask = fx.repository.findById('workspace-a', fx.plan.id)!;
    assert.equal(unchangedTask.status, 'blocked');
    assert.equal(unchangedTask.canonicalRunId, failed.id, 'the prior owner remains canonical when the lease baseline races');
    assert.equal(fx.store.runRepository().findById('workspace-a', failed.id)?.version, failed.version);
    const runs = fx.store.getDatabase().prepare('SELECT id,status FROM runs WHERE workspace_id = ?').all('workspace-a') as Array<{ id: string; status: string }>;
    const retry = runs.find(item => item.id !== failed.id);
    assert.ok(retry, 'the accepted retry identity remains durable for recovery inspection');
    assert.equal(retry.status, 'queued');
    assert.equal(fx.store.operationService().listByRun('workspace-a', retry.id).filter(item => item.type === 'run.start').length, 0,
      'the changed-baseline retry never receives Provider-start authorization');
    assert.equal(dispatchCalls, 0);
    const recovery = fx.store.getDatabase().prepare('SELECT state,error_code FROM p2_collaboration_recoveries WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as { state: string; error_code: string };
    assert.equal(recovery.state, 'recovery_required');
    assert.equal(recovery.error_code, 'COLLABORATION_BASE_CHANGED');
    const lease = fx.worktrees.listLeases().find(item => item.runId === retry.id);
    assert.equal(lease, undefined, 'the lease manager rejects a baseline change before creating a worktree');
    assert.notEqual(changedBaseCommit, fx.plan.baseCommit);
  } finally { await fx.close(); }
});

test('P2 retry recovery resumes one queued child after a pre-Start interruption, but only on its bound clean base', async () => {
  let dispatchCalls = 0;
  const fx = fixture({ runtimeDispatchEnabled: false, dispatchRun: async () => { dispatchCalls++; } });
  try {
    grantRecoveryFixturePermissions(fx);
    const { run, collaboration } = fx.runningWithCompletedStart();
    const failed = fx.store.runRepository().transitionStatus('workspace-a', run.id, run.version, 'failed', {
      failureCode: 'RUN_CONFIGURATION_INVALID', failureMessage: 'Deterministic pre-Provider configuration rejection',
    });
    const blocked = fx.repository.progress({ workspaceId: 'workspace-a', id: fx.plan.id,
      expectedVersion: collaboration.version, status: 'blocked', expectedRunId: run.id });
    const input = {
      workspaceId: 'workspace-a', collaborationId: fx.plan.id,
      expectedTaskVersion: blocked.version, expectedRunId: failed.id, expectedRunVersion: failed.version,
      idempotencyKey: 'p2-recovery-resume-queued-child-01', action: 'retry-known-failure' as const,
    };
    const createLease = fx.worktrees.createLease.bind(fx.worktrees);
    let interruptOnce = true;
    fx.worktrees.createLease = async leaseInput => {
      if (interruptOnce) {
        interruptOnce = false;
        throw new Error('simulated process interruption after durable Retry acceptance');
      }
      return createLease(leaseInput);
    };

    await assert.rejects(() => fx.service.recover(input), /simulated process interruption/u);
    const rows = () => fx.store.getDatabase().prepare(
      'SELECT id,status FROM runs WHERE workspace_id = ? AND parent_run_id = ?',
    ).all('workspace-a', failed.id) as Array<{ id: string; status: string }>;
    assert.equal(rows().length, 1, 'the crash window leaves one durable child Run');
    assert.equal(rows()[0]!.status, 'queued');
    const childId = rows()[0]!.id;
    const originalAttempts = fx.store.getDatabase().prepare(`SELECT id,workflow_stage_key,attempt,status FROM run_stages
      WHERE workspace_id = ? AND run_id = ? ORDER BY sequence`).all('workspace-a', childId);
    assert.equal(fx.repository.findById('workspace-a', fx.plan.id)?.canonicalRunId, failed.id,
      'the interrupted task has not linked the child or authorized its Start');
    assert.equal(fx.store.operationService().listByRun('workspace-a', rows()[0]!.id)
      .filter(item => item.type === 'run.start').length, 0);
    assert.equal(dispatchCalls, 0);

    const options = await fx.service.getRecoveryOptions('workspace-a', fx.plan.id);
    assert.equal(options.actions.retryKnownFailure, true);
    assert.equal(options.resumeRequest?.idempotencyKey, input.idempotencyKey);
    assert.equal(options.resumeRequest?.expectedTaskVersion, blocked.version);
    await assert.rejects(() => fx.service.recover({ ...input, expectedRunVersion: failed.version + 1 }), error =>
      (error as { code?: string }).code === 'COLLABORATION_RECOVERY_IDEMPOTENCY_CONFLICT');
    await assert.rejects(() => fx.service.recover({ ...input, expectedTaskVersion: blocked.version + 1,
      idempotencyKey: 'p2-recovery-resume-stale-version-01' }), error =>
      (error as { code?: string }).code === 'COLLABORATION_RECOVERY_STALE');

    const originalHead = fx.plan.baseCommit;
    writeFileSync(join(fx.repositoryRoot, 'README.md'), 'changed after retry acceptance\n');
    execFileSync('git', ['add', 'README.md'], { cwd: fx.repositoryRoot, windowsHide: true });
    execFileSync('git', ['commit', '-qm', 'advance baseline during interrupted retry'], { cwd: fx.repositoryRoot, windowsHide: true });
    assert.equal((await fx.service.getRecoveryOptions('workspace-a', fx.plan.id)).actions.retryKnownFailure, false,
      'a changed source baseline fences the continuation');
    await assert.rejects(() => fx.service.recover(input), error =>
      (error as { code?: string }).code === 'COLLABORATION_BASE_CHANGED');
    assert.equal(rows().length, 1, 'base mismatch never clones another child');
    assert.equal(fx.store.operationService().listByRun('workspace-a', rows()[0]!.id)
      .filter(item => item.type === 'run.start').length, 0);

    execFileSync('git', ['reset', '--hard', originalHead], { cwd: fx.repositoryRoot, windowsHide: true });
    const resumedOptions = await fx.service.getRecoveryOptions('workspace-a', fx.plan.id);
    assert.equal(resumedOptions.actions.retryKnownFailure, true, 'restoring the exact checked baseline re-enables the same request');
    const [resumed, duplicate] = await Promise.all([
      fx.service.recover(input), fx.service.recover(input),
    ]);
    assert.equal([resumed, duplicate].filter(result => result.pending).length, 1);
    const completed = resumed.pending ? duplicate : resumed;
    assert.ok(completed.newRunId);
    assert.equal(completed.newRunId, rows()[0]!.id, 'resume reuses the original queued child Run');
    assert.equal(rows().length, 1, 'same-key recovery and duplicate request create only one child Run');
    assert.deepEqual(fx.store.getDatabase().prepare(`SELECT id,workflow_stage_key,attempt,status FROM run_stages
      WHERE workspace_id = ? AND run_id = ? ORDER BY sequence`).all('workspace-a', childId), originalAttempts,
    'resume retains the accepted child stage attempts instead of cloning a new attempt');
    assert.equal(fx.repository.findById('workspace-a', fx.plan.id)?.canonicalRunId, completed.newRunId);
    assert.equal(fx.store.operationService().listByRun('workspace-a', failed.id).filter(item => item.type === 'run.retry').length, 1);
    assert.equal(fx.store.operationService().listByRun('workspace-a', completed.newRunId!).filter(item => item.type === 'run.start').length, 1);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM provider_sessions WHERE workspace_id = ? AND run_id = ?')
      .get('workspace-a', completed.newRunId) as { n: number }).n, 0);
    assert.equal(dispatchCalls, 0, 'the service fixture disables Runtime dispatch, so no Provider adapter is invoked');
    const replay = await fx.service.recover(input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.newRunId, completed.newRunId);
    assert.equal(rows().length, 1);
  } finally { await fx.close(); }
});

test('P2 linked queued retry survives database restart admission reconstruction and same-key recovery', async () => {
  let fx!: ReturnType<typeof fixture>;
  let dispatchCalls = 0;
  fx = fixture({
    requestRunAdmission: input => fx.authority.requestCanonicalRun(input),
    releaseRunAdmission: input => fx.authority.releaseCanonicalRun(input),
    dispatchRun: async () => { dispatchCalls++; },
  });
  let reopened: SqliteStore | undefined;
  try {
    grantRecoveryFixturePermissions(fx);
    const { run, collaboration } = fx.runningWithCompletedStart();
    const failed = fx.store.runRepository().transitionStatus('workspace-a', run.id, run.version, 'failed', {
      failureCode: 'RUN_CONFIGURATION_INVALID', failureMessage: 'Deterministic pre-Provider configuration rejection',
    });
    const blocked = fx.repository.progress({ workspaceId: 'workspace-a', id: fx.plan.id,
      expectedVersion: collaboration.version, status: 'blocked', expectedRunId: run.id });
    const input = {
      workspaceId: 'workspace-a', collaborationId: fx.plan.id,
      expectedTaskVersion: blocked.version, expectedRunId: failed.id, expectedRunVersion: failed.version,
      idempotencyKey: 'p2-linked-queued-retry-restart-01', action: 'retry-known-failure' as const,
    };
    const realPreflight = fx.worktrees.preflight.bind(fx.worktrees);
    fx.worktrees.preflight = async (root, options) => {
      if (root !== fx.repositoryRoot) throw new Error('simulated interruption after canonical child link and before Start');
      return realPreflight(root, options);
    };
    await assert.rejects(() => fx.service.recover(input), /after canonical child link/u);
    const child = fx.store.getDatabase().prepare('SELECT id,status FROM runs WHERE workspace_id = ? AND parent_run_id = ?')
      .get('workspace-a', failed.id) as { id: string; status: string };
    assert.equal(child.status, 'queued');
    assert.equal(fx.repository.findById('workspace-a', fx.plan.id)?.canonicalRunId, child.id);
    assert.equal(fx.store.operationService().listByRun('workspace-a', child.id).filter(operation => operation.type === 'run.start').length, 0);
    fx.closeDatabase();

    reopened = new SqliteStore(fx.dataRoot);
    const authority = new WorkspaceAdmissionAuthority({ store: reopened });
    const worktrees = new WorktreeManager(join(fx.root, 'worktrees'));
    const service = new CollaborationWorkflowService({
      store: reopened, workspaces: new WorkspaceManager(reopened), worktrees,
      dispatchRun: async () => { dispatchCalls++; },
      requestRunAdmission: input => authority.requestCanonicalRun(input),
      releaseRunAdmission: input => authority.releaseCanonicalRun(input),
      requestApplicationAdmission: async input => Boolean((await authority.requestCollaborationApplication(input)).grantedAdmission),
      releaseApplicationAdmission: async input => { await authority.releaseCollaborationApplication(input); },
      registerWorktreePath: () => undefined,
      cancelRun: async () => { throw new Error('Pre-Start recovery must not replay cancellation effects'); },
    });
    recoverInterruptedTaskRuntime(reopened, new TaskRunService(reopened), { classifyRunningProcess: () => 'unknown' });
    recoverInterruptedRuns(reopened);
    await new WorkspaceAdmissionStartupReconciler({ store: reopened }).reconcileOnStartup();
    await service.reconcileOnStartup();
    const admission = reopened.getDatabase().prepare('SELECT state FROM workspace_admissions WHERE workspace_id = ? AND canonical_run_id = ?')
      .get('workspace-a', child.id) as { state: string };
    assert.equal(admission.state, 'GRANTED', 'startup admission reconstruction is expected for this free workspace');

    await service.resumeGrantedQueuedRuns();
    assert.equal(new CollaborationRepository(reopened.getDatabase()).findById('workspace-a', fx.plan.id)?.status, 'queued',
      'startup queue handling cannot claim a retry without durable Start authorization');
    assert.equal(dispatchCalls, 0);
    const options = await service.getRecoveryOptions('workspace-a', fx.plan.id);
    assert.equal(options.actions.retryKnownFailure, true, 'a queue-only admission is not Provider side-effect evidence');
    assert.equal(options.resumeRequest?.idempotencyKey, input.idempotencyKey);

    const resumed = await service.recover(input);
    assert.equal(resumed.newRunId, child.id, 'same-key recovery resumes the already-linked child');
    assert.equal(reopened.runRepository().findById('workspace-a', child.id)?.status, 'queued');
    assert.equal(reopened.operationService().listByRun('workspace-a', child.id).filter(operation => operation.type === 'run.start').length, 1);
    assert.equal((reopened.getDatabase().prepare('SELECT COUNT(*) AS count FROM runs WHERE workspace_id = ? AND parent_run_id = ?')
      .get('workspace-a', failed.id) as { count: number }).count, 1);
    assert.equal(dispatchCalls, 1, 'the existing grant dispatches only after same-key recovery authorizes Start');
    const replay = await service.recover(input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.newRunId, child.id);
  } finally {
    reopened?.close();
    await fx.close();
  }
});

test('P2 startup resumes a running collaboration task after its queued child Start claim survives restart', async () => {
  let fx!: ReturnType<typeof fixture>;
  fx = fixture({
    runtimeDispatchEnabled: false,
    requestRunAdmission: input => fx.authority.requestCanonicalRun(input),
  });
  let reopened: SqliteStore | undefined;
  const dispatches: string[] = [];
  try {
    grantRecoveryFixturePermissions(fx);
    const { run: originalRun, collaboration } = fx.runningWithCompletedStart();
    const failed = fx.store.runRepository().transitionStatus('workspace-a', originalRun.id, originalRun.version, 'failed', {
      failureCode: 'RUN_CONFIGURATION_INVALID', failureMessage: 'Deterministic pre-Provider configuration rejection',
    });
    const blocked = fx.repository.progress({ workspaceId: 'workspace-a', id: fx.plan.id,
      expectedVersion: collaboration.version, status: 'blocked', expectedRunId: originalRun.id });
    const recoveryInput = {
      workspaceId: 'workspace-a', collaborationId: fx.plan.id,
      expectedTaskVersion: blocked.version, expectedRunId: failed.id, expectedRunVersion: failed.version,
      idempotencyKey: 'p2-running-queued-child-start-restart-01', action: 'retry-known-failure' as const,
    };
    const recovered = await fx.service.recover(recoveryInput);
    const childRunId = recovered.newRunId;
    assert.ok(childRunId);
    assert.equal(recovered.task.status, 'queued', 'dispatch-disabled recovery leaves the authorized child queued');
    assert.equal(fx.store.runRepository().findById('workspace-a', childRunId)?.status, 'queued');
    assert.equal(fx.store.operationService().listByRun('workspace-a', childRunId)
      .filter(operation => operation.type === 'run.start' && operation.status === 'queued').length, 1);
    assert.equal((fx.store.getDatabase().prepare('SELECT state FROM p2_collaboration_recoveries WHERE idempotency_key = ?')
      .get(recoveryInput.idempotencyKey) as { state: string }).state, 'completed');

    // Reproduce the durable claim/crash boundary: the queue worker commits
    // queued -> running, then the process stops before resumeRun can start.
    const interruptedQueue = productionServiceFor(fx, 'true', async () => { assert.fail('the interrupted process must not dispatch'); });
    interruptedQueue.service.resumeRun = async () => { throw new Error('simulated process stop after queue claim'); };
    await assert.rejects(() => interruptedQueue.service.resumeGrantedQueuedRuns(), /simulated process stop/u);
    const claimedTask = fx.repository.findById('workspace-a', fx.plan.id)!;
    assert.equal(claimedTask.status, 'running');
    assert.equal(claimedTask.canonicalRunId, childRunId);
    assert.equal(fx.store.runRepository().findById('workspace-a', childRunId)?.status, 'queued');
    const claimedVersion = claimedTask.version;
    const stageAttempts = fx.store.runStageRepository().listByRun('workspace-a', childRunId)
      .map(stage => ({ id: stage.id, attempt: stage.attempt }));
    fx.closeDatabase();

    reopened = new SqliteStore(fx.dataRoot);
    const activeStore = reopened;
    const production = productionServiceFor({ root: fx.root, dataRoot: fx.dataRoot, store: activeStore }, 'true', async (workspaceId, resumedRunId) => {
      dispatches.push(resumedRunId);
      admitFollowerToApproval(activeStore, workspaceId, resumedRunId);
    });
    await recoverFullStartup(activeStore, production.service);
    const repository = new CollaborationRepository(activeStore.getDatabase());
    const current = () => repository.findById('workspace-a', fx.plan.id)!;
    assert.equal(current().status, 'running', 'startup reconciliation must preserve the committed queue claim');
    assert.equal(current().version, claimedVersion, 'reconciliation must not rewrite the already-running task');
    assert.equal(current().canonicalRunId, childRunId);
    assert.equal(activeStore.runRepository().findById('workspace-a', childRunId)?.status, 'queued');
    assert.equal((activeStore.getDatabase().prepare('SELECT state FROM workspace_admissions WHERE canonical_run_id = ?')
      .get(childRunId) as { state: string }).state, 'GRANTED');
    assert.deepEqual(dispatches, [], 'startup reconciliation itself never dispatches the queued child');

    const admissions = new WorkspaceAdmissionRepository(activeStore.getDatabase());
    const setAdmission = (state: 'GRANTED' | 'QUEUED') => {
      const existing = admissions.findBySubject('workspace-a', { subjectKind: 'CANONICAL_RUN', canonicalRunId: childRunId });
      assert.ok(existing);
      assert.equal(admissions.updateState({
        workspaceId: 'workspace-a', admissionId: existing.id, expectedVersion: existing.version, state,
        queueReason: state === 'QUEUED' ? 'fixture tests the non-granted queue fence' : null,
        releaseReason: null, grantedAt: state === 'GRANTED' ? NOW : null, releasedAt: null,
        effectiveMutationClass: existing.effectiveMutationClass,
        enforcementEvidenceJson: existing.enforcementEvidenceJson, updatedAt: NOW,
      }), true);
    };
    const assertStillFenced = async (message: string) => {
      await production.service.resumeGrantedQueuedRuns();
      assert.deepEqual(dispatches, [], message);
      assert.equal(current().status, 'running', 'a rejected candidate must retain its persisted task status');
      assert.equal(current().version, claimedVersion, 'a rejected candidate must not rewrite the claimed task');
    };

    // Mutate the admission after the inventory scan but before its claim
    // transaction to prove that the worker uses fresh authorization evidence.
    const originalTransaction = activeStore.runInTransaction.bind(activeStore);
    let changedAfterScan = false;
    activeStore.runInTransaction = fn => {
      if (!changedAfterScan) {
        setAdmission('QUEUED');
        changedAfterScan = true;
      }
      return originalTransaction(fn);
    };
    await assertStillFenced('a stale GRANTED inventory row cannot dispatch after the admission became non-GRANTED');
    activeStore.runInTransaction = originalTransaction;
    assert.equal(changedAfterScan, true);
    setAdmission('GRANTED');

    const db = activeStore.getDatabase();
    const start = activeStore.operationService().listByRun('workspace-a', childRunId)
      .find(operation => operation.type === 'run.start')!;
    assert.ok(start);
    db.prepare('DELETE FROM operations WHERE workspace_id = ? AND id = ?').run('workspace-a', start.id);
    await assertStillFenced('a queued child without a durable Start cannot dispatch');
    const restoredStart = activeStore.operationService().create({ workspaceId: 'workspace-a', runId: childRunId, type: 'run.start' });

    const duplicateStart = activeStore.operationService().create({ workspaceId: 'workspace-a', runId: childRunId, type: 'run.start' });
    await assertStillFenced('duplicate Start authorization cannot dispatch');
    db.prepare('DELETE FROM operations WHERE workspace_id = ? AND id = ?').run('workspace-a', duplicateStart.id);
    assert.equal(activeStore.operationService().listByRun('workspace-a', childRunId)
      .filter(operation => operation.type === 'run.start').length, 1);
    assert.equal(restoredStart.status, 'queued');

    let childRun = activeStore.runRepository().findById('workspace-a', childRunId)!;
    activeStore.runInTransaction(() => activeStore.runRepository().markRecoveryRequiredWithinTransaction({
      workspaceId: 'workspace-a', runId: childRunId, expectedStatus: 'queued', expectedVersion: childRun.version,
      timestamp: new Date().toISOString(),
    }));
    await assertStillFenced('recovery-required Run state cannot dispatch');
    db.prepare('UPDATE runs SET recovery_required = 0,version = version + 1,updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(NOW, 'workspace-a', childRunId);

    const controls = new CollaborationControlRepository(db);
    const pending = activeStore.runInTransaction(() => controls.reserve({
      workspaceId: 'workspace-a', collaborationId: fx.plan.id, action: 'cancel', expectedVersion: current().version,
      idempotencyKey: 'p2-running-queue-pending-control-fence',
    }));
    await assertStillFenced('a pending collaboration control cannot dispatch the queued child');
    activeStore.runInTransaction(() => controls.finish(pending.control, current()));

    const runCount = (db.prepare('SELECT COUNT(*) AS count FROM runs WHERE workspace_id = ?').get('workspace-a') as { count: number }).count;
    await production.service.resumeGrantedQueuedRuns();
    assert.deepEqual(dispatches, [childRunId], 'the recovered queue claim resumes the same child exactly once');
    assert.equal(current().status, 'running');
    assert.equal(current().version, claimedVersion, 'a task already claimed before restart is not written again');
    assert.equal(current().canonicalRunId, childRunId);
    assert.equal(activeStore.runRepository().findById('workspace-a', childRunId)?.status, 'waiting_approval');
    assert.deepEqual(activeStore.runStageRepository().listByRun('workspace-a', childRunId)
      .map(stage => ({ id: stage.id, attempt: stage.attempt })), stageAttempts,
    'recovery keeps the existing Run and stage attempts');
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM runs WHERE workspace_id = ?').get('workspace-a') as { count: number }).count, runCount,
      'recovery cannot create another Run');
    await production.service.resumeGrantedQueuedRuns();
    assert.deepEqual(dispatches, [childRunId], 'a subsequent queue sweep cannot dispatch the same Run again');
  } finally {
    reopened?.close();
    await fx.close();
  }
});

test('P2 retry recovery rechecks durable Start evidence inside the Start authorization transaction', async () => {
  const fx = fixture({ runtimeDispatchEnabled: false });
  try {
    grantRecoveryFixturePermissions(fx);
    const { run, collaboration } = fx.runningWithCompletedStart();
    const failed = fx.store.runRepository().transitionStatus('workspace-a', run.id, run.version, 'failed', {
      failureCode: 'RUN_CONFIGURATION_INVALID', failureMessage: 'Deterministic pre-Provider configuration rejection',
    });
    const blocked = fx.repository.progress({ workspaceId: 'workspace-a', id: fx.plan.id,
      expectedVersion: collaboration.version, status: 'blocked', expectedRunId: run.id });
    const input = {
      workspaceId: 'workspace-a', collaborationId: fx.plan.id,
      expectedTaskVersion: blocked.version, expectedRunId: failed.id, expectedRunVersion: failed.version,
      idempotencyKey: 'p2-recovery-resume-evidence-fence-01', action: 'retry-known-failure' as const,
    };
    const preflight = fx.worktrees.preflight.bind(fx.worktrees);
    let sourcePreflights = 0;
    fx.worktrees.preflight = async (root, options) => {
      const baseCommit = await preflight(root, options);
      if (root === fx.repositoryRoot && ++sourcePreflights === 2) {
        const child = (fx.store.getDatabase().prepare('SELECT id FROM runs WHERE workspace_id = ? AND parent_run_id = ?')
          .get('workspace-a', failed.id) as { id: string }).id;
        fx.store.operationService().create({ workspaceId: 'workspace-a', runId: child, type: 'run.start' });
      }
      return baseCommit;
    };
    await assert.rejects(() => fx.service.recover(input), error =>
      (error as { code?: string }).code === 'COLLABORATION_RECOVERY_REQUIRED');
    const child = (fx.store.getDatabase().prepare('SELECT id FROM runs WHERE workspace_id = ? AND parent_run_id = ?')
      .get('workspace-a', failed.id) as { id: string }).id;
    const recovery = fx.store.getDatabase().prepare('SELECT id FROM p2_collaboration_recoveries WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as { id: string };

    const options = await fx.service.getRecoveryOptions('workspace-a', fx.plan.id);
    assert.equal(options.actions.retryKnownFailure, false);
    assert.equal(options.actions.newLinkedTask, true,
      'a queued Start is not replayable but can be safely retired into a clean linked task');
    assert.match(options.reason ?? '', /Start.*不会重放/u);
    assert.equal(fx.service.canDispatch('workspace-a', child), false,
      'the unresolved P2 row fences startup and every dispatch boundary');
    const linkInput = {
      ...input,
      expectedTaskVersion: options.taskVersion,
      expectedRunId: options.runId!,
      expectedRunVersion: options.runVersion!,
      action: 'new-linked-task' as const,
      idempotencyKey: 'p2-recovery-start-linked-clean-01',
    };
    const linked = await fx.service.recover(linkInput);
    assert.equal(linked.task.status, 'awaiting_confirmation');
    assert.equal(linked.checkedBaseCommit, fx.plan.baseCommit);
    assert.equal(fx.store.runRepository().findById('workspace-a', child)?.status, 'cancelled');
    assert.deepEqual(fx.store.operationService().listByRun('workspace-a', child)
      .filter(item => item.type === 'run.start').map(item => item.status), ['cancelled']);
    assert.equal(fx.repository.findById('workspace-a', fx.plan.id)?.canonicalRunId, child,
      'the old task retains the cancelled child as its canonical history');
    assert.equal(fx.repository.findById('workspace-a', fx.plan.id)?.status, 'blocked');
    assert.equal(fx.worktrees.listLeases().some(item => item.runId === child && item.status === 'active'), true,
      'the old owned lease remains preserved for inspection');
    assert.equal(fx.store.operationService().listByRun('workspace-a', child).filter(item => item.type === 'run.start').length, 1,
      'the recovery never adds a second Start operation');
    assert.equal((fx.store.getDatabase().prepare('SELECT state FROM p2_collaboration_recoveries WHERE id = ?')
      .get(recovery.id) as { state: string }).state, 'recovery_required');
    const replay = await fx.service.recover(linkInput);
    assert.equal(replay.replayed, true);
    assert.equal(replay.task.id, linked.task.id);
    await assert.rejects(() => fx.service.recover({ ...linkInput, expectedRunVersion: linkInput.expectedRunVersion + 1 }), error =>
      (error as { code?: string }).code === 'COLLABORATION_RECOVERY_IDEMPOTENCY_CONFLICT');
  } finally { await fx.close(); }
});

test('P2 retry recovery rolls back failed Retry acceptance and resumes with the same body-bound key', async () => {
  const fx = fixture({ runtimeDispatchEnabled: false });
  try {
    grantRecoveryFixturePermissions(fx);
    const { run, collaboration } = fx.runningWithCompletedStart();
    const failed = fx.store.runRepository().transitionStatus('workspace-a', run.id, run.version, 'failed', {
      failureCode: 'RUN_CONFIGURATION_INVALID', failureMessage: 'Deterministic pre-Provider configuration rejection',
    });
    const blocked = fx.repository.progress({ workspaceId: 'workspace-a', id: fx.plan.id,
      expectedVersion: collaboration.version, status: 'blocked', expectedRunId: run.id });
    const input = {
      workspaceId: 'workspace-a', collaborationId: fx.plan.id,
      expectedTaskVersion: blocked.version, expectedRunId: failed.id, expectedRunVersion: failed.version,
      idempotencyKey: 'p2-recovery-retry-rollback-01', action: 'retry-known-failure' as const,
    };
    const taskRuns = (fx.service as unknown as { taskRuns: TaskRunService }).taskRuns;
    const originalRetry = taskRuns.retryRunOperationForV2.bind(taskRuns);
    taskRuns.retryRunOperationForV2 = (workspaceId, parentRunId, key, expectedVersion, beforeRetry) =>
      originalRetry(workspaceId, parentRunId, key, expectedVersion, () => {
        beforeRetry?.();
        throw new Error('injected transactional retry rollback');
      });

    await assert.rejects(() => fx.service.recover(input), /injected transactional retry rollback/u);
    taskRuns.retryRunOperationForV2 = originalRetry;
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ?')
      .get('workspace-a') as { n: number }).n, 1, 'failed acceptance rolls back its child Run');
    assert.equal(fx.store.operationService().listByRun('workspace-a', failed.id).filter(item => item.type === 'run.retry').length, 0,
      'failed acceptance rolls back its Retry operation');
    assert.equal(fx.repository.findById('workspace-a', fx.plan.id)?.canonicalRunId, failed.id,
      'failed acceptance does not change the canonical collaboration owner');
    const recovery = fx.store.getDatabase().prepare(`SELECT checked_base_commit,state FROM p2_collaboration_recoveries
      WHERE idempotency_key = ?`).get(input.idempotencyKey) as { checked_base_commit: string; state: string };
    assert.equal(recovery.checked_base_commit, fx.plan.baseCommit);
    assert.equal(recovery.state, 'recovery_required');

    const resumed = await fx.service.recover(input);
    assert.ok(resumed.newRunId);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ?')
      .get('workspace-a') as { n: number }).n, 2);
    assert.equal(fx.store.runRepository().findById('workspace-a', resumed.newRunId!)?.parentRunId, failed.id);
    assert.equal(fx.store.operationService().listByRun('workspace-a', failed.id).filter(item => item.type === 'run.retry').length, 1);
  } finally { await fx.close(); }
});

test('P2 recovery review: UNKNOWN effects fail closed and clean linked recovery is body-bound/idempotent', async () => {
  let dispatchCalls = 0;
  const fx = fixture({ runtimeDispatchEnabled: false, dispatchRun: async () => { dispatchCalls++; } });
  try {
    grantRecoveryFixturePermissions(fx);
    const { run, collaboration } = fx.runningWithCompletedStart();
    const failed = fx.store.runRepository().transitionStatus('workspace-a', run.id, run.version, 'failed', {
      failureCode: 'RUN_PROCESS_UNKNOWN', failureMessage: 'Provider side effects could not be determined',
    });
    const blocked = fx.repository.progress({ workspaceId: 'workspace-a', id: fx.plan.id,
      expectedVersion: collaboration.version, status: 'blocked', expectedRunId: run.id });
    const linkedInput = {
      workspaceId: 'workspace-a', collaborationId: fx.plan.id,
      expectedTaskVersion: blocked.version, expectedRunId: failed.id, expectedRunVersion: failed.version,
      idempotencyKey: 'p2-unknown-linked-review-01', action: 'new-linked-task' as const,
    };
    const retryInput = { ...linkedInput, idempotencyKey: 'p2-unknown-retry-review-01', action: 'retry-known-failure' as const };
    const runCountBefore = (fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ?').get('workspace-a') as { n: number }).n;

    await assert.rejects(() => fx.service.recover(retryInput), error =>
      (error as { code?: string }).code === 'COLLABORATION_RECOVERY_UNRESOLVED');
    const dirtyMarker = join(fx.repositoryRoot, 'uncommitted-recovery-marker.txt');
    writeFileSync(dirtyMarker, 'must not be copied into a linked recovery baseline\n');
    await assert.rejects(() => fx.service.recover(linkedInput), error =>
      (error as { code?: string }).code === 'COLLABORATION_RECOVERY_UNRESOLVED');
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM p2_collaboration_recoveries').get() as { n: number }).n, 0,
      'a dirty/uninspectable baseline must not burn the unique recovery idempotency key');
    rmSync(dirtyMarker);
    writeFileSync(join(fx.repositoryRoot, 'README.md'), 'clean, reviewed recovery baseline\n');
    execFileSync('git', ['add', 'README.md'], { cwd: fx.repositoryRoot, windowsHide: true });
    execFileSync('git', ['commit', '-qm', 'advance clean recovery baseline'], { cwd: fx.repositoryRoot, windowsHide: true });

    const [first, concurrent] = await Promise.all([
      fx.service.recover(linkedInput), fx.service.recover(linkedInput),
    ]);
    assert.equal(first.task.id, concurrent.task.id);
    assert.deepEqual([first.replayed, concurrent.replayed].sort(), [false, true]);
    assert.equal(first.task.status, 'awaiting_confirmation');
    assert.equal(first.task.baseCommit, first.checkedBaseCommit);
    assert.equal(first.task.canonicalRunId, undefined, 'linked task requires fresh confirmation and has no old Run attached');
    assert.match(first.task.objective, new RegExp(`linked from collaboration ${fx.plan.id}, Run ${failed.id}`));
    assert.match(first.task.objective, /interrupted Provider call was not resumed/);
    assert.equal(first.checkedBaseCommit, execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fx.repositoryRoot, encoding: 'utf8', windowsHide: true,
    }).trim());
    assert.notEqual(first.checkedBaseCommit, fx.plan.baseCommit,
      'linked recovery uses the newly checked clean baseline rather than the interrupted task baseline');
    const original = fx.repository.findById('workspace-a', fx.plan.id)!;
    assert.equal(original.status, 'blocked');
    assert.equal(original.canonicalRunId, failed.id, 'the previous collaboration keeps its original canonical Run');
    assert.equal(fx.store.runRepository().findById('workspace-a', failed.id)?.version, failed.version);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ?').get('workspace-a') as { n: number }).n, runCountBefore,
      'unknown side effects never create a retry Run');
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM p2_collaboration_recoveries').get() as { n: number }).n, 1);
    assert.equal(dispatchCalls, 0, 'unknown Provider call is never replayed');

    await assert.rejects(() => fx.service.recover({ ...linkedInput, expectedRunVersion: failed.version + 1 }), error =>
      (error as { code?: string }).code === 'COLLABORATION_RECOVERY_IDEMPOTENCY_CONFLICT');
    await assert.rejects(() => fx.service.recover({ ...linkedInput, expectedTaskVersion: blocked.version + 1,
      idempotencyKey: 'p2-unknown-linked-stale-01' }), error =>
      (error as { code?: string }).code === 'COLLABORATION_RECOVERY_STALE');
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM collaboration_tasks WHERE workspace_id = ?').get('workspace-a') as { n: number }).n, 2,
      'body conflict and stale CAS do not create another linked task');
  } finally { await fx.close(); }
});

test('P2 recovery permits only linked-task recovery while an unresolved Run remains active', async () => {
  let dispatchCalls = 0;
  const fx = fixture({ runtimeDispatchEnabled: false, dispatchRun: async () => { dispatchCalls++; } });
  try {
    grantRecoveryFixturePermissions(fx);
    const { run, collaboration } = fx.runningWithCompletedStart();
    const unresolved = fx.store.runInTransaction(() => fx.store.runRepository().markRecoveryRequiredWithinTransaction({
      workspaceId: 'workspace-a', runId: run.id, expectedStatus: 'running', expectedVersion: run.version, timestamp: NOW,
    }));
    const blocked = fx.repository.progress({ workspaceId: 'workspace-a', id: fx.plan.id,
      expectedVersion: collaboration.version, status: 'blocked', expectedRunId: run.id });
    const input = {
      workspaceId: 'workspace-a', collaborationId: fx.plan.id,
      expectedTaskVersion: blocked.version, expectedRunId: unresolved.id, expectedRunVersion: unresolved.version,
      idempotencyKey: 'p2-active-unknown-linked-01', action: 'new-linked-task' as const,
    };
    const runCountBefore = (fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ?')
      .get('workspace-a') as { n: number }).n;

    const options = await fx.service.getRecoveryOptions('workspace-a', fx.plan.id);
    assert.equal(options.actions.newLinkedTask, true, 'persisted uncertainty may create a separately confirmed linked task');
    assert.equal(options.actions.retryKnownFailure, false, 'an active Run with unknown effects is never retryable');
    await assert.rejects(() => fx.service.recover({ ...input, idempotencyKey: 'p2-active-unknown-retry-01', action: 'retry-known-failure' }),
      error => (error as { code?: string }).code === 'COLLABORATION_RECOVERY_UNRESOLVED');

    const linked = await fx.service.recover(input);
    assert.equal(linked.task.status, 'awaiting_confirmation');
    assert.equal(linked.task.canonicalRunId, undefined);
    assert.equal(linked.task.baseCommit, linked.checkedBaseCommit);
    const runCountAfter = (fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ?')
      .get('workspace-a') as { n: number }).n;
    assert.equal(runCountAfter, runCountBefore, 'unknown effects never create or replay a Run');
    const priorRun = fx.store.runRepository().findById('workspace-a', run.id)!;
    assert.equal(priorRun.status, 'running');
    assert.equal(priorRun.recoveryRequired, true, 'linked recovery does not claim the old Provider process resolved');
    assert.equal(dispatchCalls, 0);
  } finally { await fx.close(); }
});

test('P2 linked recovery binds its new task to the exact SHA returned by preflight', async () => {
  const fx = fixture();
  try {
    grantRecoveryFixturePermissions(fx);
    const { run, collaboration } = fx.runningWithCompletedStart();
    const failed = fx.store.runRepository().transitionStatus('workspace-a', run.id, run.version, 'failed', {
      failureCode: 'RUN_PROCESS_UNKNOWN', failureMessage: 'Provider side effects could not be determined',
    });
    const blocked = fx.repository.progress({ workspaceId: 'workspace-a', id: fx.plan.id,
      expectedVersion: collaboration.version, status: 'blocked', expectedRunId: run.id });
    const input = {
      workspaceId: 'workspace-a', collaborationId: fx.plan.id,
      expectedTaskVersion: blocked.version, expectedRunId: failed.id, expectedRunVersion: failed.version,
      idempotencyKey: 'p2-unknown-linked-preflight-race-01', action: 'new-linked-task' as const,
    };

    const realPreflight = fx.worktrees.preflight.bind(fx.worktrees);
    let checkedAtPreflight: string | undefined;
    fx.worktrees.preflight = async (workspaceRoot, options) => {
      const checked = await realPreflight(workspaceRoot, options);
      if (checkedAtPreflight === undefined) {
        checkedAtPreflight = checked;
        writeFileSync(join(workspaceRoot, 'README.md'), 'clean source advanced after preflight returned its checked SHA\n');
        execFileSync('git', ['add', 'README.md'], { cwd: workspaceRoot, windowsHide: true });
        execFileSync('git', ['commit', '-qm', 'advance source after preflight'], { cwd: workspaceRoot, windowsHide: true });
      }
      return checked;
    };

    const result = await fx.service.recover(input);
    assert.ok(checkedAtPreflight);
    const liveHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fx.repositoryRoot, encoding: 'utf8', windowsHide: true,
    }).trim();
    assert.notEqual(liveHead, checkedAtPreflight, 'the fixture advanced HEAD after preflight had completed its check');
    assert.equal(result.checkedBaseCommit, checkedAtPreflight);
    assert.equal(result.task.baseCommit, checkedAtPreflight, 'the linked task is anchored to the SHA preflight actually validated');
    const persisted = fx.store.getDatabase().prepare(`SELECT checked_base_commit,state FROM p2_collaboration_recoveries
      WHERE workspace_id = ? AND idempotency_key = ?`).get('workspace-a', input.idempotencyKey) as {
      checked_base_commit: string; state: string;
    };
    assert.deepEqual({ ...persisted }, { checked_base_commit: checkedAtPreflight, state: 'completed' });
  } finally { await fx.close(); }
});
