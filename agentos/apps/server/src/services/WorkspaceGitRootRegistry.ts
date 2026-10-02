import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import type { WorktreeManager } from './WorktreeManager.js';

const execFileAsync = promisify(execFile);
const FORMAT = 'agentos-workspace-git-roots';
const FORMAT_VERSION = 1;

type Database = {
  prepare(sql: string): {
    all(...parameters: unknown[]): unknown[];
    get(...parameters: unknown[]): unknown;
  };
};

interface PersistedMappings {
  readonly format: typeof FORMAT;
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly workspaces: Readonly<Record<string, string>>;
}

interface CandidateBase {
  readonly id: string;
  readonly base_commit: string;
  readonly task_base_commit: string;
  readonly diff_hash: string;
  readonly diff_text: string;
  readonly manifest_json: string;
}

export interface WorkspaceGitRootStatus {
  readonly workspaceId: string;
  readonly explicitlyReconnected: boolean;
  readonly repository: 'ready' | 'unavailable' | 'invalid';
  readonly canReview: boolean;
  readonly canApply: boolean;
  readonly headCommit?: string;
  readonly activeCandidateCount: number;
  readonly candidatesAtCurrentBase: number;
  readonly missingCandidateObjects: number;
  readonly recoveryRequired: number;
  readonly reasonCode?: string;
}

export class WorkspaceGitRootError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WorkspaceGitRootError';
  }
}

/** Host-local Git reconnection metadata. It is intentionally outside the portable backup inventory. */
export class WorkspaceGitRootRegistry {
  private readonly mappingPath: string;
  private readonly mappings = new Map<string, string>();
  private invalidMapping = false;
  private readonly database: Database;

  constructor(
    dataRoot: string,
    store: SqliteStore,
    private readonly workspaces: WorkspaceManager,
    private readonly worktrees: WorktreeManager,
  ) {
    this.mappingPath = join(resolve(dataRoot), '.agentos-workspace-git-roots.json');
    this.database = store.getDatabase() as unknown as Database;
    this.loadMappings();
  }

  /** Runtime/Git callers use the explicit mapping; content and memory routes keep Workspace.rootPath. */
  rootPathFor(workspaceId: string): string | undefined {
    return this.mappings.get(workspaceId) ?? this.workspaces.get(workspaceId)?.rootPath;
  }

