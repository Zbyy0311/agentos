import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getWorkflowTemplate, type CollaborationCandidate, type CollaborationTask } from '@agentos/shared';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { CollaborationControlRepository } from '../store/CollaborationControlRepository.js';
import { CollaborationRepository } from '../store/CollaborationRepository.js';
import { SqliteStore } from '../store/SqliteStore.js';
import type { CollaborationWorkflowServiceOptions } from './CollaborationWorkflowService.js';
import { CollaborationWorkflowService } from './CollaborationWorkflowService.js';
import { RunEngine } from './run-engine/RunEngine.js';
import { StageExecutor } from './run-engine/StageExecutor.js';
import { CollaborationApplyJournalService, type ApplyJournal } from './CollaborationApplyJournal.js';
import { captureCollaborationCandidateSnapshot } from './CollaborationCandidateSnapshot.js';
import { WorktreeManager } from './WorktreeManager.js';
import { WorkspaceAdmissionAuthority } from './WorkspaceAdmissionAuthority.js';
import { CollaborationSnapshotGitContext } from './CollaborationSnapshotGitContext.js';

const NOW = '2026-09-30T00:00:00.000Z';
const WORKSPACE_ID = 'workspace-apply-journal';
const ACCEPTANCE_COMMANDS = ['node -e "process.exit(0)"'];
const BINARY_POSTIMAGE = Buffer.from([0, 1, 127, 128, 255]);
const BINARY_PREIMAGE = Buffer.from([9, 0, 8, 255]);
const OWNED_PATHS = ['README.md', 'added.bin', 'delete.bin', 'rename-new.txt', 'rename-old.txt'];

type ApplyFaultPoint = NonNullable<CollaborationWorkflowServiceOptions['applyFault']> extends (point: infer P) => void ? P : never;

async function removeOwnedTreeNoFollow(path: string): Promise<void> {
  let info;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    try { await unlink(path); } catch (error) {
      if (process.platform !== 'win32' || !['EISDIR', 'EPERM', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await rmdir(path);
    }
    return;
  }
  if (!info.isDirectory()) {
    // Git objects are read-only on Windows; this is only the owned temp fixture.
    if (process.platform === 'win32') await chmod(path, 0o600);
    await unlink(path); return;
  }
  for (const name of await readdir(path)) await removeOwnedTreeNoFollow(join(path, name));
  await rmdir(path);
}

async function disposeOwnedTree(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { await removeOwnedTreeNoFollow(path); return; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(code)) throw error;
      if (attempt < 9) await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
      else process.emitWarning(`Apply-journal fixture cleanup incomplete; preserved ${path}: ${code}`);
    }
  }
}

