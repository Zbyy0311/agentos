import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService } from './TaskRunService.js';
import { WorktreeManager } from './WorktreeManager.js';
import { WorktreeMergeService } from './WorktreeMergeService.js';
import { WorktreeRuntimeEventEmitter } from './WorktreeRuntimeEvents.js';
import { createWorktreeRoutes } from '../routes/worktrees.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }).trim();
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentos-worktree-events-'));
  mkdirSync(join(directory, 'workspace'));
  writeFileSync(join(directory, 'workspace', 'workspaces.json'), '{"workspaces":[]}');
  const store = new SqliteStore(directory);
  const workspaces = new WorkspaceManager(store);
  const workspace = await workspaces.create('Worktree events', join(directory, 'source'), { git: false, memory: false, readme: false, docs: false });
  git(workspace.rootPath, ['init', '-q', '-b', 'main']);
  git(workspace.rootPath, ['config', 'user.name', 'Events fixture']);
  git(workspace.rootPath, ['config', 'user.email', 'events@agentos.invalid']);
  git(workspace.rootPath, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(workspace.rootPath, 'README.md'), 'base\n');
  git(workspace.rootPath, ['add', '.']);
  git(workspace.rootPath, ['commit', '-qm', 'base']);
  const service = new TaskRunService(store);
  const task = service.createTask(workspace.id, { title: 'Event task', createdBy: 'test' });
  const run = service.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
  const audit: string[] = [];
  const sink = new WorktreeRuntimeEventEmitter(store.getDatabase(), store.runtimeEventOutboxWriter(), { onAudit: line => audit.push(line) });
  const worktreeRoot = join(directory, 'worktrees');
  const manager = new WorktreeManager(worktreeRoot, store.worktreeRepository(), sink);
  const createLease = () => manager.createLease({ workspaceId: workspace.id, workspaceRoot: workspace.rootPath, runId: run.id, executionId: 'exec-test', agentId: 'agent-test' });
  const events = (id: string) => store.runtimeEventRepository().listByWorktree(workspace.id, id).map(result => {
    assert.equal(result.kind, 'known'); return result.event;
  });
  return { directory, store, workspaces, workspace, run, audit, sink, worktreeRoot, manager, createLease, events,
    close: () => {
      store.close();
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
      catch (error) {
        if (process.platform !== 'win32' || !['ENOTEMPTY', 'EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        process.emitWarning(`Fixture cleanup incomplete; retained ${directory}: ${(error as NodeJS.ErrnoException).code}`);
      }
    } };
}

test('lease mutation persists a registered event and exactly one outbox handoff', async () => {
  const fx = await fixture();
  try {
    const lease = await fx.createLease();
    fx.manager.abandonLease(lease.id);
    const events = fx.events(lease.id);
    assert.deepEqual(events.map(event => event.type), ['worktree.reserved', 'worktree.created', 'worktree.abandoned']);
    assert.deepEqual(events.map(event => event.sequence), [2, 3, 4]);
    for (const event of events) {
      assert.equal(event.source, 'worktree-manager');
      assert.equal(event.runId, fx.run.id);
      assert.equal(event.workspaceId, fx.workspace.id);
      const outbox = fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM outbox_messages WHERE event_id = ?').get(event.id) as { count: number };
      assert.equal(outbox.count, 1);
    }
    assert.deepEqual(fx.store.runtimeEventRepository().listByWorktree('other-workspace', lease.id), []);
  } finally { fx.close(); }
});

test('missing canonical Run records an audit line instead of inventing a Run event', async () => {
  const fx = await fixture();
  try {
    const lease = await fx.manager.createLease({ workspaceId: fx.workspace.id, workspaceRoot: fx.workspace.rootPath, runId: 'legacy-run', executionId: 'legacy-exec', agentId: 'agent-test' });
    assert.deepEqual(fx.events(lease.id), []);
    assert.ok(fx.audit.some(line => line.includes('run-not-persisted')));
  } finally { fx.close(); }
});

test('startup reconciliation finds and preserves an orphan with no database leases', async () => {
  const fx = await fixture();
  try {
    mkdirSync(fx.worktreeRoot);
    const orphan = join(fx.worktreeRoot, 'orphan');
    git(fx.workspace.rootPath, ['worktree', 'add', '-q', '-b', 'orphan', orphan]);
    const report = await fx.manager.reconcile([fx.workspace.rootPath]);
    assert.equal(report.orphaned.length, 1);
    assert.equal(report.orphaned[0].action, 'preserve');
    assert.ok(existsSync(join(orphan, 'README.md')));
    assert.equal(fx.manager.listLeases().length, 0);
    assert.ok(fx.audit.some(line => line.includes('WORKTREE_ORPHAN_PRESERVED')));
  } finally { fx.close(); }
});

test('restart reactivates a creating lease with recovery and activation events', async () => {
  const fx = await fixture();
  try {
    const lease = await fx.createLease();
    const record = fx.manager.getRecord(lease.id)!;
    fx.store.worktreeRepository().save({ ...record, status: 'creating' });
    const restarted = new WorktreeManager(fx.worktreeRoot, fx.store.worktreeRepository(), fx.sink);
    const report = await restarted.reconcile([fx.workspace.rootPath]);
    assert.deepEqual(report.activated, [lease.id]);
    assert.equal(restarted.getLease(lease.id)?.status, 'active');
    assert.ok(fx.events(lease.id).some(event => event.type === 'worktree.activated'));
    assert.ok(fx.store.runtimeEventRepository().listByRunAfterSequence(fx.run.id, 0).some(result => result.event.type === 'worktree.recovery_started'));
  } finally { fx.close(); }
});

test('merge records requested and merged events while preserving the main checkout', async () => {
  const fx = await fixture();
  try {
    const lease = await fx.createLease();
    const checkout = fx.manager.getRecord(lease.id)!.absolutePath;
    const base = git(fx.workspace.rootPath, ['rev-parse', 'HEAD']);
    writeFileSync(join(checkout, 'feature.txt'), 'feature\n');
    git(checkout, ['add', '.']); git(checkout, ['commit', '-qm', 'feature']);
    const merge = new WorktreeMergeService(fx.manager, fx.store.worktreeMergeRepository());
    await merge.merge(lease.id, { strategy: 'ff', targetBranch: 'main', expectedHeadCommit: base, requestedBy: 'test' });
    assert.deepEqual(fx.events(lease.id).map(event => event.type), ['worktree.reserved', 'worktree.created', 'worktree.merge_requested', 'worktree.merged']);
    assert.equal(existsSync(join(fx.workspace.rootPath, 'feature.txt')), false);
  } finally { fx.close(); }
});

test('startup preserves a partial creating checkout without activating it', async () => {
  const fx = await fixture();
  try {
    const lease = await fx.createLease();
    const record = fx.manager.getRecord(lease.id)!;
    unlinkSync(join(record.absolutePath, 'README.md'));
    fx.store.worktreeRepository().save({ ...record, status: 'creating' });
    const restarted = new WorktreeManager(fx.worktreeRoot, fx.store.worktreeRepository(), fx.sink);
    const report = await restarted.reconcile([fx.workspace.rootPath]);
    assert.deepEqual(report.activated, []);
    assert.deepEqual(report.incompleteCreations, [lease.id]);
    assert.equal(restarted.getLease(lease.id)?.status, 'failed');
    assert.ok(existsSync(join(record.absolutePath, '.git')));
    assert.ok(!fx.events(lease.id).some(event => event.type === 'worktree.activated'));
  } finally { fx.close(); }
});

test('startup refuses to activate a creating checkout on a different branch', async () => {
  const fx = await fixture();
  try {
    const lease = await fx.createLease();
    const record = fx.manager.getRecord(lease.id)!;
    git(record.absolutePath, ['checkout', '-qb', 'foreign-branch']);
    fx.store.worktreeRepository().save({ ...record, status: 'creating' });
    const restarted = new WorktreeManager(fx.worktreeRoot, fx.store.worktreeRepository(), fx.sink);
    const report = await restarted.reconcile([fx.workspace.rootPath]);
    assert.deepEqual(report.incompleteCreations, [lease.id]);
    assert.equal(restarted.getLease(lease.id)?.status, 'failed');
    assert.equal(git(record.absolutePath, ['symbolic-ref', '--short', 'HEAD']), 'foreign-branch');
    assert.ok(existsSync(join(record.absolutePath, 'README.md')));
  } finally { fx.close(); }
});

test('event API serves durable workspace-scoped events with sequence pagination', async () => {
  const fx = await fixture();
  const app = express();
  app.use('/api/workspaces/:workspaceId', createWorktreeRoutes(fx.workspaces, fx.manager, undefined, undefined, undefined, undefined, fx.store.runtimeEventRepository()));
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const lease = await fx.createLease(); fx.manager.abandonLease(lease.id);
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/workspaces/${fx.workspace.id}/worktrees/${lease.id}/events`;
    const response = await fetch(`${base}?afterSequence=3`);
    const body = await response.json();
    assert.equal(body.eventModel, 'runtime_events');
    assert.deepEqual(body.events.map((event: { type: string }) => event.type), ['worktree.abandoned']);
    assert.equal(body.nextSequence, 4);
    assert.equal((await fetch(`${base}?afterSequence=-1`)).status, 400);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); fx.close(); }
});

test('failed outbox insert rolls back the lease mutation and its runtime event', async () => {
  const fx = await fixture();
  try {
    const lease = await fx.createLease();
    fx.store.getDatabase().exec("CREATE TRIGGER block_outbox BEFORE INSERT ON outbox_messages BEGIN SELECT RAISE(ABORT, 'fixture-outbox-failure'); END");
    assert.throws(() => fx.manager.abandonLease(lease.id), /OUTBOX_PERSISTENCE_FAILED/);
    assert.equal(fx.manager.getLease(lease.id)?.status, 'active');
    assert.equal(fx.store.worktreeRepository().getById(lease.id)?.status, 'active');
    assert.deepEqual(fx.events(lease.id).map(event => event.type), ['worktree.reserved', 'worktree.created']);
  } finally { fx.close(); }
});

test('reservation persistence fails before Git creates a branch or checkout', async () => {
  const fx = await fixture();
  try {
    fx.store.getDatabase().exec("CREATE TRIGGER block_outbox BEFORE INSERT ON outbox_messages BEGIN SELECT RAISE(ABORT, 'fixture-outbox-failure'); END");
    await assert.rejects(fx.createLease(), /OUTBOX_PERSISTENCE_FAILED/);
    assert.deepEqual(fx.manager.listLeases(), []);
    assert.deepEqual(fx.store.worktreeRepository().list(), []);
    assert.equal(git(fx.workspace.rootPath, ['for-each-ref', '--format=%(refname)', 'refs/heads/agentos/']), '');
    assert.equal(git(fx.workspace.rootPath, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).length, 1);
  } finally { fx.close(); }
});

test('empty execution identity is rejected before reserving a lease or creating Git content', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(fx.manager.createLease({ workspaceId: fx.workspace.id, workspaceRoot: fx.workspace.rootPath,
      runId: fx.run.id, executionId: 'execution', agentId: '',
    }), error => (error as { code?: string }).code === 'invalid_identity');
    assert.deepEqual(fx.store.worktreeRepository().list(), []);
    assert.equal(git(fx.workspace.rootPath, ['for-each-ref', '--format=%(refname)', 'refs/heads/agentos/']), '');
  } finally { fx.close(); }
});

test('startup event failure restores creating status in both database and manager cache', async () => {
  const fx = await fixture();
  try {
    const lease = await fx.createLease();
    const record = fx.manager.getRecord(lease.id)!;
    fx.store.worktreeRepository().save({ ...record, status: 'creating' });
    const restarted = new WorktreeManager(fx.worktreeRoot, fx.store.worktreeRepository(), fx.sink);
    fx.store.getDatabase().exec("CREATE TRIGGER block_outbox BEFORE INSERT ON outbox_messages BEGIN SELECT RAISE(ABORT, 'fixture-outbox-failure'); END");
    await assert.rejects(restarted.reconcile([fx.workspace.rootPath]), /OUTBOX_PERSISTENCE_FAILED/);
    assert.equal(restarted.getLease(lease.id)?.status, 'creating');
    assert.equal(fx.store.worktreeRepository().getById(lease.id)?.status, 'creating');
    assert.ok(!fx.events(lease.id).some(event => event.type === 'worktree.activated'));
    assert.ok(existsSync(join(record.absolutePath, 'README.md')));
  } finally { fx.close(); }
});
