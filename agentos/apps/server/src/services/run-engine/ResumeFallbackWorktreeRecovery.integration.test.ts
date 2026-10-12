import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WORKFLOW_TEMPLATES_V1 } from '@agentos/shared';
import { DEFAULT_CAPABILITIES, DEFAULT_TIMEOUT_POLICY } from '../../store/ProviderConfigurationRepository.js';
import { SqliteStore } from '../../store/SqliteStore.js';
import { WorkspaceManager } from '../../managers/WorkspaceManager.js';
import { IdempotencyService } from '../IdempotencyService.js';
import { TaskRunService } from '../TaskRunService.js';
import { ResumeFallbackWorktreePreparer } from '../ResumeFallbackWorktreePreparer.js';
import { WorkflowTemplateService } from '../WorkflowTemplateService.js';
import { WorktreeManager } from '../WorktreeManager.js';
import { WorktreeRuntimeEventEmitter } from '../WorktreeRuntimeEvents.js';
import { createProviderExecutionChain } from './providerExecutionChain.js';

const NOW = '2026-10-12T00:00:00.000Z';
const REQUEST_KEY = 'required-resume-fallback-restart-key';
const CHILD_RECEIPT = 'resume-fallback-child-receipt.txt';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }).trim();
}

function unlinkFixtureReparsePoints(directory: string): void {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      try { rmdirSync(path); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOTDIR' || code === 'EINVAL') {
          try { unlinkSync(path); }
          catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
          }
        } else if (code !== 'ENOENT') {
          throw error;
        }
      }
    } else if (entry.isDirectory()) {
      unlinkFixtureReparsePoints(path);
    }
  }
}

