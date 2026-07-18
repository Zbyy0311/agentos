import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, realpath } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { WorktreeLease, WorktreeRecoveryBundle } from '@agentos/shared';

type LeaseRecord = WorktreeLease & { absolutePath: string; workspaceRoot: string; recoveryBundle?: WorktreeRecoveryBundle };
type CreateInput = { workspaceId: string; workspaceRoot: string; runId: string; executionId: string; agentId: string };

export class WorktreeError extends Error { constructor(public readonly code: string, message: string) { super(message); } }

export class WorktreeManager {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly leaseFile: string;
  constructor(private readonly worktreeRoot: string) { this.leaseFile=join(worktreeRoot,'leases.json'); if(existsSync(this.leaseFile)){try{for(const record of JSON.parse(readFileSync(this.leaseFile,'utf8')) as LeaseRecord[])this.leases.set(record.id,record);}catch{/* corrupted state is reconciled as empty */}} }

  async createLease(input: CreateInput): Promise<WorktreeLease> {
    await this.assertClean(input.workspaceRoot);
    const baseCommit = (await git(input.workspaceRoot, ['rev-parse', 'HEAD'])).trim();
    const branchName = `agentos/run-${segment(input.runId)}-exec-${segment(input.executionId)}`;
    const absolutePath = resolve(this.worktreeRoot, segment(input.workspaceId), segment(input.runId), segment(input.executionId));
    if (await gitSucceeds(input.workspaceRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`])) {
      throw new WorktreeError('branch_exists', `branch_exists: ${branchName}`);
    }
    if (existsSync(absolutePath)) throw new WorktreeError('target_exists', 'target_exists: worktree path already exists');
    await mkdir(resolve(this.worktreeRoot, segment(input.workspaceId), segment(input.runId)), { recursive: true });
    const id = randomUUID(); const now = new Date().toISOString();
    await git(input.workspaceRoot, ['worktree', 'add', '-b', branchName, absolutePath, baseCommit]);
    const record: LeaseRecord = { id, ...input, branchName, pathLabel: `worktree/${segment(input.workspaceId)}/${segment(input.runId)}/${segment(input.executionId)}`, baseCommit, status:'active', createdAt:now, updatedAt:now, absolutePath, workspaceRoot:input.workspaceRoot };
    this.leases.set(id, record); this.persist(); return publicLease(record);
  }

  getLease(id: string): WorktreeLease | undefined { const record = this.leases.get(id); return record && publicLease(record); }
  getRecord(id: string): LeaseRecord | undefined { return this.leases.get(id); }
  async preflight(workspaceRoot: string): Promise<void> { await this.assertClean(workspaceRoot); }
  markRecoveryBundleVerified(id: string, bundle?: WorktreeRecoveryBundle): void {
    const record = this.leases.get(id);
    if (!record || !bundle) return;
    record.recoveryBundle = bundle;
    record.status = 'completed';
    record.updatedAt = new Date().toISOString();
    this.persist();
  }
  listLeases(): WorktreeLease[] { return [...this.leases.values()].map(publicLease); }
  markCleanupPending(id: string): void { const record = this.leases.get(id); if (!record) throw new WorktreeError('not_found','lease not found'); record.status='cleanup_pending'; record.updatedAt=new Date().toISOString(); this.persist(); }
  async reconcile(): Promise<void> {
    const configuredRoot = resolve(this.worktreeRoot);
    let realRoot: string;
    try { realRoot = await realpath(configuredRoot); } catch { realRoot = configuredRoot; }
    for (const record of this.leases.values()) {
      if (record.status !== 'creating' && record.status !== 'active' && record.status !== 'cleanup_pending') continue;
      try {
        const actualPath = await realpath(record.absolutePath);
        if (!isWithin(realRoot, actualPath)) throw new Error('worktree path escapes configured root');
        await access(join(actualPath, '.git'));
        if (record.status === 'creating') record.status = 'active';
      } catch {
        record.status = 'failed';
      }
      record.updatedAt = new Date().toISOString();
    }
    this.persist();
  }
  async removeLease(id: string, confirmRecoveryBundle: boolean): Promise<WorktreeLease> { const record=this.leases.get(id); if (!record) throw new WorktreeError('not_found','lease not found'); if (!confirmRecoveryBundle) throw new WorktreeError('confirmation_required','recovery bundle confirmation is required'); if (!record.recoveryBundle) throw new WorktreeError('bundle_required','verified recovery bundle is required'); await git(record.workspaceRoot,['worktree','remove','--force',record.absolutePath]); record.status='cleaned'; record.updatedAt=new Date().toISOString(); this.persist(); return publicLease(record); }
  private persist(): void { try { mkdirSync(this.worktreeRoot,{recursive:true}); writeFileSync(this.leaseFile,JSON.stringify([...this.leases.values()],null,2),'utf8'); } catch {/* best effort; active worktree remains recoverable from git */} }
  private async assertClean(root: string): Promise<void> {
    if (!isAbsolute(root)) throw new WorktreeError('root_not_absolute', 'root_not_absolute: workspace path must be absolute');
    if (isWithin(root, this.worktreeRoot)) throw new WorktreeError('root_inside_workspace', 'root_inside_workspace: worktree root cannot be inside the workspace');
    try {
      await git(root, ['rev-parse', '--show-toplevel']);
      if ((await git(root, ['rev-parse', '--is-bare-repository'])).trim() === 'true') throw new WorktreeError('bare_repository', 'bare_repository: bare repositories are not supported');
      await git(root, ['rev-parse', '--verify', 'HEAD']);
    } catch (error) {
      if (error instanceof WorktreeError) throw error;
      throw new WorktreeError('not_git', 'not_git: workspace is not a Git repository with a HEAD');
    }
    const status = await git(root, ['status', '--porcelain=v1', '-z']);
    if (status.length) throw new WorktreeError('workspace_dirty', 'workspace_dirty: workspace has uncommitted changes');
  }
}

function segment(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0,8); }
function publicLease(record: LeaseRecord): WorktreeLease { const { absolutePath: _path, workspaceRoot: _root, recoveryBundle: _bundle, ...lease } = record; return lease; }
function git(cwd: string, args: string[]): Promise<string> { return new Promise((resolvePromise,reject) => execFile('git', args, { cwd, timeout: 10000, windowsHide:true }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}: ${stderr}`)) : resolvePromise(stdout))); }
function gitSucceeds(cwd: string, args: string[]): Promise<boolean> { return git(cwd, args).then(() => true, () => false); }
function isWithin(root: string, candidate: string): boolean { const child = relative(resolve(root), resolve(candidate)); return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)); }
