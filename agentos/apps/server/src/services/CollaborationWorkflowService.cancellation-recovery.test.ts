import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CollaborationTask } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { isTransactionActive } from '../store/Transaction.js';
import { WorkspaceAdmissionAuthority } from './WorkspaceAdmissionAuthority.js';
import { fixture, deferred, productionServiceFor, recoverFullStartup, admitFollowerToApproval, createQueuedBehindApplicationPlan } from './CollaborationWorkflowService.test-fixture.js';


for (let repetition = 1; repetition <= 3; repetition++) {
  for (const recovery of ['restart', 'same-key-retry'] as const) {
    for (const safe of [true, false]) {
      test(`F24 cancel-gap control ${recovery} ${safe ? 'safe release' : 'unknown hold'} never dispatches cancelled B and resumes C once (${repetition}/3)`, async () => {
        let fx!: ReturnType<typeof fixture>;
        let reopened: SqliteStore | undefined;
        let applying: Promise<{ value?: CollaborationTask; error?: unknown }> | undefined;
        const applicationGranted = deferred<string>();
        const continueApplication = deferred<void>();
        const dispatches: string[] = [];
        let runIdB = ''; let runIdC = ''; let cancelGapHits = 0; let applicationGapHits = 0;
        const applyPoints: string[] = [];
        fx = fixture({
          runtimeDispatchEnabled: false,
          requestApplicationAdmission: async input => {
            assert.ok((await fx.authority.requestCollaborationApplication(input)).grantedAdmission);
            applicationGranted.resolve(input.controlId); await continueApplication.promise; return true;
          },
          requestRunAdmission: input => fx.authority.requestCanonicalRun(input),
          releaseRunAdmission: async input => {
            const db = fx.store.getDatabase();
            assert.equal(isTransactionActive(db), false);
            assert.equal(input.runId, runIdB);
            assert.equal(fx.store.runRepository().findById(input.workspaceId, runIdB)?.status, 'cancelled');
            assert.equal((db.prepare("SELECT state FROM collaboration_controls WHERE action = 'cancel' AND canonical_run_id = ?").get(runIdB) as { state: string }).state, 'completed');
            assert.equal(fx.repository.findByCanonicalRun(input.workspaceId, runIdB)?.status, 'cancelled');
            cancelGapHits++;
            throw new Error('F24 process crash after cancel task/Run/control commit before admission release');
          },
          releaseApplicationAdmission: async input => {
            const authority = new WorkspaceAdmissionAuthority({ store: fx.store, testHooks: { afterEvidenceCollectionOutsideTransaction: () => {
              const db = fx.store.getDatabase();
              assert.equal(isTransactionActive(db), false);
              assert.equal((db.prepare('SELECT state FROM workspace_admissions WHERE collaboration_control_id = ?').get(input.controlId) as { state: string }).state, 'RELEASED');
              for (const runId of [runIdB, runIdC]) assert.equal((db.prepare('SELECT state FROM workspace_admissions WHERE canonical_run_id = ?').get(runId) as { state: string }).state, 'QUEUED');
              applicationGapHits++;
              throw new Error('F24 crash after safe A release commit before pending queue advancement');
            } } });
            await authority.releaseCollaborationApplication(input);
          },
          applyFault: point => {
            applyPoints.push(point);
            if (!safe && point === 'after_write') {
              writeFileSync(join(fx.repositoryRoot, 'README.md'), 'cancel-gap concurrent user edit\n');
              throw new Error('F24 unknown A must retain its writer');
            }
          },
          dispatchRun: async () => { assert.fail('disabled initial fixture must not dispatch'); },
        });
        try {
          const taskA = await fx.verifiedReady();
          applying = fx.service.apply(fx.applicationInput(taskA, `cancel-gap-apply-${recovery}-${safe}-${repetition}`)).then(value => ({ value }), error => ({ error }));
          const controlId = await applicationGranted.promise;
          const tasks: CollaborationTask[] = [];
          for (const label of ['B', 'C']) {
            const plan = createQueuedBehindApplicationPlan(fx, `cancel-gap-${label}-${recovery}-${safe}-${repetition}`);
            const task = await fx.service.confirm({ workspaceId: plan.workspaceId, collaborationId: plan.id, expectedVersion: plan.version,
              idempotencyKey: `cancel-gap-confirm-${label}-${recovery}-${safe}-${repetition}` });
            assert.equal(task.status, 'queued'); tasks.push(task);
          }
          const [taskB, taskC] = tasks; runIdB = taskB.canonicalRunId!; runIdC = taskC.canonicalRunId!;
          const cancelInput = { workspaceId: taskB.workspaceId, collaborationId: taskB.id, expectedVersion: taskB.version,
            idempotencyKey: `cancel-gap-cancel-${recovery}-${safe}-${repetition}` };
          const cancelled = await fx.service.cancel(cancelInput);
          assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelGapHits, 1); assert.equal(fx.cancelCalls(), 1);
          const db = fx.store.getDatabase();
          const admissionSql = 'SELECT * FROM workspace_admissions WHERE canonical_run_id = ?';
          const beforeB = db.prepare(admissionSql).get(runIdB) as { id: string; state: string; request_order: number };
          const beforeC = db.prepare(admissionSql).get(runIdC) as { id: string; state: string; request_order: number };
          assert.equal(beforeB.state, 'QUEUED'); assert.equal(beforeC.state, 'QUEUED');
          const cancelledRun = fx.store.runRepository().findById(taskB.workspaceId, runIdB);
          const cancelledStages = fx.store.runStageRepository().listByRun(taskB.workspaceId, runIdB);
          const cancelControl = db.prepare("SELECT * FROM collaboration_controls WHERE action = 'cancel' AND canonical_run_id = ?").get(runIdB);
          const cAttempts = fx.store.runStageRepository().listByRun(taskC.workspaceId, runIdC).map(stage => ({ id: stage.id, attempt: stage.attempt }));
          continueApplication.resolve(); const outcome = await applying;
          const applicationDiagnostic = JSON.stringify({ applyPoints, error: String(outcome.error),
            control: db.prepare('SELECT state,error_code,error_message FROM collaboration_controls WHERE id = ?').get(controlId),
            journal: db.prepare('SELECT state FROM collaboration_apply_journals WHERE control_id = ?').get(controlId) });
          if (safe) assert.equal(outcome.value?.status, 'applied', applicationDiagnostic);
          else assert.equal((outcome.error as { code?: string })?.code, 'COLLABORATION_RECOVERY_REQUIRED', applicationDiagnostic);
          assert.equal(applicationGapHits, safe ? 1 : 0);
          assert.equal((db.prepare(admissionSql).get(runIdB) as { state: string }).state, 'QUEUED');
          const dispatch = (store: SqliteStore) => async (workspaceId: string, runId: string) => {
            assert.equal(runId, runIdC, 'only C can be driven; cancelled B cannot become a queue winner');
            dispatches.push(runId); admitFollowerToApproval(store, workspaceId, runId);
          };
          if (recovery === 'same-key-retry') {
            const production = productionServiceFor({ root: fx.root, dataRoot: fx.dataRoot, store: fx.store }, 'true', dispatch(fx.store));
            assert.deepEqual(await production.service.cancel(cancelInput), cancelled);
            assert.deepEqual(await production.service.cancel(cancelInput), cancelled);
            assert.equal((db.prepare(admissionSql).get(runIdB) as { state: string }).state, 'CANCELLED');
            assert.deepEqual(dispatches, safe ? [runIdC] : []);
            assert.equal(fx.cancelCalls(), 1); assert.equal(cancelGapHits, 1, 'a completed retry must never repeat the original cancellation');
            assert.deepEqual(db.prepare("SELECT * FROM collaboration_controls WHERE action = 'cancel' AND canonical_run_id = ?").get(runIdB), cancelControl);
          }
          const journal = db.prepare('SELECT recovery_path AS path FROM collaboration_apply_journals WHERE control_id = ?').get(controlId) as { path: string };
          const material = readFileSync(journal.path);
          fx.closeDatabase();
          let stableAdmissions: unknown[] | undefined;
          for (let reboot = 1; reboot <= 2; reboot++) {
            reopened = new SqliteStore(fx.dataRoot); const activeStore = reopened;
            const production = productionServiceFor({ root: fx.root, dataRoot: fx.dataRoot, store: activeStore }, 'true', dispatch(activeStore));
            if (reboot === 1) assert.equal((activeStore.getDatabase().prepare(admissionSql).get(runIdB) as { state: string }).state,
              recovery === 'restart' ? 'QUEUED' : 'CANCELLED', 'the original cancellation window must be durable');
            const beforeDispatch = dispatches.length;
            await recoverFullStartup(activeStore, production.service);
            assert.equal(dispatches.length, beforeDispatch, 'startup reconciliation itself cannot replay work');
            await production.startProductionBackground(); await production.startProductionBackground();
            const b = activeStore.getDatabase().prepare(admissionSql).get(runIdB) as { id: string; state: string; request_order: number; granted_at: string | null };
            const c = activeStore.getDatabase().prepare(admissionSql).get(runIdC) as { id: string; state: string; request_order: number };
            assert.equal(b.id, beforeB.id); assert.equal(b.request_order, beforeB.request_order); assert.equal(b.state, 'CANCELLED'); assert.equal(b.granted_at, null);
            assert.equal(c.id, beforeC.id); assert.equal(c.request_order, beforeC.request_order); assert.equal(c.state, safe ? 'GRANTED' : 'QUEUED');
            assert.deepEqual(dispatches, safe ? [runIdC] : []);
            assert.deepEqual(activeStore.runRepository().findById(taskB.workspaceId, runIdB), cancelledRun);
            assert.deepEqual(activeStore.runStageRepository().listByRun(taskB.workspaceId, runIdB), cancelledStages);
            assert.deepEqual(activeStore.getDatabase().prepare("SELECT * FROM collaboration_controls WHERE action = 'cancel' AND canonical_run_id = ?").get(runIdB), cancelControl);
            assert.equal(production.service.getDetails(taskB.workspaceId, taskB.id).task.status, 'cancelled');
            const currentC = production.service.getDetails(taskC.workspaceId, taskC.id).task;
            assert.equal(currentC.status, safe ? 'running' : 'queued'); assert.equal(currentC.canonicalRunId, runIdC); assert.equal(currentC.controlEpoch, taskC.controlEpoch);
            assert.equal(activeStore.runRepository().findById(taskC.workspaceId, runIdC)?.status, safe ? 'waiting_approval' : 'queued');
            assert.deepEqual(activeStore.runStageRepository().listByRun(taskC.workspaceId, runIdC).map(stage => ({ id: stage.id, attempt: stage.attempt })), cAttempts);
            assert.equal((activeStore.getDatabase().prepare('SELECT state FROM workspace_admissions WHERE collaboration_control_id = ?').get(controlId) as { state: string }).state, safe ? 'RELEASED' : 'GRANTED');
            assert.equal((activeStore.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 3);
            assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), safe ? 'candidate\n' : 'cancel-gap concurrent user edit\n');
            assert.deepEqual(readFileSync(journal.path), material);
            assert.deepEqual(activeStore.getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
            const rows = activeStore.getDatabase().prepare('SELECT * FROM workspace_admissions ORDER BY request_order').all();
            if (stableAdmissions) assert.deepEqual(rows, stableAdmissions); else stableAdmissions = rows;
            activeStore.close(); reopened = undefined;
          }
        } finally { continueApplication.resolve(); await applying; reopened?.close(); await fx.close(); }
      });
    }
  }
}
