import { createHash } from 'node:crypto';
import { redactRuntimeText } from '@agentos/agent-core';
import type { CollaborationCandidate, CollaborationTask } from '@agentos/shared';
import { assertCollaborationPathsWithinScope, normalizeCollaborationScope } from './CollaborationScopePolicy.js';
import { collaborationCandidateContentHash } from './CollaborationCandidateContentHash.js';

export const MAX_COLLABORATION_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_COLLABORATION_PREVIEW_FILES = 500;
export const MAX_COLLABORATION_PREVIEW_PAGE_SIZE = 50;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const PRIVATE_KEY_HEADER = /-----BEGIN [^-\r\n]*PRIVATE KEY-----/iu;
const AUTH_OR_COOKIE_HEADER = /^\s*(?:authorization|cookie|set-cookie)\s*:/iu;
const SENSITIVE_PATH = /(?:^|\/)(?:\.env[^/]*|\.npmrc|\.pypirc|(?:credentials?|secrets?|tokens?|passwords?|private)|id_(?:rsa|ed25519)|authorized_keys|known_hosts|[^/]+\.(?:pem|key|p12|pfx|keystore))$/iu;
const SENSITIVE_ASSIGNMENT = /(?<![\w])((?:[\w.-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd|secret|credential|private[_-]?key|client[_-]?secret|authorization|cookie)[\w.-]*))\s*([:=])\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;}\]]+))/giu;
const TOKEN_VALUE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/gu;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/iu;
const WINDOWS_INVALID_PATH_CHARACTER = /[<>:"|*?\[\]{}]/u;
const AMBIGUOUS_SLASH = /[\u2044\u2215\u29F8\uFF0F]/u;

export type CollaborationPreviewFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ParsedCollaborationDiffFile {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly status: CollaborationPreviewFileStatus;
  readonly binary: boolean;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly lines: readonly string[];
  readonly hunkBodyLineIndexes: ReadonlySet<number>;
  readonly binaryMarkerIndex: number | undefined;
  readonly oldObjectId?: string;
  readonly newObjectId?: string;
}

export interface CollaborationCandidatePreviewFile {
  readonly fileIndex: number;
  readonly path: string;
  readonly oldPath?: string;
  readonly status: CollaborationPreviewFileStatus;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
  readonly withheld: boolean;
  readonly binarySizeBytes?: number;
  readonly binarySha256?: string;
  /** False for older frozen candidates whose binary digest was never persisted. */
  readonly binarySha256Available?: boolean;
  readonly binaryGitObjectId?: string;
  readonly baseSizeBytes?: number;
  readonly baseSha256?: string;
  readonly baseSha256Available?: boolean;
  readonly baseGitObjectId?: string;
}

export interface CollaborationCandidatePreview {
  readonly workspaceId: string;
  readonly collaborationTaskId: string;
  readonly candidateId: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly snapshotVersion: number;
  readonly manifestVersion: number;
  readonly diffHash: string;
  readonly contentHash: string;
  readonly offset: number;
  readonly nextOffset?: number;
  readonly totalFiles: number;
  readonly totalAdditions: number;
  readonly totalDeletions: number;
  readonly files: readonly CollaborationCandidatePreviewFile[];
  readonly withheldContent: boolean;
  readonly withheldReasons: readonly ('binary' | 'sensitive_path' | 'secret_value')[];
}

export interface CollaborationCandidatePreviewFileDiff {
  readonly workspaceId: string;
  readonly collaborationTaskId: string;
  readonly candidateId: string;
  readonly baseCommit: string;
  readonly manifestVersion: number;
  readonly diffHash: string;
  readonly contentHash: string;
  readonly fileIndex: number;
  readonly path: string;
  /** Sanitized display text for this file only; never the applyable patch. */
  readonly diffText: string;
  readonly withheld: boolean;
  readonly withheldReason?: 'binary' | 'sensitive_path' | 'secret_value';
}

export type CollaborationCandidatePreviewSource = Pick<CollaborationCandidate,
  'id' | 'workspaceId' | 'collaborationTaskId' | 'baseCommit' | 'headCommit' | 'snapshotVersion'
  | 'manifestVersion' | 'diffHash' | 'diffText' | 'contentHash' | 'manifest'>;

export class CollaborationCandidatePreviewError extends Error {
  constructor(readonly code: 'COLLABORATION_CANDIDATE_INVALID' | 'COLLABORATION_DIFF_TOO_LARGE', message: string) {
    super(`${code}: ${message}`);
    this.name = 'CollaborationCandidatePreviewError';
  }
}

function invalid(message: string): never {
  throw new CollaborationCandidatePreviewError('COLLABORATION_CANDIDATE_INVALID', message);
}

function parseGitToken(source: string, start: number): { value: string; next: number } {
  if (source[start] !== '"') {
    let end = start;
    while (end < source.length && source[end] !== ' ') end += 1;
    if (end === start) invalid('diff contains an empty path token');
    return { value: source.slice(start, end), next: end };
  }

  const bytes: number[] = [];
  let index = start + 1;
  while (index < source.length) {
    const character = source[index]!;
    if (character === '"') return { value: Buffer.from(bytes).toString('utf8'), next: index + 1 };
    if (character !== '\\') {
      const point = String.fromCodePoint(source.codePointAt(index)!);
      bytes.push(...Buffer.from(point, 'utf8'));
      index += point.length;
      continue;
    }

    index += 1;
    const escaped = source[index];
    if (escaped === undefined) invalid('diff contains a truncated quoted path');
    const simpleEscapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
    if (Object.hasOwn(simpleEscapes, escaped)) {
      bytes.push(simpleEscapes[escaped]!);
      index += 1;
      continue;
    }
    if (/[0-7]/u.test(escaped)) {
      let octal = escaped;
      index += 1;
      for (let count = 1; count < 3 && /[0-7]/u.test(source[index] ?? ''); count += 1) {
        octal += source[index]!;
        index += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    invalid('diff contains an unsupported quoted path escape');
  }
  return invalid('diff contains an unterminated quoted path');
}

function decodeSingleGitPath(value: string): string {
  const trimmed = value.trim();
  const token = parseGitToken(trimmed, 0);
  if (token.next !== trimmed.length) invalid('diff contains trailing data after a path');
  return token.value;
}

function sidePath(value: string, side: 'a' | 'b'): string | null {
  const path = decodeSingleGitPath(value);
  if (path === '/dev/null') return null;
  const prefix = `${side}/`;
  if (!path.startsWith(prefix)) invalid('diff contains a path with an invalid side prefix');
  return path.slice(prefix.length);
}

function parseDiffHeader(line: string): { oldPath: string; newPath: string } {
  const prefix = 'diff --git ';
  if (!line.startsWith(prefix)) invalid('diff is missing a Git file header');
  const oldToken = parseGitToken(line, prefix.length);
  if (line[oldToken.next] !== ' ') invalid('diff file header is malformed');
  const newToken = parseGitToken(line, oldToken.next + 1);
  if (newToken.next !== line.length || !oldToken.value.startsWith('a/') || !newToken.value.startsWith('b/')) {
    invalid('diff file header has invalid path prefixes');
  }
  return { oldPath: oldToken.value.slice(2), newPath: newToken.value.slice(2) };
}

function assertSafePreviewPath(path: string): void {
  const segments = path.split('/');
  if (path.length === 0 || path !== path.trim() || path.startsWith('/') || path.includes('\\') || path.includes(':')
    || /^[A-Za-z]:/u.test(path) || /[\u0000-\u001f\u007f]/u.test(path)
    || WINDOWS_INVALID_PATH_CHARACTER.test(path) || AMBIGUOUS_SLASH.test(path)
    || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git'
      || segment !== segment.trim() || /[. ]$/u.test(segment) || WINDOWS_DEVICE_NAME.test(segment))) {
    invalid('frozen diff contains an unsafe path');
  }
}

function parseHunkCounts(line: string): { oldCount: number; newCount: number } | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(line);
  if (!match) return undefined;
  const oldCount = Number(match[2] ?? 1);
  const newCount = Number(match[4] ?? 1);
  if (!Number.isSafeInteger(oldCount) || !Number.isSafeInteger(newCount) || oldCount + newCount === 0) {
    invalid('diff contains invalid hunk counts');
  }
  return { oldCount, newCount };
}

function parseFileSection(lines: string[]): ParsedCollaborationDiffFile {
  const header = parseDiffHeader(lines[0] ?? '');
  let oldPath: string | null = header.oldPath;
  let newPath: string | null = header.newPath;
  let addedByMode = false;
  let deletedByMode = false;
  let rename = false;
  let binaryMarkerIndex: number | undefined;
  let binaryBlocks = 0;
  let oldObjectId: string | undefined;
  let newObjectId: string | undefined;
  let additions = 0;
  let deletions = 0;
  const hunkBodyLineIndexes = new Set<number>();
  let activeHunk: { oldCount: number; newCount: number; oldUsed: number; newUsed: number } | undefined;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (activeHunk && activeHunk.oldUsed === activeHunk.oldCount && activeHunk.newUsed === activeHunk.newCount) activeHunk = undefined;
    if (line === 'new file mode 100644' || line === 'new file mode 100755') addedByMode = true;
    if (line === 'deleted file mode 100644' || line === 'deleted file mode 100755') deletedByMode = true;
    if (line.startsWith('rename from ')) { oldPath = decodeSingleGitPath(line.slice('rename from '.length)); rename = true; }
    if (line.startsWith('rename to ')) { newPath = decodeSingleGitPath(line.slice('rename to '.length)); rename = true; }
    if (line.startsWith('--- ')) oldPath = sidePath(line.slice(4), 'a');
    if (line.startsWith('+++ ')) newPath = sidePath(line.slice(4), 'b');
    if (line === 'GIT binary patch' || line.startsWith('Binary files ')) binaryMarkerIndex ??= index;
    if (/^(?:literal|delta) \d+$/u.test(line)) binaryBlocks += 1;
    if (line.startsWith('index ')) {
      const match = /^index ([a-f0-9]{40}|[a-f0-9]{64})\.\.([a-f0-9]{40}|[a-f0-9]{64})(?: \d+)?$/iu.exec(line);
      if (!match || match[1]!.length !== match[2]!.length) invalid('diff contains an invalid full Git object identity');
      oldObjectId = match[1]!.toLowerCase();
      newObjectId = match[2]!.toLowerCase();
    }

    const hunk = parseHunkCounts(line);
    if (hunk) {
      if (activeHunk) invalid('diff contains an incomplete hunk');
      activeHunk = { ...hunk, oldUsed: 0, newUsed: 0 };
      continue;
    }
    if (!activeHunk) continue;
    if (line.startsWith('\\')) {
      hunkBodyLineIndexes.add(index);
      continue;
    }
    const prefix = line[0];
    if (prefix !== ' ' && prefix !== '+' && prefix !== '-') {
      invalid('diff contains an incomplete hunk');
    }
    hunkBodyLineIndexes.add(index);
    if (prefix === ' ') { activeHunk.oldUsed += 1; activeHunk.newUsed += 1; }
    if (prefix === '+') { activeHunk.newUsed += 1; additions += 1; }
    if (prefix === '-') { activeHunk.oldUsed += 1; deletions += 1; }
    if (activeHunk.oldUsed > activeHunk.oldCount || activeHunk.newUsed > activeHunk.newCount) {
      invalid('diff hunk exceeds its declared line counts');
    }
  }
  if (activeHunk && (activeHunk.oldUsed !== activeHunk.oldCount || activeHunk.newUsed !== activeHunk.newCount)) {
    invalid('diff ends with an incomplete hunk');
  }
  if (binaryMarkerIndex !== undefined && binaryBlocks === 0 && lines[binaryMarkerIndex] === 'GIT binary patch') {
    invalid('binary diff has no frozen payload block');
  }
  if (addedByMode) oldPath = null;
  if (deletedByMode) newPath = null;
  if (oldPath === null && newPath === null) invalid('diff file has no source or destination path');
  const status: CollaborationPreviewFileStatus = oldPath === null ? 'added'
    : newPath === null ? 'deleted'
      : rename || oldPath !== newPath ? 'renamed' : 'modified';
  return {
    oldPath, newPath, status, binary: binaryMarkerIndex !== undefined,
    additions: binaryMarkerIndex === undefined ? additions : null,
    deletions: binaryMarkerIndex === undefined ? deletions : null,
    lines, hunkBodyLineIndexes, binaryMarkerIndex,
    ...(oldObjectId === undefined ? {} : { oldObjectId }),
    ...(newObjectId === undefined ? {} : { newObjectId }),
  };
}

