import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { WorktreeLease, WorktreeRecoveryBundle } from '@agentos/shared';
import { isCollaborationWorkspaceClean } from './CollaborationCandidateSnapshot.js';
import { CollaborationSnapshotGitContext } from './CollaborationSnapshotGitContext.js';
import type { WorktreeEventSink, WorktreeLeaseEventType, WorktreeOrphanObservation } from './WorktreeRuntimeEvents.js';
import { NOOP_WORKTREE_EVENT_SINK } from './WorktreeRuntimeEvents.js';
import { inTransaction, isTransactionActive, registerAfterCommit, type TransactionDatabase } from '../store/Transaction.js';
import { RuntimeLockRepository } from '../store/RuntimeLockRepository.js';
import { createEntityId } from '../store/Identity.js';
import type { WorktreeLeaseRecord } from '../store/WorktreeRepository.js';
import { WorktreeLeaseIdentityConflictError, WorktreeRepository } from '../store/WorktreeRepository.js';

type LeaseRecord = WorktreeLeaseRecord;
type PreflightOptions = { readonly controlledGitContent?: boolean };
type CreateInput = { workspaceId: string; workspaceRoot: string; runId: string; executionId: string; agentId: string; expectedBaseCommit?: string } & PreflightOptions;
type AdoptInput = { path: string; branchName: string; workspaceId: string; workspaceRoot: string; runId?: string; executionId?: string; agentId?: string };

export const DEFAULT_DIFF_MAX_BYTES = 1_048_576;

export interface WorktreeGitStatus {
  baseCommit: string;
  branch: string;
  exists: boolean;
  gitReachable: boolean;
  head?: string;
  dirtyFiles: number;
  ahead: number;
  behind: number;
}

export interface WorktreeDiff {
  baseCommit: string;
  stat: { filesChanged: number; insertions: number; deletions: number };
  patch: string;
  patchBytes: number;
  truncated: boolean;
}

export interface WorktreeInspectReport {
  leaseId: string;
  leaseStatus: WorktreeLease['status'];
  checks: {
    directoryExists: boolean;
    gitReachable: boolean;
    pathWithinRoot: boolean | null;
    statusConsistent: boolean;
  };
  consistent: boolean;
}

export class WorktreeError extends Error { constructor(public readonly code: string, message: string) { super(message); } }

/**
 * §8.4 worktreeCreation concurrency. Saturated callers wait for a persistent
 * capacity reservation instead of turning an already-accepted Run into a
 * terminal failure. The old error remains exported for source compatibility.
 */
export class WorktreeConcurrencyLimitedError extends WorktreeError {
  constructor(limit: number) {
    super('concurrency_limited', `concurrency_limited: worktree creation concurrency limit reached (${limit})`);
    this.name = 'WorktreeConcurrencyLimitedError';
  }
}

/** §53.3/§56: a git-registered worktree with no database record, preserved as-is. */
export interface WorktreeReconcileReport {
  readonly activated: string[];
  readonly failed: string[];
  /** Creating checkouts whose registered branch or clean content does not verify. */
  readonly incompleteCreations: string[];
  /** Tracked leases whose directory still exists but is absent from `git worktree list` (no status change). */
  readonly missingGitRegistration: string[];
  /** Untracked-by-database worktrees preserved (never deleted, never auto-adopted). */
  readonly orphaned: WorktreeOrphanObservation[];
}

export interface LegacyLeaseImportIssue {
  readonly index: number;
  readonly id?: string;
  readonly code: string;
}

export type LegacyLeaseImportReport = readonly LegacyLeaseImportIssue[];

const LEGACY_LEASE_STATUSES = new Set(['creating', 'active', 'completed', 'cleanup_pending', 'cleaned', 'failed']);
const WORKTREE_CAPACITY_LOCK_PURPOSE = 'worktree-creation-capacity';
const WORKTREE_REQUEST_LOCK_PURPOSE = 'worktree-creation-request';

