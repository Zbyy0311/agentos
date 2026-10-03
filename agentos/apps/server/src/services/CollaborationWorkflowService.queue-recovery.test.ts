import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { fixture, deferred, productionServiceFor, recoverFullStartup, admitFollowerToApproval, createQueuedBehindApplicationPlan, seedQueuedAuthorityFollower } from './CollaborationWorkflowService.test-fixture.js';


for (const outcome of ['success', 'rollback', 'before_prepare', 'unknown', 'disabled', 'current-run-mismatch'] as const) {
  for (let repetition = 1; repetition <= 3; repetition++) {
    test(`F24 application ${outcome} releases and resumes the exact queued Run once (${repetition}/3)`, async () => {
      let fx!: ReturnType<typeof fixture>;
      const applicationGranted = deferred<string>();
      const continueApplication = deferred<void>();
      const dispatches: Array<{ workspaceId: string; runId: string }> = [];
      let beforePrepareFaults = 0;
      fx = fixture({
        runtimeDispatchEnabled: outcome !== 'disabled',
        requestApplicationAdmission: async input => {
          const result = await fx.authority.requestCollaborationApplication(input);
          assert.ok(result.grantedAdmission, 'A must hold the real application writer before B is confirmed');
          applicationGranted.resolve(input.controlId);
          await continueApplication.promise;
          return true;
        },
        requestRunAdmission: input => fx.authority.requestCanonicalRun(input),
        releaseApplicationAdmission: async input => {
          // Preserve the callback's Promise<void> contract and intentionally drop
          // the authority's GrantedAdmissionSubject[]; recovery must use the
          // durable authority state rather than a test-injected grant.
          await fx.authority.releaseCollaborationApplication(input);
        },
        dispatchRun: async (workspaceId, runId) => {
          dispatches.push({ workspaceId, runId });
          admitFollowerToApproval(fx.store, workspaceId, runId);
        },
        applyFault: point => {
          if (outcome === 'rollback' && point === 'after_write') throw new Error('F24 injected safe rollback');
          if (outcome === 'unknown' && point === 'after_write') {
            writeFileSync(join(fx.repositoryRoot, 'README.md'), 'concurrent user edit\n');
            throw new Error('F24 injected unknown application');
          }
          // The main implementation is adding this seam. String conversion
          // keeps the red test compilable against the pre-seam product type.
          if (outcome === 'before_prepare' && String(point) === 'before_prepare') {
            beforePrepareFaults++;
            throw new Error('F24 injected before_prepare');
          }
        },
      });
      try {
        const taskA = await fx.verifiedReady();
        const applyInput = fx.applicationInput(taskA, `F24-${outcome}-${repetition}`);
        const applying = fx.service.apply(applyInput);
        const controlId = await applicationGranted.promise;
        const holder = fx.store.getDatabase().prepare(
          "SELECT state FROM workspace_admissions WHERE workspace_id = ? AND collaboration_control_id = ? AND subject_kind = 'COLLABORATION_APPLICATION'",
        ).get(taskA.workspaceId, controlId) as { state: string };
        assert.equal(holder.state, 'GRANTED');

        const planB = createQueuedBehindApplicationPlan(fx, `${outcome}-${repetition}`);
        const taskB = await fx.service.confirm({ workspaceId: 'workspace-a', collaborationId: planB.id, expectedVersion: planB.version, idempotencyKey: `F24-confirm-B-${outcome}-${repetition}` });
        assert.equal(taskB.status, 'queued');
        assert.ok(taskB.canonicalRunId);
        assert.ok(Number.isSafeInteger(taskB.controlEpoch));
        const runIdB = taskB.canonicalRunId!;
        const epochB = taskB.controlEpoch;
        const admissionB = fx.store.getDatabase().prepare(
          "SELECT state FROM workspace_admissions WHERE workspace_id = ? AND canonical_run_id = ? AND subject_kind = 'CANONICAL_RUN'",
        ).get('workspace-a', runIdB) as { state: string };
        assert.equal(admissionB.state, 'QUEUED');
        assert.equal(dispatches.length, 0, 'B must remain undispatched while A owns the writer');
        const runCountBeforeRelease = (fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;
        if (outcome === 'current-run-mismatch') {
          assert.ok(taskA.canonicalRunId);
          assert.notEqual(taskA.canonicalRunId, runIdB);
          fx.store.getDatabase().prepare('UPDATE collaboration_tasks SET canonical_run_id = ? WHERE workspace_id = ? AND id = ?')
            .run(taskA.canonicalRunId, 'workspace-a', taskB.id);
        }

        continueApplication.resolve();
        const result = await applying.then(value => ({ value }), error => ({ error }));
        if (outcome === 'before_prepare') {
          assert.equal(beforePrepareFaults, 1, 'the before_prepare fault seam must fire after admission and before journal creation');
          assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM collaboration_apply_journals WHERE control_id = ?')
            .get(controlId) as { n: number }).n, 0, 'pre-prepare failure must leave no journal');
        }
        if (outcome === 'success' || outcome === 'disabled' || outcome === 'current-run-mismatch') {
          assert.ok('value' in result, 'A application should succeed');
          assert.equal(result.value.status, 'applied');
        } else if (outcome === 'unknown') {
          assert.ok('error' in result, 'unknown application must not be acknowledged as successful');
          assert.equal((result.error as { code?: string }).code, 'COLLABORATION_RECOVERY_REQUIRED');
        } else {
          assert.ok('error' in result, `${outcome} must fail before acknowledging application`);
          assert.match(String((result.error as Error).message), new RegExp(`F24 injected ${outcome === 'rollback' ? 'safe rollback' : 'before_prepare'}`));
        }

        if (outcome === 'disabled') {
          if (dispatches.length === 0) await new Promise<void>(resolve => setImmediate(resolve));
          assert.deepEqual(dispatches, [], 'runtimeDispatchEnabled=false must not dispatch an admitted follower');
          const latestB = fx.repository.findById('workspace-a', taskB.id)!;
          assert.equal(latestB.status, 'queued');
          assert.equal(latestB.canonicalRunId, runIdB);
          assert.equal(latestB.controlEpoch, epochB);
          assert.equal((fx.store.getDatabase().prepare('SELECT state FROM workspace_admissions WHERE workspace_id = ? AND canonical_run_id = ?')
            .get('workspace-a', runIdB) as { state: string }).state, 'GRANTED');
        } else if (outcome === 'current-run-mismatch') {
          if (dispatches.length === 0) await new Promise<void>(resolve => setImmediate(resolve));
          assert.deepEqual(dispatches, [], 'a GRANTED admission must not dispatch when its task no longer names that current Run');
          const latestB = fx.repository.findById('workspace-a', taskB.id)!;
          assert.equal(latestB.status, 'queued');
          assert.equal(latestB.canonicalRunId, taskA.canonicalRunId);
          assert.equal(latestB.controlEpoch, epochB);
          assert.equal((fx.store.getDatabase().prepare('SELECT state FROM workspace_admissions WHERE workspace_id = ? AND canonical_run_id = ?')
            .get('workspace-a', runIdB) as { state: string }).state, 'GRANTED');
        } else if (outcome !== 'unknown') {
          if (dispatches.length === 0) await new Promise<void>(resolve => setImmediate(resolve));
          assert.deepEqual(dispatches, [{ workspaceId: 'workspace-a', runId: runIdB }], 'the exact pre-existing queued Run must dispatch exactly once');
          const latestB = fx.repository.findById('workspace-a', taskB.id)!;
          assert.equal(latestB.canonicalRunId, runIdB);
          assert.equal(latestB.controlEpoch, epochB);
          assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, runCountBeforeRelease);
          const admissionAfter = fx.store.getDatabase().prepare(
            "SELECT state FROM workspace_admissions WHERE workspace_id = ? AND canonical_run_id = ?",
          ).get('workspace-a', runIdB) as { state: string };
          assert.equal(admissionAfter.state, 'GRANTED');
          const startedRunB = fx.store.runRepository().findById('workspace-a', runIdB);
          assert.equal(startedRunB?.status, 'waiting_approval');
          const startsB = fx.store.operationService().listByRun('workspace-a', runIdB)
            .filter(operation => operation.type === 'run.start');
          assert.equal(startsB.length, 1);
          assert.equal(startsB[0].status, 'completed');
          const stagesB = fx.store.runStageRepository().listByRun('workspace-a', runIdB);
          if (outcome === 'success') {
            const replay = await fx.service.apply(applyInput);
            assert.equal(replay.status, 'applied');
          } else {
            await assert.rejects(fx.service.apply(applyInput));
          }
          await fx.authority.releaseCollaborationApplication({ workspaceId: 'workspace-a', controlId });
          await fx.service.resumeGrantedQueuedRuns('workspace-a');
          await fx.service.resumeGrantedQueuedRuns();
          assert.equal(dispatches.length, 1, 'same-key replay and duplicate authority release must not dispatch B again');
          assert.deepEqual(fx.store.runRepository().findById('workspace-a', runIdB), startedRunB);
          assert.deepEqual(fx.store.operationService().listByRun('workspace-a', runIdB)
            .filter(operation => operation.type === 'run.start'), startsB);
          assert.deepEqual(fx.store.runStageRepository().listByRun('workspace-a', runIdB), stagesB,
            'same-key replay and repeated queue scans must preserve stage status, version and attempt');
        } else {
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.deepEqual(dispatches, [], 'unknown A must never start B');
          assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), 'concurrent user edit\n');
          assert.equal(fx.service.getDetails(taskA.workspaceId, taskA.id).task.pendingControl?.state, 'recovery_required');
          const application = fx.store.getDatabase().prepare(
            "SELECT state FROM workspace_admissions WHERE workspace_id = ? AND collaboration_control_id = ? AND subject_kind = 'COLLABORATION_APPLICATION'",
          ).get(taskA.workspaceId, controlId) as { state: string };
          const queuedAfter = fx.store.getDatabase().prepare(
            "SELECT state FROM workspace_admissions WHERE workspace_id = ? AND canonical_run_id = ? AND subject_kind = 'CANONICAL_RUN'",
          ).get('workspace-a', runIdB) as { state: string };
          assert.equal(application.state, 'GRANTED');
          assert.equal(queuedAfter.state, 'QUEUED');
          assert.equal(fx.repository.findById('workspace-a', taskB.id)?.canonicalRunId, runIdB);
          assert.equal(fx.repository.findById('workspace-a', taskB.id)?.controlEpoch, epochB);
        }
      } finally {
        continueApplication.resolve();
        await fx.close();
      }
    });
  }
}