function git(root: string, args: string[], input?: string | Buffer): string {
  return execFileSync('git', args, { cwd: root, input, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }).trimEnd();
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

interface FixtureOptions {
  readonly applyFault?: (point: ApplyFaultPoint) => void;
  readonly includeJunctionPath?: boolean;
  readonly realApplicationAdmission?: boolean;
  readonly autocrlf?: 'false' | 'input' | 'true';
  readonly sourceEol?: '\n' | '\r\n';
  readonly baseAttributes?: string;
  readonly postAttributes?: string;
  readonly postEncoding?: 'utf16le';
  readonly abbreviatedPatch?: boolean;
}

interface Fixture {
  readonly root: string;
  readonly dataRoot: string;
  readonly targetRoot: string;
  readonly candidateRoot: string;
  readonly worktreesRoot: string;
  readonly baseCommit: string;
  readonly snapshot: Awaited<ReturnType<typeof captureCollaborationCandidateSnapshot>>;
  readonly plan: CollaborationTask;
  readonly task: CollaborationTask;
  readonly candidate: CollaborationCandidate;
  readonly runId: string;
  get store(): SqliteStore;
  get repository(): CollaborationRepository;
  get controls(): CollaborationControlRepository;
  get workspaces(): WorkspaceManager;
  get service(): CollaborationWorkflowService;
  get journalService(): CollaborationApplyJournalService;
  restart(): Promise<void>;
  close(): Promise<void>;
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'agentos-apply-journal-'));
  const dataRoot = join(root, 'data');
  const targetRoot = join(root, 'target');
  const candidateRoot = join(root, 'candidate');
  const worktreesRoot = join(root, 'worktrees');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(targetRoot);

  for (const args of [
    ['init', '--quiet'],
    ['config', 'core.autocrlf', options.autocrlf ?? 'false'],
    ['config', 'user.name', 'Apply Journal Fixture'],
    ['config', 'user.email', 'apply-journal-fixture@agentos.invalid'],
  ]) git(targetRoot, args);
  await writeFile(join(targetRoot, 'README.md'), `base README${options.sourceEol ?? '\n'}`);
  if (options.baseAttributes !== undefined) await writeFile(join(targetRoot, '.gitattributes'), options.baseAttributes);
  await writeFile(join(targetRoot, 'delete.bin'), BINARY_PREIMAGE);
  await writeFile(join(targetRoot, 'rename-old.txt'), 'rename payload\n');
  await writeFile(join(targetRoot, 'stable.txt'), 'stable user file\n');
  git(targetRoot, ['add', '--all']);
  git(targetRoot, ['commit', '--quiet', '-m', 'fixture base']);
  const baseCommit = git(targetRoot, ['rev-parse', 'HEAD']);
  git(root, ['-c', `core.autocrlf=${options.autocrlf ?? 'false'}`, 'clone', '--quiet', '--no-hardlinks', targetRoot, candidateRoot]);
  git(candidateRoot, ['config', 'core.autocrlf', options.autocrlf ?? 'false']);

  const candidateText = `candidate README${options.sourceEol ?? '\n'}`;
  await writeFile(join(candidateRoot, 'README.md'), options.postEncoding === 'utf16le'
    ? Buffer.from(`\uFEFF${candidateText}`, 'utf16le') : candidateText);
  if (options.postAttributes !== undefined) await writeFile(join(candidateRoot, '.gitattributes'), options.postAttributes);
  await unlink(join(candidateRoot, 'delete.bin'));
  await unlink(join(candidateRoot, 'rename-old.txt'));
  await writeFile(join(candidateRoot, 'rename-new.txt'), 'rename payload\n');
  await writeFile(join(candidateRoot, 'added.bin'), BINARY_POSTIMAGE);
  if (options.includeJunctionPath) {
    await mkdir(join(candidateRoot, 'linked'));
    await writeFile(join(candidateRoot, 'linked', 'blocked.txt'), 'must not be read through a junction\n');
  }
  const snapshot = await captureCollaborationCandidateSnapshot(candidateRoot, baseCommit, ['./']);

  await mkdir(join(dataRoot, 'workspace'), { recursive: true });
  await writeFile(join(dataRoot, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
    id: WORKSPACE_ID,
    name: 'Apply journal fixture',
    rootPath: targetRoot,
    gitEnabled: true,
    memoryEnabled: false,
    agents: ['planner', 'implementer', 'reviewer'].map(id => ({
      id, name: id, role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [],
    })),
    lastOpenedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }] }));

  let store: SqliteStore;
  try {
    store = new SqliteStore(dataRoot);
    let repository = new CollaborationRepository(store.getDatabase());
    let controls = new CollaborationControlRepository(store.getDatabase());
    let workspaces = new WorkspaceManager(store);
    let journalService = new CollaborationApplyJournalService(store.getDatabase());

    const plan = repository.create({
      workspaceId: WORKSPACE_ID,
      title: 'Journal regression fixture',
      objective: 'Apply a bounded fixture candidate',
      scope: ['./'],
      acceptanceCommands: ACCEPTANCE_COMMANDS,
      plannerAgentId: 'planner',
      implementerAgentId: 'implementer',
      reviewerAgentId: 'reviewer',
      planHash: 'fixture-plan-hash',
      baseCommit,
      maxReworkRounds: 2,
      createdAt: NOW,
      scopePolicyVersion: 1,
    });
    const workspace = workspaces.get(WORKSPACE_ID);
    assert.ok(workspace, 'fixture workspace is loaded from the real SQLite store');
    const template = getWorkflowTemplate('plan-implement-review');
    assert.ok(template);
    const graph = store.workflowTemplateService().instantiateTemplateRun({
      workspace,
      template,
      roleBindings: { planner: 'codex', implementer: 'codex', reviewer: 'codex' },
      agentBindings: { plan: 'planner', implement: 'implementer', review: 'reviewer' },
      createdBy: 'apply-journal-fixture',
      createdAt: NOW,
      worktreeMode: 'required',
    });
    let task = repository.confirm({
      workspaceId: WORKSPACE_ID,
      id: plan.id,
      expectedVersion: plan.version,
      canonicalTaskId: graph.task.id,
      canonicalRunId: graph.run.id,
      confirmedAt: NOW,
      idempotencyKey: 'fixture-confirm',
    });
    task = repository.progress({ workspaceId: WORKSPACE_ID, id: task.id, expectedVersion: task.version, status: 'running' });
    task = repository.progress({ workspaceId: WORKSPACE_ID, id: task.id, expectedVersion: task.version, status: 'reviewing' });

    const engine = (stageExecutor: StageExecutor) => new RunEngine({
      runRepository: store.runRepository(),
      operationService: store.operationService(),
      lifecycleTransactionService: store.lifecycleTransactionService(),
      snapshotRepository: store.runSnapshotRepository(),
      runStageRepository: store.runStageRepository(),
      stageExecutor,
      runInTransaction: fn => store.runInTransaction(fn),
    });
    const startOperation = store.operationService().create({ workspaceId: WORKSPACE_ID, runId: graph.run.id, type: 'run.start' });
    const starter = engine(new StageExecutor(() => ({ outcome: 'active' })));
    assert.equal(starter.tick({ workspaceId: WORKSPACE_ID, runId: graph.run.id }).outcome, 'claimed');
    for (let step = 0; step < 10; step += 1) {
      starter.dispatch({ workspaceId: WORKSPACE_ID, runId: graph.run.id });
      if (store.operationService().listByRun(WORKSPACE_ID, graph.run.id).find(operation => operation.id === startOperation.id)?.status === 'completed') break;
    }
    assert.equal(store.operationService().listByRun(WORKSPACE_ID, graph.run.id).find(operation => operation.id === startOperation.id)?.status, 'completed');
    const completer = engine(new StageExecutor(() => ({ outcome: 'completed', durationMs: 1, artifactIds: [], outputContractSatisfied: true })));
    for (let step = 0; step < 32 && store.runRepository().findById(WORKSPACE_ID, graph.run.id)?.status !== 'completed'; step += 1) {
      completer.dispatch({ workspaceId: WORKSPACE_ID, runId: graph.run.id });
    }
    assert.equal(store.runRepository().findById(WORKSPACE_ID, graph.run.id)?.status, 'completed');
    const reviewStage = store.runStageRepository().listByRun(WORKSPACE_ID, graph.run.id)
      .find(stage => stage.workflowStageKey === 'review');
    assert.ok(reviewStage);

    const frozenPatch = options.abbreviatedPatch ? snapshot.patch.replace(/^index ([a-f0-9]{40})\.\.([a-f0-9]{40}) 100644$/mu,
      (_, pre: string, post: string) => `index ${pre.slice(0, 7)}..${post.slice(0, 7)} 100644`) : snapshot.patch;
    const candidate = repository.createCandidate({
      id: 'candidate-apply-journal-fixture',
      collaborationTaskId: plan.id,
      workspaceId: WORKSPACE_ID,
      canonicalRunId: graph.run.id,
      round: 0,
      baseCommit,
      headCommit: snapshot.headCommit,
      snapshotVersion: 2,
      diffText: frozenPatch,
      diffHash: hash(frozenPatch),
      manifest: [...snapshot.untrackedManifest],
      testStatus: 'passed',
      testCommand: ACCEPTANCE_COMMANDS.join(' && '),
      testExitCode: 0,
      testOutput: 'fixture acceptance command passed',
      status: 'created',
      createdAt: NOW,
    });
    repository.reviewCandidate({
      workspaceId: WORKSPACE_ID,
      candidateId: candidate.id,
      conclusion: 'approved',
      summary: 'Fixture candidate approved',
      reviewerAgentId: 'reviewer',
    });
    repository.createReview({
      id: 'review-apply-journal-fixture',
      collaborationTaskId: plan.id,
      candidateId: candidate.id,
      workspaceId: WORKSPACE_ID,
      canonicalRunId: graph.run.id,
      stageId: reviewStage.id,
      stageAttempt: reviewStage.attempt,
      reviewerAgentId: 'reviewer',
      candidateDiffHash: candidate.diffHash,
      conclusion: 'approved',
      summary: 'Fixture candidate approved',
      createdAt: NOW,
    });
    const reviewOutput = 'reviewed candidate hash and approved';
    repository.recordStageOutput({
      workspaceId: WORKSPACE_ID,
      collaborationTaskId: plan.id,
      runId: graph.run.id,
      stageId: reviewStage.id,
      stageAttempt: reviewStage.attempt,
      agentId: 'reviewer',
      role: 'reviewer',
      status: 'available',
      publicOutput: reviewOutput,
      outputHash: hash(reviewOutput),
      reviewCandidateId: candidate.id,
      reviewCandidateHash: candidate.diffHash,
      reviewConclusion: 'approved',
      createdAt: NOW,
    });
    task = repository.progress({
      workspaceId: WORKSPACE_ID,
      id: task.id,
      expectedVersion: task.version,
      status: 'awaiting_application',
      currentCandidateId: candidate.id,
    });

    const makeService = (currentStore: SqliteStore): CollaborationWorkflowService => {
      const currentWorkspaces = new WorkspaceManager(currentStore);
      const currentWorktrees = new WorktreeManager(worktreesRoot);
      const authority = new WorkspaceAdmissionAuthority({ store: currentStore });
      const serviceOptions: CollaborationWorkflowServiceOptions = {
        store: currentStore,
        workspaces: currentWorkspaces,
        worktrees: currentWorktrees,
        dispatchRun: async () => undefined,
        requestRunAdmission: async () => false,
        releaseRunAdmission: async () => undefined,
        cancelRun: async input => ({
          expectedRunVersion: currentStore.runRepository().findById(input.workspaceId, input.runId)?.version ?? 1,
          terminatedProcessIds: [],
          worktreePreserved: true,
        }),
        registerWorktreePath: () => undefined,
        requestApplicationAdmission: async input => options.realApplicationAdmission
          ? (await authority.requestCollaborationApplication(input)).grantedAdmission !== undefined : true,
        releaseApplicationAdmission: async input => {
          if (options.realApplicationAdmission) await authority.releaseCollaborationApplication(input);
        },
        ...(options.applyFault === undefined ? {} : { applyFault: options.applyFault }),
      };
      return new CollaborationWorkflowService(serviceOptions);
    };
    let service = makeService(store);

    return {
      root, dataRoot, targetRoot, candidateRoot, worktreesRoot, baseCommit, snapshot, plan, task, candidate, runId: graph.run.id,
      get store() { return store; },
      get repository() { return repository; },
      get controls() { return controls; },
      get workspaces() { return workspaces; },
      get service() { return service; },
      get journalService() { return journalService; },
      async restart() {
        store.close();
        store = new SqliteStore(dataRoot);
        repository = new CollaborationRepository(store.getDatabase());
        controls = new CollaborationControlRepository(store.getDatabase());
        workspaces = new WorkspaceManager(store);
        journalService = new CollaborationApplyJournalService(store.getDatabase());
        service = makeService(store);
      },
      async close() {
        store.close();
        await disposeOwnedTree(root);
      },
    };
  } catch (error) {
    if (store!) {
      try { store.close(); } catch { /* retain original fixture setup failure */ }
    }
    await disposeOwnedTree(root);
    throw error;
  }
}

