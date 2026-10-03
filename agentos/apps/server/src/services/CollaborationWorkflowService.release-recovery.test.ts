import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { type CollaborationTask } from '@agentos/shared';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { CollaborationControlRepository } from '../store/CollaborationControlRepository.js';
import { CollaborationApplyJournalService } from './CollaborationApplyJournal.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { isTransactionActive } from '../store/Transaction.js';
import { CollaborationWorkflowService } from './CollaborationWorkflowService.js';
import { WorkspaceAdmissionAuthority } from './WorkspaceAdmissionAuthority.js';
import { WorktreeManager } from './WorktreeManager.js';
import { fixture, deferred, productionServiceFor, recoverFullStartup, admitFollowerToApproval, createQueuedBehindApplicationPlan } from './CollaborationWorkflowService.test-fixture.js';


for (let repetition = 1; repetition <= 3; repetition++) {
  test(`F25 safe prepared journal commits recovered/failed atomically before release and production startup resumes queued B once across two DB reopens (${repetition}/3)`, async () => {
    let fx!: ReturnType<typeof fixture>;
    fx = fixture({ requestRunAdmission: input => fx.authority.requestCanonicalRun(input) });
    let reopened: SqliteStore | undefined;
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string, options?: { readOnly: boolean }) => { prepare(sql: string): { get(...values: unknown[]): unknown }; close(): void };
    };
    let observer: InstanceType<typeof DatabaseSync> | undefined;
    const dispatches: string[] = [];
    let atomicObservations = 0;
    let applicationReleases = 0;
    try {
      const taskA = await fx.verifiedReady();
      const candidate = fx.repository.findCandidate(taskA.workspaceId, taskA.currentCandidateId!)!;
      const controls = new CollaborationControlRepository(fx.store.getDatabase());
      const claim = fx.store.runInTransaction(() => controls.reserve({ workspaceId: taskA.workspaceId, collaborationId: taskA.id,
        action: 'apply', expectedVersion: taskA.version, idempotencyKey: `F25-atomic-startup-${repetition}`, ...fx.candidateBinding(taskA) }));
      assert.ok((await fx.authority.requestCollaborationApplication({ workspaceId: taskA.workspaceId, controlId: claim.control.id })).grantedAdmission);
      const journal = await new CollaborationApplyJournalService(fx.store.getDatabase()).prepare(claim.control, claim.task, candidate, fx.repositoryRoot);
      fx.store.runInTransaction(() => controls.bind(claim.control, { candidateId: candidate.id }));
      const planB = createQueuedBehindApplicationPlan(fx, `F25-atomic-queued-${repetition}`);
      const taskB = await fx.service.confirm({ workspaceId: planB.workspaceId, collaborationId: planB.id, expectedVersion: planB.version,
        idempotencyKey: `F25-atomic-confirm-B-${repetition}` });
      const runIdB = taskB.canonicalRunId!;
      assert.equal(taskB.status, 'queued');
      assert.equal((fx.store.getDatabase().prepare('SELECT state FROM workspace_admissions WHERE canonical_run_id = ?').get(runIdB) as { state: string }).state, 'QUEUED');
      const material = readFileSync(journal.recoveryPath);
      fx.store.getDatabase().exec("CREATE TRIGGER f25_observe_terminal_commit BEFORE UPDATE OF state ON collaboration_controls WHEN OLD.action = 'apply' AND NEW.state = 'failed' BEGIN SELECT f25_observe_atomic_pair(); END");
      fx.closeDatabase();
      let attempts: Array<{ id: string; attempt: number; status: string }> | undefined;
      for (let reboot = 1; reboot <= 2; reboot++) {
        reopened = new SqliteStore(fx.dataRoot);
        const activeStore = reopened;
        const db = activeStore.getDatabase();
        const databasePath = (db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>).find(row => row.name === 'main')!.file;
        observer = new DatabaseSync(databasePath, { readOnly: true });
        const pairSql = 'SELECT j.state AS journalState, c.state AS controlState FROM collaboration_controls c JOIN collaboration_apply_journals j ON j.control_id = c.id WHERE c.id = ?';
        (db as typeof db & { function(name: string, callback: () => number): void }).function('f25_observe_atomic_pair', () => {
          assert.equal(isTransactionActive(db), true, 'control finalization must run inside the journal transaction');
          assert.equal((db.prepare(pairSql).get(claim.control.id) as { journalState: string }).journalState, 'recovered');
          const durable = observer!.prepare(pairSql).get(claim.control.id) as { journalState: string; controlState: string };
          assert.equal(durable.journalState, 'prepared', 'an independent connection must not observe an early journal-only commit');
          assert.equal(durable.controlState, 'running');
          atomicObservations++;
          return 1;
        });
        const production = productionServiceFor({ root: fx.root, dataRoot: fx.dataRoot, store: activeStore }, 'true', async (workspaceId, runId) => {
          assert.equal(runId, runIdB, 'startup may only dispatch the original unstarted follower, never the apply Run');
          dispatches.push(runId);
          admitFollowerToApproval(activeStore, workspaceId, runId);
        }, input => {
          assert.equal(input.controlId, claim.control.id);
          assert.equal(isTransactionActive(db), false, 'external release must follow the joint commit');
          const durable = observer!.prepare(pairSql).get(claim.control.id) as { journalState: string; controlState: string };
          assert.equal(durable.journalState, 'recovered');
          assert.equal(durable.controlState, 'failed');
          assert.equal((db.prepare('SELECT state FROM workspace_admissions WHERE collaboration_control_id = ?').get(claim.control.id) as { state: string }).state, 'GRANTED');
          applicationReleases++;
        });
        await recoverFullStartup(activeStore, production.service);
        assert.equal(dispatches.length, reboot === 1 ? 0 : 1, 'the recovery phase must not drive B');
        const pair = db.prepare(pairSql).get(claim.control.id) as { journalState: string; controlState: string };
        assert.equal(pair.journalState, 'recovered'); assert.equal(pair.controlState, 'failed');
        assert.equal((db.prepare('SELECT state FROM workspace_admissions WHERE collaboration_control_id = ?').get(claim.control.id) as { state: string }).state, 'RELEASED');
        await production.startProductionBackground();
        await production.startProductionBackground();
        assert.deepEqual(dispatches, [runIdB]);
        assert.equal(production.service.getDetails(taskB.workspaceId, taskB.id).task.canonicalRunId, runIdB);
        assert.equal(production.service.getDetails(taskB.workspaceId, taskB.id).task.controlEpoch, taskB.controlEpoch);
        assert.equal(activeStore.runRepository().findById(taskB.workspaceId, runIdB)?.status, 'waiting_approval');
        const currentAttempts = activeStore.runStageRepository().listByRun(taskB.workspaceId, runIdB)
          .map(stage => ({ id: stage.id, attempt: stage.attempt, status: stage.status }));
        if (attempts) assert.deepEqual(currentAttempts, attempts); else attempts = currentAttempts;
        assert.equal(atomicObservations, 1); assert.equal(applicationReleases, 1);
        assert.equal((db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 2);
        assert.equal(production.service.getDetails(taskA.workspaceId, taskA.id).task.pendingControl, undefined);
        assert.equal(production.service.getDetails(taskA.workspaceId, taskA.id).task.status, 'awaiting_application');
        assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), 'base\n');
        assert.deepEqual(readFileSync(journal.recoveryPath), material);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        observer.close(); observer = undefined;
        activeStore.close(); reopened = undefined;
      }
    } finally { observer?.close(); reopened?.close(); await fx.close(); }
  });

  for (const safe of [true, false]) {
    test(`F24 release-gap control ${safe ? 'safe RELEASED' : 'unknown GRANTED'} resumes only the original queued follower across two real DB reopens (${repetition}/3)`, async () => {
      let fx!: ReturnType<typeof fixture>;
      let reopened: SqliteStore | undefined;
      const applicationGranted = deferred<string>();
      const continueApplication = deferred<void>();
      const dispatches: string[] = [];
      let runIdB = '';
      let crashPoints = 0;
      let settling: Promise<{ value?: CollaborationTask; error?: unknown }> | undefined;
      fx = fixture({
        requestApplicationAdmission: async input => {
          assert.ok((await fx.authority.requestCollaborationApplication(input)).grantedAdmission);
          applicationGranted.resolve(input.controlId);
          await continueApplication.promise;
          return true;
        },
        requestRunAdmission: input => fx.authority.requestCanonicalRun(input),
        dispatchRun: async (_workspaceId, runId) => { dispatches.push(runId); },
        releaseApplicationAdmission: async input => {
          const authority = new WorkspaceAdmissionAuthority({ store: fx.store,
            testHooks: { afterEvidenceCollectionOutsideTransaction: () => {
              const db = fx.store.getDatabase();
              assert.equal(isTransactionActive(db), false, 'the RELEASED transaction must already have committed');
              assert.equal((db.prepare('SELECT state FROM workspace_admissions WHERE collaboration_control_id = ?').get(input.controlId) as { state: string }).state, 'RELEASED');
              assert.equal((db.prepare('SELECT state FROM workspace_admissions WHERE canonical_run_id = ?').get(runIdB) as { state: string }).state, 'QUEUED');
              const pair = db.prepare('SELECT c.state AS controlState, j.state AS journalState FROM collaboration_controls c JOIN collaboration_apply_journals j ON j.control_id = c.id WHERE c.id = ?')
                .get(input.controlId) as { controlState: string; journalState: string };
              assert.equal(pair.controlState, 'completed'); assert.equal(pair.journalState, 'committed');
              crashPoints++;
              throw new Error('F24 crash after application release commit before queue advancement');
            } } });
          await authority.releaseCollaborationApplication(input);
        },
        applyFault: point => {
          if (!safe && point === 'after_write') {
            writeFileSync(join(fx.repositoryRoot, 'README.md'), 'release-gap concurrent user edit\n');
            throw new Error('F24 unknown writer must remain held');
          }
        },
      });
      try {
        const taskA = await fx.verifiedReady();
        settling = fx.service.apply(fx.applicationInput(taskA, `F24-release-gap-${safe}-${repetition}`))
          .then(value => ({ value }), error => ({ error }));
        const controlId = await applicationGranted.promise;
        const planB = createQueuedBehindApplicationPlan(fx, `release-gap-${safe}-${repetition}`);
        const taskB = await fx.service.confirm({ workspaceId: planB.workspaceId, collaborationId: planB.id,
          expectedVersion: planB.version, idempotencyKey: `F24-release-gap-B-${safe}-${repetition}` });
        runIdB = taskB.canonicalRunId!;
        assert.equal(taskB.status, 'queued');
        const admissionSql = 'SELECT * FROM workspace_admissions WHERE canonical_run_id = ?';
        const followerBefore = fx.store.getDatabase().prepare(admissionSql).get(runIdB) as { id: string; state: string; request_order: number };
        assert.equal(followerBefore.state, 'QUEUED');
        const stages = fx.store.runStageRepository().listByRun(taskB.workspaceId, runIdB).map(stage => ({ id: stage.id, attempt: stage.attempt }));
        continueApplication.resolve();
        const result = await settling;
        if (safe) assert.equal(result.value?.status, 'applied');
        else assert.equal((result.error as { code?: string })?.code, 'COLLABORATION_RECOVERY_REQUIRED');
        assert.equal(crashPoints, safe ? 1 : 0, 'the release/advance crash window must be reached only by proven terminal A');
        assert.equal(dispatches.length, 0);
        const applicationSql = 'SELECT * FROM workspace_admissions WHERE collaboration_control_id = ?';
        const applicationBefore = fx.store.getDatabase().prepare(applicationSql).get(controlId) as { state: string };
        assert.equal(applicationBefore.state, safe ? 'RELEASED' : 'GRANTED');
        assert.equal((fx.store.getDatabase().prepare(admissionSql).get(runIdB) as { state: string }).state, 'QUEUED');
        const journal = fx.store.getDatabase().prepare('SELECT recovery_path AS path FROM collaboration_apply_journals WHERE control_id = ?').get(controlId) as { path: string };
        const material = readFileSync(journal.path);
        const expectedFile = safe ? 'candidate\n' : 'release-gap concurrent user edit\n';
        fx.closeDatabase();
        let firstAdmissions: unknown[] | undefined;
        for (let reboot = 1; reboot <= 2; reboot++) {
          reopened = new SqliteStore(fx.dataRoot);
          const activeStore = reopened;
          const production = productionServiceFor({ root: fx.root, dataRoot: fx.dataRoot, store: activeStore }, 'true', async (workspaceId, resumedRunId) => {
            assert.equal(resumedRunId, runIdB, 'post-listen may resume B, never replay A or create another Run');
            dispatches.push(resumedRunId);
            admitFollowerToApproval(activeStore, workspaceId, resumedRunId);
          });
          if (reboot === 1) assert.equal((activeStore.getDatabase().prepare(admissionSql).get(runIdB) as { state: string }).state, 'QUEUED', 'the persisted gap must survive the actual DB close/reopen');
          await recoverFullStartup(activeStore, production.service);
          assert.equal(dispatches.length, safe && reboot === 2 ? 1 : 0, 'startup reconciliation itself must not dispatch');
          const follower = activeStore.getDatabase().prepare(admissionSql).get(runIdB) as { id: string; state: string; request_order: number };
          assert.equal(follower.id, followerBefore.id); assert.equal(follower.request_order, followerBefore.request_order);
          assert.equal(follower.state, safe ? 'GRANTED' : 'QUEUED', 'existing durable queued B must not require an inventory edit to advance');
          assert.deepEqual(activeStore.getDatabase().prepare(applicationSql).get(controlId), applicationBefore);
          await production.startProductionBackground(); await production.startProductionBackground();
          assert.deepEqual(dispatches, safe ? [runIdB] : []);
          const latestB = production.service.getDetails(taskB.workspaceId, taskB.id).task;
          assert.equal(latestB.canonicalRunId, runIdB); assert.equal(latestB.controlEpoch, taskB.controlEpoch);
          assert.equal(latestB.status, safe ? 'running' : 'queued');
          assert.equal(activeStore.runRepository().findById(taskB.workspaceId, runIdB)?.status, safe ? 'waiting_approval' : 'queued');
          assert.deepEqual(activeStore.runStageRepository().listByRun(taskB.workspaceId, runIdB).map(stage => ({ id: stage.id, attempt: stage.attempt })), stages);
          const latestA = production.service.getDetails(taskA.workspaceId, taskA.id).task;
          assert.equal(latestA.status, safe ? 'applied' : 'awaiting_application');
          assert.equal(latestA.pendingControl?.state, safe ? undefined : 'recovery_required');
          assert.equal((activeStore.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 2);
          assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), expectedFile);
          assert.deepEqual(readFileSync(journal.path), material);
          assert.deepEqual(activeStore.getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
          const admissions = activeStore.getDatabase().prepare('SELECT * FROM workspace_admissions ORDER BY request_order').all();
          if (firstAdmissions) assert.deepEqual(admissions, firstAdmissions); else firstAdmissions = admissions;
          activeStore.close(); reopened = undefined;
        }
      } finally { continueApplication.resolve(); await settling; reopened?.close(); await fx.close(); }
    });
  }

  test(`F25 release callback failure preserves applied/committed/completed, warns, and converges on two DB reopens without applying again (${repetition}/3)`, async () => {
    let releaseFailures = 0;
    const fx = fixture({ releaseApplicationAdmission: async () => { releaseFailures++; throw new Error('F25 injected admission release failure'); } });
    let reopened: SqliteStore | undefined;
    let writeFaults = 0;
    let dispatches = 0;
    try {
      const ready = await fx.verifiedReady();
      const applied = await fx.service.apply(fx.applicationInput(ready, `F25-release-failure-${repetition}`));
      assert.equal(applied.status, 'applied');
      assert.equal(applied.version, ready.version + 1);
      assert.equal(releaseFailures, 1);
      const pair = fx.store.getDatabase().prepare("SELECT c.id, c.state AS controlState, j.state AS journalState, j.recovery_path AS recoveryPath FROM collaboration_controls c JOIN collaboration_apply_journals j ON j.control_id = c.id WHERE c.action = 'apply' AND c.collaboration_task_id = ?")
        .get(ready.id) as { id: string; controlState: string; journalState: string; recoveryPath: string };
      assert.equal(pair.controlState, 'completed'); assert.equal(pair.journalState, 'committed');
      assert.equal(fx.repository.findCandidate(ready.workspaceId, ready.currentCandidateId!)?.status, 'applied');
      assert.equal(fx.service.getDetails(ready.workspaceId, ready.id).task.pendingControl, undefined);
      assert.equal((fx.store.getDatabase().prepare('SELECT state FROM workspace_admissions WHERE collaboration_control_id = ?').get(pair.id) as { state: string }).state, 'GRANTED');
      assert.match((fx.service.getProgress(ready.workspaceId, ready.id).warnings ?? []).join('\n'), /已安全.*写入准入(?:尚)?未释放/);
      const material = readFileSync(pair.recoveryPath);
      assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), 'candidate\n');
      fx.closeDatabase();
      for (let reboot = 1; reboot <= 2; reboot++) {
        reopened = new SqliteStore(fx.dataRoot);
        const authority = new WorkspaceAdmissionAuthority({ store: reopened });
        const service = new CollaborationWorkflowService({ store: reopened, workspaces: new WorkspaceManager(reopened), worktrees: new WorktreeManager(join(fx.root, 'worktrees')),
          dispatchRun: async () => { dispatches++; assert.fail('a committed application must not dispatch its old Run'); },
          requestRunAdmission: async () => false, releaseRunAdmission: async () => undefined, registerWorktreePath: () => undefined,
          requestApplicationAdmission: async input => Boolean((await authority.requestCollaborationApplication(input)).grantedAdmission),
          releaseApplicationAdmission: async input => { await authority.releaseCollaborationApplication(input); },
          cancelRun: async () => { assert.fail('no cancellation replay'); },
          applyFault: point => { if (point !== 'recovery') { writeFaults++; assert.fail(`startup attempted application point ${point}`); } },
        });
        await recoverFullStartup(reopened, service);
        assert.equal(service.getDetails(ready.workspaceId, ready.id).task.status, 'applied');
        assert.equal(service.getDetails(ready.workspaceId, ready.id).task.pendingControl, undefined);
        const states = reopened.getDatabase().prepare('SELECT c.state AS controlState, j.state AS journalState FROM collaboration_controls c JOIN collaboration_apply_journals j ON j.control_id = c.id WHERE c.id = ?')
          .get(pair.id) as { controlState: string; journalState: string };
        assert.equal(states.controlState, 'completed'); assert.equal(states.journalState, 'committed');
        assert.equal((reopened.getDatabase().prepare('SELECT state FROM workspace_admissions WHERE collaboration_control_id = ?').get(pair.id) as { state: string }).state, 'RELEASED');
        assert.equal((service.getProgress(ready.workspaceId, ready.id).warnings ?? []).some(warning => /写入准入(?:尚)?未释放/.test(warning)), false);
        assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), 'candidate\n');
        assert.deepEqual(readFileSync(pair.recoveryPath), material);
        assert.equal(writeFaults, 0); assert.equal(dispatches, 0);
        reopened.close(); reopened = undefined;
      }
    } finally { reopened?.close(); await fx.close(); }
  });
}