test('F24 resumes the exact GRANTED Run beyond the default 100-task repository page', async () => {
  let fx!: ReturnType<typeof fixture>;
  const applicationGranted = deferred<string>();
  const continueApplication = deferred<void>();
  const dispatches: Array<{ workspaceId: string; runId: string }> = [];
  fx = fixture({
    requestApplicationAdmission: async input => {
      const result = await fx.authority.requestCollaborationApplication(input);
      assert.ok(result.grantedAdmission);
      applicationGranted.resolve(input.controlId);
      await continueApplication.promise;
      return true;
    },
    requestRunAdmission: input => fx.authority.requestCanonicalRun(input),
    releaseApplicationAdmission: async input => { await fx.authority.releaseCollaborationApplication(input); },
    dispatchRun: async (workspaceId, runId) => {
      dispatches.push({ workspaceId, runId });
      admitFollowerToApproval(fx.store, workspaceId, runId);
    },
  });
  try {
    const taskA = await fx.verifiedReady();
    const applying = fx.service.apply(fx.applicationInput(taskA, 'F24-over-100-A'));
    await applicationGranted.promise;
    const planB = createQueuedBehindApplicationPlan(fx, 'over-100-B');
    const taskB = await fx.service.confirm({ workspaceId: 'workspace-a', collaborationId: planB.id, expectedVersion: planB.version, idempotencyKey: 'F24-over-100-confirm-B' });
    const runIdB = taskB.canonicalRunId!;
    const epochB = taskB.controlEpoch;
    assert.equal(taskB.status, 'queued');
    for (let index = 0; index < 101; index++) await seedQueuedAuthorityFollower(fx, `over-100-${index}`, index);
    fx.store.getDatabase().prepare("UPDATE collaboration_tasks SET updated_at = '2000-01-01T00:00:00.000Z' WHERE workspace_id = ? AND id = ?")
      .run('workspace-a', taskB.id);
    assert.equal(fx.repository.list('workspace-a').length, 100);
    assert.equal(fx.repository.list('workspace-a').some(task => task.id === taskB.id), false,
      'the target must sit beyond the repository default page so this covers full queue recovery');

    continueApplication.resolve();
    const applied = await applying;
    assert.equal(applied.status, 'applied');
    if (dispatches.length === 0) await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(dispatches, [{ workspaceId: 'workspace-a', runId: runIdB }]);
    const currentB = fx.repository.findById('workspace-a', taskB.id)!;
    assert.equal(currentB.canonicalRunId, runIdB);
    assert.equal(currentB.controlEpoch, epochB);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM workspace_admissions WHERE state = \'GRANTED\' AND subject_kind = \'CANONICAL_RUN\'').get() as { n: number }).n, 1);
    const startedRunB = fx.store.runRepository().findById('workspace-a', runIdB);
    assert.equal(startedRunB?.status, 'waiting_approval');
    const startsB = fx.store.operationService().listByRun('workspace-a', runIdB)
      .filter(operation => operation.type === 'run.start');
    assert.equal(startsB.length, 1);
    assert.equal(startsB[0].status, 'completed');
    const stagesB = fx.store.runStageRepository().listByRun('workspace-a', runIdB);
    await fx.service.resumeGrantedQueuedRuns('workspace-a');
    await fx.service.resumeGrantedQueuedRuns();
    assert.deepEqual(dispatches, [{ workspaceId: 'workspace-a', runId: runIdB }]);
    assert.deepEqual(fx.store.runRepository().findById('workspace-a', runIdB), startedRunB);
    assert.deepEqual(fx.store.operationService().listByRun('workspace-a', runIdB)
      .filter(operation => operation.type === 'run.start'), startsB);
    assert.deepEqual(fx.store.runStageRepository().listByRun('workspace-a', runIdB), stagesB,
      'repeated full-inventory scans must preserve the original stage status, version and attempt');
  } finally {
    continueApplication.resolve();
    await fx.close();
  }
});

