import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { BigIntStats } from 'node:fs';
import type { CollaborationCandidateManifestEntry } from '@agentos/shared';
import { lstat, open } from 'node:fs/promises';
import {
  assertCollaborationPathBoundaryUnchanged,
  captureCollaborationPathBoundary,
} from './CollaborationPathBoundary.js';
import type { NormalizedCollaborationScope } from './CollaborationScopePolicy.js';
import { parseCollaborationCandidateDiff } from './CollaborationCandidatePreview.js';
import {
  assertCollaborationPathsWithinScope,
  COLLABORATION_SCOPE_POLICY_VERSION,
  resolveCollaborationScopePolicy,
} from './CollaborationScopePolicy.js';
import { CollaborationSnapshotGitContext } from './CollaborationSnapshotGitContext.js';

const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const MAX_FROZEN_BLOB_HASH_BYTES = 32 * 1024 * 1024;
const DEFAULT_RESOURCE_LIMITS = {
  maxInventoryPaths: 50_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxGitBlobBytesPerFile: 32 * 1024 * 1024,
  maxTotalSourceBytes: 2 * 1024 * 1024 * 1024,
  maxTotalGitBlobBytes: 2 * 1024 * 1024 * 1024,
} as const;

export interface CollaborationCandidateSnapshotResourceLimits {
  readonly maxInventoryPaths: number;
  readonly maxFileBytes: number;
  readonly maxGitBlobBytesPerFile: number;
  readonly maxTotalSourceBytes: number;
  readonly maxTotalGitBlobBytes: number;
}

export interface CollaborationCandidateSnapshot {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly patch: string;
  readonly patchHash: string;
  readonly scopePolicyVersion: typeof COLLABORATION_SCOPE_POLICY_VERSION;
  readonly scope: readonly string[];
  /** Includes both source and destination paths for detected renames. */
  readonly changedPaths: readonly string[];
  readonly untrackedManifest: readonly { path: string; sizeBytes: number; sha256: string }[];
  /** Manifest metadata for binary paths and explicit text/binary rename classification; bytes stay in diffText. */
  readonly binaryManifest: readonly CollaborationCandidateManifestEntry[];
}

interface GitTreeEntry {
  readonly mode: string;
  readonly objectId: string;
}

interface GitChange {
  readonly status: string;
  readonly paths: readonly string[];
}

interface FrozenSourceImage {
  readonly sizeBytes: number;
  readonly sha256: string;
}

function resourceLimitError(message: string): Error {
  return new Error(`COLLABORATION_SNAPSHOT_RESOURCE_LIMIT: ${message}`);
}