/** Parse only the persisted Git patch; this function performs no file or Git access. */
export function parseCollaborationCandidateDiff(diffText: string): ParsedCollaborationDiffFile[] {
  if (typeof diffText !== 'string' || diffText.length === 0) invalid('frozen diff is empty');
  if (Buffer.byteLength(diffText, 'utf8') > MAX_COLLABORATION_PREVIEW_BYTES) {
    throw new CollaborationCandidatePreviewError('COLLABORATION_DIFF_TOO_LARGE', 'frozen diff exceeds the preview limit');
  }
  const lines = diffText.replace(/\r\n/gu, '\n').split('\n');
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) if (lines[index]!.startsWith('diff --git ')) starts.push(index);
  if (starts.length === 0 || lines.slice(0, starts[0]).some(line => line.trim().length > 0)) invalid('frozen diff has no complete Git file sections');
  if (starts.length > MAX_COLLABORATION_PREVIEW_FILES) {
    throw new CollaborationCandidatePreviewError('COLLABORATION_DIFF_TOO_LARGE', 'frozen diff has too many files to preview safely');
  }
  return starts.map((start, index) => parseFileSection(lines.slice(start, starts[index + 1] ?? lines.length)));
}

function validManifest(
  candidate: Pick<CollaborationCandidate, 'manifest' | 'manifestVersion'>,
  files: readonly ParsedCollaborationDiffFile[],
  task: CollaborationTask,
) {
  const manifestVersion = candidate.manifestVersion ?? 1;
  if (manifestVersion !== 1 && manifestVersion !== 2) invalid('frozen file manifest version is invalid');
  if (!Array.isArray(candidate.manifest) || candidate.manifest.length > MAX_COLLABORATION_PREVIEW_FILES) invalid('frozen file manifest is incomplete');
  const scope = normalizeCollaborationScope(task.scope);
  const changedPaths = files.flatMap(file => [file.oldPath, file.newPath]).filter((path): path is string => path !== null);
  try { assertCollaborationPathsWithinScope(scope, changedPaths); }
  catch { invalid('frozen diff contains a path outside the approved scope'); }
  for (const path of changedPaths) assertSafePreviewPath(path);

  const changedPathSet = new Set(changedPaths);
  const manifest = new Map<string, CollaborationCandidate['manifest'][number]>();
  for (const item of candidate.manifest) {
    if (!item || typeof item.path !== 'string' || !changedPathSet.has(item.path)
      || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0
      || (item.sha256 !== undefined && (typeof item.sha256 !== 'string' || !HASH_PATTERN.test(item.sha256)))
      || (item.gitObjectId !== undefined && (typeof item.gitObjectId !== 'string' || !GIT_OBJECT_ID_PATTERN.test(item.gitObjectId)))
      || (item.sha256 === undefined && item.gitObjectId === undefined)
      || (item.deleted !== undefined && typeof item.deleted !== 'boolean')
      || (item.baseSha256 !== undefined && (typeof item.baseSha256 !== 'string' || !HASH_PATTERN.test(item.baseSha256)))
      || (item.baseObjectId !== undefined && (typeof item.baseObjectId !== 'string' || !GIT_OBJECT_ID_PATTERN.test(item.baseObjectId)))
      || (item.binary !== undefined && typeof item.binary !== 'boolean')
      || (item.baseSizeBytes === undefined && (item.baseSha256 !== undefined || item.baseObjectId !== undefined))
      || (item.baseSizeBytes !== undefined && (!Number.isSafeInteger(item.baseSizeBytes) || item.baseSizeBytes < 0
        || (item.baseSha256 === undefined && item.baseObjectId === undefined)))) {
      invalid('frozen file manifest contains an invalid or unrelated entry');
    }
    assertSafePreviewPath(item.path);
    if (manifest.has(item.path)) invalid('frozen file manifest contains duplicate paths');
    manifest.set(item.path, item);
  }

  for (const file of files) {
    const metadataPath = file.status === 'deleted' ? file.oldPath : file.newPath;
    const item = metadataPath ? manifest.get(metadataPath) : undefined;
    if (manifestVersion === 2 && file.status === 'renamed' && (!item || typeof item.binary !== 'boolean')) {
      invalid('new frozen rename is missing its explicit binary classification');
    }
    if (manifestVersion === 2 && file.binary && item?.binary !== true) {
      invalid('new binary file is missing its frozen manifest image');
    }
    if (manifestVersion === 2 && file.status === 'deleted' && file.binary && item?.deleted !== true) {
      invalid('new deleted binary file is missing its frozen baseline marker');
    }
    if (!file.binary && item?.binary !== true) continue;
    // Candidates frozen before this manifest field was introduced may not have
    // binary hashes. Their stored contentHash still protects the exact legacy
    // manifest, so render them with an explicit "unavailable" label.
    if (manifestVersion === 2 && item?.binary === true && (item.sha256 === undefined || item.gitObjectId === undefined)) {
      invalid('new binary file metadata is missing its frozen SHA-256 or Git blob ID');
    }
    if (file.status === 'deleted' && item?.deleted !== undefined && item.deleted !== true) invalid('deleted binary file metadata is incomplete');
    if (file.status !== 'deleted' && item?.deleted === true) invalid('binary candidate metadata marks a present file as deleted');
    if (file.oldObjectId && file.newObjectId && item?.gitObjectId !== undefined) {
      const zeroObjectId = '0'.repeat(file.oldObjectId.length);
      const expectedCandidateObjectId = file.status === 'deleted' ? file.oldObjectId : file.newObjectId;
      if (item.gitObjectId.toLowerCase() !== expectedCandidateObjectId
        || (file.status === 'deleted' ? file.newObjectId !== zeroObjectId : file.newObjectId === zeroObjectId)) {
        invalid('binary file metadata does not match the frozen patch object identity');
      }
    }
    if ((file.status === 'modified' || file.status === 'renamed') && file.oldPath !== null
      && item?.binary === true && (item.baseSizeBytes === undefined || item.baseSha256 === undefined || item.baseObjectId === undefined)) {
      invalid('binary base image metadata is missing');
    }
    if ((file.status === 'modified' || file.status === 'renamed') && file.oldPath !== null
      && file.oldObjectId && item?.baseObjectId !== undefined && item.baseObjectId.toLowerCase() !== file.oldObjectId) {
      invalid('binary baseline metadata does not match the frozen patch object identity');
    }
  }
  return manifest;
}