for (let repetition = 1; repetition <= 3; repetition++) {
  for (const runtimeValue of [undefined, 'false', 'true'] as const) {
    test(`F24 real index constructor and post-listen flag ${runtimeValue ?? 'unset'} govern admitted confirmation (${repetition}/3)`, async () => {
      const fx = fixture();
      const dispatches: string[] = [];
      try {
        const production = productionServiceFor(fx, runtimeValue, async (workspaceId, runId) => {
          dispatches.push(runId);
          admitFollowerToApproval(fx.store, workspaceId, runId);
        });
        const task = await production.service.confirm({ workspaceId: fx.plan.workspaceId, collaborationId: fx.plan.id,
          expectedVersion: fx.plan.version, idempotencyKey: `F24-production-flag-${repetition}` });
        assert.ok(task.canonicalRunId);
        const runId = task.canonicalRunId;
        assert.equal((fx.store.getDatabase().prepare("SELECT state FROM workspace_admissions WHERE canonical_run_id = ? AND subject_kind = 'CANONICAL_RUN'")
          .get(runId) as { state: string }).state, 'GRANTED');
        assert.equal(task.status, runtimeValue === 'true' ? 'running' : 'queued');
        assert.equal(production.service.canDispatch(task.workspaceId, runId), runtimeValue === 'true');
        const expectedRunStatus = runtimeValue === 'true' ? 'waiting_approval' : 'queued';
        assert.equal(fx.store.runRepository().findById(task.workspaceId, runId)?.status, expectedRunStatus);
        const starts = fx.store.operationService().listByRun(task.workspaceId, runId)
          .filter(operation => operation.type === 'run.start');
        assert.equal(starts.length, 1);
        assert.equal(starts[0].status, runtimeValue === 'true' ? 'completed' : 'queued');
        const attempts = fx.store.runStageRepository().listByRun(task.workspaceId, runId)
          .map(stage => ({ id: stage.id, attempt: stage.attempt, status: stage.status }));
        if (runtimeValue !== 'true') await production.service.resumeRun(task.workspaceId, runId);
        await production.startProductionBackground();
        assert.deepEqual(dispatches, runtimeValue === 'true' ? [runId] : []);
        assert.equal(production.approvalResumes(), runtimeValue === 'true' ? 1 : 0, 'the real post-listen approval entry must share the runtime switch');
        await production.startProductionBackground();
        await production.service.resumeGrantedQueuedRuns(task.workspaceId);
        assert.deepEqual(dispatches, runtimeValue === 'true' ? [runId] : [],
          'repeated production queue scans must not dispatch the already-started Run again');
        assert.equal(fx.store.runRepository().findById(task.workspaceId, runId)?.status, expectedRunStatus);
        assert.deepEqual(fx.store.runStageRepository().listByRun(task.workspaceId, runId)
          .map(stage => ({ id: stage.id, attempt: stage.attempt, status: stage.status })), attempts,
        'repeated production queue scans must preserve the existing stage attempts');
        assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 1);
      } finally { await fx.close(); }
    });
  }

  test(`F24 disabled admitted confirmation stays queued then enabled production startup resumes its original Run once across two DB reopens (${repetition}/3)`, async () => {
    const fx = fixture();
    let reopened: SqliteStore | undefined;
    const dispatches: string[] = [];
    try {
      const disabled = productionServiceFor(fx, 'false', async (_workspaceId, runId) => { dispatches.push(runId); });
      const task = await disabled.service.confirm({ workspaceId: fx.plan.workspaceId, collaborationId: fx.plan.id,
        expectedVersion: fx.plan.version, idempotencyKey: 'F24-disabled-confirm-enable-on-startup' });
      const runId = task.canonicalRunId!;
      assert.equal(task.status, 'queued');
      assert.equal(disabled.service.canDispatch(task.workspaceId, runId), false);
      await disabled.startProductionBackground();
      assert.equal(dispatches.length, 0);
      assert.equal(disabled.approvalResumes(), 0);
      fx.closeDatabase();
      let attempts: Array<{ id: string; attempt: number; status: string }> | undefined;
      for (let reboot = 1; reboot <= 2; reboot++) {
        reopened = new SqliteStore(fx.dataRoot);
        const activeStore = reopened;
        const production = productionServiceFor({ root: fx.root, dataRoot: fx.dataRoot, store: activeStore }, 'true', async (workspaceId, resumedRunId) => {
          assert.equal(resumedRunId, runId);
          dispatches.push(resumedRunId);
          admitFollowerToApproval(activeStore, workspaceId, resumedRunId);
        });
        await recoverFullStartup(activeStore, production.service);
        assert.equal(dispatches.length, reboot === 1 ? 0 : 1, 'recovery itself must not dispatch an unstarted or waiting-approval Run');
        await production.startProductionBackground(true);
        assert.equal(dispatches.length, reboot === 1 ? 0 : 1, 'the maintenance fence blocks startup queue dispatch');
        assert.equal(production.approvalResumes(), 0, 'the maintenance fence blocks approval queue dispatch');
        await production.startProductionBackground();
        await production.startProductionBackground();
        assert.deepEqual(dispatches, [runId], 'duplicate production queue entries and reboot must not replay the original Run');
        const latest = production.service.getDetails(task.workspaceId, task.id).task;
        assert.equal(latest.canonicalRunId, runId);
        assert.equal(latest.controlEpoch, task.controlEpoch);
        assert.equal(activeStore.runRepository().findById(task.workspaceId, runId)?.status, 'waiting_approval');
        const currentAttempts = activeStore.runStageRepository().listByRun(task.workspaceId, runId)
          .map(stage => ({ id: stage.id, attempt: stage.attempt, status: stage.status }));
        if (attempts) assert.deepEqual(currentAttempts, attempts);
        else attempts = currentAttempts;
        assert.equal((activeStore.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 1);
        assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), 'base\n');
        activeStore.close(); reopened = undefined;
      }
    } finally { reopened?.close(); await fx.close(); }
  });
}
