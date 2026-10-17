import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { UntrackedManifestEntry, WorktreeRecoveryBundle, WorktreeRecoveryManifestV2 } from '@agentos/shared';
import { RuntimeArtifactService, type PreparedWorktreeArtifact } from './RuntimeArtifactService.js';
import type { WorktreeManager } from './WorktreeManager.js';
import { withWorktreeBranchLock } from './WorktreeBranchLock.js';
import { assertRecoveryPath, createRecoveryArchive, readRecoveryArchive, resolveRecoveryLink, WorktreeRecoveryError } from './WorktreeRecoveryArchive.js';

const execFileAsync = promisify(execFile);
type Lease = NonNullable<ReturnType<WorktreeManager['getRecord']>>;
type BundleInput = { workspaceId: string; runId: string; executionId: string; agentId: string };
type ParsedManifest = { formatVersion: 1 | 2; baseCommit?: string; headCommit?: string; entries: UntrackedManifestEntry[] };

export class WorktreeArtifactService {
  constructor(private readonly artifacts: RuntimeArtifactService, private readonly worktrees: WorktreeManager) {}

  async createBundle(leaseId: string, input: BundleInput): Promise<WorktreeRecoveryBundle> {
    const lease = this.requireLease(leaseId, input);
    return withWorktreeBranchLock(lease.absolutePath, lease.branchName,
      () => this.createBundleWithinBranchLock(leaseId, input));
  }

  /** @internal Cleanup already owns this branch lock. */
  async createBundleWithinBranchLock(leaseId: string, input: BundleInput): Promise<WorktreeRecoveryBundle> {
    const lease = this.requireLease(leaseId, input);
    const headCommit = await git(lease.absolutePath, ['rev-parse', 'HEAD']).then(text => text.trim());
    const captured = await this.captureFiles(lease);
    const patch = Buffer.from(await this.readTrackedPatch(lease, captured.patchExcludedPaths), 'utf8');
    const manifest: WorktreeRecoveryManifestV2 = { formatVersion: 2, baseCommit: lease.baseCommit, headCommit, entries: captured.entries };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
    const archive = createRecoveryArchive(captured.files);
    // Verify staged bytes against trusted Git objects before any artifact rows
    // or verified lease reference are published.
    await this.verifyBytes(manifest, patch, archive, lease);
    const repeated = await this.captureFiles(lease);
    if (JSON.stringify(repeated.entries) !== JSON.stringify(captured.entries)
      || await this.readTrackedPatch(lease, repeated.patchExcludedPaths) !== patch.toString('utf8')
      || await git(lease.absolutePath, ['rev-parse', 'HEAD']).then(text => text.trim()) !== headCommit) {
      throw new WorktreeRecoveryError('WORKTREE_RECOVERY_SOURCE_CHANGED');
    }
    const base = { workspaceId: input.workspaceId, workspaceRoot: lease.absolutePath, runId: input.runId,
      sourceExecutionId: input.executionId, agentId: input.agentId };
    const staged: PreparedWorktreeArtifact[] = [];
    try {
      for (const item of [
        { type: 'diff' as const, title: 'Worktree tracked patch', bytes: patch },
        { type: 'manifest' as const, title: 'Worktree untracked manifest', bytes: manifestBytes },
        { type: 'archive' as const, title: 'Worktree untracked archive', bytes: archive },
      ]) {
        staged.push(await this.artifacts.prepareWorktreeArtifact(leaseId,
          { ...base, type: item.type, title: item.title, source: { kind: 'bytes', content: item.bytes } }, headCommit));
      }
      if (await this.artifacts.readWorktreeHead(lease.absolutePath) !== headCommit) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_SOURCE_CHANGED');
      const bundle: WorktreeRecoveryBundle = { trackedPatchArtifactId: staged[0].id,
        manifestArtifactId: staged[1].id, untrackedArchiveArtifactId: staged[2].id,
        entryCount: manifest.entries.length, formatVersion: 2 };
      this.artifacts.publishPreparedWorktreeArtifacts(staged, () => this.worktrees.markRecoveryBundleVerified(leaseId, bundle));
      return bundle;
    } catch (error) {
      await Promise.all(staged.map(item => item.discard()));
      throw error;
    }
  }

