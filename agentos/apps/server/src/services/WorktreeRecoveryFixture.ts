import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { realpath, rm, readdir, lstat, unlink, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService } from './TaskRunService.js';
import { WorktreeManager } from './WorktreeManager.js';
import { WorktreeControlService } from './WorktreeControlService.js';
import { WorktreeArtifactService } from './WorktreeArtifactService.js';
import { RuntimeArtifactService } from './RuntimeArtifactService.js';
import { linksInRemovalOrder } from './WorktreeRecoveryBundleService.js';

const execute = promisify(execFile);
export async function recoveryGit(cwd: string, args: string[]): Promise<string> {
  return (await execute('git', args, { cwd, windowsHide: true, timeout: 30000 })).stdout.trim();
}
/** Real Git + SQLite fixture. The Run is seeded terminal without a Provider. */
export async function worktreeRecoveryFixture(options: { trackedLink?: boolean } = {}) {
  const tempRoot = await realpath(tmpdir());
  const root = mkdtempSync(join(tempRoot, 'agentos-recovery-fixture-'));
  const data = join(root, 'data');
  mkdirSync(join(data, 'workspace'), { recursive: true });
  writeFileSync(join(data, 'workspace', 'workspaces.json'), '{"workspaces":[]}');
  const store = new SqliteStore(data);
  const workspace = await new WorkspaceManager(store).create('Recovery fixture', join(root, 'workspace'),
    { git: false, memory: false, readme: false, docs: false });
  await recoveryGit(workspace.rootPath, ['-c', 'core.symlinks=false', 'init', '-q', '-b', 'main']);
  await recoveryGit(workspace.rootPath, ['config', 'core.autocrlf', 'false']);
  await recoveryGit(workspace.rootPath, ['config', 'user.email', 'recovery@example.test']);
  await recoveryGit(workspace.rootPath, ['config', 'user.name', 'Recovery Fixture']);
  writeFileSync(join(workspace.rootPath, 'target.txt'), 'baseline\n');
  if (options.trackedLink) {
    await recoveryGit(workspace.rootPath, ['config', 'core.symlinks', 'true']);
    await symlink('target.txt', join(workspace.rootPath, 'tracked-link.txt'), 'file');
  }
  await recoveryGit(workspace.rootPath, ['add', '-A']);
  await recoveryGit(workspace.rootPath, ['commit', '-qm', 'base']);
  const head = await recoveryGit(workspace.rootPath, ['rev-parse', 'HEAD']);
  const runs = new TaskRunService(store);
  const task = runs.createTask(workspace.id, { title: 'Recovery test', createdBy: 'fixture' });
  const run = runs.createRun(workspace.id, { taskId: task.id, createdBy: 'fixture' });
  store.getDatabase().prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(run.id);
  const manager = new WorktreeManager(join(root, 'managed'), store.worktreeRepository());
  const lease = await manager.createLease({ workspaceId: workspace.id, workspaceRoot: workspace.rootPath,
    runId: run.id, executionId: 'execution-a', agentId: 'agent-a' });
  const record = manager.getRecord(lease.id)!;
  const artifacts = new RuntimeArtifactService(store, data);
  const bundles = new WorktreeArtifactService(artifacts, manager);
  const control = new WorktreeControlService(manager, { getRun: (ws, id) => store.runRepository().findById(ws, id) }, artifacts);
  const input = { workspaceId: workspace.id, runId: run.id, executionId: lease.executionId, agentId: lease.agentId };
  const removeCheckout = async (path: string) => {
    const boundary = relative(root, resolve(path));
    if (!boundary || boundary.startsWith(`..${sep}`) || boundary === '..') throw new Error('Fixture checkout boundary invalid');
    const bundle = manager.getRecord(lease.id)?.recoveryBundle;
    if (bundle?.formatVersion === 2 && existsSync(join(path, 'target.txt'))) {
      const manifest = JSON.parse((await readFile(join(artifacts.artifactRoot, 'worktree-evidence', bundle.manifestArtifactId, 'content'))).toString());
      for (const item of linksInRemovalOrder(manifest.entries)) {
        try { await unlink(join(path, item.path)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    const unlinkLinks = async (directory: string): Promise<void> => {
      for (const info of await readdir(directory, { withFileTypes: true })) {
        const child = join(directory, info.name);
        if (info.isSymbolicLink()) await unlink(child);
        else if (info.isDirectory()) await unlinkLinks(child);
      }
    };
    await unlinkLinks(path);
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await recoveryGit(workspace.rootPath, ['worktree', 'prune']);
  };
  return { root, data, store, workspace, run, manager, lease, record, artifacts, bundles, control, input, head, removeCheckout,
    async close() {
      const boundary = relative(tempRoot, resolve(root));
      if (!boundary || boundary.startsWith(`..${sep}`) || boundary === '..') throw new Error('Fixture cleanup boundary invalid');
      for (const item of manager.listLeases()) {
        const leaseRecord = manager.getRecord(item.id)!;
        if (existsSync(leaseRecord.absolutePath)) {
          try { await removeCheckout(leaseRecord.absolutePath); }
          catch (error) { process.emitWarning(`Fixture checkout cleanup retained ${leaseRecord.absolutePath}: ${(error as NodeJS.ErrnoException).code}`); }
        }
      }
      try { store.close(); } catch { /* a restart test may already close this connection */ }
      if (options.trackedLink && existsSync(join(workspace.rootPath, 'tracked-link.txt'))) await unlink(join(workspace.rootPath, 'tracked-link.txt'));
      try { await rm(root, { recursive: true, force: true }); }
      catch (error) { process.emitWarning(`Fixture cleanup retained ${root}: ${(error as NodeJS.ErrnoException).code}`); }
    },
  };
}
