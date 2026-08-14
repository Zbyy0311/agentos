import { createHash } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';

/**
 * M4-P2B restricted append-only artifact sink.
 *
 * Raw stdout/stderr bytes never enter the relational database; they live in
 * this managed append-only sink keyed by artifact_id/storage_key. The DB
 * holds only references (artifact_id, storage_key, counters, sha256 over the
 * retained-byte concatenation). Bytes reaching the sink must already be
 * redacted by the P1 SecretScanner pipeline (scan mode) or strictly safe
 * (strict mode); this module enforces the append-only and storage-boundary
 * invariants, not the scanning policy.
 */

export interface ArtifactFinalizeResult {
  readonly sha256: string;
  readonly retainedBytes: number;
}

export interface ArtifactWriteSession {
  readonly artifactId: string;
  readonly storageKey: string;
  /** Append already-redacted bytes; never called after finalize/abort. */
  append(bytes: Uint8Array): Promise<void>;
  finalize(): Promise<ArtifactFinalizeResult>;
  abort(): Promise<void>;
}

export interface RestrictedArtifactSink {
  open(artifactId: string, storageKey: string): Promise<ArtifactWriteSession>;
}

export class RestrictedStorageKeyError extends Error {
  readonly code = 'RESTRICTED_STORAGE_KEY_INVALID' as const;

  constructor(message = 'RESTRICTED_STORAGE_KEY_INVALID') {
    super(message);
    this.name = 'RestrictedStorageKeyError';
  }
}

const STORAGE_KEY = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

function assertSafeStorageKey(storageKey: string, root: string): string {
  if (typeof storageKey !== 'string' || storageKey.length === 0) {
    throw new RestrictedStorageKeyError('RESTRICTED_STORAGE_KEY_INVALID: storageKey is required');
  }
  if (storageKey.includes('\u0000') || !STORAGE_KEY.test(storageKey)) {
    throw new RestrictedStorageKeyError('RESTRICTED_STORAGE_KEY_INVALID: unsafe storage key characters');
  }
  const segments = storageKey.split('/');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new RestrictedStorageKeyError('RESTRICTED_STORAGE_KEY_INVALID: unsafe storage key segment');
    }
  }
  const resolved = resolve(join(root, ...segments));
  const normalizedRoot = normalize(resolve(root));
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep)) {
    throw new RestrictedStorageKeyError('RESTRICTED_STORAGE_KEY_INVALID: storageKey escapes the sink root');
  }
  return segments.join('/');
}

class FileArtifactWriteSession implements ArtifactWriteSession {
  readonly #handle: Awaited<ReturnType<typeof open>>;
  readonly #hash = createHash('sha256');
  #retainedBytes = 0;
  #closed = false;

  constructor(
    readonly artifactId: string,
    readonly storageKey: string,
    private readonly path: string,
    handle: Awaited<ReturnType<typeof open>>,
  ) {
    this.#handle = handle;
  }

  async append(bytes: Uint8Array): Promise<void> {
    if (this.#closed) {
      throw new Error('RESTRICTED_SINK_CLOSED: append after finalize/abort is forbidden');
    }
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) return;
    await this.#handle.write(bytes);
    this.#hash.update(bytes);
    this.#retainedBytes += bytes.length;
  }

  async finalize(): Promise<ArtifactFinalizeResult> {
    if (this.#closed) {
      throw new Error('RESTRICTED_SINK_CLOSED: finalize after close is forbidden');
    }
    this.#closed = true;
    await this.#handle.sync();
    await this.#handle.close();
    return { sha256: this.#hash.digest('hex'), retainedBytes: this.#retainedBytes };
  }

  async abort(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#handle.close();
    } finally {
      // Compensation: remove the partial artifact so no half-written file
      // becomes visible to readers.
      await rm(this.path, { force: true });
    }
  }
}

/**
 * File-backed restricted sink rooted at a dedicated directory. Each
 * artifact is a single append-only file created with an exclusive flag
 * (never an overwrite); storage keys are validated to stay inside the root.
 */
export class FileArtifactSink implements RestrictedArtifactSink {
  constructor(private readonly root: string) {
    if (typeof root !== 'string' || root.length === 0) {
      throw new RestrictedStorageKeyError('RESTRICTED_STORAGE_KEY_INVALID: sink root is required');
    }
  }

  async open(artifactId: string, storageKey: string): Promise<ArtifactWriteSession> {
    if (typeof artifactId !== 'string' || artifactId.length === 0) {
      throw new RestrictedStorageKeyError('RESTRICTED_STORAGE_KEY_INVALID: artifactId is required');
    }
    const safeKey = assertSafeStorageKey(storageKey, this.root);
    const path = join(resolve(this.root), ...safeKey.split('/'));
    await mkdir(resolve(this.root), { recursive: true });
    const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf(sep)));
    if (dir.length > 0) await mkdir(dir, { recursive: true });
    // Exclusive create: an existing artifact file can never be overwritten.
    const handle = await open(path, 'wx');
    return new FileArtifactWriteSession(artifactId, safeKey, path, handle);
  }
}