  async verifyRecoveryBundle(bundle: WorktreeRecoveryBundle, workspaceId: string): Promise<void> {
    const data = await this.readBundle(bundle, workspaceId);
    await this.verifyBytes(data.manifest, data.patch, data.archive, data.lease);
  }

  /** Restore into an empty isolated directory with native relative file links. */
  async restoreRecoveryBundle(bundle: WorktreeRecoveryBundle, workspaceId: string, destination: string): Promise<void> {
    const data = await this.readBundle(bundle, workspaceId);
    await this.restoreBytes(data.manifest, data.patch, data.archive, data.lease, destination);
  }

  private requireLease(leaseId: string, input: BundleInput): Lease {
    const lease = this.worktrees.getRecord(leaseId);
    if (!lease || lease.workspaceId !== input.workspaceId || lease.runId !== input.runId
      || lease.executionId !== input.executionId || lease.agentId !== input.agentId || lease.status === 'cleaned') {
      throw new WorktreeRecoveryError('WORKTREE_RECOVERY_PROVENANCE_MISMATCH');
    }
    return lease;
  }

  private async readBundle(bundle: WorktreeRecoveryBundle, workspaceId: string) {
    const manifest = parseManifest(await this.artifacts.readContentBytes(workspaceId, bundle.manifestArtifactId));
    if (manifest.entries.length !== bundle.entryCount || (bundle.formatVersion ?? 1) !== manifest.formatVersion) {
      throw new WorktreeRecoveryError('WORKTREE_RECOVERY_MANIFEST_INVALID');
    }
    const ids = [bundle.trackedPatchArtifactId, bundle.manifestArtifactId, bundle.untrackedArchiveArtifactId];
    const lease = this.worktrees.listLeases().map(item => this.worktrees.getRecord(item.id)).find(record =>
      record?.workspaceId === workspaceId && record.recoveryBundle?.manifestArtifactId === bundle.manifestArtifactId
      && record.recoveryBundle?.trackedPatchArtifactId === bundle.trackedPatchArtifactId
      && record.recoveryBundle?.untrackedArchiveArtifactId === bundle.untrackedArchiveArtifactId);
    if (!lease) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_PROVENANCE_MISMATCH');
    if (manifest.formatVersion === 2) {
      for (const id of ids) this.artifacts.requireWorktreeProvenance(lease.id, id, manifest.headCommit);
      if (manifest.baseCommit !== lease.baseCommit) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_PROVENANCE_MISMATCH');
    }
    return { manifest, lease, patch: await this.artifacts.readContentBytes(workspaceId, bundle.trackedPatchArtifactId),
      archive: await this.artifacts.readContentBytes(workspaceId, bundle.untrackedArchiveArtifactId) };
  }