function sanitizePreviewText(value: string): { text: string; withheld: boolean } {
  let text = value;
  const original = text;
  text = text.replace(AUTH_OR_COOKIE_HEADER, '[认证或 Cookie 内容已隐藏]');
  if (PRIVATE_KEY_HEADER.test(text)) return { text: '[私钥内容已隐藏]', withheld: true };
  text = text.replace(SENSITIVE_ASSIGNMENT, (match, key: string, separator: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
    const secret = doubleQuoted ?? singleQuoted ?? bare ?? '';
    if (/^\$\{[A-Z][A-Z0-9_]*\}$/u.test(secret)) return match;
    return `${key}${separator}${doubleQuoted !== undefined ? '"[REDACTED]"' : singleQuoted !== undefined ? "'[REDACTED]'" : '[REDACTED]'}`;
  });
  text = redactRuntimeText(text, Number.MAX_SAFE_INTEGER);
  text = text.replace(TOKEN_VALUE, '[REDACTED]');
  text = text.replace(/(https?:\/\/[^:/\s]+:)[^@/\s]+(@)/giu, '$1[REDACTED]$2');
  return { text, withheld: text !== original };
}

function isSensitiveFilePath(path: string): boolean {
  return SENSITIVE_PATH.test(path) || path.split('/').some(segment =>
    /^(?:secrets?|credentials?|tokens?|passwords?|private)$/iu.test(segment)
    || /(?:^|[._-])(?:secret|credential|token|password|private[_-]?key)(?:[._-]|$)/iu.test(segment));
}