function creationProcessIsAlive(value: unknown): boolean {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return true;
  try { process.kill(value, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
const LEGACY_LEASE_REQUIRED_STRINGS = [
  'id', 'workspaceId', 'runId', 'executionId', 'agentId', 'branchName', 'pathLabel',
  'baseCommit', 'status', 'createdAt', 'updatedAt', 'absolutePath', 'workspaceRoot',
] as const;

export class WorktreeManager {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly leaseFile: string;
  private legacyImportReport: LegacyLeaseImportReport = Object.freeze([]);
  /** §8.4: in-flight createLease count for the worktreeCreation dimension. */
  private readonly creationConcurrencyLimit: number | undefined;
  private inFlightCreations = 0;
  /**
   * PR-3A: when a WorktreeRepository is supplied, lease persistence moves from
   * the whole-JSON leases.json anti-pattern to SQLite. The in-memory Map stays
   * as the runtime authority; every mutation is written through to the
   * repository. Without a repository the legacy JSON behavior is preserved
   * (embedded/test call sites that predate the store).
   *
   * PR-3D: an optional WorktreeEventSink emits the §71-76 lifecycle events
   * through the merged Runtime Event + Outbox seam. Durable row changes and
   * their events share one transaction; without a sink the manager is silent.
   */
  constructor(
    private readonly worktreeRoot: string,
    private readonly repository?: WorktreeRepository,
    private readonly events: WorktreeEventSink = NOOP_WORKTREE_EVENT_SINK,
    options: { readonly creationConcurrencyLimit?: number } = {},
  ) {
    this.leaseFile = join(worktreeRoot, 'leases.json');
    this.creationConcurrencyLimit = options.creationConcurrencyLimit;
    if (repository) {
      for (const record of repository.list()) this.leases.set(record.id, record);
      this.importLegacyLeasesFile();
    } else if (existsSync(this.leaseFile)) {
      try { for (const record of JSON.parse(readFileSync(this.leaseFile, 'utf8')) as LeaseRecord[]) this.leases.set(record.id, record); } catch { /* corrupted state is reconciled as empty */ }
    }
  }

  /** Import each legacy record independently and retain the source on any failure. */
  private importLegacyLeasesFile(): void {
    if (!existsSync(this.leaseFile) || !this.repository) return;
    let contents: string;
    try {
      contents = readFileSync(this.leaseFile, 'utf8');
    } catch {
      this.legacyImportReport = Object.freeze([{ index: 0, code: 'read_failed' }]);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      this.legacyImportReport = Object.freeze([{ index: 0, code: 'malformed_document' }]);
      return;
    }
    if (!Array.isArray(parsed)) {
      this.legacyImportReport = Object.freeze([{ index: 0, code: 'malformed_document' }]);
      return;
    }

    const issues: LegacyLeaseImportIssue[] = [];
    for (let index = 0; index < parsed.length; index += 1) {
      const candidate: unknown = parsed[index];
      const id = legacyLeaseId(candidate);
      if (!isLegacyLeaseRecord(candidate)) {
        issues.push({ index, ...(id === undefined ? {} : { id }), code: 'malformed_record' });
        continue;
      }

      try {
        const persisted = inTransaction(this.repository.transactionDatabase, () => this.repository!.importLegacy(candidate));
        // importLegacy returns the durable row, so identical duplicates keep
        // the database's current status, timestamps, and recovery bundle.
        this.leases.set(persisted.id, persisted);
      } catch (error) {
        const code = error instanceof WorktreeLeaseIdentityConflictError
          ? 'identity_conflict'
          : isUniqueConstraintError(error) ? 'unique_conflict' : 'database_error';
        issues.push({ index, id: candidate.id, code });
      }
    }

    this.legacyImportReport = Object.freeze(issues.map(issue => Object.freeze(issue)));
    if (issues.length === 0) this.archiveLegacyLeasesFile();
  }

  /** Link into a fresh name first so an existing archive can never be replaced. */
  private archiveLegacyLeasesFile(): void {
    const archiveBase = `${this.leaseFile}.migrated`;
    for (let attempt = 0; ; attempt += 1) {
      const archive = attempt === 0
        ? archiveBase
        : attempt < 128 ? `${archiveBase}.${attempt}` : `${archiveBase}.${randomUUID()}`;
      try {
        linkSync(this.leaseFile, archive);
      } catch (error) {
        if (hasNodeErrorCode(error, 'EEXIST')) continue;
        return;
      }
      try {
        unlinkSync(this.leaseFile);
      } catch {
        // Keeping both names is safe: a restart will see identical DB rows
        // and can make another non-overwriting archive attempt.
      }
      return;
    }
  }

  async createLease(input: CreateInput): Promise<WorktreeLease> {
    if (!input || [input.workspaceId, input.runId, input.executionId, input.agentId]
      .some(value => typeof value !== 'string' || value.trim().length === 0)) {
      throw new WorktreeError('invalid_identity', 'workspaceId, runId, executionId and agentId are required');
    }
    return await this.createLeaseInner(input);
  }

  private async createLeaseInner(input: CreateInput): Promise<WorktreeLease> {
    const baseCommit = await this.assertClean(input.workspaceRoot, input);
    if (input.expectedBaseCommit !== undefined && baseCommit !== input.expectedBaseCommit) {
      throw new WorktreeError('workspace_changed', 'workspace_changed: clean source baseline differs from the expected commit');
    }
    const branchName = `agentos/run-${segment(input.runId)}-exec-${segment(input.executionId)}`;
    const absolutePath = resolve(this.worktreeRoot, segment(input.workspaceId), segment(input.runId), segment(input.executionId));
    if (await gitSucceeds(input.workspaceRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`])) {
      throw new WorktreeError('branch_exists', `branch_exists: ${branchName}`);
    }
    if (existsSync(absolutePath)) throw new WorktreeError('target_exists', 'target_exists: worktree path already exists');
    await mkdir(resolve(this.worktreeRoot, segment(input.workspaceId), segment(input.runId)), { recursive: true });
    const id = randomUUID(); const now = new Date().toISOString();
    const controlled = input.controlledGitContent === true;
    const { controlledGitContent: _controlled, expectedBaseCommit: _expectedBaseCommit, ...identity } = input;
    const record: LeaseRecord = { id, ...identity, branchName, pathLabel: `worktree/${segment(input.workspaceId)}/${segment(input.runId)}/${segment(input.executionId)}`, baseCommit, status: 'creating', createdAt: now, updatedAt: now, absolutePath, workspaceRoot: input.workspaceRoot };
    // Reserve durable identity before Git can create a branch or checkout.
    // Startup reconciliation can then classify any interrupted creation.
    const releaseRequest = this.reserveCreationRequest(record);
    let releaseCapacity = (): void => undefined;
    let context: CollaborationSnapshotGitContext | undefined;
    try {
      this.leases.set(id, record);
      this.persistRecordWithEvent(record, 'worktree.reserved');
      releaseCapacity = await this.waitForCreationCapacity(input);
      context = controlled ? await CollaborationSnapshotGitContext.create(input.workspaceRoot) : undefined;
      if (context) {
        const paths = (await context.sourceMetadata(['ls-tree', '-r', '--name-only', '-z', baseCommit])).toString('utf8').split('\0').filter(Boolean);
        await context.run(['read-tree', baseCommit]);
        await context.freezeCheckoutAttributes(paths);
      }
      await git(input.workspaceRoot, ['worktree', 'add', ...(controlled ? ['--no-checkout'] : []), '-b', branchName, absolutePath, baseCommit], controlled);
      record.status = controlled ? 'creating' : 'active';
      record.updatedAt = new Date().toISOString();
      this.persistRecordWithEvent(record, 'worktree.created', { controlledGitContent: controlled });
      if (context) {
        // Checkout never inherits source filters/hooks. Only the newly owned
        // lease index is populated; the user's index remains untouched.
        await context.run(['checkout-index', '--all', `--prefix=${absolutePath.replaceAll('\\', '/')}/`]);
        await git(absolutePath, ['read-tree', baseCommit], true);
        await context.assertSourceContextUnchanged();
        await this.assertClean(absolutePath, { controlledGitContent: true });
        record.status = 'active'; record.updatedAt = new Date().toISOString();
        this.persistRecordWithEvent(record, 'worktree.activated');
      }
      return publicLease(record);
    } catch (error) {
      const preserved = this.leases.get(id);
      if (preserved) {
        preserved.status = 'failed'; preserved.updatedAt = new Date().toISOString();
        this.persist();
      }
      throw error;
    } finally {
      try { await context?.dispose(); }
      finally {
        try { releaseCapacity(); }
        finally { releaseRequest(); }
      }
    }
  }

  private reserveCreationRequest(record: LeaseRecord): () => void {
    const db = this.transactionDatabase;
    if (db === undefined) return () => undefined;
    const locks = new RuntimeLockRepository(db);
    const ownerId = randomUUID();
    const lockKey = `worktree-request:${record.id}`;
    locks.tryAcquire({
      id: createEntityId('runtimeLock'), lockKey, ownerId, purpose: WORKTREE_REQUEST_LOCK_PURPOSE,
      now: new Date().toISOString(),
      metadata: { leaseId: record.id, processId: process.pid },
    });
    return () => { locks.release(lockKey, ownerId, new Date().toISOString()); };
  }

  private async waitForCreationCapacity(input: CreateInput): Promise<() => void> {
    const limit = this.creationConcurrencyLimit;
    if (limit === undefined) return () => undefined;
    const repository = this.repository;
    if (repository === undefined) {
      while (this.inFlightCreations >= limit) await new Promise<void>(resolve => setTimeout(resolve, 50));
      this.inFlightCreations += 1;
      return () => { this.inFlightCreations = Math.max(0, this.inFlightCreations - 1); };
    }

    const db = repository.transactionDatabase;
    const runtimeLocks = new RuntimeLockRepository(db);
    const ownerId = `worktree-create:${process.pid}:${randomUUID()}`;
    const lockKey = `worktree-creation:${createHash('sha256')
      .update(`${input.workspaceId}\0${input.runId}\0${input.executionId}\0${ownerId}`)
      .digest('hex')}`;
    for (;;) {
      const run = db.prepare('SELECT status FROM runs WHERE workspace_id = ? AND id = ?')
        .get(input.workspaceId, input.runId) as { status: string } | undefined;
      if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) {
        throw new WorktreeError('run_terminal', 'worktree creation stopped because its Run is terminal');
      }
      if (run?.status === 'paused' || run?.status === 'waiting_approval') {
        await new Promise<void>(resolve => setTimeout(resolve, 50));
        continue;
      }
      const acquired = inTransaction(db, () => {
        const now = new Date().toISOString();
        // Recover a crashed creator even without restarting this instance.
        for (const lock of runtimeLocks.listActive(now)) {
          if (lock.purpose === WORKTREE_CAPACITY_LOCK_PURPOSE && !creationProcessIsAlive(lock.metadata?.processId)) {
            runtimeLocks.release(lock.lockKey, lock.ownerId, now);
          }
        }
        const active = runtimeLocks.listActive(now)
          .filter(lock => lock.purpose === WORKTREE_CAPACITY_LOCK_PURPOSE).length;
        if (active >= limit) return false;
        return runtimeLocks.tryAcquire({
          id: createEntityId('runtimeLock'), lockKey, ownerId, purpose: WORKTREE_CAPACITY_LOCK_PURPOSE, now,
          metadata: {
            kind: 'worktree-creation', workspaceId: input.workspaceId, runId: input.runId,
            executionId: input.executionId, processId: process.pid,
          },
        }) !== null;
      });
      if (acquired) {
        return () => {
          inTransaction(db, () => runtimeLocks.release(lockKey, ownerId, new Date().toISOString()));
        };
      }
      // Polling crosses process boundaries: another manager may own the slot,
      // so a local release callback alone cannot wake this accepted request.
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
  }

  private releasePriorProcessCreationReservations(): void {
    const db = this.transactionDatabase;
    if (db === undefined) return;
    inTransaction(db, () => {
      const runtimeLocks = new RuntimeLockRepository(db);
      const now = new Date().toISOString();
      for (const lock of runtimeLocks.listActive(now)) {
        if (lock.purpose !== WORKTREE_CAPACITY_LOCK_PURPOSE && lock.purpose !== WORKTREE_REQUEST_LOCK_PURPOSE) continue;
        if (!creationProcessIsAlive(lock.metadata?.processId)) runtimeLocks.release(lock.lockKey, lock.ownerId, now);
      }
    });
  }

  /**
   * Read-only git-side status snapshot for the control/query API family.
   * Never mutates lease state; git failures are reported as
   * `gitReachable: false` instead of throwing so the caller can surface a
   * degraded-but-honest status view.
   */
  async gitStatusSnapshot(id: string): Promise<WorktreeGitStatus> {
    const record = this.leases.get(id);
    if (!record) throw new WorktreeError('not_found', 'lease not found');
    const snapshot: WorktreeGitStatus = {
      baseCommit: record.baseCommit,
      branch: record.branchName,
      exists: false,
      gitReachable: false,
      dirtyFiles: 0,
      ahead: 0,
      behind: 0,
    };
    let root: string;
    try { root = await realpath(record.absolutePath); } catch { return snapshot; }
    snapshot.exists = true;
    try {
      await access(join(root, '.git'));
      snapshot.head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
      const porcelain = await git(root, ['status', '--porcelain=v1', '-z']);
      snapshot.dirtyFiles = porcelain.split('\0').filter(Boolean).length;
      snapshot.ahead = parseInt((await git(root, ['rev-list', '--count', `${record.baseCommit}..HEAD`])).trim(), 10) || 0;
      snapshot.behind = parseInt((await git(root, ['rev-list', '--count', `HEAD..${record.baseCommit}`])).trim(), 10) || 0;
      snapshot.gitReachable = true;
    } catch { /* unreachable git is reported, not thrown */ }
    return snapshot;
  }

  /**
   * Read-only base→worktree diff with size cap. `truncated` reports when the
   * patch hit `maxBytes`; no lease or git state is modified.
   */
  async diffFromBase(id: string, maxBytes = DEFAULT_DIFF_MAX_BYTES): Promise<WorktreeDiff> {
    const record = this.leases.get(id);
    if (!record) throw new WorktreeError('not_found', 'lease not found');
    const diff: WorktreeDiff = {
      baseCommit: record.baseCommit,
      stat: { filesChanged: 0, insertions: 0, deletions: 0 },
      patch: '',
      patchBytes: 0,
      truncated: false,
    };
    let root: string;
    try { root = await realpath(record.absolutePath); } catch { throw new WorktreeError('worktree_missing', 'worktree directory does not exist'); }
    const numstat = await git(root, ['diff', '--numstat', record.baseCommit]).catch(() => '');
    for (const line of numstat.split('\n')) {
      if (!line.trim()) continue;
      const [added, removed] = line.split('\t');
      diff.stat.filesChanged += 1;
      diff.stat.insertions += /^\d+$/.test(added) ? parseInt(added, 10) : 0;
      diff.stat.deletions += /^\d+$/.test(removed) ? parseInt(removed, 10) : 0;
    }
    let patch = await git(root, ['diff', '--binary', record.baseCommit]);
    if (Buffer.byteLength(patch, 'utf8') > maxBytes) {
      patch = patch.slice(0, patch.length - (Buffer.byteLength(patch, 'utf8') - maxBytes));
      // Never split a UTF-8 multibyte sequence at the cut point.
      while (patch.length && (patch.charCodeAt(patch.length - 1) & 0xc0) === 0x80) patch = patch.slice(0, -1);
      diff.truncated = true;
    }
    diff.patch = patch;
    diff.patchBytes = Buffer.byteLength(patch, 'utf8');
    return diff;
  }

  /**
   * Read-only reconcile report for `POST /worktrees/:id/inspect`. Performs a
   * one-shot directory/.git/scope/consistency check and returns the findings
   * without writing anything (unlike `reconcile()`, which mutates status).
   */
  async inspectReport(id: string): Promise<WorktreeInspectReport> {
    const record = this.leases.get(id);
    if (!record) throw new WorktreeError('not_found', 'lease not found');
    const report: WorktreeInspectReport = {
      leaseId: record.id,
      leaseStatus: record.status,
      checks: { directoryExists: false, gitReachable: false, pathWithinRoot: null, statusConsistent: false },
      consistent: false,
    };
    const configuredRoot = resolve(this.worktreeRoot);
    let realRoot: string;
    try { realRoot = await realpath(configuredRoot); } catch { realRoot = configuredRoot; }
    let actualPath: string | undefined;
    try { actualPath = await realpath(record.absolutePath); } catch { /* missing directory */ }
    if (actualPath) {
      report.checks.directoryExists = true;
      report.checks.pathWithinRoot = isWithin(realRoot, actualPath);
      try {
        await access(join(actualPath, '.git'));
        await git(actualPath, ['rev-parse', '--show-toplevel']);
        report.checks.gitReachable = true;
      } catch { /* unreachable */ }
    }
    const expectedPresent = record.status === 'creating' || record.status === 'active' || record.status === 'completed' || record.status === 'cleanup_pending';
    if (expectedPresent) {
      report.checks.statusConsistent = report.checks.directoryExists && report.checks.gitReachable && report.checks.pathWithinRoot === true;
    } else {
      report.checks.statusConsistent = true;
    }
    report.consistent = Object.values(report.checks).every(value => value !== false);
    return report;
  }

  /**
   * Abandon a lease: mark it `failed` per the lease state machine while
   * deliberately keeping the directory and branch on disk (spec default is
   * preservation; removal goes through the confirmed cleanup path).
   */
  abandonLease(id: string): WorktreeLease {
    const record = this.leases.get(id);
    if (!record) throw new WorktreeError('not_found', 'lease not found');
    if (!['creating', 'active', 'completed', 'cleanup_pending'].includes(record.status)) {
      throw new WorktreeError('state_conflict', `lease status '${record.status}' cannot be abandoned`);
    }
    record.status = 'failed';
    record.updatedAt = new Date().toISOString();
    this.persistRecordWithEvent(record, 'worktree.abandoned');
    return publicLease(record);
  }

  /**
   * Adopt an unmanaged on-disk worktree into lease management. Strict
   * validation: absolute path, realpath inside the managed root, reachable
   * .git, existing branch in the workspace repo, and no duplicate lease by
   * path or branch. A failed adoption never creates a partial record.
   */
  async adoptLease(input: AdoptInput): Promise<WorktreeLease> {
    if (!input || typeof input.path !== 'string' || !isAbsolute(input.path)) throw new WorktreeError('invalid_path', 'adopt requires an absolute worktree path');
    if (typeof input.branchName !== 'string' || !input.branchName.trim() || input.branchName.includes('..') || input.branchName.includes('~') || input.branchName.startsWith('-')) throw new WorktreeError('invalid_branch', 'adopt requires a valid branch name');
    const workspaceId = String(input.workspaceId ?? '');
    const workspaceRoot = String(input.workspaceRoot ?? '');
    if (!workspaceId || !workspaceRoot || !isAbsolute(workspaceRoot)) throw new WorktreeError('invalid_workspace', 'adopt requires a workspace id and absolute workspace root');
    const branchName = input.branchName.trim();
    const configuredRoot = resolve(this.worktreeRoot);
    let realRoot: string;
    try { realRoot = await realpath(configuredRoot); } catch { realRoot = configuredRoot; }
    let actualPath: string;
    try { actualPath = await realpath(input.path); } catch { throw new WorktreeError('path_not_found', 'adopt path does not exist'); }
    if (!isWithin(realRoot, actualPath)) throw new WorktreeError('path_outside_root', 'adopt path is outside the managed worktree root');
    try { await access(join(actualPath, '.git')); } catch { throw new WorktreeError('not_git', 'adopt path is not a git worktree'); }
    try { await git(workspaceRoot, ['rev-parse', '--verify', 'HEAD']); } catch { throw new WorktreeError('not_git', 'workspace is not a Git repository with a HEAD'); }
    if (!(await gitSucceeds(workspaceRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]))) {
      throw new WorktreeError('branch_not_found', `branch '${branchName}' does not exist in the workspace repository`);
    }
    for (const record of this.leases.values()) {
      let existingReal: string | undefined;
      try { existingReal = await realpath(record.absolutePath); } catch { /* gone */ }
      if (existingReal === actualPath) throw new WorktreeError('already_managed', 'a lease already manages this worktree path');
      if (record.workspaceId === workspaceId && record.branchName === branchName) throw new WorktreeError('branch_managed', `branch '${branchName}' is already managed by another lease`);
    }
    const baseCommit = (await git(workspaceRoot, ['merge-base', 'HEAD', branchName])).trim();
    const id = randomUUID(); const now = new Date().toISOString();
    const record: LeaseRecord = {
      id,
      workspaceId,
      runId: String(input.runId ?? ''),
      executionId: String(input.executionId ?? ''),
      agentId: String(input.agentId ?? ''),
      branchName,
      pathLabel: `worktree/adopted/${segment(`${workspaceId}:${actualPath}`)}`,
      baseCommit,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      absolutePath: actualPath,
      workspaceRoot,
    };
    this.leases.set(id, record); this.persistRecordWithEvent(record, 'worktree.activated');
    return publicLease(record);
  }

  getLease(id: string): WorktreeLease | undefined { const record = this.leases.get(id); return record && publicLease(record); }
  getRecord(id: string): LeaseRecord | undefined { return this.leases.get(id); }
  getLegacyImportReport(): LegacyLeaseImportReport { return this.legacyImportReport; }
  recordRuntimeFact(id: string, type: string, payload: Record<string, unknown>): void {
    const record = this.leases.get(id);
    if (!record) throw new WorktreeError('not_found', 'lease not found');
    this.events.emitFact(type, record, payload);
  }
  async preflight(workspaceRoot: string, options: PreflightOptions = {}): Promise<string> { return this.assertClean(workspaceRoot, options); }
  markRecoveryBundleVerified(id: string, bundle?: WorktreeRecoveryBundle): void {
    const record = this.leases.get(id);
    if (!record || !bundle) throw new WorktreeError('not_found', 'lease not found');
    const updated: LeaseRecord = { ...record, recoveryBundle: bundle, status: 'completed', updatedAt: new Date().toISOString() };
    if (this.repository) {
      const db = this.repository.transactionDatabase;
      const persist = () => {
        if (!this.repository!.updateRecoveryBundle(id, bundle, updated.updatedAt)) {
          throw new WorktreeError('not_found', 'lease not found');
        }
        registerAfterCommit(db, () => this.leases.set(id, updated));
      };
      if (isTransactionActive(db)) persist(); else inTransaction(db, persist);
    } else {
      const records = [...this.leases.values()].map(item => item.id === id ? updated : item);
      writeFileSync(this.leaseFile, JSON.stringify(records, null, 2));
      this.leases.set(id, updated);
    }
  }
  listLeases(): WorktreeLease[] { return [...this.leases.values()].map(publicLease); }
  markCleanupPending(id: string): void {
    const record = this.leases.get(id);
    if (!record) throw new WorktreeError('not_found', 'lease not found');
    if (record.status === 'cleaned' || record.status === 'cleanup_pending') return;
    record.status = 'cleanup_pending';
    record.updatedAt = new Date().toISOString();
    this.persistRecord(record);
  }
  markFailedPreserved(id: string): void {
    const record = this.leases.get(id);
    if (!record) throw new WorktreeError('not_found', 'lease not found');
    if (record.status !== 'active' && record.status !== 'creating') return;
    record.status = 'failed';
    record.updatedAt = new Date().toISOString();
    this.persist();
  }
  /**
   * Realpath containment check for git execution inside a lease checkout
   * (used by the merge runtime): the resolved path must stay inside the
   * configured worktree root so a rewritten lease can never redirect git
   * into the user's main workspace.
   */
  async assertManagedCheckout(absolutePath: string): Promise<void> {
    const configuredRoot = resolve(this.worktreeRoot);
    let realRoot: string;
    try { realRoot = await realpath(configuredRoot); } catch { realRoot = configuredRoot; }
    const actualPath = await realpath(absolutePath);
    if (!isWithin(realRoot, actualPath)) throw new WorktreeError('path_escapes_root', 'worktree path escapes configured root');
  }

  /**
   * Prove that an active durable lease still owns the checkout at its path.
   * A clean directory at the same commit is insufficient: it may have been
   * replaced with another repository or detached from the lease branch.
   */
  async assertLeaseOwnership(id: string): Promise<void> {
    const record = this.leases.get(id);
    if (!record) throw new WorktreeError('not_found', 'lease not found');
    if (record.status !== 'active') throw new WorktreeError('lease_ownership_mismatch', 'lease is not active');
    try {
      const expectedBranch = `agentos/run-${segment(record.runId)}-exec-${segment(record.executionId)}`;
      const expectedPath = resolve(this.worktreeRoot, segment(record.workspaceId), segment(record.runId), segment(record.executionId));
      if (record.branchName !== expectedBranch || normalizeManagedPath(record.absolutePath) !== normalizeManagedPath(expectedPath)) {
        throw new Error('durable lease path or branch differs from its stable identity');
      }
      await this.assertManagedCheckout(record.absolutePath);
      const actualPath = await realpath(record.absolutePath);
      const topLevel = await git(actualPath, ['rev-parse', '--show-toplevel'], true);
      if (normalizeManagedPath(await realpath(topLevel.trim())) !== normalizeManagedPath(actualPath)) {
        throw new Error('checkout top-level differs from the leased path');
      }

      const commonDirectory = async (root: string): Promise<string> => {
        const reported = (await git(root, ['rev-parse', '--git-common-dir'], true)).trim();
        if (!reported) throw new Error('git common directory is unavailable');
        return realpath(isAbsolute(reported) ? reported : resolve(root, reported));
      };
      const [expectedCommon, actualCommon] = await Promise.all([
        commonDirectory(record.workspaceRoot),
        commonDirectory(actualPath),
      ]);
      if (normalizeManagedPath(expectedCommon) !== normalizeManagedPath(actualCommon)) {
        throw new Error('checkout Git common directory differs from the lease source');
      }

      const branch = (await git(actualPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)).trim();
      if (branch !== record.branchName) throw new Error('checkout is not attached to the leased branch');

      const entries = await listGitWorktrees(record.workspaceRoot, true);
      const registered = await Promise.all(entries.map(async entry => ({
        ...entry,
        normalizedPath: normalizeManagedPath(await realpath(entry.path).catch(() => resolve(entry.path))),
      })));
      const matchingPath = registered.filter(entry => entry.normalizedPath === normalizeManagedPath(actualPath));
      const matchingBranch = registered.filter(entry => entry.branch === record.branchName);
      if (
        matchingPath.length !== 1
        || matchingPath[0]!.branch !== record.branchName
        || matchingBranch.length !== 1
        || matchingBranch[0]!.normalizedPath !== normalizeManagedPath(actualPath)
      ) {
        throw new Error('checkout registration differs from the durable lease');
      }
    } catch {
      throw new WorktreeError('lease_ownership_mismatch', 'checkout ownership does not match the durable lease');
    }
  }

  /**
   * Startup recovery reconciliation (§52-57).
   *
   * Beyond the legacy directory/.git check, this now reconciles against
   * `git worktree list --porcelain`:
   *  - creating → active when the checkout verifies (emits worktree.activated);
   *  - missing directory → failed (unchanged);
   *  - tracked lease absent from the git registration → reported, no status
   *    change (conservative, §53.2/§53.3 identity is preserved);
   *  - git-registered worktrees inside the managed root with no database
   *    record → `untracked-by-database`, classified orphaned and PRESERVED:
   *    the directory is never deleted and never auto-adopted (§55.1 adopt is
   *    an explicit API), and a worktree.orphaned Event / audit line is
   *    emitted per observation.
   *
   * §57: one worktree.recovery_started Event is emitted per distinct
   * persisted Run scope being scanned.
   */
  async reconcile(workspaceRoots: readonly string[] = []): Promise<WorktreeReconcileReport> {
    this.releasePriorProcessCreationReservations();
    const liveRequests = this.transactionDatabase === undefined ? new Set<unknown>() : new Set(
      new RuntimeLockRepository(this.transactionDatabase).listActive(new Date().toISOString())
        .filter(lock => lock.purpose === WORKTREE_REQUEST_LOCK_PURPOSE)
        .map(lock => lock.metadata?.leaseId),
    );
    const configuredRoot = resolve(this.worktreeRoot);
    let realRoot: string;
    let realRootVerified = false;
    try { realRoot = await realpath(configuredRoot); realRootVerified = true; } catch { realRoot = configuredRoot; }
    const report: WorktreeReconcileReport = { activated: [], failed: [], incompleteCreations: [], missingGitRegistration: [], orphaned: [] };
    const tracked = [...this.leases.values()].filter(record =>
      !liveRequests.has(record.id) && (record.status === 'creating' || record.status === 'active' || record.status === 'cleanup_pending'));

    // §57 recovery_started per distinct (workspace, run) scope, before any scan.
    const scopes = new Map<string, { workspaceId: string; runId: string; scannedCount: number }>();
    for (const record of tracked) {
      const key = `${record.workspaceId}:${record.runId}`;
      const scope = scopes.get(key) ?? { workspaceId: record.workspaceId, runId: record.runId, scannedCount: 0 };
      scope.scannedCount += 1;
      scopes.set(key, scope);
    }

    const activatedRecords: LeaseRecord[] = [];
    const deletedRecords: LeaseRecord[] = [];
    const failedIds = new Set<string>();
    for (const record of tracked) {
      // Cleanup recovery requires separate filesystem and Git-registration
      // evidence. The ordinary missing-directory path marks leases failed;
      // keep cleanup_pending leases out of that transition.
      if (record.status === 'cleanup_pending') continue;
      try {
        const actualPath = await realpath(record.absolutePath);
        if (!isWithin(realRoot, actualPath)) throw new Error('worktree path escapes configured root');
        await access(join(actualPath, '.git'));
      } catch {
        record.status = 'failed';
        report.failed.push(record.id);
        failedIds.add(record.id);
      }
      record.updatedAt = new Date().toISOString();
    }

    // git worktree list --porcelain reconciliation (§52/§53.3).
    const gitEntries = new Map<string, GitWorktreeListEntry[]>();
    const unavailableGitRoots = new Set<string>();
    for (const workspaceRoot of new Set([...workspaceRoots, ...[...this.leases.values()].map(record => record.workspaceRoot)])) {
      try {
        gitEntries.set(workspaceRoot, parseGitWorktreeListPorcelain(await git(workspaceRoot, ['worktree', 'list', '--porcelain'])));
      } catch {
        // Existing reconciliation continues to report unavailable roots as
        // having no entries, but that is not proof that a cleanup completed.
        gitEntries.set(workspaceRoot, []);
        unavailableGitRoots.add(workspaceRoot);
      }
    }
    const canonicalPaths = new Map<string, string>();
    const observedPaths = [...this.leases.values()].map(record => record.absolutePath)
      .concat([...gitEntries.values()].flatMap(entries => entries.map(entry => entry.path)));
    for (const path of observedPaths) {
      canonicalPaths.set(path, await realpath(path).catch(() => resolve(path)));
    }
    const normalizePath = (path: string): string => normalizeManagedPath(canonicalPaths.get(path) ?? path);
    for (const record of tracked) {
      if (failedIds.has(record.id)) continue;
      const entries = gitEntries.get(record.workspaceRoot) ?? [];
      const entry = entries.find(entry => normalizePath(entry.path) === normalizePath(record.absolutePath));
      if (record.status === 'cleanup_pending') {
        if (unavailableGitRoots.has(record.workspaceRoot) || !realRootVerified || !record.recoveryBundle) continue;
        const resolvedCheckout = resolve(record.absolutePath);
        let realCheckoutParent: string;
        try { realCheckoutParent = await realpath(dirname(resolvedCheckout)); }
        catch { continue; }
        if (!isWithin(realRoot, realCheckoutParent)) continue;
        const canonicalCheckout = resolve(realCheckoutParent, basename(resolvedCheckout));
        if (samePath(canonicalCheckout, realRoot) || !isWithin(realRoot, canonicalCheckout)) continue;
        let checkoutExists: boolean;
        try {
          await lstat(record.absolutePath);
          checkoutExists = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
          checkoutExists = false;
        }
        if (!checkoutExists && !entry) {
          // Git removal may have completed before the prior process could
          // commit the cleaned row + deleted Event/Outbox transaction.
          record.status = 'cleaned';
          record.updatedAt = new Date().toISOString();
          deletedRecords.push(record);
          continue;
        }
        if (!entry) report.missingGitRegistration.push(record.id);
        continue;
      }
      if (!entry) {
        report.missingGitRegistration.push(record.id);
      } else if (record.status === 'creating') {
        try {
          if (entry.branch !== record.branchName) throw new Error('registered branch differs from durable lease');
          await this.assertClean(record.absolutePath, { controlledGitContent: true });
          record.status = 'active';
          report.activated.push(record.id);
          activatedRecords.push(record);
        } catch {
          record.status = 'failed';
          report.failed.push(record.id);
          report.incompleteCreations.push(record.id);
        }
      }
    }
    const trackedPaths = new Set([...this.leases.values()].map(record => normalizePath(record.absolutePath)));
    for (const [workspaceRoot, entries] of gitEntries) {
      for (const entry of entries) {
        const entryPath = canonicalPaths.get(entry.path) ?? resolve(entry.path);
        // Only worktrees inside the managed root are ours to classify; the
        // main workspace checkout and external worktrees stay untouched.
        if (!isWithin(realRoot, entryPath)) continue;
        if (trackedPaths.has(normalizePath(entry.path))) continue;
        const orphan: WorktreeOrphanObservation = {
          path: entry.path,
          branch: entry.branch,
          headCommit: entry.headCommit,
          workspaceRoot,
          classification: 'untracked-by-database',
          action: 'preserve',
        };
        report.orphaned.push(orphan);
        this.events.emitOrphan(orphan);
      }
    }

    // Status write-back + lifecycle events in one transaction when a store
    // connection is available (SQLite mode).
    const emitPending = (): void => {
      if (this.repository) {
        for (const record of tracked) this.repository.save(record);
      } else {
        this.persist();
      }
      for (const scope of scopes.values()) {
        this.events.emitRecoveryStarted(scope);
      }
      for (const record of activatedRecords) {
        this.events.emitLeaseEvent('worktree.activated', record);
      }
      for (const record of deletedRecords) {
        this.events.emitLeaseEvent('worktree.deleted', record);
      }
    };
    const db = this.transactionDatabase;
    try {
      if (db && !isTransactionActive(db)) inTransaction(db, emitPending); else emitPending();
    } catch (error) {
      if (this.repository) {
        for (const record of tracked) {
          const persisted = this.repository.getById(record.id);
          if (persisted) this.leases.set(record.id, persisted);
        }
      }
      throw error;
    }
    return report;
  }

  async removeLease(id: string, confirmRecoveryBundle: boolean): Promise<WorktreeLease> {
    const record = this.leases.get(id);
    if (!record) throw new WorktreeError('not_found', 'lease not found');
    if (!confirmRecoveryBundle) throw new WorktreeError('confirmation_required', 'recovery bundle confirmation is required');
    if (!record.recoveryBundle) throw new WorktreeError('bundle_required', 'verified recovery bundle is required');
    if (record.status === 'cleaned') return publicLease(record);

    // Deletion is the most destructive lease operation. Revalidate the
    // recorded checkout immediately before invoking `git worktree remove` so
    // a stale or rewritten lease can never redirect it to the source checkout.
    await this.assertManagedCheckout(record.absolutePath);
    let checkout: string;
    let workspace: string;
    try {
      checkout = await realpath(record.absolutePath);
      workspace = await realpath(record.workspaceRoot);
    } catch {
      throw new WorktreeError('checkout_identity_mismatch', 'managed worktree checkout is unavailable');
    }
    if (samePath(checkout, workspace) || isWithin(checkout, workspace) || isWithin(workspace, checkout)) {
      throw new WorktreeError('checkout_identity_mismatch', 'managed worktree path overlaps the workspace checkout');
    }
    const checkoutRoot = resolve((await git(checkout, ['rev-parse', '--show-toplevel'])).trim());
    const branchName = (await git(checkout, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    if (!samePath(checkoutRoot, checkout) || branchName !== record.branchName) {
      throw new WorktreeError('checkout_identity_mismatch', 'managed worktree path or branch identity changed');
    }
    const workspaceCommonDir = await realpath((await git(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    const checkoutCommonDir = await realpath((await git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    if (!samePath(workspaceCommonDir, checkoutCommonDir)) {
      throw new WorktreeError('checkout_identity_mismatch', 'managed worktree belongs to a different repository');
    }
    const worktrees = (await git(workspace, ['worktree', 'list', '--porcelain']))
      .split(/\r?\n\r?\n/)
      .map(entry => Object.fromEntries(entry.split(/\r?\n/).map(line => {
        const index = line.indexOf(' ');
        return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
      })));
    const registered = worktrees.some(entry => samePath(entry.worktree ?? '', checkout)
      && entry.branch === `refs/heads/${record.branchName}`);
    if (!registered) throw new WorktreeError('checkout_identity_mismatch', 'managed worktree registration changed');

    // Make the destructive operation recoverable before Git removes either
    // the checkout directory or its registration. If the later event/outbox
    // transaction fails, the durable lease remains cleanup_pending.
    const previousStatus = record.status;
    this.markCleanupPending(id);
    try {
      await git(workspace, ['worktree', 'remove', '--force', checkout], true);
    } catch (error) {
      // A failed Git process does not prove that removal had no side effects.
      // Restore the prior terminal status only when the checkout is still a
      // real directory and Git still registers that path on the recorded
      // branch. Otherwise leave cleanup_pending for startup reconciliation.
      let checkoutStillPresentAndRegistered = false;
      try {
        const checkoutStat = await lstat(checkout);
        if (checkoutStat.isDirectory() && !checkoutStat.isSymbolicLink()) {
          const remainingWorktrees = parseGitWorktreeListPorcelain(
            await git(workspace, ['worktree', 'list', '--porcelain']),
          );
          checkoutStillPresentAndRegistered = remainingWorktrees.some(entry => samePath(entry.path, checkout)
            && entry.branch === record.branchName);
        }
      } catch {
        // Missing checkout or unavailable Git evidence is ambiguous; retain
        // cleanup_pending so recovery can reconcile it conservatively.
      }
      if (checkoutStillPresentAndRegistered && record.status === 'cleanup_pending') {
        record.status = previousStatus;
        record.updatedAt = new Date().toISOString();
        this.persistRecord(record);
      }
      throw error;
    }
    record.status = 'cleaned';
    record.updatedAt = new Date().toISOString();
    this.persistRecordWithEvent(record, 'worktree.deleted');
    return publicLease(record);
  }
  private get transactionDatabase(): TransactionDatabase | undefined {
    return this.repository?.transactionDatabase;
  }

  private persistRecord(record: LeaseRecord): void {
    if (!this.repository) {
      this.persist();
      return;
    }
    const save = (): void => this.repository!.save(record);
    try {
      const db = this.transactionDatabase;
      if (db && !isTransactionActive(db)) inTransaction(db, save); else save();
    } catch (error) {
      this.restorePersistedRecord(record.id);
      throw error;
    }
  }

  private restorePersistedRecord(id: string): void {
    if (!this.repository) return;
    const persisted = this.repository.getById(id);
    if (persisted) this.leases.set(id, persisted); else this.leases.delete(id);
  }

  /**
   * Persist one lease row and emit its lifecycle Event through ONE SQLite
   * transaction (Event + Outbox handoff stay atomic with the row write).
   * Legacy JSON mode keeps the original write-then-emit ordering.
   */
  private persistRecordWithEvent(record: LeaseRecord, type: WorktreeLeaseEventType, details?: { readonly reason?: string; readonly controlledGitContent?: boolean }): void {
    const db = this.transactionDatabase;
    if (!this.repository || !db) {
      this.persist();
      this.events.emitLeaseEvent(type, record, details);
      return;
    }
    const run = (): void => {
      this.repository!.save(record);
      this.events.emitLeaseEvent(type, record, details);
    };
    try {
      if (isTransactionActive(db)) run(); else inTransaction(db, run);
    } catch (error) {
      this.restorePersistedRecord(record.id);
      throw error;
    }
  }


  private persist(): void {
    if (this.repository) {
      for (const record of this.leases.values()) this.repository.save(record);
      return;
    }
    try { mkdirSync(this.worktreeRoot, { recursive: true }); writeFileSync(this.leaseFile, JSON.stringify([...this.leases.values()], null, 2), 'utf8'); } catch { /* best effort; active worktree remains recoverable from git */ }
  }
  private async assertClean(root: string, options: PreflightOptions = {}): Promise<string> {
    if (!isAbsolute(root)) throw new WorktreeError('root_not_absolute', 'root_not_absolute: workspace path must be absolute');
    if (isWithin(root, this.worktreeRoot)) throw new WorktreeError('root_inside_workspace', 'root_inside_workspace: worktree root cannot be inside the workspace');
    let initialHead: string;
    try {
      await git(root, ['rev-parse', '--show-toplevel'], options.controlledGitContent);
      if ((await git(root, ['rev-parse', '--is-bare-repository'], options.controlledGitContent)).trim() === 'true') throw new WorktreeError('bare_repository', 'bare_repository: bare repositories are not supported');
      initialHead = (await git(root, ['rev-parse', '--verify', 'HEAD'], options.controlledGitContent)).trim();
    } catch (error) {
      if (error instanceof WorktreeError) throw error;
      throw new WorktreeError('not_git', 'not_git: workspace is not a Git repository with a HEAD');
    }
    if (options.controlledGitContent) {
      const context = await CollaborationSnapshotGitContext.create(root);
      let head: string;
      try {
        head = (await context.sourceMetadata(['rev-parse', 'HEAD'])).toString('utf8').trim();
        if (head !== initialHead) throw new WorktreeError('workspace_changed', 'workspace_changed: HEAD moved before clean preflight snapshot');
        const tree = (await context.sourceMetadata(['ls-tree', '-r', '-z', '--full-tree', head])).toString('utf8');
        const index = (await context.sourceMetadata(['ls-files', '-s', '-z'])).toString('utf8');
        const expected = new Map(tree.split('\0').filter(Boolean).map(row => {
          const tab = row.indexOf('\t'); const [mode, , object] = row.slice(0, tab).split(' ');
          return [row.slice(tab + 1), `${mode} ${object} 0`];
        }));
        const actual = new Map(index.split('\0').filter(Boolean).map(row => {
          const tab = row.indexOf('\t'); return [row.slice(tab + 1), row.slice(0, tab)];
        }));
        if (actual.size !== expected.size || [...expected].some(([path, value]) => actual.get(path) !== value)) {
          throw new WorktreeError('workspace_dirty', 'workspace_dirty: workspace index differs from HEAD');
        }
        await context.assertSourceContextUnchanged();
      } finally { await context.dispose(); }
      if (await isCollaborationWorkspaceClean(root, head)) return head;
      throw new WorktreeError('workspace_dirty', 'workspace_dirty: workspace has uncommitted changes');
    }
    const status = await git(root, ['status', '--porcelain=v1', '-z']);
    if (status.length) throw new WorktreeError('workspace_dirty', 'workspace_dirty: workspace has uncommitted changes');
    const finalHead = (await git(root, ['rev-parse', '--verify', 'HEAD'], options.controlledGitContent)).trim();
    if (finalHead !== initialHead) throw new WorktreeError('workspace_changed', 'workspace_changed: HEAD moved during preflight');
    return initialHead;
  }
}

interface GitWorktreeListEntry {
  readonly path: string;
  readonly headCommit: string | null;
  readonly branch: string | null;
}

function legacyLeaseId(value: unknown): string | undefined {
  return isObjectRecord(value) && typeof value.id === 'string' ? value.id : undefined;
}

function isLegacyLeaseRecord(value: unknown): value is LeaseRecord {
  if (!isObjectRecord(value)) return false;
  for (const field of LEGACY_LEASE_REQUIRED_STRINGS) {
    const fieldValue = value[field];
    if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) return false;
  }
  if (!LEGACY_LEASE_STATUSES.has(value.status as string)) return false;
  if (!isAbsolute(value.absolutePath as string) || !isAbsolute(value.workspaceRoot as string)) return false;
  return value.recoveryBundle === undefined || isLegacyRecoveryBundle(value.recoveryBundle);
}

function isLegacyRecoveryBundle(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return typeof value.trackedPatchArtifactId === 'string' && value.trackedPatchArtifactId.trim().length > 0
    && typeof value.untrackedArchiveArtifactId === 'string' && value.untrackedArchiveArtifactId.trim().length > 0
    && typeof value.manifestArtifactId === 'string' && value.manifestArtifactId.trim().length > 0
    && Number.isSafeInteger(value.entryCount) && (value.entryCount as number) >= 0;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return isObjectRecord(error) && error.code === code;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (hasNodeErrorCode(error, 'SQLITE_CONSTRAINT_UNIQUE') || hasNodeErrorCode(error, 'SQLITE_CONSTRAINT_PRIMARYKEY')) return true;
  return isObjectRecord(error) && typeof error.message === 'string' && /UNIQUE constraint failed/i.test(error.message);
}

/** Parse `git worktree list --porcelain` blocks separated by blank lines. */
export function parseGitWorktreeListPorcelain(output: string): GitWorktreeListEntry[] {
  const entries: GitWorktreeListEntry[] = [];
  let current: { path: string; headCommit: string | null; branch: string | null } | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim(), headCommit: null, branch: null };
      entries.push(current);
    } else if (current && line.startsWith('HEAD ')) {
      current.headCommit = line.slice('HEAD '.length).trim() || null;
    } else if (current && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
  }
  return entries;
}

async function listGitWorktrees(workspaceRoot: string, controlled = false): Promise<GitWorktreeListEntry[]> {
  try {
    return parseGitWorktreeListPorcelain(await git(workspaceRoot, ['worktree', 'list', '--porcelain'], controlled));
  } catch {
    return []; // Unreachable git root: directory checks above still apply.
  }
}

function normalizeManagedPath(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function segment(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0,8); }
function publicLease(record: LeaseRecord): WorktreeLease { const { absolutePath: _path, workspaceRoot: _root, recoveryBundle: _bundle, ...lease } = record; return lease; }
function git(cwd: string, args: string[], controlled = false): Promise<string> {
  const env = { ...process.env };
  if (controlled) for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  const safeArgs = controlled ? ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...args] : args;
  return new Promise((resolvePromise,reject) => execFile('git', safeArgs, { cwd, env, timeout: 10000, windowsHide:true }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}: ${stderr}`)) : resolvePromise(stdout)));
}
function gitSucceeds(cwd: string, args: string[]): Promise<boolean> { return git(cwd, args).then(() => true, () => false); }
function isWithin(root: string, candidate: string): boolean { const child = relative(resolve(root), resolve(candidate)); return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)); }
function samePath(left: string, right: string): boolean {
  const normalize = (path: string): string => process.platform === 'win32' ? resolve(path).toLocaleLowerCase('en-US') : resolve(path);
  return normalize(left) === normalize(right);
}
