import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { WorktreeLeaseRecord } from '../store/WorktreeRepository.js';
import type { WorktreeMergeRecord, WorktreeMergeRepository } from '../store/WorktreeMergeRepository.js';
import type { WorktreeManager } from './WorktreeManager.js';

const exec = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const DIRECTORY = '.agentos-ref-journals';

export interface WorktreeRefIntent {
  readonly branch: string;
  readonly previousCommit: string;
  readonly resultingCommit: string;
  readonly eventType: 'worktree.commit_created' | 'worktree.merged';
  readonly payload: Record<string, unknown>;
  readonly mergeRecord?: WorktreeMergeRecord;
}

interface Journal extends WorktreeRefIntent {
  readonly version: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly worktreeId: string;
}

export class WorktreeRefRecoveryError extends Error {
  readonly code = 'WORKTREE_REF_RECOVERY_REQUIRED';
  constructor() { super('A preserved Git reference intent requires recovery before another mutation'); }
}

/** Persist the exact intended ref/result before the Git CAS can become visible. */
export async function prepareWorktreeRefUpdate(lease: WorktreeLeaseRecord, intent: WorktreeRefIntent): Promise<{ complete(): Promise<void> }> {
  const directory = await journalDirectory(lease.workspaceRoot);
  await assertNoPendingWorktreeRefUpdate(lease, intent.branch);
  const id = randomUUID();
  const journal: Journal = { version: 1, id, workspaceId: lease.workspaceId, runId: lease.runId, worktreeId: lease.id, ...intent };
  validate(journal);
  const path = join(directory, `${id}.json`);
  const handle = await open(path, 'wx');
  try { await handle.writeFile(JSON.stringify(journal)); await handle.sync(); }
  finally { await handle.close(); }
  return { complete: async () => { await unlink(path); } };
}

/** Pending intents fence source controls and target merges even after process restart. */
export async function assertNoPendingWorktreeRefUpdate(lease: WorktreeLeaseRecord, branch = lease.branchName): Promise<void> {
  const directory = await journalDirectory(lease.workspaceRoot);
  for (const { journal } of await readJournals(directory)) {
    if (journal.branch === branch) throw new WorktreeRefRecoveryError();
  }
}

/**
 * Completes only a proven published ref. It never writes Git refs or removes
 * uncertain/stale branch locks. An old or unrelated ref keeps its intent for
 * explicit recovery rather than inventing a successful operation.
 */
export async function recoverWorktreeRefUpdates(manager: WorktreeManager, merges: WorktreeMergeRepository): Promise<{ completed: number; preserved: number }> {
  const directories = new Set<string>();
  const report = { completed: 0, preserved: 0 };
  for (const lease of manager.listLeases()) {
    const record = manager.getRecord(lease.id)!;
    try { directories.add(await journalDirectory(record.workspaceRoot)); }
    catch { report.preserved += 1; }
  }
  for (const directory of directories) {
    for (const { path, journal } of await readJournals(directory)) {
      const lease = manager.getRecord(journal.worktreeId);
      if (!lease || lease.workspaceId !== journal.workspaceId || lease.runId !== journal.runId
        || await journalDirectory(lease.workspaceRoot) !== directory) {
        report.preserved += 1; continue;
      }
      const observed = await git(lease.workspaceRoot, ['rev-parse', '--verify', `refs/heads/${journal.branch}`]).catch(() => '');
      if (observed.trim() !== journal.resultingCommit) { report.preserved += 1; continue; }
      if (journal.mergeRecord) {
        const record = journal.mergeRecord;
        const previous = merges.getById(record.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new WorktreeRefRecoveryError();
        if (!previous) {
          merges.createInTransaction(record, () => manager.recordRuntimeFact(lease.id, journal.eventType, journal.payload));
        } else {
          manager.recordRuntimeFact(lease.id, journal.eventType, journal.payload);
        }
      } else {
        manager.recordRuntimeFact(lease.id, journal.eventType, journal.payload);
      }
      await unlink(path);
      report.completed += 1;
    }
  }
  return report;
}

async function readJournals(directory: string): Promise<Array<{ path: string; journal: Journal }>> {
  const result: Array<{ path: string; journal: Journal }> = [];
  for (const name of await readdir(directory)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) throw new WorktreeRefRecoveryError();
    const path = join(directory, name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_048_576
      || !within(directory, await realpath(path))) throw new WorktreeRefRecoveryError();
    let journal: Journal;
    try { journal = JSON.parse(await readFile(path, 'utf8')) as Journal; }
    catch { throw new WorktreeRefRecoveryError(); }
    validate(journal);
    if (`${journal.id}.json` !== name) throw new WorktreeRefRecoveryError();
    result.push({ path, journal });
  }
  return result;
}

function validate(journal: Journal): void {
  if (!journal || journal.version !== 1 || !/^[0-9a-f-]{36}$/.test(journal.id)
    || ![journal.workspaceId, journal.runId, journal.worktreeId].every(value => typeof value === 'string' && value.length > 0)
    || typeof journal.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(journal.branch)
    || journal.branch.includes('..') || !SHA.test(journal.previousCommit) || !SHA.test(journal.resultingCommit)
    || !journal.payload || typeof journal.payload !== 'object' || Array.isArray(journal.payload)) throw new WorktreeRefRecoveryError();
  if (journal.eventType === 'worktree.commit_created') {
    if (journal.mergeRecord || journal.payload.commitSha !== journal.resultingCommit) throw new WorktreeRefRecoveryError();
  } else if (journal.eventType === 'worktree.merged') {
    const record = journal.mergeRecord;
    if (!record || record.result !== 'merged' || record.worktreeId !== journal.worktreeId
      || record.targetBranch !== journal.branch || record.previousTargetCommit !== journal.previousCommit
      || record.resultingTargetCommit !== journal.resultingCommit || record.id !== journal.payload.mergeRecordId
      || journal.payload.resultingTargetCommit !== journal.resultingCommit) throw new WorktreeRefRecoveryError();
  } else throw new WorktreeRefRecoveryError();
}

async function journalDirectory(workspaceRoot: string): Promise<string> {
  const common = await realpath((await git(workspaceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  const directory = join(common, DIRECTORY);
  await mkdir(directory, { recursive: true });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !within(common, await realpath(directory))) {
    throw new WorktreeRefRecoveryError();
  }
  return directory;
}

function within(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  const result = await exec('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, env, windowsHide: true, timeout: 10_000 });
  return result.stdout;
}