async function requiredChildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-resume-required-child-'));
  mkdirSync(join(root, 'workspace-data'), { recursive: true });
  writeFileSync(join(root, 'workspace-data', 'workspaces.json'), '{"workspaces":[]}');
  let store = new SqliteStore(root);
  try {
    const workspace = await new WorkspaceManager(store).create(
      'Resume fallback isolated workspace',
      join(root, 'source-workspace'),
      { git: false, memory: false, readme: false, docs: false },
    );
    git(workspace.rootPath, ['init', '-q', '-b', 'main']);
    git(workspace.rootPath, ['config', 'user.name', 'AgentOS resume fixture']);
    git(workspace.rootPath, ['config', 'user.email', 'resume-fixture@agentos.invalid']);
    git(workspace.rootPath, ['config', 'core.autocrlf', 'false']);
    writeFileSync(join(workspace.rootPath, 'baseline.txt'), 'committed baseline\n');
    git(workspace.rootPath, ['add', '.']);
    git(workspace.rootPath, ['commit', '-qm', 'clean baseline']);

    const codexAgent = store.listAgentProfiles(workspace.id).find(agent => agent.role === 'codex');
    assert.ok(codexAgent?.providerConfigId);
    const providers = store.providerConfigurationRepository();
    const provider = providers.findById(codexAgent.providerConfigId);
    assert.ok(provider);
    const cliScript = `require('node:fs').writeFileSync('${CHILD_RECEIPT}', process.cwd());process.stdout.write('CHILD_STAGE_EXECUTED');`;
    providers.update({
      ...provider,
      name: 'Resume fallback configured Custom CLI',
      providerType: 'custom-cli',
      adapterId: 'builtin.custom-cli',
      runtimeMode: 'cli',
      executable: process.execPath,
      argsTemplate: ['-e', cliScript],
      model: undefined,
      workingDirectoryMode: 'workspace',
      customWorkingDirectory: undefined,
      capabilities: { ...DEFAULT_CAPABILITIES },
      timeoutPolicy: { ...DEFAULT_TIMEOUT_POLICY },
      approvalMode: 'disabled',
      outputMode: 'parsed-text',
      enabled: true,
      updatedAt: NOW,
    }, provider.version);

    const template = WORKFLOW_TEMPLATES_V1.find(candidate => candidate.key === 'single-agent');
    assert.ok(template);
    const templates = new WorkflowTemplateService({
      store,
      workflowDefinitionRepository: () => store.workflowDefinitionRepository(),
      taskRepository: () => store.taskRepository(),
      runRepository: () => store.runRepository(),
      runSnapshotRepository: () => store.runSnapshotRepository(),
      runStageRepository: () => store.runStageRepository(),
      providerConfigurationRepository: () => store.providerConfigurationRepository(),
      findAgentSnapshotSource: (workspaceId, agentId) => store.findAgentSnapshotSource(workspaceId, agentId),
    });
    const parentGraph = templates.instantiateTemplateRun({
      workspace,
      template,
      roleBindings: { 'single-agent': 'codex' },
      createdBy: 'resume-worktree-test',
      objective: 'execute the frozen child snapshot from its own worktree',
      worktreeMode: 'required',
      createdAt: NOW,
    });
    assert.equal(parentGraph.stages.length, 1);
    assert.equal(parentGraph.snapshot.payload.workflow.worktreeMode, 'required');
    store.getDatabase().prepare(`
      UPDATE runs SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?
    `).run(NOW, workspace.id, parentGraph.run.id);
    const service = new TaskRunService(store, {
      idempotencyService: new IdempotencyService(store.idempotencyRepository()),
      resumeFallbackWorktreePreparationAvailable: true,
    });
    service.pauseRunForV2(workspace.id, parentGraph.run.id);
    const accepted = service.resumeRunForV2(
      workspace.id,
      parentGraph.run.id,
      REQUEST_KEY,
      undefined,
      { resumeMode: 'child-run' },
    );
    assert.equal(accepted.replayed, false);
    const child = store.runRepository().findById(workspace.id, accepted.body.run.id);
    assert.ok(child);
    assert.equal(child.reason, 'resume-fallback');
    assert.equal(child.status, 'queued');

    const worktreeRoot = join(root, 'agentos-worktrees');
    return {
      root,
      workspace,
      parentRunId: parentGraph.run.id,
      childRunId: child.id,
      worktreeRoot,
      get store() { return store; },
      reopenStore() {
        store.close();
        store = new SqliteStore(root);
        return store;
      },
      close() {
        try {
          const leases = store.worktreeRepository().list();
          for (const lease of leases) {
            const path = resolve(lease.absolutePath);
            const fromWorktreeRoot = relative(resolve(worktreeRoot), path);
            if (fromWorktreeRoot === '' || fromWorktreeRoot === '..'
              || fromWorktreeRoot.startsWith(`..${sep}`) || isAbsolute(fromWorktreeRoot)) continue;
            try {
              execFileSync('git', ['worktree', 'remove', '--force', path], {
                cwd: workspace.rootPath, windowsHide: true, stdio: 'ignore',
              });
            } catch { /* replacement-repository fixtures are preserved until temp-root cleanup */ }
          }
          try { git(workspace.rootPath, ['worktree', 'prune', '--expire', 'now']); } catch { /* fixture may already be gone */ }
        } catch { /* keep cleanup best-effort after a partially closed store */ }
        try { store.close(); } catch { /* already closed during a restart */ }
        try {
          // Windows Git fixtures may leave junctions/reparse points in .git;
          // unlink only the link entries inside this generated temp root.
          unlinkFixtureReparsePoints(root);
          try {
            rmSync(join(workspace.rootPath, '.git'), {
              recursive: true, force: true, maxRetries: 10, retryDelay: 100,
            });
          } catch { /* the temporary source repository is discarded with the fixture */ }
          rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
        catch (error) {
          if (process.platform !== 'win32' || !['ENOTEMPTY', 'EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      },
    };
  } catch (error) {
    try { store.close(); } finally { rmSync(root, { recursive: true, force: true }); }
    throw error;
  }
}

function createPersistedWorktreeManager(store: SqliteStore, worktreeRoot: string): WorktreeManager {
  const events = new WorktreeRuntimeEventEmitter(store.getDatabase(), store.runtimeEventOutboxWriter());
  return new WorktreeManager(worktreeRoot, store.worktreeRepository(), events);
}

function createPreparer(
  store: SqliteStore,
  workspaceId: string,
  workspaceRoot: string,
  worktrees: WorktreeManager,
  registeredPaths: Map<string, string>,
): ResumeFallbackWorktreePreparer {
  return new ResumeFallbackWorktreePreparer({
    store,
    worktrees,
    workspaceGitRootFor: id => id === workspaceId ? workspaceRoot : undefined,
    registerWorktreePath: (_id, runId, path) => registeredPaths.set(runId, path),
  });
}

function createRealProviderChain(
  fx: Awaited<ReturnType<typeof requiredChildFixture>>,
  preparer: ResumeFallbackWorktreePreparer,
  registeredPaths: Map<string, string>,
  probeCalls: { value: number },
) {
  return createProviderExecutionChain({
    store: fx.store,
    artifactRoot: join(fx.root, 'artifacts'),
    workspaceRootFor: () => fx.workspace.rootPath,
    worktreePathFor: (_workspaceId, runId) => registeredPaths.get(runId),
    prepareResumeFallbackChild: (workspaceId, runId) => preparer.prepare(workspaceId, runId),
    probe: { probe: async () => {
      probeCalls.value += 1;
      return { stdout: 'v22.0.0', stderr: '', exitCode: 0, signal: null };
    } },
  });
}

test('required fallback Child reuses its persisted owned lease after restart and executes the frozen Custom CLI Stage', async () => {
  const fx = await requiredChildFixture();
  try {
    const firstWorktrees = createPersistedWorktreeManager(fx.store, fx.worktreeRoot);
    const firstPaths = new Map<string, string>();
    const firstPreparer = createPreparer(fx.store, fx.workspace.id, fx.workspace.rootPath, firstWorktrees, firstPaths);
    await firstPreparer.prepare(fx.workspace.id, fx.childRunId);
    const initialLease = firstWorktrees.listLeases().find(lease => lease.runId === fx.childRunId);
    assert.ok(initialLease);
    assert.equal(initialLease.status, 'active');
    assert.equal(initialLease.executionId, `resume-fallback-${fx.childRunId}`);
    assert.equal(firstPaths.get(fx.childRunId), firstWorktrees.getRecord(initialLease.id)?.absolutePath);

    // The isolated Child lease is durable before restart. A later untracked
    // source edit must neither invalidate nor redirect that owned checkout.
    const sourceOnlyFile = join(fx.workspace.rootPath, 'after-lease-source-only.txt');
    writeFileSync(sourceOnlyFile, 'must not be visible to the Child checkout\n');
    fx.reopenStore();
    const restartedWorktrees = createPersistedWorktreeManager(fx.store, fx.worktreeRoot);
    const reconciliation = await restartedWorktrees.reconcile([fx.workspace.rootPath]);
    assert.ok(!reconciliation.failed.includes(initialLease.id));
    assert.equal(restartedWorktrees.getLease(initialLease.id)?.status, 'active');

    const replay = new TaskRunService(fx.store, {
      idempotencyService: new IdempotencyService(fx.store.idempotencyRepository()),
      resumeFallbackWorktreePreparationAvailable: true,
    }).resumeRunForV2(
      fx.workspace.id,
      fx.parentRunId,
      REQUEST_KEY,
      undefined,
      { resumeMode: 'child-run' },
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.body.run.id, fx.childRunId);
    assert.equal(fx.store.runRepository().listByTask(fx.workspace.id,
      fx.store.runRepository().findById(fx.workspace.id, fx.parentRunId)!.taskId)
      .filter(run => run.parentRunId === fx.parentRunId && run.reason === 'resume-fallback').length, 1);

    const restartedPaths = new Map<string, string>();
    const restartedPreparer = createPreparer(fx.store, fx.workspace.id, fx.workspace.rootPath, restartedWorktrees, restartedPaths);
    const probeCalls = { value: 0 };
    const chain = createRealProviderChain(fx, restartedPreparer, restartedPaths, probeCalls);
    await chain.resumeGrantedResumeFallbackChildren(fx.workspace.id);

    const finalRun = fx.store.runRepository().findById(fx.workspace.id, fx.childRunId)!;
    const childSnapshot = fx.store.runSnapshotRepository().findByRunId(fx.workspace.id, fx.childRunId)!;
    const childStages = fx.store.runStageRepository().listByRun(fx.workspace.id, fx.childRunId);
    const processes = fx.store.processRepository().listByRun(fx.workspace.id, fx.childRunId);
    const leaseAfterDispatch = restartedWorktrees.listLeases().filter(lease => lease.runId === fx.childRunId);
    const childCheckout = restartedWorktrees.getRecord(initialLease.id)!.absolutePath;

    assert.equal(finalRun.status, 'completed');
    assert.equal(childStages.length, 1);
    assert.equal(childStages[0]?.status, 'completed');
    assert.equal(childStages[0]?.runSnapshotId, childSnapshot.id);
    assert.equal(childSnapshot.payload.schemaVersion, 2);
    if (childSnapshot.payload.schemaVersion !== 2) throw new Error('Child snapshot is not V2');
    assert.equal(childSnapshot.payload.workflow.worktreeMode, 'required');
    assert.equal(childSnapshot.payload.workflow.stages[0]?.provider?.adapterId, 'builtin.custom-cli');
    assert.equal(childSnapshot.payload.workflow.stages[0]?.provider?.workingDirectoryMode, 'worktree');
    assert.equal(probeCalls.value > 0, true, 'the real coordinator validated the frozen configured Provider');
    assert.equal(processes.length, 1);
    assert.equal(processes[0]?.runId, fx.childRunId);
    assert.equal(processes[0]?.stageId, childStages[0]?.id);
    assert.equal(resolve(processes[0]!.cwdResolved), resolve(childCheckout), 'the actual process receipt uses the Child-owned checkout');
    assert.equal(readFileSync(join(childCheckout, CHILD_RECEIPT), 'utf8'), resolve(childCheckout));
    assert.equal(existsSync(join(fx.workspace.rootPath, CHILD_RECEIPT)), false, 'the configured CLI did not write into the parent workspace');
    assert.equal(existsSync(sourceOnlyFile), true);
    assert.equal(existsSync(join(childCheckout, 'after-lease-source-only.txt')), false);
    assert.equal(leaseAfterDispatch.length, 1, 'restart replay reused the same durable Child lease');
    assert.equal(leaseAfterDispatch[0]?.id, initialLease.id);
    assert.ok(fx.store.runtimeEventRepository().listByWorktree(fx.workspace.id, initialLease.id)
      .some(result => result.kind === 'known' && result.event.type === 'worktree.activated'));

    await chain.resumeGrantedResumeFallbackChildren(fx.workspace.id);
    assert.equal(fx.store.processRepository().listByRun(fx.workspace.id, fx.childRunId).length, 1,
      'a repeated startup sweep does not dispatch a second Provider process');
    assert.equal(restartedWorktrees.listLeases().filter(lease => lease.runId === fx.childRunId).length, 1);
  } finally {
    fx.close();
  }
});

for (const replacement of ['wrong-branch', 'different-repository'] as const) {
  test(`required fallback Child ownership mismatch (${replacement}) fails visibly before Admission or Provider and preserves files`, async () => {
    const fx = await requiredChildFixture();
    try {
      const worktrees = createPersistedWorktreeManager(fx.store, fx.worktreeRoot);
      const paths = new Map<string, string>();
      const preparer = createPreparer(fx.store, fx.workspace.id, fx.workspace.rootPath, worktrees, paths);
      await preparer.prepare(fx.workspace.id, fx.childRunId);
      const lease = worktrees.listLeases().find(candidate => candidate.runId === fx.childRunId)!;
      const record = worktrees.getRecord(lease.id)!;
      let preservedPath = record.absolutePath;

      if (replacement === 'wrong-branch') {
        git(record.absolutePath, ['switch', '-c', 'unowned-child-branch']);
      } else {
        preservedPath = `${record.absolutePath}-preserved`;
        renameSync(record.absolutePath, preservedPath);
        execFileSync('git', ['clone', '--shared', '--quiet', fx.workspace.rootPath, record.absolutePath], { windowsHide: true });
        git(record.absolutePath, ['switch', '-c', record.branchName]);
        assert.equal(git(record.absolutePath, ['rev-parse', 'HEAD']), record.baseCommit);
        assert.equal(git(record.absolutePath, ['symbolic-ref', '--short', 'HEAD']), record.branchName,
          'the different-repository replacement deliberately matches the lease branch and HEAD');
      }

      const probeCalls = { value: 0 };
      const chain = createRealProviderChain(fx, preparer, paths, probeCalls);
      await chain.resumeGrantedResumeFallbackChildren(fx.workspace.id);

      const failedChild = fx.store.runRepository().findById(fx.workspace.id, fx.childRunId)!;
      const start = fx.store.operationService().listByRun(fx.workspace.id, fx.childRunId)
        .find(operation => operation.type === 'run.start');
      assert.equal(failedChild.status, 'failed');
      assert.equal(failedChild.failureCode, 'RUN_RESUME_WORKTREE_PREPARATION_FAILED');
      assert.equal(start?.status, 'failed');
      assert.equal(start?.error?.code, 'RUN_RESUME_WORKTREE_PREPARATION_FAILED');
      assert.equal(fx.store.workspaceAdmissionRepository().findBySubject(fx.workspace.id, {
        subjectKind: 'CANONICAL_RUN', canonicalRunId: fx.childRunId,
      }), undefined, 'worktree ownership failure occurs before Child Admission is requested');
      assert.equal(fx.store.processRepository().listByRun(fx.workspace.id, fx.childRunId).length, 0);
      assert.equal(probeCalls.value, 0, 'no Provider discovery or validation was entered');
      assert.equal(existsSync(record.absolutePath), true);
      assert.equal(existsSync(preservedPath), true, 'ownership failure preserves the original or replacement checkout');
      assert.equal(worktrees.getLease(lease.id)?.status, 'active', 'attestation failure preserves lease state for explicit recovery');
    } finally {
      fx.close();
    }
  });
}
