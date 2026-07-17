import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RuntimeArtifact, RuntimeArtifactType } from '@agentos/shared';
import { SqliteStore, type RuntimeArtifactRecord } from '../store/SqliteStore.js';

export type ArtifactContentSource =
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
}

const MAX_ARTIFACTS_PER_RUN = 100;
const MAX_BYTES: Record<RuntimeArtifactType, number> = {
  file: 2 * 1024 * 1024,
  diff: 1024 * 1024,
  report: 1024 * 1024,
  log: 1024 * 1024,
  image: 10 * 1024 * 1024,
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
    if (this.store.listRuntimeArtifacts(input.workspaceId, input.runId).length >= MAX_ARTIFACTS_PER_RUN) {
      throw new Error('Runtime artifact limit reached for run');
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
    if (contentAvailable && bytes) {
      storageKey = join(input.workspaceId, input.runId, artifactId, 'content').replaceAll(sep, '/');
      storageDirectory = join(this.artifactRoot, input.workspaceId, input.runId, artifactId);
      await mkdir(storageDirectory, { recursive: true });
      const temporaryPath = join(storageDirectory, `content.tmp-${randomUUID()}`);
      try {
        await writeFile(temporaryPath, bytes, { flag: 'wx' });
        await rename(temporaryPath, join(storageDirectory, 'content'));
        this.store.createRuntimeArtifact(artifact, storageKey);
      } catch (error) {
        await rm(storageDirectory, { recursive: true, force: true });
        throw error;
      }
    } else {
      this.store.createRuntimeArtifact(artifact, null);
    }
    return artifact;
  }

  getContentRecord(workspaceId: string, artifactId: string): { record: RuntimeArtifactRecord; path: string } | undefined {
    const record = this.store.getRuntimeArtifactRecord(workspaceId, artifactId);
    if (!record || !record.artifact.contentAvailable || !record.storageKey) return record ? { record, path: '' } : undefined;
    const path = resolve(this.artifactRoot, record.storageKey);
    if (!isWithin(this.artifactRoot, path)) throw new Error('Artifact storage path escapes artifact root');
    if (!existsSync(path)) return { record, path: '' };
    if (!isWithin(this.artifactRoot, realpathSync(path))) throw new Error('Artifact storage path escapes artifact root');
    return { record, path };
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

  private async readSource(source: ArtifactContentSource, workspaceRoot: string): Promise<{ bytes?: Buffer; originalPath?: string; sizeBytes?: number; summary?: string }> {
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
