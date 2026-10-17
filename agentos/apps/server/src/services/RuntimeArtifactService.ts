import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RuntimeArtifact, RuntimeArtifactType, CanonicalRuntimeArtifactRecord, WorktreeArtifactProvenance } from '@agentos/shared';
import { SqliteStore, type RuntimeArtifactRecord } from '../store/SqliteStore.js';
import { inTransaction } from '../store/Transaction.js';
import { ArtifactCompletionRepository, ArtifactCompletionRepositoryError,
  type ArtifactCompletionConclusion } from '../store/ArtifactCompletionRepository.js';
import { ArtifactCompletionService } from './ArtifactCompletionService.js';
import { withWorktreeBranchLock } from './WorktreeBranchLock.js';
import { WorktreeArtifactBindingRepository, WorktreeArtifactProvenanceError } from '../store/WorktreeArtifactBindingRepository.js';

export interface PreparedWorktreeArtifact {
  readonly id: string;
  readonly worktreeProvenance: WorktreeArtifactProvenance;
  publishWithinTransaction(): RuntimeArtifact | CanonicalRuntimeArtifactRecord;
  discard(): Promise<void>;
}

const artifactExecFile = promisify(execFile);

export type ArtifactContentSource =
  | { kind: 'bytes'; content: Uint8Array }
  | { kind: 'text'; content: string }
  | { kind: 'workspace-file'; absolutePath: string }
  | { kind: 'reference'; originalPath: string };

export interface CreateRuntimeArtifactInput {
  workspaceId: string;
  workspaceRoot: string;
  runId: string;
  sourceExecutionId: string;
  agentId: string;
  type: RuntimeArtifactType;
  title: string;
  summary?: string;
  originalPath?: string;
  mimeType?: string;
  source: ArtifactContentSource;
  /** A typed final result from the real producer; optional for ordinary artifacts. */
  completion?: { conclusion: ArtifactCompletionConclusion; sourceKey: string };
}

const MAX_ARTIFACTS_PER_RUN = 100;
const MAX_BYTES: Record<RuntimeArtifactType, number> = {
  file: 2 * 1024 * 1024,
  diff: 1024 * 1024,
  report: 1024 * 1024,
  log: 1024 * 1024,
  image: 10 * 1024 * 1024,
  archive: 100 * 1024 * 1024,
  manifest: 1024 * 1024,
  review: 1024 * 1024,
  test: 1024 * 1024,
};

export class RuntimeArtifactService {
  readonly artifactRoot: string;

  constructor(private readonly store: SqliteStore, projectRoot: string) {
    this.artifactRoot = join(resolve(projectRoot), '.agentos', 'artifacts');
  }