function displayPath(path: string | null): string | null {
  if (path === null) return null;
  if (isSensitiveFilePath(path)) return '[敏感路径已隐藏]';
  return sanitizePreviewText(path).text;
}

function renderDiffFile(file: ParsedCollaborationDiffFile, metadata: CollaborationCandidate['manifest'][number] | undefined): { text: string; withheldReason?: 'binary' | 'sensitive_path' | 'secret_value' } {
  if (file.binary) {
    return { text: '[二进制内容已隐藏；文件大小与 SHA-256 请查看冻结 manifest]', withheldReason: 'binary' };
  }
  const isSensitivePath = [file.oldPath, file.newPath].some(path => path !== null && isSensitiveFilePath(path));
  const hasPrivateOrAuthMaterial = file.hunkBodyLineIndexes.size > 0 && [...file.hunkBodyLineIndexes]
    .some(index => PRIVATE_KEY_HEADER.test(file.lines[index]!.slice(1)) || AUTH_OR_COOKIE_HEADER.test(file.lines[index]!.slice(1)));
  const lines: string[] = [];
  let secretLineWithheld = false;

  for (let index = 0; index < file.lines.length; index += 1) {
    const line = file.lines[index]!;
    if (file.binaryMarkerIndex !== undefined && index === file.binaryMarkerIndex) {
      lines.push('[二进制内容已隐藏；文件大小与 SHA-256 请查看冻结 manifest]');
      break;
    }
    if (file.binaryMarkerIndex !== undefined && index > file.binaryMarkerIndex) break;
    if (file.hunkBodyLineIndexes.has(index) && (isSensitivePath || hasPrivateOrAuthMaterial)) {
      const prefix = line[0] === '\\' ? '\\' : line[0] ?? ' ';
      lines.push(`${prefix}[内容已隐藏：${isSensitivePath ? '敏感文件' : '认证字段'}]`);
      continue;
    }
    if (file.hunkBodyLineIndexes.has(index)) {
      const prefix = line[0] ?? '';
      const sanitized = sanitizePreviewText(line.slice(1));
      if (sanitized.withheld) secretLineWithheld = true;
      lines.push(`${prefix}${sanitized.text}`);
      continue;
    }
    let displayLine = line;
    if (line.startsWith('diff --git ')) {
      const oldDisplay = displayPath(file.oldPath) ?? displayPath(file.newPath) ?? '[path hidden]';
      const newDisplay = displayPath(file.newPath) ?? displayPath(file.oldPath) ?? '[path hidden]';
      displayLine = `diff --git a/${oldDisplay} b/${newDisplay}`;
    } else if (line.startsWith('--- ')) {
      displayLine = file.oldPath === null ? '--- /dev/null' : `--- a/${displayPath(file.oldPath)}`;
    } else if (line.startsWith('+++ ')) {
      displayLine = file.newPath === null ? '+++ /dev/null' : `+++ b/${displayPath(file.newPath)}`;
    } else if (line.startsWith('rename from ')) {
      displayLine = `rename from ${displayPath(file.oldPath)}`;
    } else if (line.startsWith('rename to ')) {
      displayLine = `rename to ${displayPath(file.newPath)}`;
    }
    const sanitized = sanitizePreviewText(displayLine);
    if (sanitized.withheld) secretLineWithheld = true;
    lines.push(sanitized.text);
  }

  if (isSensitivePath || hasPrivateOrAuthMaterial) {
    return { text: lines.join('\n'), withheldReason: isSensitivePath ? 'sensitive_path' : 'secret_value' };
  }
  return { text: lines.join('\n'), ...(secretLineWithheld ? { withheldReason: 'secret_value' as const } : {}) };
}

