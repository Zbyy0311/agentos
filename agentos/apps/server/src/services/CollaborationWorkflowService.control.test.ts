import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { CollaborationControlRepository } from '../store/CollaborationControlRepository.js';
import { CollaborationApplyJournalService } from './CollaborationApplyJournal.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { CollaborationWorkflowError, CollaborationWorkflowService } from './CollaborationWorkflowService.js';
import { createCollaborationRoutes } from '../routes/collaborations.js';
import { collaborationCandidateContentHash } from './CollaborationCandidateContentHash.js';
import { WorkspaceAdmissionAuthority } from './WorkspaceAdmissionAuthority.js';
import { WorkspaceAdmissionStartupReconciler } from './WorkspaceAdmissionStartupReconciler.js';
import { TaskRunService } from './TaskRunService.js';
import { recoverInterruptedTaskRuntime } from '../taskRecovery.js';
import { recoverInterruptedRuns } from '../runRecovery.js';
import { WorktreeManager } from './WorktreeManager.js';
import { NOW, fixture, conflict } from './CollaborationWorkflowService.test-fixture.js';


for (let repetition = 1; repetition <= 3; repetition++) {
  test(`F02 running Run is cancelled despite completed start Operation (${repetition}/3)`, async () => {
    const fx = fixture();
    try {
      const { run, collaboration, operation } = fx.runningWithCompletedStart();
      const result = await fx.service.cancel({ workspaceId: 'workspace-a', collaborationId: fx.plan.id, expectedVersion: collaboration.version, idempotencyKey: 'running-cancel' });
      assert.equal(result.status, 'cancelled');
      assert.equal(fx.store.runRepository().findById('workspace-a', run.id)?.status, 'cancelled');
      assert.equal(fx.cancelCalls(), 1);
      const replay = await fx.service.cancel({ workspaceId: 'workspace-a', collaborationId: fx.plan.id, expectedVersion: collaboration.version, idempotencyKey: 'running-cancel' });
      assert.equal(replay.status, 'cancelled'); assert.equal(fx.cancelCalls(), 1);
      assert.equal(fx.store.operationService().listByRun('workspace-a', run.id).find(row => row.id === operation.id)?.status, 'completed');
      assert.ok(fx.store.runStageRepository().listByRun('workspace-a', run.id).every(stage => stage.status === 'cancelled'));
    } finally { await fx.close(); }
  });
  test(`F01 stale application is rejected before writing files (${repetition}/3)`, async () => {
    const fx = fixture();
    try {
      const ready = await fx.verifiedReady();
      await assert.rejects(fx.service.apply(fx.applicationInput(ready, 'stale-apply', ready.version - 1)), conflict);
      assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), 'base\n');
      assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: fx.repositoryRoot, encoding: 'utf8', windowsHide: true }), '');
      assert.equal(fx.repository.findById(ready.workspaceId, ready.id)?.status, 'awaiting_application');
    } finally { await fx.close(); }
  });

  test(`F03 stale cancellation has no Run or process side effect (${repetition}/3)`, async () => {
    const fx = fixture();
    try {
      const { run, collaboration } = fx.queued();
      await assert.rejects(fx.service.cancel({ workspaceId: 'workspace-a', collaborationId: fx.plan.id, expectedVersion: collaboration.version - 1, idempotencyKey: 'stale-cancel' }), conflict);
      assert.equal(fx.cancelCalls(), 0);
      assert.equal(fx.store.runRepository().findById('workspace-a', run.id)?.status, 'queued');
      assert.equal(fx.repository.findById('workspace-a', fx.plan.id)?.status, 'queued');
    } finally { await fx.close(); }
  });

  test(`F05 confirm checks client version before creating canonical graph (${repetition}/3)`, async () => {
    const fx = fixture();
    try {
      await assert.rejects(fx.service.confirm({ workspaceId: 'workspace-a', collaborationId: fx.plan.id, expectedVersion: 100, idempotencyKey: 'stale-confirm' }), conflict);
      const count = fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };
      assert.equal(count.n, 0);
      assert.equal(fx.repository.findById('workspace-a', fx.plan.id)?.status, 'awaiting_confirmation');
    } finally { await fx.close(); }
  });

  test(`F04 repository cannot resurrect cancelled task (${repetition}/3)`, async () => {
    const fx = fixture();
    try {
      const cancelled = fx.repository.cancel('workspace-a', fx.plan.id, fx.plan.version, NOW);
      assert.throws(() => fx.repository.progress({ workspaceId: 'workspace-a', id: cancelled.id, expectedVersion: cancelled.version, status: 'reviewing' }), conflict);
      assert.equal(fx.repository.findById('workspace-a', cancelled.id)?.status, 'cancelled');
    } finally { await fx.close(); }
  });
}

