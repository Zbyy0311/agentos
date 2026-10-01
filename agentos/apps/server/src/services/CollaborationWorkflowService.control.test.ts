import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { getWorkflowTemplate, type CollaborationCandidate, type CollaborationTask } from '@agentos/shared';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { CollaborationRepository } from '../store/CollaborationRepository.js';
import { CollaborationControlRepository } from '../store/CollaborationControlRepository.js';
import { CollaborationApplyJournalService } from './CollaborationApplyJournal.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { isTransactionActive } from '../store/Transaction.js';
import { CollaborationWorkflowService, type CollaborationWorkflowServiceOptions } from './CollaborationWorkflowService.js';
import { captureCollaborationCandidateSnapshot } from './CollaborationCandidateSnapshot.js';
import { WorkspaceAdmissionAuthority } from './WorkspaceAdmissionAuthority.js';
import { WorkspaceAdmissionStartupReconciler } from './WorkspaceAdmissionStartupReconciler.js';
import { migration046 } from '../migrations/migrations/046-memory-verified-facts.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { TaskRunService } from './TaskRunService.js';
import { recoverInterruptedTaskRuntime } from '../taskRecovery.js';
import { recoverInterruptedRuns } from '../runRecovery.js';
import { RunEngine } from './run-engine/RunEngine.js';
import { StageExecutor } from './run-engine/StageExecutor.js';
import { WorktreeManager } from './WorktreeManager.js';

const NOW = '2026-09-30T00:00:00.000Z';
const PATCH = 'diff --git a/README.md b/README.md\nindex df967b9..a9a2f8e 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-base\n+candidate\n';

type CollaborationWorkflowTestOverrides = Partial<CollaborationWorkflowServiceOptions> & {
  readonly runtimeDispatchEnabled?: boolean;
};
interface CollaborationWorkflowFixtureSettings {
  readonly memoryEnabled?: boolean;
  readonly acceptanceCommands?: readonly string[];
}

async function disposeFixtureTree(path: string): Promise<void> {
  let entry;
  try { entry = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) { await unlink(path); return; }
  for (const child of await readdir(path)) await disposeFixtureTree(join(path, child));
  await rmdir(path);
}