function validatedPreviewFiles(
  task: CollaborationTask,
  candidate: CollaborationCandidatePreviewSource,
): { readonly parsedFiles: readonly ParsedCollaborationDiffFile[]; readonly manifest: ReadonlyMap<string, CollaborationCandidate['manifest'][number]> } {
  if (candidate.workspaceId !== task.workspaceId || candidate.collaborationTaskId !== task.id) invalid('candidate does not belong to this task and workspace');
  if (task.currentCandidateId !== candidate.id) {
    throw new CollaborationCandidatePreviewError('COLLABORATION_CANDIDATE_INVALID', 'candidate is stale for this task');
  }
  if (!task.baseCommit || candidate.baseCommit !== task.baseCommit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(candidate.baseCommit)) invalid('candidate base does not match the frozen task base');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(candidate.headCommit)) invalid('candidate head commit is invalid');
  if (candidate.snapshotVersion !== 2 || typeof candidate.diffText !== 'string' || !candidate.diffText.trim()
    || !HASH_PATTERN.test(candidate.diffHash) || createHash('sha256').update(candidate.diffText, 'utf8').digest('hex') !== candidate.diffHash) {
    invalid('candidate snapshot is incomplete or its frozen diff hash does not match');
  }

  const parsedFiles = parseCollaborationCandidateDiff(candidate.diffText);
  const manifest = validManifest(candidate, parsedFiles, task);
  const contentHash = collaborationCandidateContentHash({
    diffHash: candidate.diffHash, snapshotVersion: candidate.snapshotVersion,
    manifestVersion: candidate.manifestVersion ?? 1, manifest: candidate.manifest,
  });
  if (candidate.contentHash !== contentHash) invalid('candidate manifest does not match its frozen content hash');
  return { parsedFiles, manifest };
}