  async status(workspaceId: string): Promise<WorkspaceGitRootStatus> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new WorkspaceGitRootError('WORKSPACE_NOT_FOUND');
    if (this.invalidMapping) return emptyStatus(workspaceId, this.mappings.has(workspaceId), 'WORKSPACE_GIT_MAPPING_INVALID');
    const root = this.rootPathFor(workspaceId);
    if (!root) return emptyStatus(workspaceId, false, 'WORKSPACE_GIT_ROOT_UNAVAILABLE');
    try {
      return await this.inspectRoot(workspaceId, root, this.mappings.has(workspaceId));
    } catch (error) {
      const code = error instanceof WorkspaceGitRootError ? error.code : 'WORKSPACE_GIT_ROOT_UNAVAILABLE';
      return emptyStatus(workspaceId, this.mappings.has(workspaceId), code);
    }
  }

  async check(workspaceId: string, requestedRoot: string): Promise<WorkspaceGitRootStatus> {
    if (!this.workspaces.get(workspaceId)) throw new WorkspaceGitRootError('WORKSPACE_NOT_FOUND');
    if (this.invalidMapping) throw new WorkspaceGitRootError('WORKSPACE_GIT_MAPPING_INVALID');
    const inspected = await this.inspectRoot(workspaceId, requestedRoot, this.mappings.has(workspaceId));
    return inspected;
  }

  async reconnect(workspaceId: string, requestedRoot: string): Promise<WorkspaceGitRootStatus> {
    const checked = await this.check(workspaceId, requestedRoot);
    if (checked.repository !== 'ready') throw new WorkspaceGitRootError(checked.reasonCode ?? 'WORKSPACE_GIT_ROOT_UNAVAILABLE');
    const root = await realpath(requestedRoot);
    const next = new Map(this.mappings);
    next.set(workspaceId, root);
    await this.persist(next);
    this.mappings.clear();
    for (const [id, path] of next) this.mappings.set(id, path);
    return this.inspectRoot(workspaceId, root, true);
  }

  private async inspectRoot(workspaceId: string, requestedRoot: string, explicitlyReconnected: boolean): Promise<WorkspaceGitRootStatus> {
    if (!isAbsolute(requestedRoot)) throw new WorkspaceGitRootError('WORKSPACE_GIT_ROOT_NOT_ABSOLUTE');
    const info = await lstat(requestedRoot).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new WorkspaceGitRootError('WORKSPACE_GIT_ROOT_UNAVAILABLE');
    const root = await realpath(requestedRoot);
    let topLevel: string;
    let headCommit: string;
    try {
      const top = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      topLevel = await realpath(top.stdout.trim());
      if (!samePath(root, topLevel)) throw new WorkspaceGitRootError('WORKSPACE_GIT_ROOT_MUST_BE_REPOSITORY_ROOT');
      const bare = await execFileAsync('git', ['rev-parse', '--is-bare-repository'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      if (bare.stdout.trim() !== 'false') throw new WorkspaceGitRootError('WORKSPACE_GIT_ROOT_UNAVAILABLE');
      const head = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      headCommit = head.stdout.trim().toLowerCase();
    } catch (error) {
      if (error instanceof WorkspaceGitRootError) throw error;
      throw new WorkspaceGitRootError('WORKSPACE_GIT_ROOT_UNAVAILABLE');
    }
    await this.worktrees.preflight(root, { controlledGitContent: true }).catch(() => {
      throw new WorkspaceGitRootError('WORKSPACE_GIT_ROOT_NOT_CLEAN');
    });

    const candidates = this.activeCandidates(workspaceId);
    let candidatesAtCurrentBase = 0;
    let missingCandidateObjects = 0;
    for (const candidate of candidates) {
      if (sha(candidate.diff_text) !== candidate.diff_hash || !validCandidateManifest(candidate.manifest_json)) {
        throw new WorkspaceGitRootError('WORKSPACE_CANDIDATE_PAYLOAD_INVALID');
      }
      if (candidate.base_commit !== candidate.task_base_commit) continue;
      let objectAvailable = false;
      try {
        await execFileAsync('git', ['cat-file', '-e', `${candidate.base_commit}^{commit}`], {
          cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000,
        });
        objectAvailable = true;
      } catch { /* checked below as an unavailable frozen base */ }
      if (!objectAvailable) missingCandidateObjects += 1;
      if (candidate.base_commit.toLowerCase() === headCommit && objectAvailable) candidatesAtCurrentBase += 1;
    }
    const recoveryRequired = this.recoveryRequiredCount(workspaceId);
    const allCandidatesReady = candidatesAtCurrentBase === candidates.length && missingCandidateObjects === 0;
    return {
      workspaceId,
      explicitlyReconnected,
      repository: 'ready',
      canReview: allCandidatesReady,
      canApply: allCandidatesReady && recoveryRequired === 0,
      headCommit,
      activeCandidateCount: candidates.length,
      candidatesAtCurrentBase,
      missingCandidateObjects,
      recoveryRequired,
      ...(!allCandidatesReady ? { reasonCode: 'WORKSPACE_CANDIDATE_BASE_MISMATCH' } : recoveryRequired > 0
        ? { reasonCode: 'WORKSPACE_RECOVERY_REQUIRED' } : {}),
    };
  }

  private activeCandidates(workspaceId: string): CandidateBase[] {
    if (!tableExists(this.database, 'collaboration_candidates') || !tableExists(this.database, 'collaboration_tasks')) return [];
    return this.database.prepare(`SELECT c.id,c.base_commit,c.diff_hash,c.diff_text,c.manifest_json,t.base_commit AS task_base_commit
      FROM collaboration_candidates c JOIN collaboration_tasks t
        ON t.workspace_id=c.workspace_id AND t.id=c.collaboration_task_id
      WHERE c.workspace_id=? AND c.status IN ('created','reviewed') ORDER BY c.id`).all(workspaceId) as CandidateBase[];
  }

  private recoveryRequiredCount(workspaceId: string): number {
    if (!tableExists(this.database, 'collaboration_controls')) return 0;
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM collaboration_controls WHERE workspace_id=? AND state='recovery_required'")
      .get(workspaceId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private loadMappings(): void {
    let text: string;
    try { text = requireRead(this.mappingPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.invalidMapping = true;
      return;
    }
    try {
      const parsed = JSON.parse(text) as PersistedMappings;
      if (parsed.format !== FORMAT || parsed.formatVersion !== FORMAT_VERSION || !parsed.workspaces
        || typeof parsed.workspaces !== 'object' || Array.isArray(parsed.workspaces)) throw new Error('invalid mapping');
      for (const [id, path] of Object.entries(parsed.workspaces)) {
        if (!validWorkspaceId(id) || typeof path !== 'string' || !isAbsolute(path)) throw new Error('invalid mapping');
        this.mappings.set(id, resolve(path));
      }
    } catch { this.invalidMapping = true; this.mappings.clear(); }
  }

  private async persist(mappings: ReadonlyMap<string, string>): Promise<void> {
    const parent = dirname(this.mappingPath);
    await mkdir(parent, { recursive: true });
    const existing = await lstat(this.mappingPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new WorkspaceGitRootError('WORKSPACE_GIT_MAPPING_UNAVAILABLE');
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new WorkspaceGitRootError('WORKSPACE_GIT_MAPPING_UNAVAILABLE');
    const temporary = `${this.mappingPath}.tmp-${randomUUID()}`;
    const document: PersistedMappings = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      workspaces: Object.fromEntries([...mappings.entries()].sort(([left], [right]) => left.localeCompare(right))),
    };
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.mappingPath);
    } catch {
      throw new WorkspaceGitRootError('WORKSPACE_GIT_MAPPING_UNAVAILABLE');
    }
  }
}

function requireRead(path: string): string {
  // Kept synchronous so dispatch resolvers never observe partially loaded maps.
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new WorkspaceGitRootError('WORKSPACE_GIT_MAPPING_INVALID');
  return readFileSync(path, 'utf8');
}

function emptyStatus(workspaceId: string, explicitlyReconnected: boolean, reasonCode: string): WorkspaceGitRootStatus {
  return {
    workspaceId, explicitlyReconnected, repository: reasonCode.includes('INVALID') ? 'invalid' : 'unavailable',
    canReview: false, canApply: false, activeCandidateCount: 0, candidatesAtCurrentBase: 0,
    missingCandidateObjects: 0, recoveryRequired: 0, reasonCode,
  };
}

function validCandidateManifest(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every(item => item && typeof item === 'object'
      && typeof (item as Record<string, unknown>).path === 'string'
      && Number.isSafeInteger((item as Record<string, unknown>).sizeBytes)
      && (item as Record<string, unknown>).sizeBytes as number >= 0
      && typeof (item as Record<string, unknown>).sha256 === 'string'
      && /^[a-f0-9]{64}$/u.test((item as Record<string, unknown>).sha256 as string));
  } catch { return false; }
}

function tableExists(database: Database, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function samePath(left: string, right: string): boolean {
  const normalize = (path: string) => resolve(path).replace(/[\\/]+$/u, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function validWorkspaceId(value: string): boolean {
  return value.length > 0 && value.length <= 160 && /^[\w.-]+$/u.test(value) && value !== '.' && value !== '..';
}
