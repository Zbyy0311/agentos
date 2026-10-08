import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { getWorkflowTemplate, type CollaborationCandidate, type CollaborationTask } from '@agentos/shared';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { CollaborationRepository } from '../store/CollaborationRepository.js';
import { SqliteStore } from '../store/SqliteStore.js';
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
import { WorkspaceGitRootRegistry } from './WorkspaceGitRootRegistry.js';


export const NOW = '2026-09-30T00:00:00.000Z';
export const PATCH = 'diff --git a/README.md b/README.md\nindex df967b9..a9a2f8e 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-base\n+candidate\n';

export type CollaborationWorkflowTestOverrides = Partial<CollaborationWorkflowServiceOptions> & {
  readonly runtimeDispatchEnabled?: boolean;
};
export interface CollaborationWorkflowFixtureSettings {
  readonly memoryEnabled?: boolean;
  readonly acceptanceCommands?: readonly string[];
}

export async function disposeFixtureTree(path: string): Promise<void> {
  let entry;
  try { entry = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) { await unlink(path); return; }
  for (const child of await readdir(path)) await disposeFixtureTree(join(path, child));
  await rmdir(path);
}

export function fixture(overrides: CollaborationWorkflowTestOverrides = {}, settings: CollaborationWorkflowFixtureSettings = {}) {
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
  function candidateBinding(task: CollaborationTask) {
    const candidate = task.currentCandidateId ? repository.findCandidate(task.workspaceId, task.currentCandidateId) : undefined;
    if (!candidate?.contentHash) throw new Error('Fixture candidate content hash is missing');
    return { candidateId: candidate.id, candidateBaseCommit: candidate.baseCommit, candidateContentHash: candidate.contentHash };
  }
  function applicationInput(task: CollaborationTask, idempotencyKey: string, expectedVersion = task.version) {
    return { workspaceId: task.workspaceId, collaborationId: task.id, expectedVersion, idempotencyKey, ...candidateBinding(task) };
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
      diffHash: snapshot.patchHash, manifestVersion: 2,
      manifest: [...snapshot.untrackedManifest, ...snapshot.binaryManifest], testStatus: 'passed', testCommand: plan.acceptanceCommands.join(' && '),
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
  return { root, dataRoot, store, repository, service, authority, workspaces, worktrees, repositoryRoot, plan, queued, ready, verifiedReady, runningWithCompletedStart, candidateBinding, applicationInput, cancelCalls: () => cancelCalls,
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

export function preparePortableWorkspace(fx: ReturnType<typeof fixture>): { portableRoot: string; markerPath: string } {
  const portableRoot = join(fx.root, 'portable-restored-workspace');
  mkdirSync(portableRoot);
  const markerPath = join(portableRoot, 'restored-content.txt');
  writeFileSync(markerPath, 'portable restored content must remain untouched\n');
  const workspace = fx.workspaces.get('workspace-a');
  assert.ok(workspace);
  fx.store.workspaceRepo.update({ ...workspace, rootPath: portableRoot });
  return { portableRoot, markerPath };
}

export function createMappedCleanClone(fx: ReturnType<typeof fixture>): string {
  const cloneRoot = join(fx.root, 'mapped-clean-clone');
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', fx.repositoryRoot, cloneRoot], { windowsHide: true });
  return cloneRoot;
}

export function grantRecoveryFixturePermissions(fx: ReturnType<typeof fixture>): void {
  const db = fx.store.getDatabase();
  db.prepare('UPDATE agent_profiles SET permissions_json = ? WHERE workspace_id = ? AND id = ?')
    .run(JSON.stringify(['read']), 'workspace-a', 'planner');
  db.prepare('UPDATE agent_profiles SET permissions_json = ? WHERE workspace_id = ? AND id = ?')
    .run(JSON.stringify(['read', 'write']), 'workspace-a', 'implementer');
  db.prepare('UPDATE agent_profiles SET permissions_json = ? WHERE workspace_id = ? AND id = ?')
    .run(JSON.stringify(['read', 'review']), 'workspace-a', 'reviewer');
}

export function conflict(error: unknown): boolean {
  return typeof (error as { code?: unknown })?.code === 'string' && String((error as { code: string }).code).includes('CONFLICT');
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

// Execute the real production option construction and post-listen queue entry,
// with isolated SQLite/Git and stub dispatch boundaries. Importing index.ts
// itself would acquire server ownership and start unrelated native services.
export function productionCollaborationSlices() {
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

export function productionServiceFor(
  fx: { root: string; dataRoot: string; store: SqliteStore },
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
  const withDispatchPermit = async (operation: () => Promise<void>) => { await operation(); return true; };
  const workspaceManager = new WorkspaceManager(fx.store);
  const worktreeManager = new WorktreeManager(join(fx.root, 'worktrees'));
  const workspaceGitRoots = new WorkspaceGitRootRegistry(fx.dataRoot, fx.store, workspaceManager, worktreeManager);
  const construct = new Function('store', 'workspaceManager', 'worktreeManager', 'providerExecutionChain', 'collaborationWorktreePaths', 'CollaborationWorkflowService', 'process', 'withDispatchPermit', 'workspaceGitRoots',
    compile(`${slices.flag}\nlet collaborationService;\n${slices.construction}\nreturn collaborationService;`));
  const service = construct(fx.store, workspaceManager, worktreeManager, chain,
    new Map<string, string>(), CollaborationWorkflowService, environment, withDispatchPermit, workspaceGitRoots) as CollaborationWorkflowService;
  return { service, authority, approvalResumes: () => approvalResumes,
    async startProductionBackground(quiescing = false): Promise<void> {
      const pending: Promise<void>[] = [];
      const observed = { resumeGrantedQueuedRuns: (...args: Parameters<CollaborationWorkflowService['resumeGrantedQueuedRuns']>) => {
        const result = service.resumeGrantedQueuedRuns(...args); pending.push(result); return result;
      } };
      const withDispatchPermit = async (operation: () => Promise<void>) => { await operation(); return true; };
      const start = new Function('collaborationService', 'providerExecutionChain', 'process', 'diagLog', 'maintenanceBarrier', 'withDispatchPermit', compile(`${slices.flag}\n${slices.background}`));
      start(observed, chain, environment, () => undefined, { snapshot: { quiescing } }, withDispatchPermit);
      await Promise.all(pending);
    },
  };
}

export async function recoverFullStartup(store: SqliteStore, service: CollaborationWorkflowService): Promise<void> {
  recoverInterruptedTaskRuntime(store, new TaskRunService(store));
  recoverInterruptedRuns(store);
  store.groupInteractionRepository().reconcileInterruptedOnStartup(new Date().toISOString());
  await new WorkspaceAdmissionStartupReconciler({ store }).reconcileOnStartup();
  await service.reconcileOnStartup();
}

export function admitFollowerToApproval(store: SqliteStore, workspaceId: string, runId: string): void {
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

export function createQueuedBehindApplicationPlan(fx: ReturnType<typeof fixture>, suffix: string) {
  return fx.repository.create({
    workspaceId: 'workspace-a', title: `Queued behind application ${suffix}`, objective: 'Remain queued until the application writer releases',
    scope: ['README.md'], acceptanceCommands: ['node -e "process.exit(0)"'],
    plannerAgentId: 'planner', implementerAgentId: 'implementer', reviewerAgentId: 'reviewer',
    planHash: `queued-plan-${suffix}`, baseCommit: fx.plan.baseCommit, maxReworkRounds: 2, createdAt: NOW,
  });
}

export async function seedQueuedAuthorityFollower(fx: ReturnType<typeof fixture>, suffix: string, index: number): Promise<string> {
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

export function applyVerifiedMemoryFacts046(fx: ReturnType<typeof fixture>): void {
  migration046.apply({ db: fx.store.getDatabase() as unknown as MinimalDatabaseSync });
}

export async function captureServerAcceptanceCandidate(
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