/** Validates the frozen diff and manifest without consulting the mutable worktree. */
export function assertCollaborationCandidatePreviewValid(
  task: CollaborationTask,
  candidate: CollaborationCandidatePreviewSource,
): void {
  validatedPreviewFiles(task, candidate);
}

function previewFile(
  file: ParsedCollaborationDiffFile,
  fileIndex: number,
  manifest: ReadonlyMap<string, CollaborationCandidate['manifest'][number]>,
): { readonly metadata: CollaborationCandidate['manifest'][number] | undefined; readonly file: CollaborationCandidatePreviewFile; readonly rendered: ReturnType<typeof renderDiffFile> } {
  const path = file.newPath ?? file.oldPath!;
  const metadata = manifest.get(path) ?? (file.status === 'deleted' && file.oldPath ? manifest.get(file.oldPath) : undefined);
  const binary = file.binary || metadata?.binary === true;
  const displayFile = binary && !file.binary ? { ...file, binary: true, additions: null, deletions: null } : file;
  const rendered = renderDiffFile(displayFile, metadata);
  return {
    metadata,
    rendered,
    file: {
      fileIndex,
      path: displayPath(path)!,
      ...(file.oldPath !== null && file.oldPath !== file.newPath ? { oldPath: displayPath(file.oldPath)! } : {}),
      status: file.status,
      additions: displayFile.additions,
      deletions: displayFile.deletions,
      binary,
      withheld: rendered.withheldReason !== undefined,
      ...(binary ? {
        ...(metadata ? { binarySizeBytes: metadata.sizeBytes } : {}),
        binarySha256Available: metadata?.sha256 !== undefined,
        ...(metadata?.sha256 === undefined ? {} : { binarySha256: metadata.sha256 }),
        ...(metadata?.gitObjectId === undefined ? {} : { binaryGitObjectId: metadata.gitObjectId }),
        ...(metadata?.baseSizeBytes === undefined ? {} : { baseSizeBytes: metadata.baseSizeBytes }),
        baseSha256Available: metadata?.baseSha256 !== undefined,
        ...(metadata?.baseSha256 === undefined ? {} : { baseSha256: metadata.baseSha256 }),
        ...(metadata?.baseObjectId === undefined ? {} : { baseGitObjectId: metadata.baseObjectId }),
      } : {}),
    },
  };
}