  private async verifyBytes(manifest: ParsedManifest, patch: Buffer, archive: Buffer, lease: Lease): Promise<void> {
    const isolation = await mkdtemp(join(tmpdir(), 'agentos-recovery-'));
    try { await this.restoreBytes(manifest, patch, archive, lease, isolation); }
    finally {
      // Windows cannot reliably remove a now-dangling link chain. Unlink
      // dependants first while their targets still exist.
      for (const entry of linksInRemovalOrder(manifest.entries)) {
        try { await unlink(join(isolation, entry.path)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      await rm(isolation, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }

  private async restoreBytes(manifest: ParsedManifest, patch: Buffer, archive: Buffer, lease: Lease, root: string): Promise<void> {
    const directory = await lstat(root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (await readdir(root)).length !== 0) {
      throw new WorktreeRecoveryError('WORKTREE_RECOVERY_DESTINATION_NOT_EMPTY');
    }
    root = await realpath(root);
    const archived = readRecoveryArchive(archive);
    const files = manifest.entries.filter(entry => entry.kind !== 'symlink');
    if (archived.length !== files.length || archived.some(item =>
      !files.some(entry => entry.path === item.path && entry.sha256 === hash(item.bytes) && entry.sizeBytes === item.bytes.length))) {
      throw new WorktreeRecoveryError('WORKTREE_RECOVERY_ARCHIVE_MANIFEST_MISMATCH');
    }
    const baseCommit = manifest.baseCommit ?? lease.baseCommit;
    if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_MANIFEST_INVALID');
    // Read the primary repository's object database, never lease.absolutePath.
    const baseline = readRecoveryArchive((await execFileAsync('git', ['archive', '--format=tar', baseCommit],
      { cwd: lease.workspaceRoot, encoding: 'buffer', timeout: 30000, windowsHide: true, maxBuffer: 256 * 1024 * 1024 })).stdout, true);
    if (manifest.formatVersion === 1 && baseline.some(file => file.kind === 'symlink')) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_V1_LINKS_UNSUPPORTED');
    for (const file of baseline) await writeOrdinary(root, file.path, file.bytes);
    if (patch.length) {
      const patchRoot = await mkdtemp(join(tmpdir(), 'agentos-recovery-patch-'));
      try {
        const patchPath = join(patchRoot, 'tracked.patch');
        await writeFile(patchPath, patch, { flag: 'wx' });
        await execFileAsync('git', ['-c', 'core.symlinks=false', '-c', 'core.autocrlf=false',
          'apply', '--binary', '--whitespace=nowarn', patchPath], { cwd: root, windowsHide: true, timeout: 30000,
          env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) } });
      } catch { throw new WorktreeRecoveryError('WORKTREE_RECOVERY_PATCH_INVALID'); }
      finally { await rm(patchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    }
    for (const file of archived) await writeOrdinary(root, file.path, file.bytes);
    const links = new Map(manifest.entries.filter(entry => entry.kind === 'symlink').map(entry => [pathKey(entry.path), entry]));
    for (const entry of links.values()) {
      let path = entry.path;
      const visited = new Set<string>();
      while (links.has(pathKey(path))) {
        if (visited.has(pathKey(path))) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_LINK_CYCLE');
        visited.add(pathKey(path));
        const next = links.get(pathKey(path))!;
        path = resolveRecoveryLink(path, next.target!);
      }
      await assertOrdinaryParents(root, path);
      const target = join(root, path);
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_LINK_TARGET_INVALID');
      const content = await readFile(target);
      if (content.length !== entry.sizeBytes || hash(content) !== entry.sha256) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_HASH_MISMATCH');
    }
    for (const entry of links.values()) {
      await assertOrdinaryParents(root, entry.path);
      const path = join(root, entry.path);
      await rm(path, { force: true });
      await symlink(entry.target!, path, 'file');
    }
    for (const entry of manifest.entries) {
      const path = join(root, entry.path);
      const info = await lstat(path);
      if (entry.kind === 'symlink' ? !info.isSymbolicLink() : !info.isFile() || info.isSymbolicLink()) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_FILE_KIND_MISMATCH');
      const actual = await realpath(path);
      if (!isWithin(root, actual)) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_LINK_ESCAPES_ROOT');
      const bytes = await readFile(path);
      if (bytes.length !== entry.sizeBytes || hash(bytes) !== entry.sha256) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_HASH_MISMATCH');
    }
  }

  private async captureFiles(lease: Lease): Promise<{ entries: UntrackedManifestEntry[]; files: { path: string; bytes: Buffer }[]; patchExcludedPaths: string[] }> {
    const root = await realpath(lease.absolutePath);
    const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    const tracked = (await git(root, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean).map(line => {
      const tab = line.indexOf('\t'); return { path: line.slice(tab + 1), mode: line.slice(0, 6) };
    });
    const rawModes = parseRawDiffModes(await git(root, ['diff', '--raw', '--no-abbrev', '--no-renames', '-z', lease.baseCommit]));
    const symlinkTypeChanges = new Set([...rawModes].filter(([, modes]) => modes.oldMode === '120000'
      && (modes.newMode === '100644' || modes.newMode === '100755')).map(([path]) => path));
    // A tracked symlink may be checked out as a regular placeholder when
    // core.symlinks=false. Git still reports mode 120000 in that case. A real
    // symlink-to-file type change is reported with a regular new mode. Store
    // that file in the manifest and exclude its path from the tracked patch;
    // Git emits separate delete/add blocks for this transition, which git
    // apply cannot replay as a single path.
    const trackedLinks = new Set(tracked.filter(item => item.mode === '120000'
      && !symlinkTypeChanges.has(item.path)).map(item => item.path));
    const trackedPaths = new Set(tracked.map(item => item.path));
    const paths = new Set(untracked);
    for (const path of symlinkTypeChanges) paths.add(path);
    for (const item of tracked) {
      try { if ((await lstat(join(root, item.path))).isSymbolicLink() || trackedLinks.has(item.path)) paths.add(item.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const entries = new Map<string, UntrackedManifestEntry>();
    const files: { path: string; bytes: Buffer }[] = [];
    const inspect = async (path: string, seen: Set<string>): Promise<Buffer> => {
      assertRecoveryPath(path);
      if (seen.has(pathKey(path))) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_LINK_CYCLE');
      seen.add(pathKey(path));
      await assertOrdinaryParents(root, path, false);
      const absolute = join(root, path);
      let info: Awaited<ReturnType<typeof lstat>>;
      try { info = await lstat(absolute); }
      catch { throw new WorktreeRecoveryError('WORKTREE_RECOVERY_LINK_TARGET_INVALID'); }
      if (info.isSymbolicLink() || trackedLinks.has(path)) {
        const rawTarget = info.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute, 'utf8');
        const absoluteTarget = resolve(dirname(absolute), rawTarget);
        if (!isWithin(root, absoluteTarget)) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_LINK_ESCAPES_ROOT');
        const target = relative(dirname(absolute), absoluteTarget).replaceAll(sep, '/');
        const bytes = await inspect(resolveRecoveryLink(path, target), seen);
        entries.set(path, { path, kind: 'symlink', target, sizeBytes: bytes.length, sha256: hash(bytes) });
        return bytes;
      }
      if (!info.isFile()) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_LINK_TARGET_INVALID');
      const bytes = await readFile(absolute);
      if ((!trackedPaths.has(path) || symlinkTypeChanges.has(path)) && !entries.has(path)) {
        entries.set(path, { path, kind: 'file', sizeBytes: bytes.length, sha256: hash(bytes) });
        files.push({ path, bytes });
      }
      return bytes;
    };
    for (const path of [...paths].sort()) await inspect(path, new Set());
    return { entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)), files: files.sort((a, b) => a.path.localeCompare(b.path)),
      patchExcludedPaths: [...entries.keys()].filter(path => trackedPaths.has(path)).sort() };
  }

  private readTrackedPatch(lease: Lease, excludedPaths: readonly string[]): Promise<string> {
    const args = ['diff', '--binary', lease.baseCommit, '--', '.'];
    for (const path of excludedPaths) args.push(`:(exclude,literal)${path}`);
    return git(lease.absolutePath, args);
  }
}

function parseManifest(bytes: Buffer): ParsedManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new WorktreeRecoveryError('WORKTREE_RECOVERY_MANIFEST_INVALID'); }
  const v2 = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  const formatVersion = v2 === undefined ? 1 : 2;
  if (v2 && (v2.formatVersion !== 2 || typeof v2.baseCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(v2.baseCommit)
    || typeof v2.headCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(v2.headCommit))) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_MANIFEST_INVALID');
  const items = v2 ? v2.entries : parsed;
  if (!Array.isArray(items)) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_MANIFEST_INVALID');
  const names = new Set<string>();
  const entries = items.map((item): UntrackedManifestEntry => {
    if (!item || typeof item !== 'object') throw new WorktreeRecoveryError('WORKTREE_RECOVERY_MANIFEST_INVALID');
    const value = item as Record<string, unknown>;
    if (typeof value.path !== 'string' || typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
      || (v2 && value.kind !== 'file' && value.kind !== 'symlink')
      || (!v2 && (value.kind === 'symlink' || value.target !== undefined))) {
      throw new WorktreeRecoveryError(!v2 && value.kind === 'symlink' ? 'WORKTREE_RECOVERY_V1_LINKS_UNSUPPORTED' : 'WORKTREE_RECOVERY_MANIFEST_INVALID');
    }
    assertRecoveryPath(value.path);
    if (names.has(pathKey(value.path))) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_DUPLICATE_PATH');
    names.add(pathKey(value.path));
    if (value.kind === 'symlink') {
      if (typeof value.target !== 'string') throw new WorktreeRecoveryError('WORKTREE_RECOVERY_MANIFEST_INVALID');
      resolveRecoveryLink(value.path, value.target);
    }
    return { path: value.path, sizeBytes: value.sizeBytes, sha256: value.sha256,
      ...(v2 ? { kind: value.kind as 'file' | 'symlink' } : {}),
      ...(value.kind === 'symlink' ? { target: value.target as string } : {}) };
  });
  return { formatVersion, ...(v2 ? { baseCommit: v2.baseCommit as string, headCommit: v2.headCommit as string } : {}), entries };
}

async function assertOrdinaryParents(root: string, path: string, createMissing = true): Promise<void> {
  assertRecoveryPath(path);
  let parent = root;
  for (const segment of path.split('/').slice(0, -1)) {
    parent = join(parent, segment);
    try {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_DIRECTORY_LINK_UNSUPPORTED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !createMissing) throw error;
      await mkdir(parent);
    }
  }
}
async function writeOrdinary(root: string, path: string, bytes: Buffer): Promise<void> {
  await assertOrdinaryParents(root, path);
  const file = join(root, path);
  try { if ((await lstat(file)).isSymbolicLink()) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_DIRECTORY_LINK_UNSUPPORTED'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeFile(file, bytes);
}
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function pathKey(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path; }
function parseRawDiffModes(raw: string): Map<string, { oldMode: string; newMode: string }> {
  const fields = raw.split('\0');
  const modes = new Map<string, { oldMode: string; newMode: string }>();
  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    if (!header) break;
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]{40,64} [0-9a-f]{40,64} [A-Z][0-9]*$/.exec(header);
    const path = fields[index++];
    if (!match || !path) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_GIT_STATUS_INVALID');
    modes.set(path, { oldMode: match[1], newMode: match[2] });
  }
  return modes;
}
export function linksInRemovalOrder(entries: readonly UntrackedManifestEntry[]): UntrackedManifestEntry[] {
  const links = new Map(entries.filter(entry => entry.kind === 'symlink').map(entry => [pathKey(entry.path), entry]));
  const depth = (entry: UntrackedManifestEntry) => {
    const seen = new Set<string>();
    let path = entry.path;
    while (links.has(pathKey(path))) {
      if (seen.has(pathKey(path))) return seen.size;
      seen.add(pathKey(path));
      path = resolveRecoveryLink(path, links.get(pathKey(path))!.target!);
    }
    return seen.size;
  };
  return [...links.values()].sort((a, b) => depth(b) - depth(a));
}
function isWithin(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
function git(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('git', args, { cwd, timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).then(result => result.stdout);
}