  async create(input: CreateRuntimeArtifactInput): Promise<RuntimeArtifact> {
    const run = this.store.getRun(input.workspaceId, input.runId);
    const execution = this.store.getExecution(input.workspaceId, input.sourceExecutionId);
    if (!run || !execution || execution.runId !== input.runId || execution.agentId !== input.agentId) {
      throw new Error('Runtime artifact provenance is invalid');
    }
    const title = input.title.trim();
    if (!title) throw new Error('Runtime artifact title is required');
    const originalPath = normalizeOriginalPath(input.originalPath, input.workspaceRoot);
    const source = await this.readSource(input.source, input.workspaceRoot);
    const resolvedOriginalPath = originalPath ?? source.originalPath;
    const bytes = source.bytes;
    const sizeBytes = bytes?.byteLength ?? source.sizeBytes ?? 0;
    if (input.type === 'image' && bytes && !isSupportedRaster(bytes)) throw new Error('Unsupported image artifact format');
    const contentAvailable = Boolean(bytes) && sizeBytes <= MAX_BYTES[input.type];
    const createdAt = new Date().toISOString();
    const findCompleted = (): RuntimeArtifact | undefined => {
      if (!input.completion) return undefined;
      const previous = new ArtifactCompletionRepository(this.store.getDatabase())
        .findBySourceKey(input.workspaceId, input.completion.sourceKey);
      if (previous) {
        const existing = this.store.getRuntimeArtifactRecord(input.workspaceId, previous.artifactId)?.artifact;
        if (!existing || existing.runId !== input.runId || existing.sourceExecutionId !== input.sourceExecutionId ||
          existing.type !== input.type || previous.conclusion !== input.completion.conclusion ||
          !bytes || existing.sha256 !== hash(bytes)) throw new ArtifactCompletionRepositoryError('CONFLICT');
        return existing;
      }
      return undefined;
    };
    if (input.completion) {
      const completed = findCompleted();
      if (completed) return completed;
      if (!contentAvailable || !bytes) throw new ArtifactCompletionRepositoryError('SOURCE_INVALID');
    }
    if (this.store.listRuntimeArtifacts(input.workspaceId, input.runId).length >= MAX_ARTIFACTS_PER_RUN) {
      throw new Error('Runtime artifact limit reached for run');
    }
    const artifactId = randomUUID();
    const summary = contentAvailable
      ? input.summary?.trim() || source.summary
      : input.summary?.trim() || `Artifact content exceeds the ${MAX_BYTES[input.type]} byte limit`;
    const artifact: RuntimeArtifact = {
      id: artifactId,
      workspaceId: input.workspaceId,
      runId: input.runId,
      sourceExecutionId: input.sourceExecutionId,
      agentId: input.agentId,
      type: input.type,
      title,
      ...(summary ? { summary } : {}),
      ...(resolvedOriginalPath ? { originalPath: resolvedOriginalPath } : {}),
      ...(input.mimeType || inferMimeType(title) ? { mimeType: input.mimeType ?? inferMimeType(title) } : {}),
      sizeBytes,
      ...(contentAvailable && bytes ? { sha256: hash(bytes) } : {}),
      contentAvailable,
      createdAt,
    };

    let storageKey: string | null = null;
    let storageDirectory: string | undefined;
    const persist = (key: string | null): void => {
      if (!input.completion) { this.store.createRuntimeArtifact(artifact, key); return; }
      inTransaction(this.store.getDatabase(), () => {
        this.store.createRuntimeArtifact(artifact, key);
        new ArtifactCompletionService(this.store).completeWithinTransaction({ workspaceId: input.workspaceId,
          artifactId, conclusion: input.completion!.conclusion, sourceKey: input.completion!.sourceKey, decidedAt: createdAt });
      });
    };
    if (contentAvailable && bytes) {
      storageKey = join(input.workspaceId, input.runId, artifactId, 'content').replaceAll(sep, '/');
      storageDirectory = join(this.artifactRoot, input.workspaceId, input.runId, artifactId);
      await mkdir(storageDirectory, { recursive: true });
      const temporaryPath = join(storageDirectory, `content.tmp-${randomUUID()}`);
      try {
        await writeFile(temporaryPath, bytes, { flag: 'wx' });
        await rename(temporaryPath, join(storageDirectory, 'content'));
        persist(storageKey);
      } catch (error) {
        await rm(storageDirectory, { recursive: true, force: true });
        // Another completion may have committed while this file was written.
        // Only exact same-producer evidence may converge after the losing insert.
        const winner = findCompleted();
        if (winner) return winner;
        throw error;
      }
    } else {
      persist(null);
    }
    return artifact;
  }

  /** Managed checkout evidence can belong to a canonical Run without a legacy Execution. */
  async createWorktreeArtifact(worktreeId: string, input: CreateRuntimeArtifactInput): Promise<RuntimeArtifact | CanonicalRuntimeArtifactRecord> {
    const lease = this.store.worktreeRepository().getById(worktreeId);
    if (!lease) throw new WorktreeArtifactProvenanceError('WORKTREE_ARTIFACT_PROVENANCE_MISMATCH');
    return withWorktreeBranchLock(lease.absolutePath, lease.branchName,
      () => this.createWorktreeArtifactWithinBranchLock(worktreeId, input));
  }