export function buildCollaborationCandidatePreview(
  task: CollaborationTask,
  candidate: CollaborationCandidate,
  pagination: { readonly offset?: number; readonly limit?: number } = {},
): CollaborationCandidatePreview {
  const offset = pagination.offset ?? 0;
  const limit = pagination.limit ?? MAX_COLLABORATION_PREVIEW_PAGE_SIZE;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= MAX_COLLABORATION_PREVIEW_FILES
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_COLLABORATION_PREVIEW_PAGE_SIZE) {
    invalid('preview page bounds are invalid');
  }
  const { parsedFiles, manifest } = validatedPreviewFiles(task, candidate);
  if (offset > parsedFiles.length) invalid('preview offset is beyond the frozen file list');
  const reasons = new Set<'binary' | 'sensitive_path' | 'secret_value'>();
  const pageFiles = parsedFiles.slice(offset, offset + limit).map((file, index) => {
    const result = previewFile(file, offset + index, manifest);
    if (result.rendered.withheldReason) reasons.add(result.rendered.withheldReason);
    return result.file;
  });
  const nextOffset = offset + pageFiles.length;

  return {
    workspaceId: task.workspaceId,
    collaborationTaskId: task.id,
    candidateId: candidate.id,
    baseCommit: candidate.baseCommit,
    headCommit: candidate.headCommit,
    snapshotVersion: candidate.snapshotVersion!,
    diffHash: candidate.diffHash,
    manifestVersion: candidate.manifestVersion ?? 1,
    contentHash: collaborationCandidateContentHash({
      diffHash: candidate.diffHash, snapshotVersion: candidate.snapshotVersion!,
      manifestVersion: candidate.manifestVersion ?? 1, manifest: candidate.manifest,
    }),
    offset,
    ...(nextOffset < parsedFiles.length ? { nextOffset } : {}),
    totalFiles: parsedFiles.length,
    totalAdditions: parsedFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    totalDeletions: parsedFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    files: pageFiles,
    withheldContent: reasons.size > 0,
    withheldReasons: [...reasons],
  };
}