async function reserveApply(fx: Fixture, idempotencyKey = 'fixture-apply-reservation') {
  return fx.store.runInTransaction(() => fx.controls.reserve({
    workspaceId: WORKSPACE_ID,
    collaborationId: fx.task.id,
    action: 'apply',
    expectedVersion: fx.task.version,
    idempotencyKey,
  }));
}

async function prepareJournal(fx: Fixture, idempotencyKey?: string): Promise<{ journal: ApplyJournal; controlId: string }> {
  const claim = await reserveApply(fx, idempotencyKey);
  const journal = await fx.journalService.prepare(claim.control, claim.task, fx.candidate, fx.targetRoot);
  return { journal, controlId: claim.control.id };
}

async function pathState(root: string, paths: readonly string[]): Promise<Array<{ path: string; exists: boolean; bytes?: string; mode?: number; mtimeMs?: number }>> {
  const result = [];
  for (const path of [...paths].sort()) {
    try {
      const absolutePath = join(root, ...path.split('/'));
      const info = await lstat(absolutePath);
      result.push({ path, exists: true, bytes: (await readFile(absolutePath)).toString('base64'), mode: info.mode & 0o777, mtimeMs: info.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      result.push({ path, exists: false });
    }
  }
  return result;
}

async function immutableFileSnapshot(fx: Fixture, recoveryPath: string, paths = fx.snapshot.changedPaths) {
  const recoveryInfo = await stat(recoveryPath);
  return {
    targetFiles: await pathState(fx.targetRoot, paths),
    index: (await readFile(join(fx.targetRoot, '.git', 'index'))).toString('base64'),
    gitStatus: git(fx.targetRoot, ['status', '--porcelain=v1', '-z']),
    recoveryMaterial: (await readFile(recoveryPath)).toString('base64'),
    recoveryMtimeMs: recoveryInfo.mtimeMs,
  };
}

function markerCommand(marker: string, output: 'passthrough' | 'fsmonitor'): string {
  const script = `require('node:fs').writeFileSync(process.argv[1],'external Git driver executed');`
    + (output === 'passthrough' ? 'process.stdin.pipe(process.stdout);' : "process.stdout.write('token\\0/\\0');");
  return `"${process.execPath.replaceAll('\\', '/')}" -e "${script}" "${marker.replaceAll('\\', '/')}"`;
}

async function rawTargetSnapshot(fx: Fixture, recoveryPath?: string) {
  return {
    files: await pathState(fx.targetRoot, [...OWNED_PATHS, 'stable.txt']),
    index: (await readFile(join(fx.targetRoot, '.git', 'index'))).toString('base64'),
    ...(recoveryPath ? { recovery: (await readFile(recoveryPath)).toString('base64'),
      recoveryMtime: (await stat(recoveryPath)).mtimeMs } : {}),
  };
}

for (let repetition = 1; repetition <= 3; repetition += 1) {
  for (const driver of ['smudge', 'fsmonitor'] as const) {
    test(`F26 prepare never executes a ${driver} configured after candidate freeze (${repetition}/3)`, async () => {
      const fx = await createFixture();
      try {
        const marker = join(fx.root, `${driver}.marker`);
        if (driver === 'smudge') {
          git(fx.targetRoot, ['config', 'filter.late.smudge', markerCommand(marker, 'passthrough')]);
          await writeFile(join(fx.targetRoot, '.git', 'info', 'attributes'), 'README.md filter=late\n');
        } else {
          git(fx.targetRoot, ['config', 'core.fsmonitor', markerCommand(marker, 'fsmonitor')]);
          git(fx.targetRoot, ['config', 'core.fsmonitorHookVersion', '2']);
        }
        const before = await rawTargetSnapshot(fx);
        let failure: unknown;
        try { await prepareJournal(fx, `marker-${driver}-${repetition}`); } catch (error) { failure = error; }
        await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'external driver must not execute even when prepare rejects');
        assert.deepEqual(await rawTargetSnapshot(fx), before);
        if (driver === 'smudge') {
          assert.match(String(failure), /COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED/);
          assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM collaboration_apply_journals').get() as { count: number }).count, 0);
        } else assert.equal(failure, undefined);
      } finally { await fx.close(); }
    });
  }

  test(`F26 recovery never executes a late clean filter and retains the durable writer (${repetition}/3)`, async () => {
    const fx = await createFixture({ realApplicationAdmission: true });
    try {
      const { journal, controlId } = await prepareJournal(fx, `recovery-marker-${repetition}`);
      const authority = new WorkspaceAdmissionAuthority({ store: fx.store });
      const grant = await authority.requestCollaborationApplication({ workspaceId: WORKSPACE_ID, controlId });
      assert.ok(grant.grantedAdmission);
      const marker = join(fx.root, 'recovery-clean.marker');
      git(fx.targetRoot, ['config', 'filter.late.clean', markerCommand(marker, 'passthrough')]);
      await writeFile(join(fx.targetRoot, '.git', 'info', 'attributes'), 'README.md filter=late\n');
      // Force Git to reconsider the unchanged raw file rather than a stat-cache hit.
      await writeFile(join(fx.targetRoot, 'README.md'), 'base README\n');
      const before = await rawTargetSnapshot(fx, journal.recoveryPath);
      for (let cycle = 1; cycle <= 2; cycle += 1) {
        await fx.restart();
        const result = await fx.service.reconcileOnStartup();
        await assert.rejects(readFile(marker), { code: 'ENOENT' });
        assert.deepEqual(await rawTargetSnapshot(fx, journal.recoveryPath), before);
        assert.equal(result.unresolved, 1);
        assert.equal(fx.controls.find(WORKSPACE_ID, controlId)?.state, 'recovery_required');
        assert.equal((fx.store.getDatabase().prepare('SELECT state FROM collaboration_apply_journals WHERE control_id = ?')
          .get(controlId) as { state: string }).state, 'recovery_required');
        assert.equal((fx.store.getDatabase().prepare('SELECT state FROM workspace_admissions WHERE id = ?')
          .get(grant.admission.id) as { state: string }).state, 'GRANTED');
        await assert.rejects(new WorkspaceAdmissionAuthority({ store: fx.store }).releaseCollaborationApplication({
          workspaceId: WORKSPACE_ID, controlId,
        }), /ADMISSION_NOT_RELEASABLE/);
        assert.equal(fx.repository.findById(WORKSPACE_ID, fx.task.id)?.status, 'awaiting_application');
        assert.notEqual(fx.repository.findCandidate(WORKSPACE_ID, fx.candidate.id)?.status, 'applied');
      }
    } finally { await fx.close(); }
  });
}

test('F26 clean preflight must not classify a changed live source as an empty frozen snapshot', async () => {
  const fx = await createFixture();
  try {
    const index = await readFile(join(fx.targetRoot, '.git', 'index'));
    await assert.rejects(captureCollaborationCandidateSnapshot(fx.targetRoot, fx.baseCommit, ['./'], {
      beforeFrozenNormalization: async () => { await writeFile(join(fx.targetRoot, 'late.txt'), 'changed after frozen inventory\n'); },
    }), /COLLABORATION_SNAPSHOT_SOURCE_CHANGED/);
    assert.equal(await readFile(join(fx.targetRoot, 'late.txt'), 'utf8'), 'changed after frozen inventory\n');
    assert.deepEqual(await readFile(join(fx.targetRoot, '.git', 'index')), index);
  } finally { await fx.close(); }
});

for (const autocrlf of ['false', 'input', 'true'] as const) {
  for (const sourceEol of ['\n', '\r\n'] as const) {
    test(`F26 private prepare/write preserves ${autocrlf}/${sourceEol === '\n' ? 'LF' : 'CRLF'}, binary and real index`, async () => {
      const fx = await createFixture({ autocrlf, sourceEol });
      try {
        const before = await rawTargetSnapshot(fx);
        const { journal } = await prepareJournal(fx);
        assert.deepEqual(await rawTargetSnapshot(fx), before);
        await fx.journalService.writePrepared(journal);
        assert.equal(await fx.journalService.matches(journal, 'post'), true);
        assert.deepEqual(await readFile(join(fx.targetRoot, 'added.bin')), BINARY_POSTIMAGE);
        const expectedEol = autocrlf === 'true' ? '\r\n' : autocrlf === 'input' ? '\n' : sourceEol;
        assert.equal(await readFile(join(fx.targetRoot, 'README.md'), 'utf8'), `candidate README${expectedEol}`);
        const result = await captureCollaborationCandidateSnapshot(fx.targetRoot, fx.baseCommit, ['./']);
        assert.equal(result.patchHash, fx.candidate.diffHash);
        assert.equal((await readFile(join(fx.targetRoot, '.git', 'index'))).toString('base64'), before.index);
        assert.equal(await fx.journalService.rollback(journal), true);
        assert.equal(await fx.journalService.matches(journal, 'pre'), true);
      } finally { await fx.close(); }
    });
  }
}

for (const scenario of [
  { name: 'new text/eol=crlf', options: { postAttributes: 'README.md text eol=crlf\n' }, expected: Buffer.from('candidate README\r\n') },
  { name: 'changed text/eol=lf', options: { baseAttributes: 'README.md text eol=crlf\n', postAttributes: 'README.md text eol=lf\n', sourceEol: '\r\n' as const }, expected: Buffer.from('candidate README\n') },
  { name: 'new working-tree-encoding', options: { postAttributes: 'README.md text eol=crlf working-tree-encoding=UTF-16LE-BOM\n', sourceEol: '\r\n' as const, postEncoding: 'utf16le' as const }, expected: Buffer.from('\uFEFFcandidate README\r\n', 'utf16le') },
]) {
  test(`F26 postimages use approved patched-index attributes: ${scenario.name}`, async () => {
    const fx = await createFixture(scenario.options);
    try {
      const index = await readFile(join(fx.targetRoot, '.git', 'index'));
      const before = await pathState(fx.targetRoot, [...fx.snapshot.changedPaths]);
      const { journal } = await prepareJournal(fx);
      assert.deepEqual(Buffer.from(journal.images.find(entry => entry.path === 'README.md')!.post!, 'base64'), scenario.expected);
      assert.deepEqual(await pathState(fx.targetRoot, [...fx.snapshot.changedPaths]), before);
      await fx.journalService.writePrepared(journal);
      assert.deepEqual(await readFile(join(fx.targetRoot, 'README.md')), scenario.expected);
      assert.equal(await readFile(join(fx.targetRoot, '.gitattributes'), 'utf8'), scenario.options.postAttributes);
      assert.deepEqual(await readFile(join(fx.targetRoot, 'added.bin')), BINARY_POSTIMAGE);
      assert.equal((await captureCollaborationCandidateSnapshot(fx.targetRoot, fx.baseCommit, ['./'])).patchHash, fx.candidate.diffHash);
      assert.deepEqual(await readFile(join(fx.targetRoot, '.git', 'index')), index);
      assert.equal(await fx.journalService.rollback(journal), true);
      assert.equal(await fx.journalService.matches(journal, 'pre'), true);
    } finally { await fx.close(); }
  });
}

for (let repetition = 1; repetition <= 3; repetition += 1) {
  test(`F26 prepare rejects a patched external filter before post materialization (${repetition}/3)`, async () => {
    const fx = await createFixture();
    try {
      const marker = join(fx.root, 'patched-smudge.marker');
      git(fx.targetRoot, ['config', 'filter.late.smudge', markerCommand(marker, 'passthrough')]);
      const attributes = 'README.md filter=late\n';
      const objectId = createHash('sha1').update(`blob ${Buffer.byteLength(attributes)}\0${attributes}`).digest('hex');
      const attrPatch = `diff --git a/.gitattributes b/.gitattributes\nnew file mode 100644\nindex ${'0'.repeat(40)}..${objectId}\n--- /dev/null\n+++ b/.gitattributes\n@@ -0,0 +1 @@\n+README.md filter=late\n`;
      const diffText = fx.candidate.diffText + attrPatch;
      const candidate = { ...fx.candidate, diffText, diffHash: hash(diffText) };
      const claim = await reserveApply(fx, `unsupported-patched-filter-${repetition}`);
      const before = await rawTargetSnapshot(fx);
      await assert.rejects(fx.journalService.prepare(claim.control, claim.task, candidate, fx.targetRoot), /COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED/);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      await assert.rejects(readFile(join(fx.targetRoot, '.gitattributes')), { code: 'ENOENT' });
      assert.deepEqual(await rawTargetSnapshot(fx), before);
      assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM collaboration_apply_journals').get() as { n: number }).n, 0);
    } finally { await fx.close(); }
  });

  test(`F26 late source/config changes after frozen post attributes never invoke drivers (${repetition}/3)`, async () => {
    const fx = await createFixture();
    try {
      const marker = join(fx.root, 'after-freeze.marker');
      const claim = await reserveApply(fx, `late-context-${repetition}`);
      const before = await rawTargetSnapshot(fx);
      await assert.rejects(fx.journalService.prepare(claim.control, claim.task, fx.candidate, fx.targetRoot, {
        beforePostMaterialization: async () => {
          git(fx.targetRoot, ['config', 'filter.late.smudge', markerCommand(marker, 'passthrough')]);
          await writeFile(join(fx.targetRoot, '.git', 'info', 'attributes'), 'README.md filter=late\n');
        },
      }), /COLLABORATION_SNAPSHOT_SOURCE_CHANGED/);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      assert.deepEqual(await rawTargetSnapshot(fx), before);
    } finally { await fx.close(); }
  });

  test(`F26 write validates every preimage before writing any earlier path (${repetition}/3)`, async () => {
    const fx = await createFixture();
    try {
      const { journal } = await prepareJournal(fx);
      await writeFile(join(fx.targetRoot, 'rename-old.txt'), 'foreign edit before write\n');
      const before = await rawTargetSnapshot(fx, journal.recoveryPath);
      await assert.rejects(fx.journalService.writePrepared(journal), error => {
        assert.equal((error as { code: string }).code, 'COLLABORATION_SNAPSHOT_SOURCE_CHANGED');
        return true;
      });
      assert.deepEqual(await rawTargetSnapshot(fx, journal.recoveryPath), before);
      assert.equal(journal.state, 'prepared');
    } finally { await fx.close(); }
  });

  test(`F26 partial per-path write can restore only its exact owned pre/post mixture (${repetition}/3)`, async () => {
    const fx = await createFixture();
    try {
      const { journal } = await prepareJournal(fx);
      const recovery = await readFile(journal.recoveryPath);
      const index = await readFile(join(fx.targetRoot, '.git', 'index'));
      let calls = 0;
      await assert.rejects(fx.journalService.writePrepared(journal, { beforeWritePath: () => {
        if (++calls === 2) throw new Error('injected partial path write');
      } }), /injected partial path write/);
      assert.equal(calls, 2);
      assert.equal(await fx.journalService.matches(journal, 'pre'), false);
      assert.equal(await fx.journalService.matches(journal, 'post'), false);
      assert.equal(await readFile(join(fx.targetRoot, 'README.md'), 'utf8'), 'candidate README\n');
      assert.equal(await fx.journalService.rollback(journal), true);
      assert.equal(await fx.journalService.matches(journal, 'pre'), true);
      assert.deepEqual(await readFile(journal.recoveryPath), recovery);
      assert.deepEqual(await readFile(join(fx.targetRoot, '.git', 'index')), index);
    } finally { await fx.close(); }
  });

  test(`F26 partial write plus foreign content retains all recovery material and never restores an earlier path (${repetition}/3)`, async () => {
    const fx = await createFixture();
    try {
      const { journal } = await prepareJournal(fx);
      let calls = 0;
      await assert.rejects(fx.journalService.writePrepared(journal, { beforeWritePath: async () => {
        if (++calls === 2) {
          await writeFile(join(fx.targetRoot, 'delete.bin'), Buffer.from('foreign bytes'));
        }
      } }), error => {
        assert.equal((error as { code: string }).code, 'COLLABORATION_SNAPSHOT_SOURCE_CHANGED');
        return true;
      });
      assert.equal(calls, 3, 'the late foreign edit is rejected by the real per-path guard, not the test hook');
      const before = await rawTargetSnapshot(fx, journal.recoveryPath);
      assert.equal(await fx.journalService.rollback(journal), false);
      assert.deepEqual(await rawTargetSnapshot(fx, journal.recoveryPath), before);
      assert.equal(journal.state, 'recovery_required');
    } finally { await fx.close(); }
  });
}

test('F26 changing a preimage during prepare fails before durable material or target writes', async () => {
  const fx = await createFixture();
  try {
    const claim = await reserveApply(fx);
    const index = await readFile(join(fx.targetRoot, '.git', 'index'));
    await assert.rejects(fx.journalService.prepare(claim.control, claim.task, fx.candidate, fx.targetRoot, {
      beforePostMaterialization: async () => { await writeFile(join(fx.targetRoot, 'README.md'), 'user changed during prepare\n'); },
    }), /COLLABORATION_PATH_BOUNDARY|COLLABORATION_SNAPSHOT_SOURCE_CHANGED/);
    assert.equal(await readFile(join(fx.targetRoot, 'README.md'), 'utf8'), 'user changed during prepare\n');
    await assert.rejects(readFile(join(fx.targetRoot, 'added.bin')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(fx.targetRoot, '.git', 'index')), index);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM collaboration_apply_journals').get() as { n: number }).n, 0);
  } finally { await fx.close(); }
});

test('F26 an abbreviated v2 stored patch is apply-compatible but rejected without writing or supplementing its review hash', async () => {
  const fx = await createFixture({ abbreviatedPatch: true });
  try {
    assert.notEqual(fx.candidate.diffHash, fx.snapshot.patchHash);
    const stored = fx.repository.findCandidate(WORKSPACE_ID, fx.candidate.id)!;
    const context = await CollaborationSnapshotGitContext.create(fx.targetRoot);
    try {
      await context.run(['read-tree', fx.baseCommit]);
      await context.run(['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], Buffer.from(stored.diffText));
    } finally { await context.dispose(); }
    const before = await rawTargetSnapshot(fx);
    await assert.rejects(fx.service.apply({ workspaceId: WORKSPACE_ID, collaborationId: fx.task.id,
      expectedVersion: fx.task.version, idempotencyKey: 'legacy-abbreviated-apply',
    }), error => {
      assert.equal((error as { code: string }).code, 'COLLABORATION_CANDIDATE_INVALID');
      return true;
    });
    assert.deepEqual(await rawTargetSnapshot(fx), before);
    assert.deepEqual(fx.repository.findCandidate(WORKSPACE_ID, fx.candidate.id), stored);
    assert.equal(fx.repository.findById(WORKSPACE_ID, fx.task.id)?.status, 'awaiting_application');
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM collaboration_apply_journals').get() as { n: number }).n, 0);
  } finally { await fx.close(); }
});

for (const corruption of ['recovery bytes', 'in-memory postimage', 'durable summary'] as const) {
  test(`F26 writePrepared rejects changed ${corruption} before target writes`, async () => {
    const fx = await createFixture();
    try {
      const { journal } = await prepareJournal(fx);
      if (corruption === 'recovery bytes') await writeFile(journal.recoveryPath, 'tampered material');
      else if (corruption === 'in-memory postimage') journal.images[0].post = Buffer.from('foreign postimage').toString('base64');
      else fx.store.getDatabase().prepare('UPDATE collaboration_apply_journals SET images_json = ? WHERE control_id = ?')
        .run(JSON.stringify({ recoveryHash: hash(await readFile(journal.recoveryPath)), paths: [] }), journal.controlId);
      const before = await rawTargetSnapshot(fx, journal.recoveryPath);
      await assert.rejects(fx.journalService.writePrepared(journal), /Recovery material changed|Recovery association mismatch|Recovery image summary changed/);
      assert.deepEqual(await rawTargetSnapshot(fx, journal.recoveryPath), before);
    } finally { await fx.close(); }
  });
}

test('F26 writePrepared rechecks durable control after awaited path barrier', async () => {
  const fx = await createFixture();
  try {
    const { journal } = await prepareJournal(fx);
    const before = await rawTargetSnapshot(fx, journal.recoveryPath);
    await assert.rejects(fx.journalService.writePrepared(journal, { beforeWritePath: () => {
      fx.store.getDatabase().prepare('UPDATE collaboration_tasks SET control_epoch = control_epoch + 1 WHERE id = ?').run(fx.task.id);
    } }), /Application control ownership changed/);
    assert.deepEqual(await rawTargetSnapshot(fx, journal.recoveryPath), before);
  } finally { await fx.close(); }
});

test('F26 writePrepared rejects a real index change at an awaited barrier before any target write', async () => {
  const fx = await createFixture();
  try {
    const { journal } = await prepareJournal(fx);
    const before = await pathState(fx.targetRoot, [...OWNED_PATHS, 'stable.txt']);
    const baseObject = git(fx.targetRoot, ['rev-parse', 'HEAD:README.md']);
    let changedIndex: Buffer | undefined;
    let invoked = false;
    await assert.rejects(fx.journalService.writePrepared(journal, { beforeWritePath: async () => {
      if (invoked) return;
      invoked = true;
      git(fx.targetRoot, ['update-index', '--add', '--cacheinfo', `100644,${baseObject},staged-only.txt`]);
      changedIndex = await readFile(join(fx.targetRoot, '.git', 'index'));
    } }), error => {
      assert.equal((error as { code: string }).code, 'COLLABORATION_SNAPSHOT_SOURCE_CHANGED');
      return true;
    });
    assert.equal(invoked, true);
    assert.deepEqual(await pathState(fx.targetRoot, [...OWNED_PATHS, 'stable.txt']), before);
    assert.deepEqual(await readFile(join(fx.targetRoot, '.git', 'index')), changedIndex);
  } finally { await fx.close(); }
});

test('F26 writePrepared rejects a late Windows junction without writing its external target', { skip: process.platform !== 'win32' }, async () => {
  const fx = await createFixture({ includeJunctionPath: true });
  const external = join(fx.root, 'external');
  const linked = join(fx.targetRoot, 'linked');
  try {
    await mkdir(external);
    await writeFile(join(external, 'blocked.txt'), 'foreign external content\n');
    const before = await pathState(external, ['blocked.txt']);
    const { journal } = await prepareJournal(fx);
    const recovery = await readFile(journal.recoveryPath);
    await assert.rejects(fx.journalService.writePrepared(journal, { beforeWritePath: async path => {
      if (path === 'linked/blocked.txt') await symlink(external, linked, 'junction');
    } }), /COLLABORATION_PATH_BOUNDARY/);
    assert.deepEqual(await pathState(external, ['blocked.txt']), before);
    assert.deepEqual(await readFile(journal.recoveryPath), recovery);
    await unlink(linked);
    assert.equal(await fx.journalService.rollback(journal), true);
  } finally { await fx.close(); }
});

test('prepare records exact preimages and postimages for binary add, delete, text edit and both rename paths without touching the real index', async () => {
  const fx = await createFixture();
  try {
    const indexBefore = await readFile(join(fx.targetRoot, '.git', 'index'));
    const statusBefore = git(fx.targetRoot, ['status', '--porcelain=v1', '-z']);
    const { journal } = await prepareJournal(fx);

    assert.equal(journal.state, 'prepared');
    assert.deepEqual([...journal.images].map(image => image.path).sort(), [...OWNED_PATHS].sort());
    assert.deepEqual([...fx.snapshot.changedPaths].sort(), [...OWNED_PATHS].sort());
    assert.match(fx.candidate.diffText, /GIT binary patch/);
    assert.match(fx.candidate.diffText, /rename from rename-old\.txt/);
    assert.match(fx.candidate.diffText, /rename to rename-new\.txt/);

    const images = new Map(journal.images.map(image => [image.path, image]));
    assert.equal(images.get('README.md')?.pre, Buffer.from('base README\n').toString('base64'));
    assert.equal(images.get('README.md')?.post, Buffer.from('candidate README\n').toString('base64'));
    assert.equal(images.get('added.bin')?.pre, null);
    assert.equal(images.get('added.bin')?.post, BINARY_POSTIMAGE.toString('base64'));
    assert.equal(images.get('delete.bin')?.pre, BINARY_PREIMAGE.toString('base64'));
    assert.equal(images.get('delete.bin')?.post, null);
    assert.equal(images.get('rename-old.txt')?.pre, Buffer.from('rename payload\n').toString('base64'));
    assert.equal(images.get('rename-old.txt')?.post, null);
    assert.equal(images.get('rename-new.txt')?.pre, null);
    assert.equal(images.get('rename-new.txt')?.post, Buffer.from('rename payload\n').toString('base64'));

    const row = fx.store.getDatabase().prepare('SELECT state, candidate_hash, recovery_path, images_json FROM collaboration_apply_journals WHERE control_id = ?')
      .get(journal.controlId) as { state: string; candidate_hash: string; recovery_path: string; images_json: string };
    assert.equal(row.state, 'prepared');
    assert.equal(row.candidate_hash, fx.candidate.diffHash);
    assert.deepEqual(JSON.parse(row.images_json).paths, journal.images.map(image => ({
      path: image.path,
      pre: image.pre === null ? null : hash(Buffer.from(image.pre, 'base64')),
      post: image.post === null ? null : hash(Buffer.from(image.post, 'base64')),
    })));
    assert.equal((await lstat(row.recovery_path)).isFile(), true);
    assert.deepEqual(await readFile(join(fx.targetRoot, '.git', 'index')), indexBefore);
    assert.equal(git(fx.targetRoot, ['status', '--porcelain=v1', '-z']), statusBefore);
    assert.equal(await readFile(join(fx.targetRoot, 'README.md'), 'utf8'), 'base README\n');
  } finally { await fx.close(); }
});

test('SQLite commit failure after Git write rolls back only journal-owned paths and preserves an unrelated user file', async () => {
  let injected = false;
  let targetRoot = '';
  const fx = await createFixture({ applyFault: point => {
    if (point !== 'before_commit') return;
    injected = true;
    writeFileSync(join(targetRoot, 'user-owned.txt'), 'created during failed commit\n');
    throw new Error('injected SQLite commit failure');
  } });
  targetRoot = fx.targetRoot;
  try {
    const indexBefore = await readFile(join(fx.targetRoot, '.git', 'index'));
    await assert.rejects(fx.service.apply({
      workspaceId: WORKSPACE_ID,
      collaborationId: fx.task.id,
      expectedVersion: fx.task.version,
      idempotencyKey: 'service-apply-db-failure',
    }), /injected SQLite commit failure/);
    assert.equal(injected, true);
    assert.equal(await readFile(join(fx.targetRoot, 'README.md'), 'utf8'), 'base README\n');
    assert.deepEqual(await readFile(join(fx.targetRoot, 'delete.bin')), BINARY_PREIMAGE);
    assert.equal(await readFile(join(fx.targetRoot, 'rename-old.txt'), 'utf8'), 'rename payload\n');
    await assert.rejects(readFile(join(fx.targetRoot, 'added.bin')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(fx.targetRoot, 'rename-new.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(join(fx.targetRoot, 'stable.txt'), 'utf8'), 'stable user file\n');
    assert.equal(await readFile(join(fx.targetRoot, 'user-owned.txt'), 'utf8'), 'created during failed commit\n');
    assert.deepEqual(await readFile(join(fx.targetRoot, '.git', 'index')), indexBefore);
    assert.deepEqual(git(fx.targetRoot, ['status', '--porcelain=v1', '-z']).split('\0').filter(Boolean), ['?? user-owned.txt']);

    const control = fx.store.getDatabase().prepare('SELECT state FROM collaboration_controls WHERE idempotency_key = ?')
      .get('service-apply-db-failure') as { state: string };
    const journal = fx.store.getDatabase().prepare('SELECT state FROM collaboration_apply_journals WHERE collaboration_task_id = ?')
      .get(fx.task.id) as { state: string };
    assert.equal(control.state, 'failed');
    assert.equal(journal.state, 'recovered');
    assert.equal(fx.repository.findById(WORKSPACE_ID, fx.task.id)?.status, 'awaiting_application');
    assert.equal(fx.repository.findCandidate(WORKSPACE_ID, fx.candidate.id)?.status, 'reviewed');
  } finally { await fx.close(); }
});

test('concurrent edit during apply enters recovery_required and never overwrites that edit', async () => {
  let targetRoot = '';
  const fx = await createFixture({ applyFault: point => {
    if (point === 'after_write') writeFileSync(join(targetRoot, 'README.md'), 'concurrent user edit\n');
  } });
  targetRoot = fx.targetRoot;
  try {
    const indexBefore = await readFile(join(fx.targetRoot, '.git', 'index'));
    await assert.rejects(fx.service.apply({
      workspaceId: WORKSPACE_ID,
      collaborationId: fx.task.id,
      expectedVersion: fx.task.version,
      idempotencyKey: 'service-apply-concurrent-edit',
    }), error => {
      assert.equal((error as { code?: string }).code, 'COLLABORATION_RECOVERY_REQUIRED');
      return true;
    });
    assert.equal(await readFile(join(fx.targetRoot, 'README.md'), 'utf8'), 'concurrent user edit\n');
    assert.deepEqual(await readFile(join(fx.targetRoot, 'added.bin')), BINARY_POSTIMAGE);
    await assert.rejects(readFile(join(fx.targetRoot, 'delete.bin')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(fx.targetRoot, 'rename-old.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(join(fx.targetRoot, 'rename-new.txt'), 'utf8'), 'rename payload\n');
    assert.equal(await readFile(join(fx.targetRoot, 'stable.txt'), 'utf8'), 'stable user file\n');
    assert.deepEqual(await readFile(join(fx.targetRoot, '.git', 'index')), indexBefore);

    const control = fx.store.getDatabase().prepare('SELECT state, recovery_reference FROM collaboration_controls WHERE idempotency_key = ?')
      .get('service-apply-concurrent-edit') as { state: string; recovery_reference: string | null };
    const journal = fx.store.getDatabase().prepare('SELECT state, recovery_path FROM collaboration_apply_journals WHERE collaboration_task_id = ?')
      .get(fx.task.id) as { state: string; recovery_path: string };
    assert.equal(control.state, 'recovery_required');
    assert.equal(control.recovery_reference, journal.recovery_path);
    assert.equal(journal.state, 'recovery_required');
    assert.equal(fx.repository.findById(WORKSPACE_ID, fx.task.id)?.status, 'awaiting_application');
  } finally { await fx.close(); }
});

test('prepare rejects a real Windows target-directory junction before reading or writing its contents', { skip: process.platform !== 'win32' }, async () => {
  const fx = await createFixture({ includeJunctionPath: true });
  const externalRoot = await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), 'agentos-apply-junction-target-')));
  const junctionPath = join(fx.targetRoot, 'linked');
  try {
    await writeFile(join(externalRoot, 'outside.txt'), 'external target content\n');
    await symlink(externalRoot, junctionPath, 'junction');
    const indexBefore = await readFile(join(fx.targetRoot, '.git', 'index'));
    const claim = await reserveApply(fx, 'fixture-junction-control');
    await assert.rejects(
      fx.journalService.prepare(claim.control, claim.task, fx.candidate, fx.targetRoot),
      /COLLABORATION_PATH_BOUNDARY/,
    );
    assert.equal(await readFile(join(externalRoot, 'outside.txt'), 'utf8'), 'external target content\n');
    assert.deepEqual(await readFile(join(fx.targetRoot, '.git', 'index')), indexBefore);
    assert.equal(git(fx.targetRoot, ['status', '--porcelain=v1', '-z']).includes('outside.txt'), false);
  } finally {
    await fx.close();
    await disposeOwnedTree(externalRoot);
  }
});

test('a fresh journal service loads pending backup by verified hash without mutating target or recovery files', async () => {
  const fx = await createFixture();
  try {
    const { journal } = await prepareJournal(fx, 'fixture-load-pending');
    const beforeRestart = await immutableFileSnapshot(fx, journal.recoveryPath);
    await fx.restart();
    const pending = await fx.journalService.loadPending();
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0], journal);
    assert.deepEqual(await immutableFileSnapshot(fx, journal.recoveryPath), beforeRestart);
  } finally { await fx.close(); }
});

test('a fresh journal service rejects tampered backup bytes and leaves the tampered material untouched', async () => {
  const fx = await createFixture();
  try {
    const { journal } = await prepareJournal(fx, 'fixture-tampered-backup');
    await fx.restart();
    const tampered = Buffer.concat([await readFile(journal.recoveryPath), Buffer.from('tampered')]);
    await writeFile(journal.recoveryPath, tampered);
    const beforeRead = await immutableFileSnapshot(fx, journal.recoveryPath);
    await assert.rejects(fx.journalService.loadPending(), /Recovery material changed/);
    assert.deepEqual(await immutableFileSnapshot(fx, journal.recoveryPath), beforeRead);
  } finally { await fx.close(); }
});

for (let repetition = 1; repetition <= 3; repetition += 1) {
  test(`F25 recovered journal and control failure commit atomically (${repetition}/3)`, async () => {
    const fx = await createFixture();
    try {
      const { journal, controlId } = await prepareJournal(fx, `atomic-recovery-${repetition}`);
      const control = fx.controls.find(WORKSPACE_ID, controlId)!;
      fx.store.runInTransaction(() => fx.controls.bind(control, { candidateId: fx.candidate.id }));
      git(fx.targetRoot, ['apply', '--binary', '--whitespace=nowarn', '-'], fx.candidate.diffText);
      fx.journalService.setState(journal, 'written');
      const indexBefore = await readFile(join(fx.targetRoot, '.git', 'index'));
      let callbacks = 0;

      await assert.rejects(fx.journalService.rollback(journal, () => {
        callbacks += 1;
        fx.controls.fail(control, new Error('application failed'), false, journal.recoveryPath);
        throw new Error('injected recovery transaction failure');
      }), /injected recovery transaction failure/);
      assert.equal(callbacks, 1);
      assert.equal(fx.controls.find(WORKSPACE_ID, controlId)?.state, 'running');
      assert.equal((fx.store.getDatabase().prepare('SELECT state FROM collaboration_apply_journals WHERE control_id = ?')
        .get(controlId) as { state: string }).state, 'written');
      assert.equal(journal.state, 'written');
      assert.equal(await fx.journalService.matches(journal, 'pre'), true);

      assert.equal(await fx.journalService.rollback(journal, () => {
        callbacks += 1;
        fx.controls.fail(control, new Error('application failed'), false, journal.recoveryPath);
      }), true);
      assert.equal(callbacks, 2);
      assert.equal(fx.controls.find(WORKSPACE_ID, controlId)?.state, 'failed');
      assert.equal((fx.store.getDatabase().prepare('SELECT state FROM collaboration_apply_journals WHERE control_id = ?')
        .get(controlId) as { state: string }).state, 'recovered');
      assert.deepEqual(await readFile(join(fx.targetRoot, '.git', 'index')), indexBefore);
    } finally { await fx.close(); }
  });
}

test('F25 loading includes a recovered journal whose control has not terminated', async () => {
  const fx = await createFixture();
  try {
    const { journal, controlId } = await prepareJournal(fx, 'old-recovered-pending-control');
    fx.store.runInTransaction(() => fx.controls.bind(fx.controls.find(WORKSPACE_ID, controlId)!, { candidateId: fx.candidate.id }));
    fx.journalService.setState(journal, 'recovered');
    const before = await immutableFileSnapshot(fx, journal.recoveryPath);
    await fx.restart();
    const pending = await fx.journalService.loadPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].state, 'recovered');
    assert.deepEqual(await immutableFileSnapshot(fx, journal.recoveryPath), before);
  } finally { await fx.close(); }
});

for (const scenario of ['pre', 'post', 'mixed'] as const) {
  test(`two SQLite/service restart cycles converge ${scenario} images without mutating files during recovery`, async () => {
    const fx = await createFixture();
    try {
      const { journal, controlId } = await prepareJournal(fx, `fixture-reboot-${scenario}`);
      if (scenario !== 'pre') {
        const control = fx.controls.find(WORKSPACE_ID, controlId)!;
        fx.controls.bind(control, { candidateId: fx.candidate.id });
      }
      if (scenario === 'post') {
        git(fx.targetRoot, ['apply', '--binary', '--whitespace=nowarn', '-'], fx.candidate.diffText);
        fx.journalService.setState(journal, 'written');
      } else if (scenario === 'mixed') {
        await writeFile(join(fx.targetRoot, 'README.md'), 'candidate README\n');
        fx.journalService.setState(journal, 'written');
      }

      let unresolvedByCycle = 0;
      for (let cycle = 1; cycle <= 2; cycle += 1) {
        const before = await immutableFileSnapshot(fx, journal.recoveryPath);
        await fx.restart();
        const result = await fx.service.reconcileOnStartup();
        unresolvedByCycle = result.unresolved;
        assert.deepEqual(await immutableFileSnapshot(fx, journal.recoveryPath), before, `cycle ${cycle} must not rewrite target or backup files`);
      }

      const row = fx.store.getDatabase().prepare('SELECT state FROM collaboration_apply_journals WHERE control_id = ?')
        .get(controlId) as { state: string };
      const control = fx.controls.find(WORKSPACE_ID, controlId)!;
      const task = fx.repository.findById(WORKSPACE_ID, fx.task.id)!;
      if (scenario === 'pre') {
        assert.equal(row.state, 'recovered');
        assert.equal(control.state, 'failed');
        assert.equal(task.status, 'awaiting_application');
        assert.equal(unresolvedByCycle, 0);
        assert.equal(await readFile(join(fx.targetRoot, 'README.md'), 'utf8'), 'base README\n');
      } else if (scenario === 'post') {
        assert.equal(row.state, 'committed');
        assert.equal(control.state, 'completed');
        assert.equal(task.status, 'applied');
        assert.equal(unresolvedByCycle, 0);
        assert.equal(await readFile(join(fx.targetRoot, 'README.md'), 'utf8'), 'candidate README\n');
        assert.deepEqual(await readFile(join(fx.targetRoot, 'added.bin')), BINARY_POSTIMAGE);
      } else {
        assert.equal(row.state, 'recovery_required');
        assert.equal(control.state, 'recovery_required');
        assert.equal(task.status, 'awaiting_application');
        assert.equal(unresolvedByCycle, 1);
        assert.equal(await readFile(join(fx.targetRoot, 'README.md'), 'utf8'), 'candidate README\n');
        assert.deepEqual(await readFile(join(fx.targetRoot, 'delete.bin')), BINARY_PREIMAGE);
        await assert.rejects(readFile(join(fx.targetRoot, 'added.bin')), { code: 'ENOENT' });
      }
    } finally { await fx.close(); }
  });
}
