import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { readdir, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createFileBackupProvider } from '../migrations/backup.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorktreeArtifactProvenanceError } from '../store/WorktreeArtifactBindingRepository.js';
import { RuntimeArtifactService, type CreateRuntimeArtifactInput } from './RuntimeArtifactService.js';
import { WorktreeControlError } from './WorktreeControlService.js';
import { recoveryGit, worktreeRecoveryFixture } from './WorktreeRecoveryFixture.js';

function artifactInput(fx: Awaited<ReturnType<typeof worktreeRecoveryFixture>>, overrides: Partial<CreateRuntimeArtifactInput> = {}): CreateRuntimeArtifactInput {
  return {
    workspaceId: fx.workspace.id,
    runId: fx.run.id,
    sourceExecutionId: fx.lease.executionId,
    agentId: fx.lease.agentId,
    workspaceRoot: fx.record.absolutePath,
    type: 'diff',
    title: 'Worktree diff',
    summary: 'Synthetic worktree provenance evidence',
    source: { kind: 'text', content: 'diff --git a/target.txt b/target.txt\n' },
    ...overrides,
  };
}

function assertControl409(error: unknown, code: string): boolean {
  return error instanceof WorktreeControlError && error.status === 409 && error.code === code;
}

async function emptyOrRead(directory: string): Promise<string[]> {
  try { return await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

test('a Run artifact is bound to its creating worktree and another same-Run worktree receives a stable 409', async () => {
  const fx = await worktreeRecoveryFixture();
  try {
    const otherLease = await fx.manager.createLease({
      workspaceId: fx.workspace.id,
      workspaceRoot: fx.workspace.rootPath,
      runId: fx.run.id,
      executionId: 'execution-b',
      agentId: 'agent-b',
    });
    const artifact = await fx.artifacts.createWorktreeArtifact(fx.lease.id, artifactInput(fx));
    const otherRecord = fx.manager.getRecord(otherLease.id)!;
    const otherArtifact = await fx.artifacts.createWorktreeArtifact(otherLease.id, artifactInput(fx, {
      workspaceRoot: otherRecord.absolutePath,
      sourceExecutionId: otherLease.executionId,
      agentId: otherLease.agentId,
    }));
    assert.deepEqual(fx.artifacts.listForWorktree(fx.lease.id).map(item => item.id), [artifact.id]);
    assert.deepEqual(fx.artifacts.listForWorktree(otherLease.id).map(item => item.id), [otherArtifact.id]);
    assert.throws(() => fx.artifacts.requireWorktreeProvenance(otherLease.id, artifact.id), error =>
      error instanceof WorktreeArtifactProvenanceError && error.code === 'WORKTREE_ARTIFACT_PROVENANCE_MISMATCH');
    await assert.rejects(
      () => fx.control.review(fx.workspace.id, otherLease.id, { expectedHeadCommit: fx.head, diffArtifactId: artifact.id }),
      error => assertControl409(error, 'WORKTREE_ARTIFACT_PROVENANCE_MISMATCH'),
    );
  } finally { await fx.close(); }
});

test('an unbound historical canonical artifact is rejected without fabricating an Execution', async () => {
  const fx = await worktreeRecoveryFixture();
  try {
    const artifact = await fx.artifacts.createWorktreeArtifact(fx.lease.id, artifactInput(fx));
    const db = fx.store.getDatabase();
    assert.equal((db.prepare('SELECT source_execution_id AS value FROM runtime_artifacts WHERE id = ?').get(artifact.id) as { value: string | null }).value, null);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM executions').get() as { count: number }).count, 0);

    db.prepare('DELETE FROM worktree_artifact_bindings WHERE artifact_id = ?').run(artifact.id);
    assert.deepEqual(fx.artifacts.listForWorktree(fx.lease.id), []);
    assert.throws(() => fx.artifacts.requireWorktreeProvenance(fx.lease.id, artifact.id), error =>
      error instanceof WorktreeArtifactProvenanceError && error.code === 'WORKTREE_ARTIFACT_PROVENANCE_MISSING');
    await assert.rejects(
      () => fx.control.review(fx.workspace.id, fx.lease.id, { expectedHeadCommit: fx.head, diffArtifactId: artifact.id }),
      error => assertControl409(error, 'WORKTREE_ARTIFACT_PROVENANCE_MISSING'),
    );
  } finally { await fx.close(); }
});

test('review rejects stale expected HEAD and stale artifact provenance, then accepts freshly generated evidence', async () => {
  const fx = await worktreeRecoveryFixture();
  try {
    const oldArtifact = await fx.artifacts.createWorktreeArtifact(fx.lease.id, artifactInput(fx));
    const root = fx.record.absolutePath;
    await recoveryGit(root, ['config', 'user.email', 'provenance@example.test']);
    await recoveryGit(root, ['config', 'user.name', 'Provenance Fixture']);
    await writeFile(`${root}/target.txt`, 'new committed content\n');
    await recoveryGit(root, ['add', 'target.txt']);
    await recoveryGit(root, ['commit', '-qm', 'advance worktree head']);
    const currentHead = await recoveryGit(root, ['rev-parse', 'HEAD']);

    await assert.rejects(
      () => fx.control.review(fx.workspace.id, fx.lease.id, { expectedHeadCommit: fx.head, diffArtifactId: oldArtifact.id }),
      error => assertControl409(error, 'WORKTREE_HEAD_MISMATCH'),
    );
    await assert.rejects(
      () => fx.control.review(fx.workspace.id, fx.lease.id, { expectedHeadCommit: currentHead, diffArtifactId: oldArtifact.id }),
      error => assertControl409(error, 'WORKTREE_ARTIFACT_HEAD_MISMATCH'),
    );

    const freshArtifact = await fx.artifacts.createWorktreeArtifact(fx.lease.id, artifactInput(fx));
    const reviewed = await fx.control.review(fx.workspace.id, fx.lease.id, {
      expectedHeadCommit: currentHead,
      diffArtifactId: freshArtifact.id,
    });
    assert.equal(reviewed.status, 'ready_for_review');
    assert.equal(reviewed.headCommit, currentHead);
    assert.equal(reviewed.diffArtifactId, freshArtifact.id);
  } finally { await fx.close(); }
});

test('worktree identity, Run, execution, agent, and root mismatches are rejected before artifact persistence', async () => {
  const fx = await worktreeRecoveryFixture();
  try {
    const invalidInputs: Array<Partial<CreateRuntimeArtifactInput>> = [
      { workspaceId: 'workspace-other' },
      { runId: 'run-other' },
      { sourceExecutionId: 'execution-other' },
      { agentId: 'agent-other' },
      { workspaceRoot: fx.workspace.rootPath },
    ];
    for (const overrides of invalidInputs) {
      await assert.rejects(
        () => fx.artifacts.createWorktreeArtifact(fx.lease.id, artifactInput(fx, overrides)),
        error => error instanceof WorktreeArtifactProvenanceError && error.code === 'WORKTREE_ARTIFACT_PROVENANCE_MISMATCH',
      );
    }
    assert.equal(fx.artifacts.listForRun(fx.workspace.id, fx.run.id).length, 0);
    assert.deepEqual(await emptyOrRead(`${fx.artifacts.artifactRoot}/worktree-evidence`), []);
  } finally { await fx.close(); }
});

test('a binding insert failure rolls back the canonical artifact row and staged content, and retry succeeds', async () => {
  const fx = await worktreeRecoveryFixture();
  try {
    const db = fx.store.getDatabase();
    db.exec(`CREATE TRIGGER fail_worktree_artifact_binding BEFORE INSERT ON worktree_artifact_bindings
      BEGIN SELECT RAISE(ABORT, 'synthetic binding failure'); END;`);
    await assert.rejects(() => fx.artifacts.createWorktreeArtifact(fx.lease.id, artifactInput(fx)), /synthetic binding failure/);
    assert.equal(fx.artifacts.listForRun(fx.workspace.id, fx.run.id).length, 0);
    assert.deepEqual(await emptyOrRead(`${fx.artifacts.artifactRoot}/worktree-evidence`), []);

    db.exec('DROP TRIGGER fail_worktree_artifact_binding');
    const artifact = await fx.artifacts.createWorktreeArtifact(fx.lease.id, artifactInput(fx));
    assert.equal(fx.artifacts.listForWorktree(fx.lease.id).some(item => item.id === artifact.id), true);
    assert.equal(existsSync(`${fx.artifacts.artifactRoot}/worktree-evidence/${artifact.id}/content`), true);
  } finally { await fx.close(); }
});

test('binding survives store restart and a SQLite backup/restore round trip', async () => {
  const fx = await worktreeRecoveryFixture();
  let restartedStore: SqliteStore | undefined;
  let originalStoreClosed = false;
  try {
    const artifact = await fx.artifacts.createWorktreeArtifact(fx.lease.id, artifactInput(fx));
    const sqlitePath = `${fx.data}/.agentos/agentos.sqlite`;
    fx.store.close();
    originalStoreClosed = true;

    restartedStore = new SqliteStore(fx.data);
    fx.store = restartedStore;
    const restartedArtifacts = new RuntimeArtifactService(restartedStore, fx.data);
    const afterRestart = restartedArtifacts.requireWorktreeProvenance(fx.lease.id, artifact.id);
    assert.equal(afterRestart.leaseId, fx.lease.id);
    assert.equal(afterRestart.headCommit, fx.head);

    restartedStore.getDatabase().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const backupDirectory = `${fx.root}/sqlite-backups`;
    const backupProvider = createFileBackupProvider(backupDirectory);
    backupProvider.backup(sqlitePath);
    const backupName = (await readdir(backupDirectory))[0];
    assert.ok(backupName);

    const restoreRoot = `${fx.root}/sqlite-restored`;
    mkdirSync(`${restoreRoot}/.agentos`, { recursive: true });
    copyFileSync(`${backupDirectory}/${backupName}`, `${restoreRoot}/.agentos/agentos.sqlite`);
    const restoredStore = new SqliteStore(restoreRoot);
    try {
      const restoredArtifacts = new RuntimeArtifactService(restoredStore, restoreRoot);
      const afterRestore = restoredArtifacts.requireWorktreeProvenance(fx.lease.id, artifact.id);
      assert.equal(afterRestore.leaseId, fx.lease.id);
      assert.equal(afterRestore.headCommit, fx.head);
      assert.deepEqual(restoredStore.getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
    } finally { restoredStore.close(); }
  } finally {
    if (restartedStore) restartedStore.close();
    else if (!originalStoreClosed) fx.store.close();
    await fx.removeCheckout(fx.record.absolutePath);
    await rm(fx.root, { recursive: true, force: true });
  }
});