test('positive control: queued collaboration cancellation cancels its canonical Run', async () => {
  const fx = fixture();
  try {
    const { collaboration, run } = fx.queued();
    const result = await fx.service.cancel({ workspaceId: 'workspace-a', collaborationId: collaboration.id, expectedVersion: collaboration.version, idempotencyKey: 'cancel-positive' });
    assert.equal(result.status, 'cancelled');
    assert.equal(fx.store.runRepository().findById('workspace-a', run.id)?.status, 'cancelled');
    assert.equal(fx.cancelCalls(), 1);
  } finally { await fx.close(); }
});

test('candidate preview is served from the persisted frozen candidate after the live workspace changes', async () => {
  const fx = fixture();
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const task = await fx.verifiedReady();
    const candidate = fx.repository.findCandidate(task.workspaceId, task.currentCandidateId!)!;
    assert.ok(candidate.contentHash);
    const details = fx.service.getDetails(task.workspaceId, task.id);
    assert.equal(details.candidate?.id, candidate.id);
    assert.equal(details.candidate?.contentHash, candidate.contentHash);
    assert.equal(details.candidates[0]?.id, candidate.id);
    assert.equal(details.candidates[0]?.contentHash, candidate.contentHash);
    assert.equal('diffText' in details.candidates[0]!, false, 'task details must not eagerly transfer the frozen patch');
    assert.equal('manifest' in details.candidates[0]!, false, 'file metadata is loaded through the paged preview API');
    writeFileSync(join(fx.repositoryRoot, 'README.md'), 'live workspace changed after capture\n');
    const page = fx.service.getCandidatePreview(task.workspaceId, task.id, candidate.id, task.baseCommit, candidate.contentHash!, { offset: 0, limit: 50 });
    const file = fx.service.getCandidatePreviewFileDiff(task.workspaceId, task.id, candidate.id, task.baseCommit, candidate.contentHash!, 0);
    assert.equal(page.contentHash, candidate.contentHash);
    assert.equal(page.files[0]?.path, 'README.md');
    assert.match(file.diffText, /^\+candidate$/mu);
    assert.doesNotMatch(file.diffText, /live workspace changed after capture/u);

    const app = express();
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId', createCollaborationRoutes(fx.service, fx.workspaces));
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}/api/workspaces/${task.workspaceId}/collaboration/tasks/${task.id}`;
    const detailsResponse = await fetch(origin);
    assert.equal(detailsResponse.status, 200);
    const httpDetails = await detailsResponse.json() as { candidates: Array<Record<string, unknown>>; candidate?: Record<string, unknown> };
    assert.equal(httpDetails.candidate?.id, candidate.id);
    assert.equal(httpDetails.candidate?.contentHash, candidate.contentHash);
    assert.equal('diffText' in httpDetails.candidates[0]!, false);
    assert.equal('manifest' in httpDetails.candidates[0]!, false);
    const identity = new URLSearchParams({ candidateBaseCommit: task.baseCommit, candidateContentHash: candidate.contentHash!, offset: '0', limit: '50' });
    const pageResponse = await fetch(`${origin}/candidates/${candidate.id}/preview?${identity}`);
    assert.equal(pageResponse.status, 200);
    assert.equal(pageResponse.headers.get('cache-control'), 'no-store');
    const httpPage = await pageResponse.json() as { candidateId: string; contentHash: string; files: Array<{ path: string }> };
    assert.equal(httpPage.candidateId, candidate.id);
    assert.equal(httpPage.contentHash, candidate.contentHash);
    assert.equal(httpPage.files[0]?.path, 'README.md');
    const diffResponse = await fetch(`${origin}/candidates/${candidate.id}/preview/files/0?${identity}`);
    assert.equal(diffResponse.status, 200);
    const rendered = await diffResponse.json() as { diffText: string; contentHash: string };
    assert.equal(rendered.contentHash, candidate.contentHash);
    assert.match(rendered.diffText, /^\+candidate$/mu);
    assert.doesNotMatch(rendered.diffText, /live workspace changed after capture/u);
    assert.throws(() => fx.service.getCandidatePreview(task.workspaceId, task.id, candidate.id, task.baseCommit, 'f'.repeat(64), { offset: 0, limit: 50 }),
      (error: unknown) => error instanceof CollaborationWorkflowError && error.code === 'COLLABORATION_CANDIDATE_CHANGED');
  } finally {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    await fx.close();
  }
});

test('apply rejects a changed canonical content hash before admission, journal creation, or filesystem writes', async () => {
  const fx = fixture();
  try {
    const task = await fx.verifiedReady();
    await assert.rejects(fx.service.apply({ ...fx.applicationInput(task, 'changed-content-hash'), candidateContentHash: 'f'.repeat(64) }),
      error => (error as { code?: string }).code === 'COLLABORATION_CANDIDATE_CHANGED');
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM collaboration_controls').get() as { n: number }).n, 0);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM collaboration_apply_journals').get() as { n: number }).n, 0);
    assert.equal((fx.store.getDatabase().prepare("SELECT COUNT(*) AS n FROM workspace_admissions WHERE state = 'GRANTED'").get() as { n: number }).n, 0);
    assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), 'base\n');
  } finally { await fx.close(); }
});

test('apply rejects a v2 binary candidate without its manifest image before reservation, admission, or writes', async () => {
  const fx = fixture();
  try {
    const task = await fx.verifiedReady();
    const candidateId = task.currentCandidateId!;
    const diffText = [
      'diff --git a/README.md b/README.md', 'deleted file mode 100644',
      `index ${'1'.repeat(40)}..${'0'.repeat(40)}`, 'GIT binary patch', 'literal 0', '',
    ].join('\n');
    const diffHash = createHash('sha256').update(diffText, 'utf8').digest('hex');
    const contentHash = collaborationCandidateContentHash({
      diffHash, snapshotVersion: 2, manifestVersion: 2, manifest: [],
    });
    fx.store.getDatabase().prepare(`UPDATE collaboration_candidates SET
      diff_hash = ?, diff_text = ?, manifest_json = '[]', manifest_version = 2, content_hash = ?
      WHERE id = ?`).run(diffHash, diffText, contentHash, candidateId);

    await assert.rejects(fx.service.apply({
      ...fx.applicationInput(task, 'missing-binary-manifest'), candidateContentHash: contentHash,
    }), error => (error as { code?: string }).code === 'COLLABORATION_CANDIDATE_CHANGED');
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM collaboration_controls').get() as { n: number }).n, 0);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM collaboration_apply_journals').get() as { n: number }).n, 0);
    assert.equal((fx.store.getDatabase().prepare("SELECT COUNT(*) AS n FROM workspace_admissions WHERE state = 'GRANTED'").get() as { n: number }).n, 0);
    assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), 'base\n');
  } finally { await fx.close(); }
});

for (const point of ['before_write', 'after_write', 'before_commit'] as const) {
  for (let repetition = 1; repetition <= 3; repetition++) {
    test(`F01 application fault ${point} restores exact owned preimages (${repetition}/3)`, async () => {
      const fx = fixture({ applyFault: observed => { if (point === observed) throw new Error(`injected ${point}`); } });
      try {
        const task = await fx.verifiedReady();
        await assert.rejects(fx.service.apply(fx.applicationInput(task, `fault-${point}`)), /injected/);
        assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), 'base\n');
        assert.equal(fx.repository.findById(task.workspaceId, task.id)?.status, 'awaiting_application');
        assert.equal((fx.store.getDatabase().prepare('SELECT state FROM collaboration_apply_journals').get() as { state: string }).state, 'recovered');
        assert.equal((fx.store.getDatabase().prepare('SELECT state FROM collaboration_controls').get() as { state: string }).state, 'failed');
        assert.equal((fx.store.getDatabase().prepare("SELECT COUNT(*) AS n FROM workspace_admissions WHERE state = 'GRANTED'").get() as { n: number }).n, 0);
      } finally { await fx.close(); }
    });
  }
}

test('F01 successful application is journal-committed and same-key replay does not write again', async () => {
  const fx = fixture();
  try {
    const task = await fx.verifiedReady();
    const input = fx.applicationInput(task, 'verified-apply');
    const applied = await fx.service.apply(input);
    assert.equal(applied.status, 'applied');
    assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), 'candidate\n');
    writeFileSync(join(fx.repositoryRoot, 'README.md'), 'user edit after application\n');
    const replay = await fx.service.apply(input);
    assert.equal(replay.version, applied.version);
    assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), 'user edit after application\n');
    assert.equal((fx.store.getDatabase().prepare('SELECT state FROM collaboration_apply_journals').get() as { state: string }).state, 'committed');
  } finally { await fx.close(); }
});

test('F01 concurrent user changes are preserved and unknown application holds the single writer', async () => {
  let fx: ReturnType<typeof fixture>;
  fx = fixture({ applyFault: point => { if (point === 'after_write') {
    writeFileSync(join(fx.repositoryRoot, 'README.md'), 'concurrent user change\n'); throw new Error('injected concurrent change');
  } } });
  try {
    const task = await fx.verifiedReady();
    await assert.rejects(fx.service.apply(fx.applicationInput(task, 'concurrent-edit')), { code: 'COLLABORATION_RECOVERY_REQUIRED' });
    assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), 'concurrent user change\n');
    assert.equal(fx.service.getDetails(task.workspaceId, task.id).task.pendingControl?.state, 'recovery_required');
    assert.equal((fx.store.getDatabase().prepare("SELECT COUNT(*) AS n FROM workspace_admissions WHERE state='GRANTED' AND subject_kind='COLLABORATION_APPLICATION'").get() as { n: number }).n, 1);
    await fx.service.reconcileOnStartup();
    await fx.service.reconcileOnStartup();
    assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), 'concurrent user change\n');
  } finally { await fx.close(); }
});

test('F03/F04 a durable cancellation claim fences competing controls, stage dispatch and late output', async () => {
  let accept!: () => void; const barrier = new Promise<void>(resolve => { accept = resolve; });
  let calls = 0; let fx: ReturnType<typeof fixture>;
  fx = fixture({ cancelRun: async input => { calls++; await barrier;
    return { expectedRunVersion: fx.store.runRepository().findById(input.workspaceId, input.runId)!.version, terminatedProcessIds: [], worktreePreserved: true }; } });
  try {
    const { collaboration, run } = fx.runningWithCompletedStart();
    const input = { workspaceId: collaboration.workspaceId, collaborationId: collaboration.id, expectedVersion: collaboration.version, idempotencyKey: 'barrier-cancel' };
    const cancellation = fx.service.cancel(input);
    assert.equal(fx.service.canDispatch(input.workspaceId, run.id), false);
    assert.equal(fx.service.getDetails(input.workspaceId, input.collaborationId).task.pendingControl?.action, 'cancel');
    await assert.rejects(fx.service.cancel({ ...input, idempotencyKey: 'competitor' }), conflict);
    const replayPending = await fx.service.cancel(input); assert.equal(replayPending.pendingControl?.action, 'cancel'); assert.equal(calls, 1);
    const stage = fx.store.runStageRepository().listByRun(input.workspaceId, run.id)[0];
    await fx.service.completedStage({ workspaceId: input.workspaceId, runId: run.id, stage, role: 'planner', agentId: 'planner', output: 'late output' });
    assert.equal(fx.repository.findStageOutput(input.workspaceId, run.id, stage.id, stage.attempt), undefined);
    accept(); assert.equal((await cancellation).status, 'cancelled');
    await assert.rejects(fx.service.beforeStage({ workspaceId: input.workspaceId, runId: run.id, stage, workspaceRoot: fx.repositoryRoot }), conflict);
    assert.equal(fx.repository.findById(input.workspaceId, collaboration.id)?.status, 'cancelled');
  } finally { accept(); await fx.close(); }
});

for (const scenario of ['queued', 'running-unknown', 'running-missing', 'waiting_approval', 'completed-valid', 'completed-missing', 'cancelled', 'applied'] as const) {
  test(`F08 actual database reopen and full startup composition twice: ${scenario}`, async () => {
    const fx = fixture(); let reopened: SqliteStore | undefined; let dispatches = 0;
    try {
      let expected: string;
      if (scenario === 'queued') { fx.queued(); expected = 'queued'; }
      else if (scenario.startsWith('running-') || scenario === 'waiting_approval') {
        const active = fx.runningWithCompletedStart(); expected = scenario === 'running-missing' ? 'failed' : scenario === 'waiting_approval' ? 'running' : 'blocked';
        if (scenario === 'waiting_approval') {
          const stage = fx.store.runStageRepository().listByRun(fx.plan.workspaceId, active.run.id).find(stage => stage.status === 'running')!;
          fx.store.lifecycleTransactionService().requestApproval({ workspaceId: fx.plan.workspaceId, runId: active.run.id, stageId: stage.id,
            expectedRunVersion: active.run.version, expectedStageVersion: stage.version, correlationId: active.operation.id,
            approvalRequestId: 'approval-fixture-wait', category: 'command', riskLevel: 'high', title: 'Fixture approval', description: 'Await explicit decision', requestSummary: {} });
        }
      }
      else if (scenario === 'cancelled') {
        fx.repository.cancel(fx.plan.workspaceId, fx.plan.id, fx.plan.version, NOW); expected = 'cancelled';
      } else {
        const task = await fx.verifiedReady(); expected = scenario === 'applied' ? 'applied' : scenario === 'completed-valid' ? 'awaiting_application' : 'blocked';
        if (scenario === 'applied') await fx.service.apply(fx.applicationInput(task, 'before-restart-apply'));
        else if (scenario === 'completed-missing') fx.store.getDatabase().prepare('DELETE FROM collaboration_stage_outputs WHERE workspace_id=?').run(task.workspaceId);
        if (scenario !== 'applied') fx.store.getDatabase().prepare("UPDATE collaboration_tasks SET status='reviewing' WHERE workspace_id=? AND id=?").run(task.workspaceId, task.id);
      }
      fx.closeDatabase();
      for (let reboot = 1; reboot <= 2; reboot++) {
        reopened = new SqliteStore(fx.dataRoot);
        const authority = new WorkspaceAdmissionAuthority({ store: reopened });
        const service = new CollaborationWorkflowService({ store: reopened, workspaces: new WorkspaceManager(reopened), worktrees: new WorktreeManager(join(fx.root, 'worktrees')),
          dispatchRun: async () => { dispatches++; }, requestRunAdmission: async () => false, releaseRunAdmission: async () => undefined,
          requestApplicationAdmission: async input => Boolean((await authority.requestCollaborationApplication(input)).grantedAdmission),
          releaseApplicationAdmission: async input => { await authority.releaseCollaborationApplication(input); }, registerWorktreePath: () => undefined,
          cancelRun: async () => { throw new Error('Startup must not replay cancellation effects'); } });
        recoverInterruptedTaskRuntime(reopened, new TaskRunService(reopened), { classifyRunningProcess: () => scenario === 'running-missing' ? 'missing' : 'unknown' });
        recoverInterruptedRuns(reopened);
        reopened.groupInteractionRepository().reconcileInterruptedOnStartup(new Date().toISOString());
        await new WorkspaceAdmissionStartupReconciler({ store: reopened }).reconcileOnStartup();
        await service.reconcileOnStartup();
        assert.equal(service.getDetails(fx.plan.workspaceId, fx.plan.id).task.status, expected, `reboot ${reboot}`);
        assert.equal(dispatches, 0);
        assert.equal((reopened.getDatabase().prepare('SELECT COUNT(*) AS n FROM collaboration_candidates').get() as { n: number }).n, scenario.startsWith('completed-') || scenario === 'applied' ? 1 : 0);
        reopened.close(); reopened = undefined;
      }
    } finally { reopened?.close(); await fx.close(); }
  });
}

for (const crash of ['prepared', 'written', 'mixed', 'recovery_fault', 'corrupt_material'] as const) {
  test(`F01/F08 durable application crash recovery with two actual database reopens: ${crash}`, async () => {
    const fx = fixture(); let reopened: SqliteStore | undefined;
    try {
      const task = await fx.verifiedReady();
      const candidate = fx.repository.findCandidate(task.workspaceId, task.currentCandidateId!)!;
      const controls = new CollaborationControlRepository(fx.store.getDatabase());
      const claim = fx.store.runInTransaction(() => controls.reserve({ workspaceId: task.workspaceId, collaborationId: task.id, action: 'apply', expectedVersion: task.version, idempotencyKey: `crash-${crash}`, ...fx.candidateBinding(task) }));
      const authority = new WorkspaceAdmissionAuthority({ store: fx.store });
      assert.ok((await authority.requestCollaborationApplication({ workspaceId: task.workspaceId, controlId: claim.control.id })).grantedAdmission);
      const journals = new CollaborationApplyJournalService(fx.store.getDatabase());
      const journal = await journals.prepare(claim.control, claim.task, candidate, fx.repositoryRoot);
      fx.store.runInTransaction(() => controls.bind(claim.control, { candidateId: candidate.id }));
      if (crash !== 'prepared') {
        execFileSync('git', ['apply', '--binary', '--whitespace=nowarn', '-'], { cwd: fx.repositoryRoot, input: candidate.diffText, windowsHide: true });
        journals.setState(journal, 'written');
      }
      if (crash === 'mixed') writeFileSync(join(fx.repositoryRoot, 'README.md'), 'user changed during crash\n');
      if (crash === 'corrupt_material') writeFileSync(journal.recoveryPath, 'tampered recovery material');
      fx.closeDatabase();
      for (let reboot = 1; reboot <= 2; reboot++) {
        reopened = new SqliteStore(fx.dataRoot);
        const recoveredAuthority = new WorkspaceAdmissionAuthority({ store: reopened });
        const service = new CollaborationWorkflowService({ store: reopened, workspaces: new WorkspaceManager(reopened), worktrees: new WorktreeManager(join(fx.root, 'worktrees')),
          dispatchRun: async () => { assert.fail('recovery must not start a Provider'); }, requestRunAdmission: async () => false, releaseRunAdmission: async () => undefined,
          requestApplicationAdmission: async input => Boolean((await recoveredAuthority.requestCollaborationApplication(input)).grantedAdmission),
          releaseApplicationAdmission: async input => { await recoveredAuthority.releaseCollaborationApplication(input); }, registerWorktreePath: () => undefined,
          cancelRun: async () => { assert.fail('recovery must not repeat native cancellation'); },
          applyFault: point => { if (crash === 'recovery_fault' && reboot === 1 && point === 'recovery') throw new Error('injected recovery error'); } });
        recoverInterruptedTaskRuntime(reopened, new TaskRunService(reopened)); recoverInterruptedRuns(reopened);
        await new WorkspaceAdmissionStartupReconciler({ store: reopened }).reconcileOnStartup();
        await service.reconcileOnStartup();
        const unresolved = crash === 'mixed' || crash === 'corrupt_material' || (crash === 'recovery_fault' && reboot === 1);
        assert.equal(service.getDetails(task.workspaceId, task.id).task.status, crash === 'prepared' || unresolved ? 'awaiting_application' : 'applied');
        assert.equal((reopened.getDatabase().prepare("SELECT COUNT(*) AS n FROM workspace_admissions WHERE state='GRANTED' AND subject_kind='COLLABORATION_APPLICATION'").get() as { n: number }).n, unresolved ? 1 : 0);
        assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), crash === 'prepared' ? 'base\n' : crash === 'mixed' ? 'user changed during crash\n' : 'candidate\n');
        reopened.close(); reopened = undefined;
      }
    } finally { reopened?.close(); await fx.close(); }
  });
}