function fixture(overrides: CollaborationWorkflowTestOverrides = {}, settings: CollaborationWorkflowFixtureSettings = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'agentos-collaboration-control-'));
  const repositoryRoot = join(root, 'repository');
  const dataRoot = join(root, 'data');
  mkdirSync(repositoryRoot); mkdirSync(join(dataRoot, 'workspace'), { recursive: true });
  for (const args of [['init', '-q'], ['config', 'core.autocrlf', 'false'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Fixture']]) {
    execFileSync('git', args, { cwd: repositoryRoot, windowsHide: true });
  }
  writeFileSync(join(repositoryRoot, 'README.md'), 'base\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repositoryRoot, windowsHide: true });
  execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: repositoryRoot, windowsHide: true });
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true }).trim();
  writeFileSync(join(dataRoot, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
    id: 'workspace-a', name: 'Fixture', rootPath: repositoryRoot, gitEnabled: true, memoryEnabled: settings.memoryEnabled ?? false,
    agents: ['planner', 'implementer', 'reviewer'].map(id => ({ id, name: id, role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] })),
    lastOpenedAt: NOW, createdAt: NOW, updatedAt: NOW,
  }] }));
  const store = new SqliteStore(dataRoot);
  let databaseClosed = false;
  const workspaces = new WorkspaceManager(store);
  const worktrees = new WorktreeManager(join(root, 'worktrees'));
  const repository = new CollaborationRepository(store.getDatabase());
  let cancelCalls = 0;
  const authority = new WorkspaceAdmissionAuthority({ store });
  const serviceOptions = {
    store, workspaces, worktrees,
    dispatchRun: async () => undefined,
    requestRunAdmission: async () => false,
    releaseRunAdmission: async () => undefined,
    registerWorktreePath: () => undefined,
    requestApplicationAdmission: async input => Boolean((await authority.requestCollaborationApplication(input)).grantedAdmission),
    releaseApplicationAdmission: async input => { await authority.releaseCollaborationApplication(input); },
    cancelRun: async input => {
      cancelCalls++;
      return { expectedRunVersion: store.runRepository().findById(input.workspaceId, input.runId)!.version, terminatedProcessIds: [], worktreePreserved: true };
    },
    ...overrides,
    runtimeDispatchEnabled: overrides.runtimeDispatchEnabled ?? true,
  } as CollaborationWorkflowServiceOptions & { readonly runtimeDispatchEnabled?: boolean };
  const service = new CollaborationWorkflowService(serviceOptions);
  const plan = repository.create({
    workspaceId: 'workspace-a', title: 'Control regression', objective: 'Change README only',
    scope: ['README.md'], acceptanceCommands: [...(settings.acceptanceCommands ?? ['node -e "process.exit(0)"'])],
    plannerAgentId: 'planner', implementerAgentId: 'implementer', reviewerAgentId: 'reviewer',
    planHash: 'fixture-plan', baseCommit, maxReworkRounds: 2, createdAt: NOW,
  });
  function queued() {
    const task = store.taskRepository().insert({ workspaceId: 'workspace-a', title: plan.title, createdBy: 'test' });
    const run = store.runRepository().insert({ workspaceId: 'workspace-a', taskId: task.id, origin: 'v2_api', createdBy: 'test' });
    const operation = store.operationService().create({ workspaceId: 'workspace-a', runId: run.id, type: 'run.start' });
    const collaboration = repository.confirm({ workspaceId: 'workspace-a', id: plan.id, expectedVersion: plan.version,
      canonicalTaskId: task.id, canonicalRunId: run.id, confirmedAt: NOW, idempotencyKey: 'fixture-confirm' });
    return { task, run, operation, collaboration };
  }
  function ready(): CollaborationTask {
    const { run, collaboration } = queued();
    const running = repository.progress({ workspaceId: 'workspace-a', id: plan.id, expectedVersion: collaboration.version, status: 'running' });
    const reviewing = repository.progress({ workspaceId: 'workspace-a', id: plan.id, expectedVersion: running.version, status: 'reviewing' });
    const candidate = repository.createCandidate({
      id: 'candidate-fixture', collaborationTaskId: plan.id, workspaceId: 'workspace-a', canonicalRunId: run.id, round: 0,
      baseCommit, headCommit: baseCommit, snapshotVersion: 2, diffText: PATCH,
      diffHash: createHash('sha256').update(PATCH).digest('hex'), manifest: [],
      testStatus: 'passed', testCommand: 'node -e "process.exit(0)"', testExitCode: 0, testOutput: 'exit 0', status: 'created', createdAt: NOW,
    });
    repository.reviewCandidate({ workspaceId: 'workspace-a', candidateId: candidate.id, conclusion: 'approved', summary: 'fixture review', reviewerAgentId: 'reviewer' });
    repository.createReview({ id: 'review-fixture', collaborationTaskId: plan.id, candidateId: candidate.id, workspaceId: 'workspace-a', canonicalRunId: run.id,
      stageId: 'stage-fixture', stageAttempt: 1, reviewerAgentId: 'reviewer', candidateDiffHash: candidate.diffHash, conclusion: 'approved', summary: 'fixture review', createdAt: NOW });
    return repository.progress({ workspaceId: 'workspace-a', id: plan.id, expectedVersion: reviewing.version, status: 'awaiting_application', currentCandidateId: candidate.id });
  }
  function runningWithCompletedStart() {
    const workspace = workspaces.get('workspace-a')!;
    const created = store.workflowTemplateService().instantiateTemplateRun({
      workspace, template: getWorkflowTemplate('plan-implement-review')!,
      roleBindings: { planner: 'codex', implementer: 'codex', reviewer: 'codex' },
      agentBindings: { plan: 'planner', implement: 'implementer', review: 'reviewer' },
      createdBy: 'collaboration-workflow', createdAt: NOW, worktreeMode: 'required',
    });
    const collaboration = repository.confirm({ workspaceId: 'workspace-a', id: plan.id, expectedVersion: plan.version,
      canonicalTaskId: created.task.id, canonicalRunId: created.run.id, confirmedAt: NOW, idempotencyKey: 'fixture-running-confirm' });
    repository.progress({ workspaceId: 'workspace-a', id: plan.id, expectedVersion: collaboration.version, status: 'running' });
    const operation = store.operationService().create({ workspaceId: 'workspace-a', runId: created.run.id, type: 'run.start' });
    const engine = new RunEngine({
      runRepository: store.runRepository(), operationService: store.operationService(), lifecycleTransactionService: store.lifecycleTransactionService(),
      snapshotRepository: store.runSnapshotRepository(), runStageRepository: store.runStageRepository(),
      stageExecutor: new StageExecutor(() => ({ outcome: 'active' })), runInTransaction: fn => store.runInTransaction(fn),
    });
    assert.equal(engine.tick({ workspaceId: 'workspace-a', runId: created.run.id }).outcome, 'claimed');
    for (let step = 0; step < 10; step++) {
      engine.dispatch({ workspaceId: 'workspace-a', runId: created.run.id });
      if (store.operationService().listByRun('workspace-a', created.run.id).find(row => row.id === operation.id)?.status === 'completed') break;
    }
    assert.equal(store.operationService().listByRun('workspace-a', created.run.id).find(row => row.id === operation.id)?.status, 'completed');
    assert.equal(store.runRepository().findById('workspace-a', created.run.id)?.status, 'running');
    return { run: store.runRepository().findById('workspace-a', created.run.id)!, collaboration: repository.findById('workspace-a', plan.id)!, operation };
  }
  async function verifiedReady() {
    const active = runningWithCompletedStart();
    const working = join(root, 'implementation');
    execFileSync('git', ['worktree', 'add', '--detach', working, baseCommit], { cwd: repositoryRoot, windowsHide: true, stdio: 'pipe' });
    writeFileSync(join(working, 'README.md'), 'candidate\n');
    const snapshot = await captureCollaborationCandidateSnapshot(working, baseCommit, plan.scope);
    const actualOutput = execFileSync(process.execPath, ['-e', 'process.exit(0)'], { cwd: working, encoding: 'utf8', windowsHide: true });
    const candidate = repository.createCandidate({ id: 'candidate-verified', collaborationTaskId: plan.id, workspaceId: plan.workspaceId,
      canonicalRunId: active.run.id, round: 0, baseCommit, headCommit: baseCommit, snapshotVersion: 2, diffText: snapshot.patch,
      diffHash: snapshot.patchHash, manifest: [...snapshot.untrackedManifest], testStatus: 'passed', testCommand: plan.acceptanceCommands.join(' && '),
      testExitCode: 0, testOutput: `$ ${plan.acceptanceCommands[0]}\n${actualOutput}\nexit 0`, status: 'created', createdAt: NOW });
    const reviewing = repository.progress({ workspaceId: plan.workspaceId, id: plan.id, expectedVersion: active.collaboration.version, status: 'reviewing', currentCandidateId: candidate.id });
    const engine = new RunEngine({ runRepository: store.runRepository(), operationService: store.operationService(), lifecycleTransactionService: store.lifecycleTransactionService(),
      snapshotRepository: store.runSnapshotRepository(), runStageRepository: store.runStageRepository(), runInTransaction: fn => store.runInTransaction(fn),
      stageExecutor: new StageExecutor(() => ({ outcome: 'completed', durationMs: 1, artifactIds: [], outputContractSatisfied: true })) });
    for (let step = 0; step < 32 && store.runRepository().findById(plan.workspaceId, active.run.id)?.status !== 'completed'; step++) engine.dispatch({ workspaceId: plan.workspaceId, runId: active.run.id });
    assert.equal(store.runRepository().findById(plan.workspaceId, active.run.id)?.status, 'completed');
    const reviewStage = store.runStageRepository().listByRun(plan.workspaceId, active.run.id).find(stage => stage.workflowStageKey === 'review')!;
    // This is completed historical evidence from before runtime dispatch was
    // disabled; the service under test still retains its disabled flag.
    const evidenceService = overrides.runtimeDispatchEnabled === false
      ? new CollaborationWorkflowService({ ...serviceOptions, runtimeDispatchEnabled: true })
      : service;
    await evidenceService.completedStage({ workspaceId: plan.workspaceId, runId: active.run.id, stage: reviewStage, agentId: plan.reviewerAgentId, role: 'reviewer',
      output: JSON.stringify({ agentosCollaborationReview: { version: 1, candidateId: candidate.id, candidateHash: candidate.diffHash, runId: active.run.id,
        stageAttempt: reviewStage.attempt, reviewerAgentId: plan.reviewerAgentId, conclusion: 'approved', summary: 'Verified fixture review of the frozen patch' } }) });
    repository.createReview({ id: 'review-verified', collaborationTaskId: plan.id, candidateId: candidate.id, workspaceId: plan.workspaceId, canonicalRunId: active.run.id,
      stageId: reviewStage.id, stageAttempt: reviewStage.attempt, reviewerAgentId: plan.reviewerAgentId, candidateDiffHash: candidate.diffHash,
      conclusion: 'approved', summary: 'Verified fixture review', createdAt: NOW });
    repository.reviewCandidate({ workspaceId: plan.workspaceId, candidateId: candidate.id, conclusion: 'approved', summary: 'Verified fixture review', reviewerAgentId: plan.reviewerAgentId });
    return repository.progress({ workspaceId: plan.workspaceId, id: plan.id, expectedVersion: reviewing.version, status: 'awaiting_application' });
  }
  return { root, dataRoot, store, repository, service, authority, workspaces, worktrees, repositoryRoot, plan, queued, ready, verifiedReady, runningWithCompletedStart, cancelCalls: () => cancelCalls,
    closeDatabase() { if (!databaseClosed) { store.close(); databaseClosed = true; } },
    async close() {
      if (!databaseClosed) { store.close(); databaseClosed = true; }
      try { await disposeFixtureTree(root); } catch (error) {
        if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        // A dangling Windows Git temp reparse point cannot be lstat'ed/unlinked
        // by Node. Preserve it rather than masking the product assertion.
        process.emitWarning(`Fixture cleanup incomplete; retained ${root}: ${(error as NodeJS.ErrnoException).code}`);
      }
    } };
}

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
          applying = fx.service.apply({ workspaceId: taskA.workspaceId, collaborationId: taskA.id,
            expectedVersion: taskA.version, idempotencyKey: `cancel-gap-apply-${recovery}-${safe}-${repetition}` }).then(value => ({ value }), error => ({ error }));
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
            const production = productionServiceFor({ root: fx.root, store: fx.store }, 'true', dispatch(fx.store));
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
            const production = productionServiceFor({ root: fx.root, store: activeStore }, 'true', dispatch(activeStore));
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

