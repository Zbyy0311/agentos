import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { CollaborationControlRepository } from '../store/CollaborationControlRepository.js';
import { CollaborationApplyJournalService } from './CollaborationApplyJournal.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { CollaborationWorkflowService } from './CollaborationWorkflowService.js';
import { WorkspaceAdmissionAuthority } from './WorkspaceAdmissionAuthority.js';
import { WorkspaceAdmissionStartupReconciler } from './WorkspaceAdmissionStartupReconciler.js';
import { TaskRunService } from './TaskRunService.js';
import { recoverInterruptedTaskRuntime } from '../taskRecovery.js';
import { recoverInterruptedRuns } from '../runRecovery.js';
import { WorktreeManager } from './WorktreeManager.js';
import { NOW, fixture, createQueuedBehindApplicationPlan } from './CollaborationWorkflowService.test-fixture.js';


for (const scenario of ['safe-preimage', 'concurrent-user-edit', 'corrupt-journal', 'wrong-epoch', 'wrong-task', 'wrong-candidate', 'wrong-version', 'wrong-run'] as const) {
  for (let repetition = 1; repetition <= 3; repetition++) {
    test(`F25 recovered journal with pending control survives full startup twice: ${scenario} (${repetition}/3)`, async () => {
      const fx = fixture();
      let reopened: SqliteStore | undefined;
      let dispatches = 0;
      try {
        const task = await fx.verifiedReady();
        const candidate = fx.repository.findCandidate(task.workspaceId, task.currentCandidateId!)!;
        const controls = new CollaborationControlRepository(fx.store.getDatabase());
        const claim = fx.store.runInTransaction(() => controls.reserve({ workspaceId: task.workspaceId, collaborationId: task.id,
          action: 'apply', expectedVersion: task.version, idempotencyKey: `F25-${scenario}-${repetition}`, ...fx.candidateBinding(task) }));
        assert.equal((fx.store.getDatabase().prepare('SELECT state FROM collaboration_controls WHERE id = ?').get(claim.control.id) as { state: string }).state, 'reserved');
        assert.ok((await fx.authority.requestCollaborationApplication({ workspaceId: task.workspaceId, controlId: claim.control.id })).grantedAdmission);
        const journals = new CollaborationApplyJournalService(fx.store.getDatabase());
        const journal = await journals.prepare(claim.control, claim.task, candidate, fx.repositoryRoot);
        fx.store.runInTransaction(() => controls.bind(claim.control, { candidateId: candidate.id }));
        assert.equal((fx.store.getDatabase().prepare('SELECT state FROM collaboration_controls WHERE id = ?').get(claim.control.id) as { state: string }).state, 'running');
        execFileSync('git', ['apply', '--binary', '--whitespace=nowarn', '-'], {
          cwd: fx.repositoryRoot, input: candidate.diffText, windowsHide: true,
        });
        journals.setState(journal, 'written');

        // Simulate the historical crash gap: filesystem rollback and durable
        // journal.recovered have completed, but control.fail has not happened.
        assert.equal(await journals.rollback(journal), true);
        assert.equal((fx.store.getDatabase().prepare('SELECT state FROM collaboration_controls WHERE id = ?').get(claim.control.id) as { state: string }).state, 'running');
        assert.equal((fx.store.getDatabase().prepare('SELECT state FROM collaboration_apply_journals WHERE control_id = ?').get(claim.control.id) as { state: string }).state, 'recovered');
        if (scenario === 'concurrent-user-edit') writeFileSync(join(fx.repositoryRoot, 'README.md'), 'user edit after journal recovery\n');
        if (scenario === 'corrupt-journal') writeFileSync(journal.recoveryPath, 'corrupt recovery bytes');
        if (scenario === 'wrong-epoch') {
          fx.store.getDatabase().prepare('UPDATE collaboration_tasks SET control_epoch = control_epoch + 1 WHERE workspace_id = ? AND id = ?')
            .run(task.workspaceId, task.id);
        }
        if (scenario === 'wrong-task') {
          const other = createQueuedBehindApplicationPlan(fx, `F25-wrong-task-${repetition}`);
          // Keep the backup digest internally valid, so this tests ownership
          // validation before preimage convergence rather than a JSON/hash error.
          const material = { ...JSON.parse(readFileSync(journal.recoveryPath, 'utf8')), taskId: other.id };
          const bytes = JSON.stringify(material);
          writeFileSync(journal.recoveryPath, bytes);
          const summary = JSON.parse((fx.store.getDatabase().prepare('SELECT images_json FROM collaboration_apply_journals WHERE control_id = ?')
            .get(claim.control.id) as { images_json: string }).images_json);
          summary.recoveryHash = createHash('sha256').update(bytes).digest('hex');
          fx.store.getDatabase().prepare('UPDATE collaboration_apply_journals SET collaboration_task_id = ?, images_json = ? WHERE control_id = ?')
            .run(other.id, JSON.stringify(summary), claim.control.id);
        }
        if (scenario === 'wrong-candidate') {
          const other = fx.repository.createCandidate({ ...candidate, id: `F25-alternate-candidate-${repetition}`, round: 1, status: 'created', createdAt: NOW });
          fx.store.getDatabase().prepare('UPDATE collaboration_tasks SET current_candidate_id = ? WHERE workspace_id = ? AND id = ?')
            .run(other.id, task.workspaceId, task.id);
        }
        if (scenario === 'wrong-version') fx.store.getDatabase().prepare('UPDATE collaboration_tasks SET version = version + 1 WHERE workspace_id = ? AND id = ?')
          .run(task.workspaceId, task.id);
        if (scenario === 'wrong-run') {
          const otherTask = fx.store.taskRepository().insert({ workspaceId: task.workspaceId, title: 'Unrelated completed Run', createdBy: 'F25-test' });
          const otherRun = fx.store.runRepository().insert({ workspaceId: task.workspaceId, taskId: otherTask.id, origin: 'v2_api', createdBy: 'F25-test' });
          fx.store.getDatabase().prepare("UPDATE runs SET status = 'completed', completed_at = ? WHERE id = ?").run(NOW, otherRun.id);
          fx.store.getDatabase().prepare('UPDATE collaboration_controls SET canonical_run_id = ? WHERE id = ?').run(otherRun.id, claim.control.id);
        }
        const expectedFile = scenario === 'concurrent-user-edit' ? 'user edit after journal recovery\n' : 'base\n';
        assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), expectedFile);
        const materialBytes = readFileSync(journal.recoveryPath);
        const runCount = (fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;
        fx.closeDatabase();

        for (let reboot = 1; reboot <= 2; reboot++) {
          reopened = new SqliteStore(fx.dataRoot);
          const authority = new WorkspaceAdmissionAuthority({ store: reopened });
          const service = new CollaborationWorkflowService({
            store: reopened, workspaces: new WorkspaceManager(reopened), worktrees: new WorktreeManager(join(fx.root, 'worktrees')),
            dispatchRun: async () => { dispatches++; assert.fail('F25 recovery must not replay a Provider Run'); },
            requestRunAdmission: async () => false, releaseRunAdmission: async () => undefined,
            requestApplicationAdmission: async input => Boolean((await authority.requestCollaborationApplication(input)).grantedAdmission),
            releaseApplicationAdmission: async input => { await authority.releaseCollaborationApplication(input); },
            registerWorktreePath: () => undefined,
            cancelRun: async () => { assert.fail('F25 recovery must not repeat cancellation'); },
          });

          // Mirror the startup composition: canonical task/run/group recovery,
          // admission inventory, then collaboration/journal reconciliation.
          recoverInterruptedTaskRuntime(reopened, new TaskRunService(reopened));
          recoverInterruptedRuns(reopened);
          reopened.groupInteractionRepository().reconcileInterruptedOnStartup(new Date().toISOString());
          await new WorkspaceAdmissionStartupReconciler({ store: reopened }).reconcileOnStartup();
          const applicationAdmissionBeforeCollaborationRecovery = (reopened.getDatabase().prepare(
            "SELECT state FROM workspace_admissions WHERE workspace_id = ? AND collaboration_control_id = ? AND subject_kind = 'COLLABORATION_APPLICATION'",
          ).get(task.workspaceId, claim.control.id) as { state: string }).state;
          if (reboot === 1) {
            assert.equal(applicationAdmissionBeforeCollaborationRecovery, 'GRANTED',
              'terminal journal alone must not release the writer while its control is pending');
            assert.equal((reopened.getDatabase().prepare('SELECT state FROM collaboration_controls WHERE id = ?').get(claim.control.id) as { state: string }).state, 'running',
              'startup admission inventory must leave pending control reconciliation to the collaboration coordinator');
          } else {
            assert.equal(applicationAdmissionBeforeCollaborationRecovery, scenario === 'safe-preimage' ? 'RELEASED' : 'GRANTED', 'second reboot must retain the previous safe/held admission state');
            assert.equal((reopened.getDatabase().prepare('SELECT state FROM collaboration_controls WHERE id = ?').get(claim.control.id) as { state: string }).state,
              scenario === 'safe-preimage' ? 'failed' : 'recovery_required', 'second reboot must retain the previous recovery outcome');
          }
          await service.reconcileOnStartup();

          const controlState = (reopened.getDatabase().prepare('SELECT state FROM collaboration_controls WHERE id = ?').get(claim.control.id) as { state: string }).state;
          const journalState = (reopened.getDatabase().prepare('SELECT state FROM collaboration_apply_journals WHERE control_id = ?').get(claim.control.id) as { state: string }).state;
          const admissionState = (reopened.getDatabase().prepare(
            "SELECT state FROM workspace_admissions WHERE workspace_id = ? AND collaboration_control_id = ? AND subject_kind = 'COLLABORATION_APPLICATION'",
          ).get(task.workspaceId, claim.control.id) as { state: string }).state;
          const shouldConverge = scenario === 'safe-preimage';
          assert.equal(controlState, shouldConverge ? 'failed' : 'recovery_required', `control after reboot ${reboot}`);
          assert.equal(admissionState, shouldConverge ? 'RELEASED' : 'GRANTED', `writer admission after reboot ${reboot}`);
          if (scenario === 'concurrent-user-edit' || scenario === 'wrong-epoch') assert.equal(journalState, 'recovery_required');
          if (scenario === 'wrong-task' || scenario === 'wrong-candidate' || scenario === 'wrong-version' || scenario === 'wrong-run') assert.equal(journalState, 'recovery_required');
          if (scenario === 'safe-preimage' || scenario === 'corrupt-journal') assert.equal(journalState, 'recovered');
          assert.equal(service.getDetails(task.workspaceId, task.id).task.status, 'awaiting_application');
          assert.equal(service.getDetails(task.workspaceId, task.id).task.pendingControl?.state,
            shouldConverge ? undefined : 'recovery_required');
          assert.equal(readFileSync(join(fx.repositoryRoot, 'README.md'), 'utf8'), expectedFile, 'recovery must not apply or overwrite the target');
          assert.deepEqual(readFileSync(journal.recoveryPath), materialBytes, 'startup must not rewrite immutable recovery materials');
          assert.equal((reopened.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, runCount);
          assert.deepEqual(reopened.getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
          assert.equal(dispatches, 0);
          reopened.close();
          reopened = undefined;
        }
      } finally {
        reopened?.close();
        await fx.close();
      }
    });
  }
}
