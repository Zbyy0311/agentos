import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { UntrackedManifestEntry, WorktreeRecoveryBundle } from '@agentos/shared';
import { RuntimeArtifactService } from './RuntimeArtifactService.js';
import type { WorktreeManager } from './WorktreeManager.js';

const execFileAsync = promisify(execFile);

export class WorktreeArtifactService {
  constructor(private readonly artifacts: RuntimeArtifactService, private readonly worktrees: WorktreeManager) {}

  async createBundle(
    leaseId: string,
    input: { workspaceId: string; runId: string; executionId: string; agentId: string },
  ): Promise<WorktreeRecoveryBundle> {
    const lease = this.worktrees.getRecord(leaseId);
    if (!lease) throw new Error('Worktree lease not found');
    const patch = await git(lease.absolutePath, ['diff', '--binary', lease.baseCommit]);
    const paths = (await git(lease.absolutePath, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0').filter(Boolean).sort();
    const entries = await this.buildManifest(lease.absolutePath, paths);
    const tempArchive = join(lease.absolutePath, '.agentos-untracked.tar');
    if (paths.length) await tar(lease.absolutePath, tempArchive, paths);
    else await writeFile(tempArchive, Buffer.alloc(0));

    const base = {
      workspaceId: input.workspaceId,
      workspaceRoot: lease.absolutePath,
      runId: input.runId,
      sourceExecutionId: input.executionId,
      agentId: input.agentId,
    };
    try {
      const patchArtifact = await this.artifacts.create({
        ...base, type: 'diff', title: 'Worktree tracked patch', source: { kind: 'text', content: patch },
      });
      const manifestArtifact = await this.artifacts.create({
        ...base, type: 'manifest', title: 'Worktree untracked manifest',
        source: { kind: 'text', content: JSON.stringify(entries, null, 2) },
      });
      const archiveArtifact = await this.artifacts.create({
        ...base, type: 'archive', title: 'Worktree untracked archive',
        source: { kind: 'workspace-file', absolutePath: tempArchive },
      });
      const bundle = {
        trackedPatchArtifactId: patchArtifact.id,
        untrackedArchiveArtifactId: archiveArtifact.id,
        manifestArtifactId: manifestArtifact.id,
        entryCount: entries.length,
      };
      await this.verifyRecoveryBundle(bundle, input.workspaceId);
      this.worktrees.markRecoveryBundleVerified(leaseId, bundle);
      return bundle;
    } finally {
      await rm(tempArchive, { force: true });
    }
  }

  async verifyRecoveryBundle(bundle: WorktreeRecoveryBundle, workspaceId: string): Promise<void> {
    const manifestBytes = await this.artifacts.readContentBytes(workspaceId, bundle.manifestArtifactId);
    const archiveBytes = await this.artifacts.readContentBytes(workspaceId, bundle.untrackedArchiveArtifactId);
    // The patch is deliberately read and hashed too; a cleanup gate must not
    // trust only metadata for any of the three recovery artifacts.
    await this.artifacts.readContentBytes(workspaceId, bundle.trackedPatchArtifactId);
    const manifest = parseManifest(manifestBytes);
    if (manifest.length !== bundle.entryCount) throw new Error('Recovery manifest entry count mismatch');
    const extractionRoot = await mkdtemp(join(tmpdir(), 'agentos-recovery-'));
    const archivePath = join(extractionRoot, 'bundle.tar');
    const unpackRoot = join(extractionRoot, 'unpacked');
    try {
      if (bundle.entryCount === 0 && archiveBytes.byteLength === 0) return;
      await writeFile(archivePath, archiveBytes, { flag: 'wx' });
      await mkdirSafe(unpackRoot);
      const listing = await tarList(archivePath);
      assertSafeTarListing(listing, manifest);
      await execFileAsync('tar', ['-xf', archivePath, '-C', unpackRoot], { timeout: 10000, windowsHide: true });
      for (const entry of manifest) {
        const extracted = resolve(unpackRoot, entry.path);
        if (!isWithin(unpackRoot, extracted)) throw new Error('Recovery archive path escapes extraction root');
        const bytes = await readFile(extracted);
        if (bytes.byteLength !== entry.sizeBytes || hash(bytes) !== entry.sha256) {
          throw new Error(`Recovery archive hash mismatch: ${entry.path}`);
        }
      }
    } finally {
      await rm(extractionRoot, { recursive: true, force: true });
    }
  }

  private async buildManifest(root: string, paths: string[]): Promise<UntrackedManifestEntry[]> {
    const entries: UntrackedManifestEntry[] = [];
    for (const path of paths) {
      if (path.startsWith('/') || path.includes('..') || path.includes('\\')) throw new Error('Invalid untracked path');
      const absolute = resolve(root, path);
      if (!isWithin(root, absolute)) throw new Error('Untracked path escapes worktree');
      const link = await lstat(absolute);
      const resolved = link.isSymbolicLink() ? await realpath(absolute) : absolute;
      if (!isWithin(root, resolved)) throw new Error('Untracked path escapes worktree');
      const file = await stat(resolved);
      if (!file.isFile()) throw new Error('Untracked path is not a regular file');
      const bytes = await readFile(resolved);
      entries.push({ path, sizeBytes: bytes.byteLength, sha256: hash(bytes) });
    }
    return entries;
  }
}

function parseManifest(bytes: Buffer): UntrackedManifestEntry[] {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Recovery manifest is not valid JSON'); }
  if (!Array.isArray(parsed)) throw new Error('Recovery manifest is not an array');
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Recovery manifest entry ${index} is invalid`);
    const value = item as Record<string, unknown>;
    if (typeof value.path !== 'string' || typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
      throw new Error(`Recovery manifest entry ${index} is invalid`);
    }
    if (value.path.startsWith('/') || value.path.includes('\\') || value.path.includes('..') || /^[A-Za-z]:/.test(value.path)) {
      throw new Error('Recovery manifest contains an unsafe path');
    }
    const pathValue = value.path;
    const sizeValue = value.sizeBytes;
    const shaValue = value.sha256;
    return { path: pathValue, sizeBytes: sizeValue, sha256: shaValue };
  });
}

function assertSafeTarListing(listing: string[], manifest: UntrackedManifestEntry[]): void {
  const expected = new Set(manifest.map(entry => entry.path.replaceAll('\\', '/')));
  const files = new Set<string>();
  for (const raw of listing) {
    const path = raw.replaceAll('\\', '/').replace(/\/$/, '');
    if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path === '..' || path.startsWith('../') || path.includes('/../')) {
      throw new Error('Recovery archive contains an unsafe path');
    }
    if (expected.has(path)) files.add(path);
    else if (!expected.has(path) && ![...expected].some(entry => entry.startsWith(`${path}/`))) {
      throw new Error(`Recovery archive contains an unexpected path: ${path}`);
    }
  }
  if (files.size !== expected.size) throw new Error('Recovery archive does not contain every manifest entry');
}

async function tarList(archivePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync('tar', ['-tf', archivePath], { timeout: 10000, windowsHide: true });
  return stdout.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

async function mkdirSafe(path: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path, { recursive: true });
}

function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function isWithin(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
function git(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('git', args, { cwd, timeout: 10000, windowsHide: true }).then(result => result.stdout);
}
function tar(cwd: string, output: string, paths: string[]): Promise<void> {
  return execFileAsync('tar', ['-cf', output, '-C', cwd, '--', ...paths], { cwd, timeout: 10000, windowsHide: true }).then(() => undefined);
}