export function buildCollaborationCandidatePreviewFileDiff(
  task: CollaborationTask,
  candidate: CollaborationCandidate,
  fileIndex: number,
): CollaborationCandidatePreviewFileDiff {
  if (!Number.isSafeInteger(fileIndex) || fileIndex < 0 || fileIndex >= MAX_COLLABORATION_PREVIEW_FILES) invalid('preview file index is invalid');
  const { parsedFiles, manifest } = validatedPreviewFiles(task, candidate);
  const file = parsedFiles[fileIndex];
  if (!file) invalid('preview file index is outside the frozen file list');
  const result = previewFile(file, fileIndex, manifest);
  const rendered = result.rendered;
  if (Buffer.byteLength(rendered.text, 'utf8') > MAX_COLLABORATION_PREVIEW_BYTES) {
    throw new CollaborationCandidatePreviewError('COLLABORATION_DIFF_TOO_LARGE', 'sanitized file preview exceeds the response limit');
  }
  return {
    workspaceId: task.workspaceId,
    collaborationTaskId: task.id,
    candidateId: candidate.id,
    baseCommit: candidate.baseCommit,
    manifestVersion: candidate.manifestVersion ?? 1,
    diffHash: candidate.diffHash,
    contentHash: collaborationCandidateContentHash({
      diffHash: candidate.diffHash, snapshotVersion: candidate.snapshotVersion!,
      manifestVersion: candidate.manifestVersion ?? 1, manifest: candidate.manifest,
    }),
    fileIndex,
    path: result.file.path,
    diffText: rendered.text,
    withheld: rendered.withheldReason !== undefined,
    ...(rendered.withheldReason ? { withheldReason: rendered.withheldReason } : {}),
  };
}