  /** @internal Caller already holds the lease branch lock. */
  async createWorktreeArtifactWithinBranchLock(worktreeId: string, input: CreateRuntimeArtifactInput): Promise<RuntimeArtifact | CanonicalRuntimeArtifactRecord> {
    const headCommit = await this.readWorktreeHead(input.workspaceRoot);
    const prepared = await this.prepareWorktreeArtifact(worktreeId, input, headCommit);
    try {
      if (await this.readWorktreeHead(input.workspaceRoot) !== headCommit) {
        throw new WorktreeArtifactProvenanceError('WORKTREE_ARTIFACT_HEAD_MISMATCH');
      }
      return this.publishPreparedWorktreeArtifacts([prepared])[0];
    } catch (error) {
      await prepared.discard();
      throw error;
    }
  }

  /** @internal Stage bytes without publishing metadata. Caller owns the branch lock. */
  async prepareWorktreeArtifact(worktreeId: string, input: CreateRuntimeArtifactInput, headCommit: string): Promise<PreparedWorktreeArtifact> {
    const lease = this.store.worktreeRepository().getById(worktreeId);
    if (!lease || lease.workspaceId !== input.workspaceId || lease.runId !== input.runId
      || lease.executionId !== input.sourceExecutionId || lease.agentId !== input.agentId
      || resolve(lease.absolutePath) !== resolve(input.workspaceRoot) || lease.status === 'cleaned'
      || !/^[a-f0-9]{40,64}$/.test(headCommit)) {
      throw new WorktreeArtifactProvenanceError('WORKTREE_ARTIFACT_PROVENANCE_MISMATCH');
    }
    const worktreeProvenance: WorktreeArtifactProvenance = { leaseId: lease.id, workspaceId: lease.workspaceId,
      runId: lease.runId, executionId: lease.executionId, agentId: lease.agentId, baseCommit: lease.baseCommit, headCommit };
    const canonical = Boolean(this.store.runRepository().findById(input.workspaceId, input.runId));
    if (input.completion) throw new Error('Worktree evidence cannot declare review or test completion');
    const title = input.title.trim();
    if (!title) throw new Error('Runtime artifact title is required');
    const source = await this.readSource(input.source, input.workspaceRoot);
    const bytes = source.bytes;
    if (!bytes || bytes.byteLength > MAX_BYTES[input.type]) throw new Error('Worktree artifact content exceeds its byte limit');
    if (input.type === 'image' && !isSupportedRaster(bytes)) throw new Error('Unsupported image artifact format');
    const id = randomUUID();
    const storageKey = `worktree-evidence/${id}/content`;
    const directory = join(this.artifactRoot, 'worktree-evidence', id);
    const createdAt = new Date().toISOString();
    const metadata: RuntimeArtifact = { id, workspaceId: input.workspaceId, runId: input.runId,
      sourceExecutionId: input.sourceExecutionId, agentId: input.agentId, type: input.type, title,
      summary: input.summary?.trim() || source.summary,
      originalPath: normalizeOriginalPath(input.originalPath, input.workspaceRoot) ?? source.originalPath,
      mimeType: input.mimeType ?? inferMimeType(title), sizeBytes: bytes.byteLength,
      sha256: hash(bytes), contentAvailable: true, createdAt, worktreeProvenance };
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(join(directory, 'content'), bytes, { flag: 'wx' });
      return { id, worktreeProvenance, discard: () => rm(directory, { recursive: true, force: true }),
        publishWithinTransaction: () => {
          if (this.listForRun(input.workspaceId, input.runId).length >= MAX_ARTIFACTS_PER_RUN) {
            throw new Error('Runtime artifact limit reached for run');
          }
          const current = this.store.worktreeRepository().getById(worktreeId);
          if (!current || resolve(current.absolutePath) !== resolve(lease.absolutePath)
            || current.branchName !== lease.branchName || current.status === 'cleaned') {
            throw new WorktreeArtifactProvenanceError('WORKTREE_ARTIFACT_PROVENANCE_MISMATCH');
          }
          if (canonical) this.store.createCanonicalRuntimeArtifact(metadata, { kind: 'CANONICAL', canonicalRunId: input.runId }, storageKey);
          else this.store.createRuntimeArtifact(metadata, storageKey);
          new WorktreeArtifactBindingRepository(this.store.getDatabase()).insertWithinTransaction(id, worktreeProvenance, createdAt);
          return canonical ? { ...this.store.getCanonicalRuntimeArtifactRecord(input.workspaceId, id)!, worktreeProvenance } : metadata;
        },
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  publishPreparedWorktreeArtifacts(items: readonly PreparedWorktreeArtifact[], afterPersist?: () => void): Array<RuntimeArtifact | CanonicalRuntimeArtifactRecord> {
    return inTransaction(this.store.getDatabase(), () => {
      const artifacts = items.map(item => item.publishWithinTransaction());
      afterPersist?.();
      return artifacts;
    });
  }

  async readWorktreeHead(worktreePath: string): Promise<string> {
    return (await artifactExecFile('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, timeout: 10000, windowsHide: true })).stdout.trim();
  }

  requireWorktreeProvenance(worktreeId: string, artifactId: string, expectedHeadCommit?: string): WorktreeArtifactProvenance {
    const lease = this.store.worktreeRepository().getById(worktreeId);
    if (!lease) throw new WorktreeArtifactProvenanceError('WORKTREE_ARTIFACT_PROVENANCE_MISMATCH');
    const binding = new WorktreeArtifactBindingRepository(this.store.getDatabase()).find(lease.workspaceId, artifactId);
    if (!binding) throw new WorktreeArtifactProvenanceError('WORKTREE_ARTIFACT_PROVENANCE_MISSING');
    if (binding.leaseId !== lease.id || binding.workspaceId !== lease.workspaceId || binding.runId !== lease.runId
      || binding.executionId !== lease.executionId || binding.agentId !== lease.agentId || binding.baseCommit !== lease.baseCommit) {
      throw new WorktreeArtifactProvenanceError('WORKTREE_ARTIFACT_PROVENANCE_MISMATCH');
    }
    if (expectedHeadCommit !== undefined && binding.headCommit !== expectedHeadCommit) {
      throw new WorktreeArtifactProvenanceError('WORKTREE_ARTIFACT_HEAD_MISMATCH');
    }
    return binding;
  }

  listForWorktree(worktreeId: string): Array<RuntimeArtifact | CanonicalRuntimeArtifactRecord> {
    const lease = this.store.worktreeRepository().getById(worktreeId);
    if (!lease) return [];
    return this.listForRun(lease.workspaceId, lease.runId).filter(artifact => {
      try { this.requireWorktreeProvenance(worktreeId, artifact.id); return true; } catch { return false; }
    });
  }

  async createCanonicalCompleted(input: {
    workspaceId: string; runId: string; stageId: string; stageAttempt: number; operationId: string; agentId: string;
    type: 'review' | 'test'; conclusion: ArtifactCompletionConclusion; summary: string; sourceKey: string;
  }): Promise<CanonicalRuntimeArtifactRecord> {
    const db = this.store.getDatabase();
    const bytes = Buffer.from(input.summary, 'utf8');
    if (bytes.byteLength < 1 || bytes.byteLength > 8192) throw new ArtifactCompletionRepositoryError('INPUT_INVALID');
    const lookup = (): CanonicalRuntimeArtifactRecord | undefined => {
      const previous = new ArtifactCompletionRepository(db).findBySourceKey(input.workspaceId, input.sourceKey);
      if (!previous) return undefined;
      const artifact = this.store.getCanonicalRuntimeArtifactRecord(input.workspaceId, previous.artifactId);
      if (!artifact || artifact.canonicalRunId !== input.runId || artifact.sourceStageId !== input.stageId ||
          artifact.sourceOperationId !== input.operationId || artifact.agentId !== input.agentId ||
          artifact.type !== input.type || previous.conclusion !== input.conclusion || artifact.sha256 !== hash(bytes)) {
        throw new ArtifactCompletionRepositoryError('CONFLICT');
      }
      return artifact;
    };
    const existing = lookup();
    if (existing) return existing;
    const assertCurrentSource = (): void => {
      if (!Number.isSafeInteger(input.stageAttempt) || input.stageAttempt < 1 ||
        !db.prepare(`SELECT s.id FROM run_stages s JOIN runs r ON r.id = s.run_id
          WHERE s.id = ? AND s.run_id = ? AND s.workspace_id = ? AND r.workspace_id = ?
            AND s.attempt = ? AND s.status = 'running' AND r.status = 'running'`)
          .get(input.stageId, input.runId, input.workspaceId, input.workspaceId, input.stageAttempt)) {
        throw new ArtifactCompletionRepositoryError('SOURCE_INVALID');
      }
    };
    assertCurrentSource();
    const id = randomUUID();
    // Canonical IDs have durable provenance checks below; generated directory
    // name means a caller-provided Run/Workspace is never a filesystem path.
    const storageKey = `canonical-results/${id}/content`;
    const directory = join(this.artifactRoot, 'canonical-results', id);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(join(directory, 'content'), bytes, { flag: 'wx' });
      const now = new Date().toISOString();
      inTransaction(db, () => {
        // File I/O yielded: a cancel/retry may have invalidated this attempt.
        assertCurrentSource();
        this.store.createCanonicalRuntimeArtifact({ id, workspaceId: input.workspaceId, agentId: input.agentId,
          type: input.type, title: `${input.type} result`, summary: input.conclusion,
          sizeBytes: bytes.byteLength, sha256: hash(bytes), contentAvailable: true,
          mimeType: 'text/plain', createdAt: now },
        { kind: 'CANONICAL', canonicalRunId: input.runId, sourceStageId: input.stageId, sourceOperationId: input.operationId }, storageKey);
        new ArtifactCompletionService(this.store).completeWithinTransaction({ workspaceId: input.workspaceId,
          artifactId: id, sourceKey: input.sourceKey, conclusion: input.conclusion, decidedAt: now });
      });
      return this.store.getCanonicalRuntimeArtifactRecord(input.workspaceId, id)!;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      const winner = lookup();
      if (winner) return winner;
      throw error;
    }
  }

  getContentRecord(workspaceId: string, artifactId: string): {
    record: RuntimeArtifactRecord | { artifact: CanonicalRuntimeArtifactRecord; storageKey: string | null }; path: string;
  } | undefined {
    const legacy = this.store.getRuntimeArtifactRecord(workspaceId, artifactId);
    const canonical = legacy ? undefined : this.store.getCanonicalRuntimeArtifactRecord(workspaceId, artifactId);
    const record = legacy ?? (canonical ? { artifact: canonical, storageKey: canonical.storageKey } : undefined);
    if (!record || !record.artifact.contentAvailable || !record.storageKey) return record ? { record, path: '' } : undefined;
    const path = resolve(this.artifactRoot, record.storageKey);
    if (!isWithin(this.artifactRoot, path)) throw new Error('Artifact storage path escapes artifact root');
    if (!existsSync(path)) return { record, path: '' };
    if (!isWithin(this.artifactRoot, realpathSync(path))) throw new Error('Artifact storage path escapes artifact root');
    return { record, path };
  }

  async readContentBytes(workspaceId: string, artifactId: string): Promise<Buffer> {
    const content = this.getContentRecord(workspaceId, artifactId);
    if (!content?.record.artifact.contentAvailable || !content.path || !content.record.artifact.sha256) {
      throw new Error('Artifact content is unavailable');
    }
    const bytes = await readFile(content.path);
    if (bytes.byteLength !== content.record.artifact.sizeBytes || hash(bytes) !== content.record.artifact.sha256) {
      throw new Error('Artifact content hash verification failed');
    }
    return bytes;
  }

  /** Read-only listing channel for the worktree control API (diff/bundle/inspect views). */
  listForRun(workspaceId: string, runId: string): Array<RuntimeArtifact | CanonicalRuntimeArtifactRecord> {
    if (!runId) return [];
    const bindings = new WorktreeArtifactBindingRepository(this.store.getDatabase());
    return [...this.store.listRuntimeArtifacts(workspaceId, runId), ...this.store.listCanonicalRuntimeArtifacts(workspaceId, runId)]
      .map(artifact => { const provenance = bindings.find(workspaceId, artifact.id);
        return provenance ? { ...artifact, worktreeProvenance: provenance } : artifact; });
  }

  async cleanupConversation(workspaceId: string, conversationId: string): Promise<void> {
    const runs = this.store.listRuns(workspaceId, conversationId, 1_000_000);
    for (const run of runs) {
      for (const artifact of this.store.listRuntimeArtifacts(workspaceId, run.id)) {
        const record = this.store.getRuntimeArtifactRecord(workspaceId, artifact.id);
        if (record?.storageKey) await rm(resolve(this.artifactRoot, record.storageKey, '..'), { recursive: true, force: true });
        this.store.deleteRuntimeArtifact(workspaceId, artifact.id);
      }
    }
  }

  async deleteRuns(workspaceId: string, runIds: string[]): Promise<{ deletedArtifacts: number; bytes: number }> {
    let deletedArtifacts = 0;
    let bytes = 0;
    for (const runId of [...new Set(runIds)]) {
      const artifacts = this.store.listRuntimeArtifacts(workspaceId, runId);
      for (const artifact of artifacts) {
        const record = this.store.getRuntimeArtifactRecord(workspaceId, artifact.id);
        if (record?.storageKey) {
          const artifactDirectory = resolve(this.artifactRoot, record.storageKey, '..');
          if (!isWithin(this.artifactRoot, artifactDirectory)) throw new Error('Artifact storage path escapes artifact root');
          await rm(artifactDirectory, { recursive: true, force: true });
        }
        bytes += artifact.sizeBytes;
        deletedArtifacts += 1;
      }
      this.store.deleteRunData(workspaceId, runId);
    }
    return { deletedArtifacts, bytes };
  }

  private async readSource(source: ArtifactContentSource, workspaceRoot: string): Promise<{ bytes?: Buffer; originalPath?: string; sizeBytes?: number; summary?: string }> {
    if (source.kind === 'bytes') return { bytes: Buffer.from(source.content) };
    if (source.kind === 'text') return { bytes: Buffer.from(source.content, 'utf8') };
    if (source.kind === 'reference') return { originalPath: normalizeOriginalPath(source.originalPath, workspaceRoot) };
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(source.absolutePath);
    } catch {
      const workspaceRealPath = await realpath(workspaceRoot);
      const relativePath = relative(workspaceRealPath, resolve(source.absolutePath));
      return { originalPath: normalizeOriginalPath(relativePath, workspaceRoot), summary: 'Source file is no longer present' };
    }
    const workspaceRealPath = await realpath(workspaceRoot);
    if (!isWithin(workspaceRealPath, resolvedPath)) throw new Error('Artifact source file is outside workspace path');
    const bytes = await readFile(resolvedPath);
    return { bytes, originalPath: relative(workspaceRealPath, resolvedPath).replaceAll(sep, '/') };
  }
}

function normalizeOriginalPath(value: string | undefined, workspaceRoot: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.replaceAll('\\', '/');
  if (isAbsolute(value) || normalized === '..' || normalized.startsWith('../') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error('Artifact workspace path is invalid');
  }
  const resolved = resolve(workspaceRoot, normalized);
  if (!isWithin(resolve(workspaceRoot), resolved)) throw new Error('Artifact workspace path is invalid');
  return relative(resolve(workspaceRoot), resolved).replaceAll(sep, '/') || '.';
}

function isWithin(root: string, candidate: string): boolean {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const relativePath = relative(rootResolved, candidateResolved);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isSupportedRaster(bytes: Buffer): boolean {
  return (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    || (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    || (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    || (bytes.length >= 6 && (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a'));
}

function inferMimeType(title: string): string | undefined {
  switch (extname(title).toLowerCase()) {
    case '.ts': return 'text/typescript';
    case '.tsx': return 'text/tsx';
    case '.js': return 'text/javascript';
    case '.json': return 'application/json';
    case '.md': return 'text/markdown';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return undefined;
  }
}