function conflict(error: unknown): boolean {
  return typeof (error as { code?: unknown })?.code === 'string' && String((error as { code: string }).code).includes('CONFLICT');
}

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
      const ready = fx.ready();
      await assert.rejects(fx.service.apply({ workspaceId: ready.workspaceId, collaborationId: ready.id, expectedVersion: ready.version - 1, idempotencyKey: 'stale-apply' }), conflict);
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

for (const point of ['before_write', 'after_write', 'before_commit'] as const) {
  for (let repetition = 1; repetition <= 3; repetition++) {
    test(`F01 application fault ${point} restores exact owned preimages (${repetition}/3)`, async () => {
      const fx = fixture({ applyFault: observed => { if (point === observed) throw new Error(`injected ${point}`); } });
      try {
        const task = await fx.verifiedReady();
        await assert.rejects(fx.service.apply({ workspaceId: task.workspaceId, collaborationId: task.id, expectedVersion: task.version, idempotencyKey: `fault-${point}` }), /injected/);
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
    const input = { workspaceId: task.workspaceId, collaborationId: task.id, expectedVersion: task.version, idempotencyKey: 'verified-apply' };
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
    await assert.rejects(fx.service.apply({ workspaceId: task.workspaceId, collaborationId: task.id, expectedVersion: task.version, idempotencyKey: 'concurrent-edit' }), { code: 'COLLABORATION_RECOVERY_REQUIRED' });
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
        if (scenario === 'applied') await fx.service.apply({ workspaceId: task.workspaceId, collaborationId: task.id, expectedVersion: task.version, idempotencyKey: 'before-restart-apply' });
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
      const claim = fx.store.runInTransaction(() => controls.reserve({ workspaceId: task.workspaceId, collaborationId: task.id, action: 'apply', expectedVersion: task.version, idempotencyKey: `crash-${crash}` }));
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

// Execute the real production option construction and post-listen queue entry,
// with isolated SQLite/Git and stub dispatch boundaries. Importing index.ts
// itself would acquire server ownership and start unrelated native services.
function productionCollaborationSlices() {
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('../index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bootstrap = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'bootstrap');
  assert.ok(bootstrap?.body);
  const startup = bootstrap.body.statements.find(ts.isTryStatement)?.tryBlock;
  assert.ok(startup);
  const nodes: ts.Node[] = [];
  function visit(node: ts.Node): void { nodes.push(node); ts.forEachChild(node, visit); }
  visit(startup);
  const flag = nodes.find((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'runtimeDispatchEnabled');
  assert.ok(flag && flag.initializer);
  const flagStatement = flag.parent.parent;
  assert.ok(ts.isVariableStatement(flagStatement));
  const construction = startup.statements.find((node): node is ts.ExpressionStatement => ts.isExpressionStatement(node)
    && ts.isBinaryExpression(node.expression) && node.expression.left.getText(source) === 'collaborationService'
    && ts.isNewExpression(node.expression.right) && node.expression.right.expression.getText(source) === 'CollaborationWorkflowService');
  assert.ok(construction, 'production must construct the collaboration service');
  assert.ok(flagStatement.end < construction.pos, 'production must read the runtime switch before constructing the service');
  const calls = nodes.filter(ts.isCallExpression);
  const queueCall = calls.find(node => node.expression.getText(source) === 'collaborationService.resumeGrantedQueuedRuns');
  const listen = calls.find(node => node.expression.getText(source) === 'listenHttpServer');
  const admissionRecovery = calls.find(node => ts.isPropertyAccessExpression(node.expression)
    && ts.isNewExpression(node.expression.expression) && node.expression.expression.expression.getText(source) === 'WorkspaceAdmissionStartupReconciler');
  const collaborationRecovery = calls.find(node => node.expression.getText(source) === 'collaborationService.reconcileOnStartup');
  assert.ok(queueCall && listen && admissionRecovery && collaborationRecovery, 'production startup must retain the complete recovery/listen/queue sequence');
  assert.ok(queueCall.pos > listen.end && queueCall.pos > admissionRecovery.end && queueCall.pos > collaborationRecovery.end,
    'the production queue entry must run after recovery and successful listen');
  let queueStatement: ts.Node = queueCall;
  while (queueStatement.parent !== startup) queueStatement = queueStatement.parent;
  return { flag: flagStatement.getText(source), construction: construction.getText(source), background: queueStatement.getText(source) };
}

function productionServiceFor(
  fx: { root: string; store: SqliteStore },
  runtimeValue: string | undefined,
  dispatchRun: (workspaceId: string, runId: string) => Promise<void>,
  beforeApplicationRelease?: (input: { workspaceId: string; controlId: string }) => void,
) {
  const slices = productionCollaborationSlices();
  const authority = new WorkspaceAdmissionAuthority({ store: fx.store });
  let approvalResumes = 0;
  const chain = {
    admissionAuthority: {
      requestCanonicalRun: (input: { workspaceId: string; runId: string }) => authority.requestCanonicalRun(input),
      releaseCanonicalRun: (input: { workspaceId: string; runId: string }) => authority.releaseCanonicalRun(input),
      requestCollaborationApplication: (input: { workspaceId: string; controlId: string }) => authority.requestCollaborationApplication(input),
      releaseCollaborationApplication: async (input: { workspaceId: string; controlId: string }) => {
        beforeApplicationRelease?.(input);
        return authority.releaseCollaborationApplication(input);
      },
    },
    dispatcher: { driveSafely: dispatchRun, cancelRun: async () => { assert.fail('no native cancellation is allowed in the startup fixture'); } },
    approvalGate: { resumeApprovedUnconsumed: async () => { approvalResumes++; } },
  };
  const environment = { env: { AGENTOS_RUNTIME_DISPATCH_ENABLED: runtimeValue } };
  const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const construct = new Function('store', 'workspaceManager', 'worktreeManager', 'providerExecutionChain', 'collaborationWorktreePaths', 'CollaborationWorkflowService', 'process',
    compile(`${slices.flag}\nlet collaborationService;\n${slices.construction}\nreturn collaborationService;`));
  const service = construct(fx.store, new WorkspaceManager(fx.store), new WorktreeManager(join(fx.root, 'worktrees')), chain,
    new Map<string, string>(), CollaborationWorkflowService, environment) as CollaborationWorkflowService;
  return { service, authority, approvalResumes: () => approvalResumes,
    async startProductionBackground(): Promise<void> {
      const pending: Promise<void>[] = [];
      const observed = { resumeGrantedQueuedRuns: (...args: Parameters<CollaborationWorkflowService['resumeGrantedQueuedRuns']>) => {
        const result = service.resumeGrantedQueuedRuns(...args); pending.push(result); return result;
      } };
      const start = new Function('collaborationService', 'providerExecutionChain', 'process', 'diagLog', compile(`${slices.flag}\n${slices.background}`));
      start(observed, chain, environment, () => undefined);
      await Promise.all(pending);
    },
  };
}

async function recoverFullStartup(store: SqliteStore, service: CollaborationWorkflowService): Promise<void> {
  recoverInterruptedTaskRuntime(store, new TaskRunService(store));
  recoverInterruptedRuns(store);
  store.groupInteractionRepository().reconcileInterruptedOnStartup(new Date().toISOString());
  await new WorkspaceAdmissionStartupReconciler({ store }).reconcileOnStartup();
  await service.reconcileOnStartup();
}

function admitFollowerToApproval(store: SqliteStore, workspaceId: string, runId: string): void {
  const engine = new RunEngine({ runRepository: store.runRepository(), operationService: store.operationService(), lifecycleTransactionService: store.lifecycleTransactionService(),
    snapshotRepository: store.runSnapshotRepository(), runStageRepository: store.runStageRepository(), runInTransaction: fn => store.runInTransaction(fn),
    stageExecutor: new StageExecutor(() => ({ outcome: 'active' })) });
  assert.equal(engine.tick({ workspaceId, runId }).outcome, 'claimed');
  const start = store.operationService().listByRun(workspaceId, runId).find(operation => operation.type === 'run.start')!;
  assert.ok(start);
  for (let step = 0; step < 12; step++) {
    engine.dispatch({ workspaceId, runId });
    if (store.operationService().listByRun(workspaceId, runId).find(operation => operation.id === start.id)?.status === 'completed') break;
  }
  const run = store.runRepository().findById(workspaceId, runId)!;
  assert.equal(run.status, 'running');
  const stage = store.runStageRepository().listByRun(workspaceId, runId).find(item => item.status === 'running')!;
  assert.ok(stage);
  store.lifecycleTransactionService().requestApproval({ workspaceId, runId, stageId: stage.id,
    expectedRunVersion: run.version, expectedStageVersion: stage.version, correlationId: start.id,
    approvalRequestId: `fixture-approval-${runId}`, category: 'command', riskLevel: 'high', title: 'Fixture pause', description: 'Await explicit approval', requestSummary: {} });
  assert.equal(store.runRepository().findById(workspaceId, runId)?.status, 'waiting_approval');
}

function createQueuedBehindApplicationPlan(fx: ReturnType<typeof fixture>, suffix: string) {
  return fx.repository.create({
    workspaceId: 'workspace-a', title: `Queued behind application ${suffix}`, objective: 'Remain queued until the application writer releases',
    scope: ['README.md'], acceptanceCommands: ['node -e "process.exit(0)"'],
    plannerAgentId: 'planner', implementerAgentId: 'implementer', reviewerAgentId: 'reviewer',
    planHash: `queued-plan-${suffix}`, baseCommit: fx.plan.baseCommit, maxReworkRounds: 2, createdAt: NOW,
  });
}

async function seedQueuedAuthorityFollower(fx: ReturnType<typeof fixture>, suffix: string, index: number): Promise<string> {
  const createdAt = new Date(Date.now() + index * 1_000).toISOString();
  const canonicalTask = fx.store.taskRepository().insert({ workspaceId: 'workspace-a', title: `Follower task ${suffix}`, createdBy: 'control-regression-test' });
  const run = fx.store.runRepository().insert({ workspaceId: 'workspace-a', taskId: canonicalTask.id, origin: 'v2_api', createdBy: 'collaboration-workflow' });
  const plan = fx.repository.create({ workspaceId: 'workspace-a', title: `Follower ${suffix}`, objective: 'Remain behind the current writer',
    scope: ['README.md'], acceptanceCommands: ['node -e "process.exit(0)"'], plannerAgentId: 'planner', implementerAgentId: 'implementer',
    reviewerAgentId: 'reviewer', planHash: `follower-plan-${suffix}`, baseCommit: fx.plan.baseCommit, maxReworkRounds: 2, createdAt });
  const queued = fx.repository.confirm({ workspaceId: 'workspace-a', id: plan.id, expectedVersion: plan.version,
    canonicalTaskId: canonicalTask.id, canonicalRunId: run.id, confirmedAt: createdAt, idempotencyKey: `follower-confirm-${suffix}` });
  assert.equal(queued.status, 'queued');
  assert.equal(await fx.authority.requestCanonicalRun({ workspaceId: 'workspace-a', runId: run.id }), false);
  const admission = fx.store.getDatabase().prepare('SELECT state FROM workspace_admissions WHERE workspace_id = ? AND canonical_run_id = ?')
    .get('workspace-a', run.id) as { state: string };
  assert.equal(admission.state, 'QUEUED');
  return run.id;
}

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
        const applyInput = { workspaceId: taskA.workspaceId, collaborationId: taskA.id, expectedVersion: taskA.version, idempotencyKey: `F24-${outcome}-${repetition}` };
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
          if (outcome === 'success') {
            const replay = await fx.service.apply(applyInput);
            assert.equal(replay.status, 'applied');
          } else {
            await assert.rejects(fx.service.apply(applyInput));
          }
          await fx.authority.releaseCollaborationApplication({ workspaceId: 'workspace-a', controlId });
          assert.equal(dispatches.length, 1, 'same-key replay and duplicate authority release must not dispatch B again');
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
    dispatchRun: async (workspaceId, runId) => { dispatches.push({ workspaceId, runId }); },
  });
  try {
    const taskA = await fx.verifiedReady();
    const applying = fx.service.apply({ workspaceId: taskA.workspaceId, collaborationId: taskA.id, expectedVersion: taskA.version, idempotencyKey: 'F24-over-100-A' });
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
        const production = productionServiceFor(fx, runtimeValue, async (_workspaceId, runId) => { dispatches.push(runId); });
        const task = await production.service.confirm({ workspaceId: fx.plan.workspaceId, collaborationId: fx.plan.id,
          expectedVersion: fx.plan.version, idempotencyKey: `F24-production-flag-${repetition}` });
        assert.ok(task.canonicalRunId);
        const runId = task.canonicalRunId;
        assert.equal((fx.store.getDatabase().prepare("SELECT state FROM workspace_admissions WHERE canonical_run_id = ? AND subject_kind = 'CANONICAL_RUN'")
          .get(runId) as { state: string }).state, 'GRANTED');
        assert.equal(task.status, runtimeValue === 'true' ? 'running' : 'queued');
        assert.equal(production.service.canDispatch(task.workspaceId, runId), runtimeValue === 'true');
        if (runtimeValue !== 'true') await production.service.resumeRun(task.workspaceId, runId);
        await production.startProductionBackground();
        assert.deepEqual(dispatches, runtimeValue === 'true' ? [runId] : []);
        assert.equal(production.approvalResumes(), runtimeValue === 'true' ? 1 : 0, 'the real post-listen approval entry must share the runtime switch');
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
        const production = productionServiceFor({ root: fx.root, store: activeStore }, 'true', async (workspaceId, resumedRunId) => {
          assert.equal(resumedRunId, runId);
          dispatches.push(resumedRunId);
          admitFollowerToApproval(activeStore, workspaceId, resumedRunId);
        });
        await recoverFullStartup(activeStore, production.service);
        assert.equal(dispatches.length, reboot === 1 ? 0 : 1, 'recovery itself must not dispatch an unstarted or waiting-approval Run');
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

function applyVerifiedMemoryFacts046(fx: ReturnType<typeof fixture>): void {
  migration046.apply({ db: fx.store.getDatabase() as unknown as MinimalDatabaseSync });
}

async function captureServerAcceptanceCandidate(
  fx: ReturnType<typeof fixture>,
  runId: string,
  worktreePath: string,
): Promise<CollaborationCandidate> {
  const task = fx.repository.findById('workspace-a', fx.plan.id)!;
  const service = fx.service as unknown as {
    captureAndPersistCandidate(task: CollaborationTask, runId: string, worktreePath: string): Promise<CollaborationCandidate>;
  };
  return service.captureAndPersistCandidate(task, runId, worktreePath);
}

test('M3 runner receipt binds the persisted server acceptance output, exit code and frozen HEAD in one transaction', async () => {
  const fx = fixture({}, {
    memoryEnabled: true,
    acceptanceCommands: ['node -e "process.stdout.write(\'server-acceptance-proof\')"'],
  });
  try {
    applyVerifiedMemoryFacts046(fx);
    const active = fx.runningWithCompletedStart();
    const working = join(fx.root, 'implementation');
    execFileSync('git', ['worktree', 'add', '--detach', working, fx.plan.baseCommit], { cwd: fx.repositoryRoot, windowsHide: true, stdio: 'pipe' });
    writeFileSync(join(working, 'README.md'), 'candidate\n');

    const candidate = await captureServerAcceptanceCandidate(fx, active.run.id, working);
    const persistedOutput = fx.store.getDatabase().prepare('SELECT test_output FROM collaboration_candidates WHERE id=?')
      .get(candidate.id) as { test_output: string };
    const receipt = fx.store.getDatabase().prepare(`SELECT candidate_id,workspace_id,run_id,commit_id,result,exit_code,
      output_sha256,runner_version FROM memory_test_runner_receipts WHERE candidate_id=?`).get(candidate.id) as {
      candidate_id: string; workspace_id: string; run_id: string; commit_id: string; result: string; exit_code: number;
      output_sha256: string; runner_version: string;
    };
    assert.equal(candidate.testStatus, 'passed');
    assert.equal(candidate.testExitCode, 0);
    assert.match(persistedOutput.test_output, /server-acceptance-proof/u);
    assert.deepEqual({ ...receipt }, {
      candidate_id: candidate.id, workspace_id: 'workspace-a', run_id: active.run.id,
      commit_id: candidate.headCommit, result: 'passed', exit_code: 0,
      output_sha256: createHash('sha256').update(persistedOutput.test_output).digest('hex'),
      runner_version: 'collaboration-acceptance.v1',
    });
    assert.throws(() => fx.store.getDatabase().prepare('UPDATE memory_test_runner_receipts SET result=? WHERE candidate_id=?')
      .run('failed', candidate.id), /MEMORY_TEST_RUNNER_RECEIPT_IMMUTABLE/u);
  } finally { await fx.close(); }
});

test('M3 runner receipt records the acceptance process actual nonzero exit code', async () => {
  const fx = fixture({}, {
    memoryEnabled: true,
    acceptanceCommands: ['node -e "process.stdout.write(\'server-runner-failure\');process.exit(7)"'],
  });
  try {
    applyVerifiedMemoryFacts046(fx);
    const active = fx.runningWithCompletedStart();
    const working = join(fx.root, 'implementation');
    execFileSync('git', ['worktree', 'add', '--detach', working, fx.plan.baseCommit], { cwd: fx.repositoryRoot, windowsHide: true, stdio: 'pipe' });
    writeFileSync(join(working, 'README.md'), 'candidate\n');

    const candidate = await captureServerAcceptanceCandidate(fx, active.run.id, working);
    const persisted = fx.store.getDatabase().prepare(`SELECT c.head_commit,c.test_status,c.test_exit_code,c.test_output,
      rr.commit_id,rr.result,rr.exit_code,rr.output_sha256 FROM collaboration_candidates c
      JOIN memory_test_runner_receipts rr ON rr.candidate_id=c.id WHERE c.id=?`).get(candidate.id) as {
      head_commit: string; test_status: string; test_exit_code: number; test_output: string;
      commit_id: string; result: string; exit_code: number; output_sha256: string;
    };
    assert.equal(persisted.test_status, 'failed');
    assert.equal(persisted.test_exit_code, 7);
    assert.equal(persisted.result, persisted.test_status);
    assert.equal(persisted.exit_code, persisted.test_exit_code);
    assert.equal(persisted.commit_id, persisted.head_commit);
    assert.match(persisted.test_output, /server-runner-failure/u);
    assert.equal(persisted.output_sha256, createHash('sha256').update(persisted.test_output).digest('hex'));
  } finally { await fx.close(); }
});

test('M3 runner receipt is omitted when acceptance changes the frozen candidate', async () => {
  const fx = fixture({}, {
    memoryEnabled: true,
    acceptanceCommands: ['node -e "require(\'fs\').writeFileSync(\'README.md\', \'mutated\\n\')"'],
  });
  try {
    applyVerifiedMemoryFacts046(fx);
    const active = fx.runningWithCompletedStart();
    const working = join(fx.root, 'implementation');
    execFileSync('git', ['worktree', 'add', '--detach', working, fx.plan.baseCommit], { cwd: fx.repositoryRoot, windowsHide: true, stdio: 'pipe' });
    writeFileSync(join(working, 'README.md'), 'candidate\n');

    const candidate = await captureServerAcceptanceCandidate(fx, active.run.id, working);
    assert.equal(candidate.testStatus, 'failed');
    assert.match(candidate.testOutput ?? '', /COLLABORATION_TEST_MUTATED_CANDIDATE/u);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM memory_test_runner_receipts WHERE candidate_id=?')
      .get(candidate.id) as { count: number }).count, 0);
  } finally { await fx.close(); }
});

test('M3 keeps candidate capture compatible before migration 046 and atomically rolls back a failed receipt insert', async () => {
  const legacy = fixture({}, { memoryEnabled: true });
  try {
    const active = legacy.runningWithCompletedStart();
    const working = join(legacy.root, 'implementation');
    execFileSync('git', ['worktree', 'add', '--detach', working, legacy.plan.baseCommit], { cwd: legacy.repositoryRoot, windowsHide: true, stdio: 'pipe' });
    writeFileSync(join(working, 'README.md'), 'candidate\n');
    const candidate = await captureServerAcceptanceCandidate(legacy, active.run.id, working);
    assert.equal(candidate.testStatus, 'passed');
    assert.equal((legacy.store.getDatabase().prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='memory_test_runner_receipts'")
      .get() as { count: number }).count, 0);
  } finally { await legacy.close(); }

  const fx = fixture({}, { memoryEnabled: true });
  try {
    applyVerifiedMemoryFacts046(fx);
    fx.store.getDatabase().exec(`CREATE TRIGGER reject_memory_test_receipt BEFORE INSERT ON memory_test_runner_receipts
      BEGIN SELECT RAISE(ABORT,'receipt insert rejected'); END`);
    const active = fx.runningWithCompletedStart();
    const working = join(fx.root, 'implementation');
    execFileSync('git', ['worktree', 'add', '--detach', working, fx.plan.baseCommit], { cwd: fx.repositoryRoot, windowsHide: true, stdio: 'pipe' });
    writeFileSync(join(working, 'README.md'), 'candidate\n');
    await assert.rejects(captureServerAcceptanceCandidate(fx, active.run.id, working), /receipt insert rejected/u);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM collaboration_candidates WHERE canonical_run_id=?')
      .get(active.run.id) as { count: number }).count, 0);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM memory_test_runner_receipts').get() as { count: number }).count, 0);
  } finally { await fx.close(); }
});

test('M3 terminal hook derives its eventContext from the canonical durable terminal event', async () => {
  const observed: Array<{ workspaceId: string; runId: string; createdAt: string; eventContext?: unknown }> = [];
  const fx = fixture({
    verifiedMemoryFacts: () => ({ accumulateTerminal(input) { observed.push(input); return []; } }),
  }, { memoryEnabled: true });
  try {
    applyVerifiedMemoryFacts046(fx);
    const active = fx.runningWithCompletedStart();
    const db = fx.store.getDatabase();
    db.prepare("UPDATE runs SET status='completed',updated_at=?,version=version+1 WHERE workspace_id=? AND id=?")
      .run(NOW, 'workspace-a', active.run.id);
    const sequence = (db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM runtime_events WHERE run_id=?')
      .get(active.run.id) as { sequence: number }).sequence;
    db.prepare(`INSERT INTO runtime_events
      (id,schema_version,type,workspace_id,task_id,run_id,sequence,timestamp,source,correlation_id,severity,visibility,durability,payload_json,created_at)
      VALUES(?,1,'run.completed',?,?,?,?,?,'test',?,'info','workspace','durable','{}',?)`)
      .run('evt_terminal_hook', 'workspace-a', active.run.taskId, active.run.id, sequence, NOW, 'corr-terminal-hook', NOW);

    assert.deepEqual(fx.service.accumulateTerminal({ workspaceId: 'workspace-a', runId: active.run.id }), []);
    assert.equal(observed.length, 1);
    assert.deepEqual(observed[0], {
      workspaceId: 'workspace-a', runId: active.run.id, createdAt: NOW,
      eventContext: { origin: 'persisted_event', eventId: 'evt_terminal_hook', context: {
        correlationId: 'corr-terminal-hook', causationId: 'evt_terminal_hook',
      } },
    });
  } finally { await fx.close(); }
});

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
          action: 'apply', expectedVersion: task.version, idempotencyKey: `F25-${scenario}-${repetition}` }));
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
        action: 'apply', expectedVersion: taskA.version, idempotencyKey: `F25-atomic-startup-${repetition}` }));
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
        const production = productionServiceFor({ root: fx.root, store: activeStore }, 'true', async (workspaceId, runId) => {
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
        settling = fx.service.apply({ workspaceId: taskA.workspaceId, collaborationId: taskA.id,
          expectedVersion: taskA.version, idempotencyKey: `F24-release-gap-${safe}-${repetition}` })
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
          const production = productionServiceFor({ root: fx.root, store: activeStore }, 'true', async (workspaceId, resumedRunId) => {
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
      const applied = await fx.service.apply({ workspaceId: ready.workspaceId, collaborationId: ready.id, expectedVersion: ready.version,
        idempotencyKey: `F25-release-failure-${repetition}` });
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
