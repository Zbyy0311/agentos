import { createHash } from 'node:crypto';
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, unlinkSync, writeSync, type BigIntStats } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CollaborationCandidate, CollaborationTask } from '@agentos/shared';
import type { TransactionDatabase } from '../store/Transaction.js';
import { inTransaction } from '../store/Transaction.js';
import type { CollaborationControl } from '../store/CollaborationControlRepository.js';
import { captureCollaborationPathBoundary, assertCollaborationPathBoundaryUnchanged } from './CollaborationPathBoundary.js';
import { assertCollaborationPathsWithinScope, normalizeCollaborationScope } from './CollaborationScopePolicy.js';
import { CollaborationSnapshotGitContext } from './CollaborationSnapshotGitContext.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export class CollaborationApplyJournalError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export interface ApplyImage { path: string; pre: string | null; post: string | null; preMode: number | null; postMode: number | null }
export interface ApplyJournal {
  controlId: string; workspaceId: string; taskId: string; candidateId: string; candidateHash: string;
  baseCommit: string; targetRoot: string; recoveryPath: string; images: ApplyImage[];
  state: 'prepared' | 'written' | 'committed' | 'recovered' | 'recovery_required';
}
export interface ApplyJournalTestHooks {
  readonly beforePostMaterialization?: () => void | Promise<void>;
  readonly beforeWritePath?: (path: string) => void | Promise<void>;
}
interface FileImage { bytes: Buffer; mode: number }
interface DirectoryIdentity { realPath: string; mode: bigint; dev: bigint; ino: bigint }
type DirectoryGuards = Map<string, DirectoryIdentity | null>;
interface JournalRow {
  control_id: string; workspace_id: string; collaboration_task_id: string; candidate_id: string;
  candidate_hash: string; base_commit: string; recovery_path: string; images_json: string; state: ApplyJournal['state'];
}
const changed = () => new CollaborationApplyJournalError('COLLABORATION_SNAPSHOT_SOURCE_CHANGED', 'Application source or path changed');
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function readImage(file: string, assertBoundary?: () => void): FileImage | null {
  assertBoundary?.();
  let before: BigIntStats;
  try { before = lstatSync(file, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { assertBoundary?.(); return null; }
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new CollaborationApplyJournalError('COLLABORATION_PATH_BOUNDARY', 'Unsupported application path');
  const fd = openSync(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    if (!sameFile(before, fstatSync(fd, { bigint: true }))) throw changed();
    assertBoundary?.();
    const bytes = readFileSync(fd);
    if (!sameFile(before, fstatSync(fd, { bigint: true })) || !sameFile(before, lstatSync(file, { bigint: true }))) throw changed();
    assertBoundary?.();
    return { bytes, mode: Number(before.mode & 0o777n) };
  } finally { closeSync(fd); }
}
async function image(root: string, path: string): Promise<{ bytes: Buffer; mode: number } | null> {
  const guards = captureDirectories(root, [path]);
  return readImage(resolve(root, ...path.split('/')), () => checkDirectories(root, path, guards, false));
}
function digest(bytes: string | null): string | null { return bytes === null ? null : sha(Buffer.from(bytes, 'base64')); }
function matchesImage(current: FileImage | null, entry: ApplyImage, side: 'pre' | 'post'): boolean {
  return (current === null ? null : sha(current.bytes)) === digest(entry[side])
    && (process.platform === 'win32' || !current || (current.mode & 0o111) === ((entry[`${side}Mode`] ?? 0) & 0o111));
}
function directoryIdentity(path: string): DirectoryIdentity | null {
  let info: BigIntStats;
  try { info = lstatSync(path, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new CollaborationApplyJournalError('COLLABORATION_PATH_BOUNDARY', 'Application ancestor is not a real directory');
  return { realPath: realpathSync(path), mode: info.mode, dev: info.dev, ino: info.ino };
}
function parentPaths(root: string, path: string): string[] {
  const segments = path.split('/');
  return [resolve(root), ...segments.slice(0, -1).map((_, index) => resolve(root, ...segments.slice(0, index + 1)))];
}
function captureDirectories(root: string, paths: readonly string[]): DirectoryGuards {
  const guards: DirectoryGuards = new Map();
  for (const path of paths) for (const parent of parentPaths(root, path)) if (!guards.has(parent)) guards.set(parent, directoryIdentity(parent));
  return guards;
}
function checkDirectories(root: string, path: string, guards: DirectoryGuards, create: boolean): void {
  const rootGuard = guards.get(resolve(root));
  if (!rootGuard) throw changed();
  for (const parent of parentPaths(root, path)) {
    let current = directoryIdentity(parent);
    const expected = guards.get(parent);
    if (expected === undefined || (!!current !== !!expected)
      || (current && expected && (current.realPath !== expected.realPath || current.mode !== expected.mode
        || current.dev !== expected.dev || current.ino !== expected.ino))) throw changed();
    if (!current && create) {
      mkdirSync(parent);
      current = directoryIdentity(parent);
      guards.set(parent, current);
    }
    if (current) {
      const child = relative(rootGuard.realPath, current.realPath);
      if (current.dev !== rootGuard.dev || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) throw changed();
    }
  }
}
/** No await between the final path/content check and the native mutation. */
function writeImage(root: string, entry: ApplyImage, from: 'pre' | 'post', to: 'pre' | 'post', guards: DirectoryGuards): void {
  checkDirectories(root, entry.path, guards, false);
  const destination = resolve(root, ...entry.path.split('/'));
  if (!matchesImage(readImage(destination, () => checkDirectories(root, entry.path, guards, false)), entry, from)) throw changed();
  if (entry[to] === null) {
    if (entry[from] !== null) unlinkSync(destination);
    return;
  }
  checkDirectories(root, entry.path, guards, true);
  const exists = entry[from] !== null;
  const flags = exists ? constants.O_RDWR | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  const fd = openSync(destination, flags, entry[`${to}Mode`] ?? 0o644);
  try {
    const before = fstatSync(fd, { bigint: true });
    // A hardlink would make an exact-path write affect a different path too.
    if (!before.isFile() || before.nlink !== 1n || !sameFile(before, lstatSync(destination, { bigint: true }))) throw changed();
    checkDirectories(root, entry.path, guards, false);
    if (exists && !matchesImage({ bytes: readFileSync(fd), mode: Number(before.mode & 0o777n) }, entry, from)) throw changed();
    if (!sameFile(before, fstatSync(fd, { bigint: true })) || !sameFile(before, lstatSync(destination, { bigint: true }))) throw changed();
    checkDirectories(root, entry.path, guards, false);
    const bytes = Buffer.from(entry[to]!, 'base64');
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('Application write made no progress');
      offset += count;
    }
    ftruncateSync(fd, bytes.length);
    if (process.platform !== 'win32' && entry[`${to}Mode`] !== null) fchmodSync(fd, entry[`${to}Mode`]!);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/** Durable, exact-path recovery materials. This class never grants write authority. */
export class CollaborationApplyJournalService {
  private readonly recoveryRoot: string;
  constructor(private readonly db: TransactionDatabase) {
    const database = (db.prepare('PRAGMA database_list').all() as { name: string; file: string }[]).find(row => row.name === 'main');
    if (!database?.file) throw new Error('Application journal requires a persistent database');
    this.recoveryRoot = resolve(dirname(database.file), 'collaboration-apply-recovery');
  }

  async prepare(control: CollaborationControl, task: CollaborationTask, candidate: CollaborationCandidate, targetRoot: string,
    testHooks?: ApplyJournalTestHooks): Promise<ApplyJournal> {
    if (candidate.snapshotVersion !== 2 || candidate.diffHash !== sha(candidate.diffText) || !candidate.diffText.trim()) {
      throw new CollaborationApplyJournalError('COLLABORATION_CANDIDATE_INVALID', 'Only a complete frozen candidate can be applied');
    }
    const outside = relative(resolve(targetRoot), this.recoveryRoot);
    if (outside === '' || (!isAbsolute(outside) && outside !== '..' && !outside.startsWith(`..${sep}`))) {
      throw new CollaborationApplyJournalError('COLLABORATION_RECOVERY_PATH_INVALID', 'Recovery material must be outside the target repository');
    }
    const context = await CollaborationSnapshotGitContext.create(targetRoot);
    try {
      const head = await context.sourceMetadata(['rev-parse', 'HEAD']);
      if (head.toString('utf8').trim() !== candidate.baseCommit) throw changed();
      const realIndex = await context.sourceMetadata(['ls-files', '-s', '-z']);
      await context.run(['read-tree', candidate.baseCommit]);
      const baseIndex = await context.run(['ls-files', '-s', '-z']);
      if (!baseIndex.equals(realIndex)) throw new CollaborationApplyJournalError('COLLABORATION_CONFLICT', 'Application requires the unchanged base index');
      const indexEntries = (output: Buffer): Map<string, { mode: string; objectId: string }> => new Map(
        output.toString('utf8').split('\0').filter(Boolean).map(record => {
          const tab = record.indexOf('\t');
          const [mode, objectId, stage] = record.slice(0, tab).split(' ');
          if (tab < 0 || stage !== '0') throw new Error('Invalid application index entry');
          return [record.slice(tab + 1), { mode, objectId }];
        }),
      );
      const baseEntries = indexEntries(baseIndex);
      const patch = Buffer.from(candidate.diffText, 'utf8');
      await context.run(['apply', '--cached', '--check', '--binary', '--whitespace=nowarn', '-'], patch);
      await context.run(['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], patch);
      const postIndex = await context.run(['ls-files', '-s', '-z']);
      const entries = indexEntries(postIndex);
      const paths = (await context.run(['diff', '--cached', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', candidate.baseCommit]))
        .toString('utf8').split('\0').filter(Boolean);
      if (!paths.length) throw new CollaborationApplyJournalError('COLLABORATION_CANDIDATE_EMPTY', 'Candidate contains no changes');
      assertCollaborationPathsWithinScope(normalizeCollaborationScope(task.scope), paths);
      const checkedPaths = [...new Set(paths.flatMap(path => [path, ...path.split('/').map((_, index, segments) =>
        [...segments.slice(0, index), '.gitattributes'].join('/'))]))].sort();
      const witness = await captureCollaborationPathBoundary(targetRoot, checkedPaths);
      for (const path of checkedPaths) if ([entries.get(path), baseEntries.get(path)]
        .some(entry => entry && !['100644', '100755'].includes(entry.mode))) {
        throw new CollaborationApplyJournalError('COLLABORATION_PATH_BOUNDARY', 'Candidate contains a link, submodule or unsupported file');
      }
      // First prove the raw target is still the base under BASE clean semantics.
      // No Git content command reads from the active target checkout.
      await context.run(['read-tree', candidate.baseCommit]);
      await context.freezeCheckoutAttributes(checkedPaths);
      const preimages = new Map<string, FileImage | null>();
      for (const path of checkedPaths) {
        const before = await image(targetRoot, path);
        preimages.set(path, before);
        const base = baseEntries.get(path);
        if (!!before !== !!base || (before && base && ((await context.run(['hash-object', `--path=${path}`, '--stdin'], before.bytes))
          .toString('utf8').trim() !== base.objectId || (process.platform !== 'win32' && !!(before.mode & 0o111) !== (base.mode === '100755'))))) {
          throw new CollaborationApplyJournalError('COLLABORATION_CONFLICT', 'Application preimage no longer matches the approved base');
        }
      }
      await context.run(['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], patch);
      if (!(await context.run(['ls-files', '-s', '-z'])).equals(postIndex)) throw changed();
      // Attributes come from BASE + approved patch (including new attributes),
      // never raw copies from the live worktree. Unsupported drivers fail here
      // before checkout, while standard Git EOL/encoding remains authoritative.
      await context.freezeCheckoutAttributes(checkedPaths);
      const canonicalPatch = await context.run(['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-color',
        '--src-prefix=a/', '--dst-prefix=b/', '-M', candidate.baseCommit]);
      if (sha(canonicalPatch) !== candidate.diffHash) {
        throw new CollaborationApplyJournalError('COLLABORATION_CANDIDATE_INVALID', 'Frozen patch is not the current canonical snapshot; create and review a new candidate');
      }
      await testHooks?.beforePostMaterialization?.();
      await context.assertSourceContextUnchanged();
      const postPaths = paths.filter(path => entries.has(path));
      if (postPaths.length) await context.run(['checkout-index', '--stdin', '-z'], Buffer.from(`${postPaths.join('\0')}\0`));
      const images: ApplyImage[] = [];
      for (const path of paths) {
        const before = preimages.get(path)!;
        const post = entries.has(path) ? await context.readFrozenSource(path) : null;
        const postMode = post === null ? null : (before && baseEntries.get(path)?.mode === entries.get(path)?.mode
          ? before.mode : entries.get(path)?.mode === '100755' ? 0o755 : 0o644);
        images.push({ path, pre: before?.bytes.toString('base64') ?? null, post: post?.toString('base64') ?? null,
          preMode: before?.mode ?? null, postMode });
      }
      await assertCollaborationPathBoundaryUnchanged(targetRoot, witness);
      for (const path of checkedPaths) {
        const current = await image(targetRoot, path); const original = preimages.get(path)!;
        if ((current === null ? null : sha(current.bytes)) !== (original === null ? null : sha(original.bytes))
          || current?.mode !== original?.mode) throw changed();
      }
      await context.assertSourceContextUnchanged();
      if (!(await context.sourceMetadata(['rev-parse', 'HEAD'])).equals(head)
        || !(await context.sourceMetadata(['ls-files', '-s', '-z'])).equals(realIndex)) throw changed();
      await mkdir(this.recoveryRoot, { recursive: true });
      const recoveryPath = join(this.recoveryRoot, `${control.id}.json`);
      await captureCollaborationPathBoundary(this.recoveryRoot, [`${control.id}.json`]);
      const journal: ApplyJournal = { controlId: control.id, workspaceId: task.workspaceId, taskId: task.id, candidateId: candidate.id,
        candidateHash: candidate.diffHash, baseCommit: candidate.baseCommit, targetRoot: resolve(targetRoot), recoveryPath, images, state: 'prepared' };
      const serialized = JSON.stringify(journal);
      const file = await open(recoveryPath, 'wx', 0o600);
      try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
      const timestamp = new Date().toISOString();
      this.db.prepare(`INSERT INTO collaboration_apply_journals(control_id,workspace_id,collaboration_task_id,candidate_id,candidate_hash,base_commit,state,recovery_path,images_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'prepared',?,?,?,?)`).run(control.id, task.workspaceId, task.id, candidate.id, candidate.diffHash, candidate.baseCommit, recoveryPath,
        JSON.stringify({ recoveryHash: sha(serialized), paths: images.map(item => ({ path: item.path, pre: digest(item.pre), post: digest(item.post) })) }), timestamp, timestamp);
      return journal;
    } finally { await context.dispose(); }
  }

  setState(journal: ApplyJournal, state: ApplyJournal['state']): void {
    const result = this.db.prepare('UPDATE collaboration_apply_journals SET state = ?, updated_at = ? WHERE control_id = ? AND workspace_id = ? AND candidate_hash = ?')
      .run(state, new Date().toISOString(), journal.controlId, journal.workspaceId, journal.candidateHash) as { changes: number };
    if (result.changes !== 1) throw new CollaborationApplyJournalError('COLLABORATION_CONFLICT', 'Apply journal changed');
    journal.state = state;
  }

  private async verifiedMaterial(row: JournalRow): Promise<ApplyJournal> {
    if (resolve(row.recovery_path) !== join(this.recoveryRoot, `${row.control_id}.json`)) throw new Error('Unsafe recovery path');
    const witness = await captureCollaborationPathBoundary(this.recoveryRoot, [`${row.control_id}.json`]);
    const recovery = await image(this.recoveryRoot, `${row.control_id}.json`);
    if (!recovery) throw new Error('Application recovery material missing');
    const bytes = recovery.bytes.toString('utf8');
    const summary = JSON.parse(row.images_json);
    await assertCollaborationPathBoundaryUnchanged(this.recoveryRoot, witness);
    if (sha(bytes) !== summary.recoveryHash) throw new Error('Recovery material changed');
    const journal = JSON.parse(bytes) as ApplyJournal;
    if (journal.controlId !== row.control_id || journal.workspaceId !== row.workspace_id
      || journal.taskId !== row.collaboration_task_id || journal.candidateId !== row.candidate_id
      || journal.baseCommit !== row.base_commit || resolve(journal.recoveryPath) !== resolve(row.recovery_path)
      || journal.candidateHash !== row.candidate_hash || !Array.isArray(journal.images) || !journal.images.length
      || !isAbsolute(journal.targetRoot)) throw new Error('Recovery association mismatch');
    const paths = new Set<string>();
    for (const entry of journal.images) {
      if (typeof entry.path !== 'string' || paths.has(entry.path)) throw new Error('Invalid recovery image');
      paths.add(entry.path);
      for (const side of ['pre', 'post'] as const) {
        const bytes = entry[side]; const mode = entry[`${side}Mode`];
        if (bytes !== null && (typeof bytes !== 'string' || Buffer.from(bytes, 'base64').toString('base64') !== bytes)
          || (bytes === null ? mode !== null : !Number.isInteger(mode) || mode === null || mode < 0 || mode > 0o777)) {
          throw new Error('Invalid recovery image');
        }
      }
    }
    if (JSON.stringify(summary.paths) !== JSON.stringify(journal.images.map(entry => ({ path: entry.path, pre: digest(entry.pre), post: digest(entry.post) })))) {
      throw new Error('Recovery image summary changed');
    }
    // Validate persisted paths before any target reads (including corrupt data).
    await captureCollaborationPathBoundary(journal.targetRoot, journal.images.map(entry => entry.path));
    journal.state = row.state;
    return journal;
  }

  private async exactMaterial(journal: ApplyJournal): Promise<ApplyJournal> {
    const row = this.db.prepare('SELECT * FROM collaboration_apply_journals WHERE workspace_id = ? AND control_id = ?')
      .get(journal.workspaceId, journal.controlId) as JournalRow | undefined;
    if (!row) throw new Error('Application recovery material missing');
    const persisted = await this.verifiedMaterial(row);
    const binding = (item: ApplyJournal) => JSON.stringify({ controlId: item.controlId, workspaceId: item.workspaceId,
      taskId: item.taskId, candidateId: item.candidateId, candidateHash: item.candidateHash, baseCommit: item.baseCommit,
      targetRoot: item.targetRoot, recoveryPath: item.recoveryPath, images: item.images });
    if (binding(persisted) !== binding(journal)) throw new Error('Recovery association mismatch');
    return persisted;
  }

  private assertWritableOwner(journal: ApplyJournal): void {
    const facts = this.db.prepare('SELECT c.state, c.action, c.candidate_id, c.epoch, c.expected_version,'
      + ' t.control_epoch, t.version, t.current_candidate_id FROM collaboration_controls c'
      + ' JOIN collaboration_tasks t ON t.workspace_id = c.workspace_id AND t.id = c.collaboration_task_id'
      + ' WHERE c.workspace_id = ? AND c.id = ? AND c.collaboration_task_id = ?')
      .get(journal.workspaceId, journal.controlId, journal.taskId) as {
        state: string; action: string; candidate_id: string | null; current_candidate_id: string | null;
        epoch: number; expected_version: number; control_epoch: number; version: number;
      } | undefined;
    if (!facts || !['reserved', 'running'].includes(facts.state) || facts.action !== 'apply'
      || facts.candidate_id !== journal.candidateId || facts.current_candidate_id !== journal.candidateId
      || facts.epoch !== facts.control_epoch || facts.expected_version !== facts.version) {
      throw new CollaborationApplyJournalError('COLLABORATION_CONFLICT', 'Application control ownership changed');
    }
  }

  /** Caller must hold admission and assertOwned. This method grants no authority. */
  async writePrepared(journal: ApplyJournal, testHooks?: ApplyJournalTestHooks): Promise<void> {
    const material = await this.exactMaterial(journal);
    if (material.state !== 'prepared') throw new CollaborationApplyJournalError('COLLABORATION_CONFLICT', 'Journal is not prepared; do not replay a write');
    const paths = material.images.map(entry => entry.path);
    const witness = await captureCollaborationPathBoundary(material.targetRoot, paths);
    const guards = captureDirectories(material.targetRoot, paths);
    const context = await CollaborationSnapshotGitContext.create(material.targetRoot);
    try {
      const head = await context.sourceMetadata(['rev-parse', 'HEAD']);
      if (head.toString('utf8').trim() !== material.baseCommit) throw changed();
      const index = await context.sourceMetadata(['ls-files', '-s', '-z']);
      await context.run(['read-tree', material.baseCommit]);
      if (!(await context.run(['ls-files', '-s', '-z'])).equals(index)) throw changed();
      // Validate every preimage first: no earlier path is written when a later
      // path already contains foreign data. Hooks exercise subsequent races.
      for (const entry of material.images) if (!matchesImage(await image(material.targetRoot, entry.path), entry, 'pre')) throw changed();
      await assertCollaborationPathBoundaryUnchanged(material.targetRoot, witness);
      for (const entry of material.images) {
        await testHooks?.beforeWritePath?.(entry.path);
        if ((await this.exactMaterial(material)).state !== 'prepared') throw changed();
        const [currentHead, currentIndex] = await Promise.all([
          context.sourceMetadata(['rev-parse', 'HEAD']), context.sourceMetadata(['ls-files', '-s', '-z']),
        ]);
        if (!currentHead.equals(head) || !currentIndex.equals(index)) throw changed();
        this.assertWritableOwner(material);
        writeImage(material.targetRoot, entry, 'pre', 'post', guards);
      }
      for (const entry of material.images) {
        checkDirectories(material.targetRoot, entry.path, guards, false);
        if (!matchesImage(await image(material.targetRoot, entry.path), entry, 'post')) throw changed();
      }
      if (!(await context.sourceMetadata(['rev-parse', 'HEAD'])).equals(head)
        || !(await context.sourceMetadata(['ls-files', '-s', '-z'])).equals(index)) throw changed();
      await context.assertSourceContextUnchanged();
      await this.exactMaterial(material);
      // The caller records 'written'; errors preserve the original material so
      // it can prove and restore a per-path mixture of our pre/post images.
    } finally { await context.dispose(); }
  }

  async matches(journal: ApplyJournal, side: 'pre' | 'post'): Promise<boolean> {
    await this.exactMaterial(journal);
    const witness = await captureCollaborationPathBoundary(journal.targetRoot, journal.images.map(item => item.path));
    for (const entry of journal.images) {
      const current = await image(journal.targetRoot, entry.path);
      if ((current === null ? null : sha(current.bytes)) !== digest(entry[side])) return false;
      if (process.platform !== 'win32' && current && (current.mode & 0o111) !== ((entry[`${side}Mode`] ?? 0) & 0o111)) return false;
    }
    await assertCollaborationPathBoundaryUnchanged(journal.targetRoot, witness);
    return true;
  }

  /** Validate ALL paths as owned pre/post images before restoring ANY path. */
  async rollback(journal: ApplyJournal, finalizeRecovery?: () => void): Promise<boolean> {
    const material = await this.exactMaterial(journal);
    if (material.state === 'committed') throw new CollaborationApplyJournalError('COLLABORATION_CONFLICT', 'Committed application cannot be rolled back');
    const commitRecovery = (): void => {
      const previousState = journal.state;
      try {
        inTransaction(this.db, () => {
          this.setState(journal, 'recovered');
          // Filesystem verification precedes this short synchronous transaction;
          // the journal and its owning control must become terminal together.
          finalizeRecovery?.();
        });
      } catch (error) {
        journal.state = previousState;
        throw error;
      }
    };
    const paths = material.images.map(entry => entry.path);
    const witness = await captureCollaborationPathBoundary(material.targetRoot, paths);
    const guards = captureDirectories(material.targetRoot, paths);
    const context = await CollaborationSnapshotGitContext.create(material.targetRoot);
    try {
      if ((await context.sourceMetadata(['rev-parse', 'HEAD'])).toString('utf8').trim() !== material.baseCommit) throw changed();
      for (const entry of material.images) {
        const current = await image(material.targetRoot, entry.path);
        if (!matchesImage(current, entry, 'pre') && !matchesImage(current, entry, 'post')) throw changed();
      }
      await assertCollaborationPathBoundaryUnchanged(material.targetRoot, witness);
      for (const entry of material.images) {
        checkDirectories(material.targetRoot, entry.path, guards, false);
        const current = await image(material.targetRoot, entry.path);
        if (matchesImage(current, entry, 'pre')) continue;
        writeImage(material.targetRoot, entry, 'post', 'pre', guards);
      }
      if (!await this.matches(journal, 'pre')) throw changed();
      await this.syncImages(journal, 'pre');
    } catch {
      this.setState(journal, 'recovery_required');
      return false;
    } finally { await context.dispose(); }
    commitRecovery(); return true;
  }

  async syncImages(journal: ApplyJournal, side: 'pre' | 'post'): Promise<void> {
    await this.exactMaterial(journal);
    await captureCollaborationPathBoundary(journal.targetRoot, journal.images.map(item => item.path));
    const guards = captureDirectories(journal.targetRoot, journal.images.map(item => item.path));
    for (const entry of journal.images) {
      if (entry[side] === null) continue;
      checkDirectories(journal.targetRoot, entry.path, guards, false);
      const path = resolve(journal.targetRoot, ...entry.path.split('/'));
      if (!matchesImage(readImage(path), entry, side)) throw changed();
      const before = lstatSync(path, { bigint: true });
      const fd = openSync(path, constants.O_RDWR | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
      try {
        if (!sameFile(before, fstatSync(fd, { bigint: true }))) throw changed();
        checkDirectories(journal.targetRoot, entry.path, guards, false);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
  }

  async loadPending(): Promise<ApplyJournal[]> {
    const rows = this.db.prepare(
      "SELECT j.* FROM collaboration_apply_journals j"
        + " LEFT JOIN collaboration_controls c ON c.workspace_id = j.workspace_id AND c.id = j.control_id"
        + " WHERE j.state IN ('prepared','written','recovery_required')"
        + " OR (j.state IN ('committed','recovered') AND c.state IN ('reserved','running','recovery_required'))"
        + " ORDER BY j.created_at,j.control_id",
    ).all() as JournalRow[];
    const result: ApplyJournal[] = [];
    for (const row of rows) {
      result.push(await this.verifiedMaterial(row));
    }
    return result;
  }
}