function resolveResourceLimits(overrides?: Partial<CollaborationCandidateSnapshotResourceLimits>): CollaborationCandidateSnapshotResourceLimits {
  const limits = { ...DEFAULT_RESOURCE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid snapshot resource limit: ${name}`);
  }
  return limits;
}

async function preflightSourceBytes(
  root: string,
  paths: readonly string[],
  witness: PathBoundaryWitness,
  limits: CollaborationCandidateSnapshotResourceLimits,
): Promise<bigint> {
  let totalBytes = 0n;
  for (const path of paths) {
    let stats: BigIntStats;
    try {
      stats = await lstat(resolve(root, ...path.split('/')), { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (stats.isSymbolicLink() || !sameFileIdentity(leafWitness(witness, path), stats)) {
      throw new Error(`COLLABORATION_PATH_BOUNDARY: source identity changed before size preflight (${JSON.stringify(path)})`);
    }
    if (stats.isDirectory()) continue;
    if (!stats.isFile()) throw new Error('COLLABORATION_PATH_BOUNDARY: unsupported source file type');
    if (stats.size > BigInt(limits.maxFileBytes)) {
      throw resourceLimitError(`single file exceeds ${limits.maxFileBytes} bytes (${JSON.stringify(path)})`);
    }
    totalBytes += stats.size;
    if (totalBytes > BigInt(limits.maxTotalSourceBytes)) {
      throw resourceLimitError(`source inventory exceeds ${limits.maxTotalSourceBytes} bytes`);
    }
  }
  return totalBytes;
}

async function readBoundedFile(handle: Awaited<ReturnType<typeof open>>, path: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - totalBytes + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) throw resourceLimitError(`source file grew beyond its byte budget (${JSON.stringify(path)})`);
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, totalBytes);
}

async function assertGitBlobByteLimit(
  context: CollaborationSnapshotGitContext,
  entries: readonly GitTreeEntry[],
  maxFileBytes: number,
  maxTotalBytes: number,
): Promise<void> {
  const objectIds = [...new Set(entries.map(entry => entry.objectId))];
  if (objectIds.length === 0) return;
  const output = await context.run(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    Buffer.from(`${objectIds.join('\n')}\n`, 'utf8'));
  const records = output.toString('ascii').trimEnd().split('\n');
  if (records.length !== objectIds.length) throw new Error('COLLABORATION_GIT_OUTPUT_INVALID: malformed frozen blob size inventory');
  let totalBytes = 0n;
  const maxBytes = BigInt(maxTotalBytes);
  for (const [index, record] of records.entries()) {
    const [objectId, type, sizeText, ...extra] = record.trim().split(' ');
    if (extra.length !== 0 || !objectId || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(objectId)
      || objectId !== objectIds[index] || type !== 'blob' || !sizeText || !/^\d+$/u.test(sizeText)) {
      throw new Error('COLLABORATION_GIT_OUTPUT_INVALID: malformed frozen blob size record');
    }
    const sizeBytes = BigInt(sizeText);
    if (sizeBytes > BigInt(maxFileBytes)) {
      throw resourceLimitError(`single Git blob exceeds ${maxFileBytes} bytes (${objectId})`);
    }
    totalBytes += sizeBytes;
    if (totalBytes > maxBytes) throw resourceLimitError(`base and candidate Git blobs exceed ${maxTotalBytes} bytes`);
  }
}

type PathBoundaryWitness = Awaited<ReturnType<typeof captureCollaborationPathBoundary>>;
type PathComponentWitness = PathBoundaryWitness['root'];

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function splitNul(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

function parseTreeEntries(output: string): Map<string, GitTreeEntry> {
  const entries = new Map<string, GitTreeEntry>();
  for (const record of splitNul(output)) {
    const separator = record.indexOf('\t');
    if (separator < 0) throw new Error('COLLABORATION_GIT_OUTPUT_INVALID: malformed tree entry');
    const [mode, , objectId] = record.slice(0, separator).split(' ');
    entries.set(record.slice(separator + 1), { mode, objectId });
  }
  return entries;
}

function parseIndexEntries(output: string): Map<string, GitTreeEntry> {
  const entries = new Map<string, GitTreeEntry>();
  for (const record of splitNul(output)) {
    const separator = record.indexOf('\t');
    if (separator < 0) throw new Error('COLLABORATION_GIT_OUTPUT_INVALID: malformed index entry');
    const [mode, objectId] = record.slice(0, separator).split(' ');
    entries.set(record.slice(separator + 1), { mode, objectId });
  }
  return entries;
}

function parseNameStatus(output: string): GitChange[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes: GitChange[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const pathCount = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    const paths = fields.slice(index, index + pathCount);
    if (paths.length !== pathCount || paths.some(path => path.length === 0)) {
      throw new Error('COLLABORATION_GIT_OUTPUT_INVALID: malformed diff path list');
    }
    index += pathCount;
    changes.push({ status, paths });
  }
  return changes;
}

function leafWitness(witness: PathBoundaryWitness, path: string): PathComponentWitness {
  const leaf = witness.paths.find(item => item.path === path)?.components.at(-1);
  if (!leaf) throw new Error('COLLABORATION_PATH_BOUNDARY: missing source identity witness');
  return leaf;
}

function sameFileIdentity(expected: PathComponentWitness, stats: BigIntStats): boolean {
  return expected.exists && expected.device === String(stats.dev)
    && expected.inode === String(stats.ino) && expected.mode === Number(stats.mode);
}

async function readSourceImage(root: string, path: string, expected: PathComponentWitness, maxBytes: number): Promise<Buffer | null> {
  const absolutePath = resolve(root, ...path.split('/'));
  let stats: BigIntStats;
  try {
    stats = await lstat(absolutePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (stats.isSymbolicLink() || !sameFileIdentity(expected, stats)) {
    throw new Error(`COLLABORATION_PATH_BOUNDARY: source identity changed before reading (${JSON.stringify(path)})`);
  }
  if (stats.isDirectory()) return null;
  if (!stats.isFile()) throw new Error('COLLABORATION_PATH_BOUNDARY: unsupported source file type');
  if (stats.size > BigInt(maxBytes)) throw resourceLimitError(`source file exceeds its byte budget (${JSON.stringify(path)})`);
  const handle = await open(absolutePath, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    // Validate the opened handle before reading. An ancestor swapped after the
    // path check cannot make us read a different file through the same name.
    if (!before.isFile() || !sameFileIdentity(expected, before)) {
      throw new Error(`COLLABORATION_PATH_BOUNDARY: opened source does not match its witness (${JSON.stringify(path)})`);
    }
    if (before.size > BigInt(maxBytes)) throw resourceLimitError(`source file exceeds its byte budget (${JSON.stringify(path)})`);
    const bytes = await readBoundedFile(handle, path, maxBytes);
    const after = await handle.stat({ bigint: true });
    if (BigInt(bytes.byteLength) !== before.size || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error(`COLLABORATION_SNAPSHOT_SOURCE_CHANGED: source changed while being read (${JSON.stringify(path)})`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function samePathIdentity(left: PathBoundaryWitness, right: PathBoundaryWitness): boolean {
  const identity = (witness: PathBoundaryWitness) => ({
    rootRealPath: witness.rootRealPath,
    root: { realPath: witness.root.realPath, mode: witness.root.mode, device: witness.root.device, inode: witness.root.inode },
    paths: witness.paths.map(item => ({
      path: item.path,
      components: item.components.map(component => ({
        path: component.path, exists: component.exists, realPath: component.realPath,
        mode: component.mode, device: component.device, inode: component.inode,
      })),
    })),
  });
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}

async function assertSourceImagesUnchanged(
  root: string,
  witness: PathBoundaryWitness,
  images: ReadonlyMap<string, FrozenSourceImage | null>,
): Promise<void> {
  const currentWitness = await captureCollaborationPathBoundary(root, witness.paths.map(item => item.path));
  if (!samePathIdentity(witness, currentWitness)) {
    throw new Error('COLLABORATION_PATH_BOUNDARY: path or ancestor identity changed during the operation');
  }
  for (const [path, expected] of images) {
    let current: Buffer | null;
    try {
      current = await readSourceImage(root, path, leafWitness(currentWitness, path), expected?.sizeBytes ?? 0);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('COLLABORATION_SNAPSHOT_RESOURCE_LIMIT:')) {
        throw new Error(`COLLABORATION_SNAPSHOT_SOURCE_CHANGED: source exceeded its frozen size (${JSON.stringify(path)})`);
      }
      throw error;
    }
    if (expected === null ? current !== null : current === null
      || current.byteLength !== expected.sizeBytes || sha256(current) !== expected.sha256) {
      throw new Error(`COLLABORATION_SNAPSHOT_SOURCE_CHANGED: source bytes changed during candidate capture (${JSON.stringify(path)})`);
    }
  }
  await assertCollaborationPathBoundaryUnchanged(root, currentWitness);
}

function attributePathsFor(paths: readonly string[]): string[] {
  const attributes = new Set(['.gitattributes']);
  for (const path of paths) {
    const segments = path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      attributes.add(`${segments.slice(0, index).join('/')}/.gitattributes`);
    }
  }
  return [...attributes].sort();
}

function isRegularBlob(entry: GitTreeEntry | undefined): boolean {
  return entry === undefined || entry.mode === '100644' || entry.mode === '100755';
}

/** Freeze source bytes, effective attributes and normalization config before
 * any clean operation. Only an owned shadow worktree/index produces blobs and
 * patch bytes; the original worktree is used for metadata/stability checks. */
export async function captureCollaborationCandidateSnapshot(
  worktreePath: string,
  baseCommit: string,
  approvedScope: readonly string[] | NormalizedCollaborationScope,
  /** @internal Deterministic capture barriers; beforeGitAdd retains the original regression seam. */
  testHooks?: {
    readonly afterGitContextFrozen?: () => void | Promise<void>;
    readonly beforeGitAdd?: () => void | Promise<void>;
    readonly beforeFrozenNormalization?: () => void | Promise<void>;
    readonly beforePatch?: () => void | Promise<void>;
    readonly resourceLimits?: Partial<CollaborationCandidateSnapshotResourceLimits>;
  },
): Promise<CollaborationCandidateSnapshot> {
  const resourceLimits = resolveResourceLimits(testHooks?.resourceLimits);
  const scope = resolveCollaborationScopePolicy(approvedScope);
  const worktreeRoot = resolve(worktreePath);
  await captureCollaborationPathBoundary(worktreeRoot, []);
  const context = await CollaborationSnapshotGitContext.create(worktreeRoot);
  try {
    const [head, baseTree, realIndex, untracked] = await Promise.all([
      context.sourceMetadata(['rev-parse', 'HEAD']),
      context.sourceMetadata(['ls-tree', '-r', '-z', '--full-tree', baseCommit]),
      context.sourceMetadata(['ls-files', '-s', '-z']),
      context.sourceMetadata(['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    const headAtStart = head.toString('utf8').trim();
    const baseEntries = parseTreeEntries(baseTree.toString('utf8'));
    const realIndexEntries = parseIndexEntries(realIndex.toString('utf8'));
    const inventoryPaths = [...new Set([...baseEntries.keys(), ...realIndexEntries.keys(), ...splitNul(untracked.toString('utf8'))])].sort();
    if (inventoryPaths.length > resourceLimits.maxInventoryPaths) {
      throw resourceLimitError(`inventory contains more than ${resourceLimits.maxInventoryPaths} paths`);
    }
    const inventoryWitness = await captureCollaborationPathBoundary(worktreeRoot, inventoryPaths);
    const attributeWitness = await captureCollaborationPathBoundary(worktreeRoot, attributePathsFor(inventoryPaths));
    for (const path of inventoryPaths) {
      if (!isRegularBlob(baseEntries.get(path)) || !isRegularBlob(realIndexEntries.get(path))) {
        throw new Error(`COLLABORATION_PATH_BOUNDARY: symlink, submodule, or unsupported Git mode is not allowed (${JSON.stringify(path)})`);
      }
    }
    await preflightSourceBytes(worktreeRoot, inventoryPaths, inventoryWitness, resourceLimits);
    await context.freezeAttributes(inventoryPaths);
    await testHooks?.afterGitContextFrozen?.();
    await context.assertSourceContextUnchanged();
    await assertCollaborationPathBoundaryUnchanged(worktreeRoot, inventoryWitness);
    await assertCollaborationPathBoundaryUnchanged(worktreeRoot, attributeWitness);

    const sourceImages = new Map<string, FrozenSourceImage | null>();
    let totalSourceBytesRead = 0;
    for (const path of inventoryPaths) {
      const leaf = leafWitness(inventoryWitness, path);
      const remainingBytes = resourceLimits.maxTotalSourceBytes - totalSourceBytesRead;
      const maxBytes = Math.max(0, Math.min(resourceLimits.maxFileBytes, remainingBytes));
      const bytes = await readSourceImage(worktreeRoot, path, leaf, maxBytes);
      if (bytes !== null) {
        totalSourceBytesRead += bytes.byteLength;
        if (totalSourceBytesRead > resourceLimits.maxTotalSourceBytes) {
          throw resourceLimitError(`source inventory exceeds ${resourceLimits.maxTotalSourceBytes} bytes`);
        }
      }
      sourceImages.set(path, bytes === null ? null : { sizeBytes: bytes.byteLength, sha256: sha256(bytes) });
      if (bytes !== null) await context.writeFrozenSource(path, bytes, leaf.mode!);
    }
    await assertCollaborationPathBoundaryUnchanged(worktreeRoot, inventoryWitness);

    const assertFrozenState = async (): Promise<void> => {
      const [currentHead, currentIndex, currentUntracked] = await Promise.all([
        context.sourceMetadata(['rev-parse', 'HEAD']),
        context.sourceMetadata(['ls-files', '-s', '-z']),
        context.sourceMetadata(['ls-files', '--others', '--exclude-standard', '-z']),
      ]);
      if (!head.equals(currentHead) || !realIndex.equals(currentIndex) || !untracked.equals(currentUntracked)) {
        throw new Error('COLLABORATION_SNAPSHOT_SOURCE_CHANGED: HEAD, index, or candidate path inventory changed during capture');
      }
      await assertSourceImagesUnchanged(worktreeRoot, inventoryWitness, sourceImages);
      await context.assertSourceContextUnchanged();
      await assertCollaborationPathBoundaryUnchanged(worktreeRoot, attributeWitness);
    };

    await testHooks?.beforeGitAdd?.();
    await assertFrozenState();
    await testHooks?.beforeFrozenNormalization?.();
    await context.run(['read-tree', baseCommit]);
    // The shadow contains only the validated, frozen inventory. Force retains
    // real-index-tracked files that are ignored by the worktree's ignore rules.
    await context.run(['add', '--all', '--force', '--', '.']);
    const changes = parseNameStatus((await context.run([
      'diff', '--cached', '--name-status', '-z', '--no-ext-diff', '--no-textconv', '-M', baseCommit,
    ])).toString('utf8'));
    const changedPaths = [...new Set(changes.flatMap(change => change.paths))].sort();
    if (changedPaths.length === 0) {
      await assertFrozenState();
      throw new Error('COLLABORATION_CANDIDATE_EMPTY: implementation produced no changes');
    }
    assertCollaborationPathsWithinScope(scope, changedPaths);

    const stagedEntries = parseIndexEntries((await context.run(['ls-files', '-s', '-z'])).toString('utf8'));
    // Changed-object budgets apply only to the frozen candidate's baseline and
    // result images. Unchanged repository blobs are already bounded by the
    // complete source inventory limits above and must not consume candidate
    // diff/hash budget.
    const changedGitEntries = changedPaths.flatMap(path => [baseEntries.get(path), stagedEntries.get(path)])
      .filter((entry): entry is GitTreeEntry => entry !== undefined);
    await assertGitBlobByteLimit(context, changedGitEntries,
      resourceLimits.maxGitBlobBytesPerFile, resourceLimits.maxTotalGitBlobBytes);
    for (const path of changedPaths) {
      const entry = stagedEntries.get(path);
      if (!isRegularBlob(baseEntries.get(path)) || !isRegularBlob(entry)) {
        throw new Error(`COLLABORATION_PATH_BOUNDARY: unsupported staged Git mode (${JSON.stringify(path)})`);
      }
      if (!entry) continue;
      const image = sourceImages.get(path);
      if (!image) throw new Error('COLLABORATION_SNAPSHOT_SOURCE_CHANGED: staged source was not frozen');
      const bytes = await context.readFrozenSource(path);
      if (bytes.byteLength !== image.sizeBytes || sha256(bytes) !== image.sha256) {
        throw new Error('COLLABORATION_SNAPSHOT_SOURCE_CHANGED: frozen source bytes changed');
      }
      const cleaned = (await context.run(['hash-object', `--path=${path}`, '--stdin'], bytes)).toString('utf8').trim();
      if (cleaned !== entry.objectId) {
        throw new Error(`COLLABORATION_GIT_CLEAN_MISMATCH: staged content differs from frozen source clean image (${JSON.stringify(path)})`);
      }
    }

    await testHooks?.beforePatch?.();
    const patch = (await context.run([
      'diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-color',
      '--src-prefix=a/', '--dst-prefix=b/', '-M', baseCommit,
    ])).toString('utf8');
    if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
      throw new Error('COLLABORATION_DIFF_TOO_LARGE: candidate patch exceeds the safe limit');
    }
    if (!patch) {
      await assertFrozenState();
      throw new Error('COLLABORATION_CANDIDATE_EMPTY: implementation produced no changes');
    }
    const diffRecords = parseCollaborationCandidateDiff(patch);
    // Validate the exact emitted patch against base objects in the same owned
    // context. Neither this check nor the preceding diff accesses live content.
    await context.run(['read-tree', baseCommit]);
    await context.run(['apply', '--cached', '--check', '--binary', '--whitespace=nowarn', '-'], Buffer.from(patch, 'utf8'));
    await assertFrozenState();

    const untrackedManifest = changes.filter(change => change.status === 'A').flatMap(change => change.paths).map(path => {
      const image = sourceImages.get(path);
      if (!image) throw new Error('COLLABORATION_SNAPSHOT_SOURCE_CHANGED: added source was not frozen');
      return { path, sizeBytes: image.sizeBytes, sha256: image.sha256 };
    }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const blobImages = new Map<string, { sizeBytes: number; sha256?: string; binary: boolean }>();
    let frozenBlobHashBytes = 0;
    const blobImage = async (entry: GitTreeEntry | undefined, includeSha256 = false): Promise<{ sizeBytes: number; sha256?: string; binary: boolean } | undefined> => {
      if (!entry) return undefined;
      const cached = blobImages.get(entry.objectId);
      if (cached && (!includeSha256 || cached.sha256 !== undefined)) return cached;
      const sizeBytes = cached?.sizeBytes ?? Number((await context.run(['cat-file', '-s', entry.objectId])).toString('utf8').trim());
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error('COLLABORATION_SNAPSHOT_SOURCE_CHANGED: binary blob size is invalid');
      const frozenBlob = await context.run(['cat-file', 'blob', entry.objectId]);
      if (frozenBlob.byteLength !== sizeBytes) throw new Error('COLLABORATION_SNAPSHOT_SOURCE_CHANGED: frozen binary blob size changed');
      const binary = cached?.binary ?? frozenBlob.includes(0);
      let digest = cached?.sha256;
      if ((includeSha256 || binary) && digest === undefined) {
        if (frozenBlobHashBytes + sizeBytes > MAX_FROZEN_BLOB_HASH_BYTES) {
          throw new Error('COLLABORATION_DIFF_TOO_LARGE: frozen blob hashing exceeds the 32 MiB aggregate limit');
        }
        frozenBlobHashBytes += sizeBytes;
        digest = sha256(frozenBlob);
      }
      const image = { sizeBytes, ...(digest === undefined ? {} : { sha256: digest }), binary };
      blobImages.set(entry.objectId, image);
      return image;
    };
    const binaryManifest: CollaborationCandidateManifestEntry[] = [];
    // Git attributes can force text hunks for blobs containing NUL bytes. Probe
    // every changed base/candidate object so the frozen manifest does not trust
    // the diff driver's presentation as its binary classification.
    for (const record of diffRecords) {
      const sourcePath = record.newPath ?? record.oldPath;
      if (!sourcePath) throw new Error('COLLABORATION_SNAPSHOT_SOURCE_CHANGED: binary patch path is missing');
      const targetEntry = record.newPath === null ? undefined : stagedEntries.get(record.newPath);
      const baseEntry = record.oldPath === null ? undefined : baseEntries.get(record.oldPath);
      const baseImage = await blobImage(baseEntry);
      const candidateImage = await blobImage(targetEntry);
      const binary = record.binary || baseImage?.binary === true || candidateImage?.binary === true;
      if (!binary && record.status !== 'renamed') continue;
      const baseMetadata = await blobImage(baseEntry, true);
      const candidateMetadata = await blobImage(targetEntry, true);
      if (!binary) {
        if (!targetEntry || !candidateMetadata?.sha256) {
          throw new Error(`COLLABORATION_SNAPSHOT_SOURCE_CHANGED: renamed image was not frozen (${JSON.stringify(sourcePath)})`);
        }
        binaryManifest.push({
          path: sourcePath, sizeBytes: candidateMetadata.sizeBytes, sha256: candidateMetadata.sha256,
          gitObjectId: targetEntry.objectId, binary: false,
        });
        continue;
      }
      const baselineImage = baseMetadata;
      const sizeBytes = targetEntry === undefined ? baselineImage?.sizeBytes : candidateMetadata?.sizeBytes;
      const gitObjectId = targetEntry?.objectId ?? baseEntry?.objectId;
      const imageSha256 = targetEntry === undefined ? baselineImage?.sha256 : candidateMetadata?.sha256;
      if (sizeBytes === undefined || imageSha256 === undefined || gitObjectId === undefined) {
        throw new Error(`COLLABORATION_SNAPSHOT_SOURCE_CHANGED: binary image was not frozen (${JSON.stringify(sourcePath)})`);
      }
      const deleted = targetEntry === undefined;
      binaryManifest.push({
        path: sourcePath,
        sizeBytes,
        sha256: imageSha256,
        gitObjectId,
        binary: true,
        ...(targetEntry && baseEntry && baselineImage?.sha256 ? {
          baseSizeBytes: baselineImage.sizeBytes,
          baseSha256: baselineImage.sha256,
          baseObjectId: baseEntry.objectId,
        } : {}),
        ...(deleted ? { deleted: true } : {}),
      });
    }
    return {
      baseCommit, headCommit: headAtStart, patch, patchHash: sha256(patch),
      scopePolicyVersion: scope.policyVersion, scope: scope.paths, changedPaths, untrackedManifest, binaryManifest,
    };
  } finally {
    await context.dispose();
  }
}
