/**
 * P6-L1C-M1 Git Observation application contracts and pure parsing.
 *
 * This module deliberately has no child-process, filesystem, SQLite,
 * Artifact, Runtime Event writer, Outbox, API, lifecycle, Provider, or
 * Worktree dependency. Later slices may supply adapters around these sealed
 * request/result contracts; this module only classifies already-bounded bytes.
 */

import type { RuntimeEventContext } from './m3-runtime.js';

declare const GIT_COMMIT_OBJECT_ID_V1: unique symbol;

/** A Git object ID accepted by the application contract (SHA-1 or SHA-256). */
export type GitCommitObjectIdV1 = string & {
  readonly [GIT_COMMIT_OBJECT_ID_V1]: 'GitCommitObjectIdV1';
};

export const GIT_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const GIT_CHANGED_FILES_SCHEMA_VERSION = 1 as const;

export const GIT_CHANGED_FILES_LIMITS_V1 = Object.freeze({
  maximumEntries: 4096,
  maximumSerializedBytes: 512 * 1024,
} as const);

export type GitObservationTriggerV1 =
  | 'on_demand'
  | 'pre_start'
  | 'milestone'
  | 'terminal';

export type GitObservationStateV1 = 'GIT' | 'NOT_GIT' | 'UNAVAILABLE';
export type GitDirtyStateV1 = 'clean' | 'dirty' | 'unknown' | 'not_applicable';
export type GitStatusCompletenessV1 = 'complete' | 'incomplete' | 'not_applicable';
export type GitDiffStateV1 =
  | 'not_requested'
  | 'available'
  | 'unavailable'
  | 'truncated'
  | 'not_applicable';

export type GitChangedFileKindV1 =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted';

export type GitObservationFailurePhaseV1 =
  | 'repository_discovery'
  | 'head'
  | 'status'
  | 'diff'
  | 'path_validation';

export type GitObservationErrorCodeV1 =
  | 'GIT_COMMAND_TIMEOUT'
  | 'GIT_COMMAND_CANCELLED'
  | 'GIT_OUTPUT_LIMIT_EXCEEDED'
  | 'GIT_EXECUTABLE_UNAVAILABLE'
  | 'GIT_COMMAND_SPAWN_FAILED'
  | 'GIT_DUBIOUS_OWNERSHIP'
  | 'GIT_PERMISSION_DENIED'
  | 'GIT_REPOSITORY_DISCOVERY_FAILED'
  | 'GIT_REPOSITORY_ROOT_INVALID'
  | 'GIT_HEAD_UNAVAILABLE'
  | 'GIT_HEAD_OUTPUT_INVALID'
  | 'GIT_STATUS_PARSE_FAILED'
  | 'GIT_STATUS_PATH_INVALID'
  | 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE'
  | 'GIT_DIFF_UNAVAILABLE'
  | 'GIT_DIFF_TRUNCATED';

export interface GitObservationFailureV1 {
  readonly phase: GitObservationFailurePhaseV1;
  readonly code: GitObservationErrorCodeV1;
}

export interface ChangedFileV1 {
  /** Workspace-relative semantic path, always using Git's '/' separator. */
  readonly path: string;
  readonly kind: GitChangedFileKindV1;
  readonly staged: boolean;
  readonly unstaged: boolean;
  /** Workspace-relative source path for rename/copy; null otherwise. */
  readonly previousPath: string | null;
}

export interface ChangedFilesV1 {
  readonly schemaVersion: 1;
  /** Deterministically sorted by path, then previousPath and kind. */
  readonly entries: readonly ChangedFileV1[];
  /** Number of distinct logical paths before limits were applied. */
  readonly totalEntries: number;
  readonly omittedEntries: number;
  /** True when either the entry or serialized-byte limit omitted entries. */
  readonly truncated: boolean;
  readonly maximumEntries: number;
  readonly maximumSerializedBytes: number;
}

interface GitObservationSnapshotBaseV1 {
  readonly schemaVersion: 1;
  readonly trigger: GitObservationTriggerV1;
  readonly cwd: string;
  readonly truncation: {
    readonly changedFiles: boolean;
    readonly diff: boolean;
  };
  /** Stable partial-fact failures; raw diagnostics remain adapter-private. */
  readonly subfailures: readonly GitObservationFailureV1[];
}

/** State-specific union prevents contradictory public snapshots. */
export type GitObservationSnapshotV1 =
  | (GitObservationSnapshotBaseV1 & {
      readonly observationState: 'GIT';
      readonly repositoryRoot: string;
      readonly baseCommitSha: GitCommitObjectIdV1 | null;
      readonly finalCommitSha: GitCommitObjectIdV1 | null;
      readonly dirtyState: 'clean' | 'dirty';
      readonly statusCompleteness: 'complete';
      readonly changedFiles: ChangedFilesV1;
      readonly diffState: GitDiffStateV1;
      readonly error: null;
    })
  | (GitObservationSnapshotBaseV1 & {
      readonly observationState: 'NOT_GIT';
      readonly repositoryRoot: null;
      readonly baseCommitSha: null;
      readonly finalCommitSha: null;
      readonly dirtyState: 'not_applicable';
      readonly statusCompleteness: 'not_applicable';
      readonly changedFiles: null;
      readonly diffState: 'not_applicable';
      readonly error: null;
    })
  | (GitObservationSnapshotBaseV1 & {
      readonly observationState: 'UNAVAILABLE';
      readonly repositoryRoot: string | null;
      readonly baseCommitSha: null;
      readonly finalCommitSha: null;
      readonly dirtyState: 'unknown';
      readonly statusCompleteness: 'incomplete';
      readonly changedFiles: null;
      readonly diffState: 'unavailable';
      /** Stable public failure only; raw stderr is intentionally unrepresentable. */
      readonly error: GitObservationFailureV1;
    });

export interface GitChangedFilesLimitsV1 {
  readonly maximumEntries: number;
  readonly maximumSerializedBytes: number;
}

/**
 * The only normal construction path for commit/object IDs. The brand keeps
 * arbitrary revisions and option-like strings out of future command requests.
 */
export function parseGitCommitObjectIdV1(value: string): GitCommitObjectIdV1 | null {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) return null;
  return value as GitCommitObjectIdV1;
}

const KIND_PRECEDENCE: Readonly<Record<GitChangedFileKindV1, number>> = Object.freeze({
  conflicted: 7,
  renamed: 6,
  copied: 5,
  deleted: 4,
  added: 3,
  untracked: 2,
  modified: 1,
});

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareChangedFiles(a: ChangedFileV1, b: ChangedFileV1): number {
  return compareText(a.path, b.path)
    || compareText(a.previousPath ?? '', b.previousPath ?? '')
    || compareText(a.kind, b.kind);
}

function chooseKind(a: GitChangedFileKindV1, b: GitChangedFileKindV1): GitChangedFileKindV1 {
  if (KIND_PRECEDENCE[a] > KIND_PRECEDENCE[b]) return a;
  if (KIND_PRECEDENCE[b] > KIND_PRECEDENCE[a]) return b;
  return compareText(a, b) <= 0 ? a : b;
}

function mergeChangedFile(a: ChangedFileV1, b: ChangedFileV1): ChangedFileV1 {
  const previousCandidates = [a.previousPath, b.previousPath]
    .filter((value): value is string => value !== null)
    .sort(compareText);
  return {
    path: a.path,
    kind: chooseKind(a.kind, b.kind),
    staged: a.staged || b.staged,
    unstaged: a.unstaged || b.unstaged,
    previousPath: previousCandidates[0] ?? null,
  };
}

function validateLimits(limits: GitChangedFilesLimitsV1): void {
  if (!Number.isSafeInteger(limits.maximumEntries) || limits.maximumEntries < 0) {
    throw new RangeError('maximumEntries must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(limits.maximumSerializedBytes) || limits.maximumSerializedBytes < 192) {
    throw new RangeError('maximumSerializedBytes must be a safe integer of at least 192');
  }
}

function changedFilesWireValue(value: ChangedFilesV1): Record<string, unknown> {
  return {
    schemaVersion: value.schemaVersion,
    entries: [...value.entries].sort(compareChangedFiles).map(entry => ({
      path: entry.path,
      kind: entry.kind,
      staged: entry.staged,
      unstaged: entry.unstaged,
      previousPath: entry.previousPath,
    })),
    totalEntries: value.totalEntries,
    omittedEntries: value.omittedEntries,
    truncated: value.truncated,
    maximumEntries: value.maximumEntries,
    maximumSerializedBytes: value.maximumSerializedBytes,
  };
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function serializeChangedFilesV1(value: ChangedFilesV1): string {
  return JSON.stringify(changedFilesWireValue(value));
}

/**
 * Normalizes duplicate logical paths and applies both limits after stable
 * sorting. A truncated container retains totalEntries, so dirty evidence is
 * never lost even when every detailed entry is omitted.
 */
export function createChangedFilesV1(
  entries: readonly ChangedFileV1[],
  limits: GitChangedFilesLimitsV1 = GIT_CHANGED_FILES_LIMITS_V1,
): ChangedFilesV1 {
  validateLimits(limits);
  const byPath = new Map<string, ChangedFileV1>();
  for (const entry of entries) {
    const safeEntry: ChangedFileV1 = {
      ...entry,
      path: validateRepositoryRelativePath(entry.path, false),
      previousPath: entry.previousPath === null
        ? null
        : validateRepositoryRelativePath(entry.previousPath, false),
    };
    const prior = byPath.get(safeEntry.path);
    byPath.set(
      safeEntry.path,
      prior === undefined ? safeEntry : mergeChangedFile(prior, safeEntry),
    );
  }
  const normalized = [...byPath.values()].sort(compareChangedFiles);
  const selected = normalized.slice(0, limits.maximumEntries);

  const build = (bounded: readonly ChangedFileV1[]): ChangedFilesV1 => ({
    schemaVersion: GIT_CHANGED_FILES_SCHEMA_VERSION,
    entries: bounded,
    totalEntries: normalized.length,
    omittedEntries: normalized.length - bounded.length,
    truncated: bounded.length < normalized.length,
    maximumEntries: limits.maximumEntries,
    maximumSerializedBytes: limits.maximumSerializedBytes,
  });

  let bounded = selected;
  let container = build(bounded);
  while (utf8Length(serializeChangedFilesV1(container)) > limits.maximumSerializedBytes && bounded.length > 0) {
    bounded = bounded.slice(0, -1);
    container = build(bounded);
  }
  if (utf8Length(serializeChangedFilesV1(container)) > limits.maximumSerializedBytes) {
    throw new RangeError('maximumSerializedBytes is too small for the changed-files envelope');
  }
  return container;
}

// ---------------------------------------------------------------------------
// Future read-only command adapter boundary (interface only in M1)
// ---------------------------------------------------------------------------

export const GIT_COMMAND_EXECUTION_CONTRACT_V1 = Object.freeze({
  environment: Object.freeze({
    LC_ALL: 'C',
    LANG: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  }),
  pagerDisabled: true,
  externalDiffDisabled: true,
  /** Raw stdout caps are enforced before a future adapter accumulates bytes. */
  stdoutMaximumBytes: Object.freeze({
    repository_root: 4096,
    head_commit: 4096,
    porcelain_v2_status: 1024 * 1024,
    bounded_diff: 4 * 1024 * 1024,
  } as const),
} as const);

/**
 * Raw process-output limits are distinct from the parsed changed-files JSON
 * limit. Every sealed read family has a finite, positive safe-integer cap.
 */
export const GIT_COMMAND_STDOUT_LIMITS_V1 = GIT_COMMAND_EXECUTION_CONTRACT_V1.stdoutMaximumBytes;

/**
 * Frozen future adapter argv templates. The canonical HEAD probe verifies a
 * commit object, not arbitrary symbolic revision text.
 */
export const GIT_COMMAND_ARGUMENTS_V1 = Object.freeze({
  head_commit: Object.freeze([
    'rev-parse',
    '--verify',
    'HEAD^{commit}',
  ] as const),
} as const);

/** Maximum adapter-owned stderr diagnostic bytes retained per command result. */
export const GIT_COMMAND_DIAGNOSTIC_LIMIT_BYTES_V1 = 16 * 1024;

export type GitCommandRequestV1 =
  | {
      readonly family: 'repository_root';
      readonly cwd: string;
    }
  | {
      readonly family: 'head_commit';
      readonly cwd: string;
    }
  | {
      readonly family: 'porcelain_v2_status';
      readonly cwd: string;
      readonly workspacePathFromRepositoryRoot: string;
    }
  | {
      readonly family: 'bounded_diff';
      readonly cwd: string;
      readonly baseCommitSha: GitCommitObjectIdV1;
      readonly workspacePathFromRepositoryRoot: string;
    };

interface GitCommandResultBaseV1 {
  readonly stdout: Uint8Array;
  /** Adapter-bounded diagnostic bytes. Never copied into public snapshots. */
  readonly stderrDiagnostic: Uint8Array;
  readonly stderrDiagnosticTruncated: boolean;
}

export type GitCommandResultV1 =
  | (GitCommandResultBaseV1 & {
      readonly termination: 'exited';
      readonly exitCode: number;
    })
  | (GitCommandResultBaseV1 & {
      readonly termination: 'timed_out' | 'cancelled' | 'output_limit';
      readonly exitCode: null;
    })
  | (GitCommandResultBaseV1 & {
      readonly termination: 'spawn_failed';
      readonly exitCode: null;
      readonly spawnFailure: 'not_found' | 'permission' | 'unknown';
    });

export interface GitCommandPort {
  readonly executionContract: typeof GIT_COMMAND_EXECUTION_CONTRACT_V1;
  execute(request: GitCommandRequestV1): Promise<GitCommandResultV1>;
}

export type GitRepositoryDiscoveryResultV1 =
  | {
      readonly observationState: 'GIT';
      readonly repositoryRoot: string;
      readonly error: null;
    }
  | {
      readonly observationState: 'NOT_GIT';
      readonly repositoryRoot: null;
      readonly error: null;
    }
  | {
      readonly observationState: 'UNAVAILABLE';
      readonly repositoryRoot: null;
      readonly error: GitObservationFailureV1;
    };

function failure(
  phase: GitObservationFailurePhaseV1,
  code: GitObservationErrorCodeV1,
): GitObservationFailureV1 {
  return { phase, code };
}

function unavailableDiscovery(code: GitObservationErrorCodeV1): GitRepositoryDiscoveryResultV1 {
  return {
    observationState: 'UNAVAILABLE',
    repositoryRoot: null,
    error: failure('repository_discovery', code),
  };
}

function decodeUtf8(value: Uint8Array, fatal: boolean): string | null {
  try {
    return new TextDecoder('utf-8', { fatal }).decode(value);
  } catch {
    return null;
  }
}

function stripOneLineEnding(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

function hasProhibitedWindowsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function normalizeDiagnostic(value: Uint8Array): string {
  return (decodeUtf8(value, false) ?? '').replace(/\r\n/g, '\n').replace(/\n+$/u, '');
}

function isAbsolutePathSyntax(value: string): boolean {
  return value.startsWith('/')
    || /^[A-Za-z]:[\\/]/u.test(value)
    || value.startsWith('\\\\')
    || value.startsWith('//');
}

const C_LOCALE_NON_REPOSITORY_DIAGNOSTIC =
  'fatal: not a git repository (or any of the parent directories): .git';

/**
 * Only this reviewed, exact bounded C-locale diagnostic yields NOT_GIT.
 * Other Git versions may word the condition differently; those variants must
 * remain UNAVAILABLE until independently reviewed, never be generalized from
 * exit code 128.
 */
export function classifyRepositoryDiscoveryResultV1(
  result: GitCommandResultV1,
): GitRepositoryDiscoveryResultV1 {
  if (result.termination === 'timed_out') return unavailableDiscovery('GIT_COMMAND_TIMEOUT');
  if (result.termination === 'cancelled') return unavailableDiscovery('GIT_COMMAND_CANCELLED');
  if (result.termination === 'output_limit') return unavailableDiscovery('GIT_OUTPUT_LIMIT_EXCEEDED');
  if (result.termination === 'spawn_failed') {
    if (result.spawnFailure === 'not_found') return unavailableDiscovery('GIT_EXECUTABLE_UNAVAILABLE');
    if (result.spawnFailure === 'permission') return unavailableDiscovery('GIT_PERMISSION_DENIED');
    return unavailableDiscovery('GIT_COMMAND_SPAWN_FAILED');
  }

  if (result.exitCode === 0) {
    const decoded = decodeUtf8(result.stdout, true);
    const root = decoded === null ? '' : stripOneLineEnding(decoded);
    if (
      root.length === 0
      || root.includes('\0')
      || hasProhibitedWindowsControl(root)
      || !isAbsolutePathSyntax(root)
    ) {
      return unavailableDiscovery('GIT_REPOSITORY_ROOT_INVALID');
    }
    return { observationState: 'GIT', repositoryRoot: root, error: null };
  }

  if (result.stderrDiagnosticTruncated) {
    return unavailableDiscovery('GIT_REPOSITORY_DISCOVERY_FAILED');
  }
  const diagnostic = normalizeDiagnostic(result.stderrDiagnostic);
  if (diagnostic === C_LOCALE_NON_REPOSITORY_DIAGNOSTIC) {
    return { observationState: 'NOT_GIT', repositoryRoot: null, error: null };
  }
  const lower = diagnostic.toLowerCase();
  if (lower.includes('detected dubious ownership in repository')) {
    return unavailableDiscovery('GIT_DUBIOUS_OWNERSHIP');
  }
  if (lower.includes('permission denied') || lower.includes('access is denied')) {
    return unavailableDiscovery('GIT_PERMISSION_DENIED');
  }
  return unavailableDiscovery('GIT_REPOSITORY_DISCOVERY_FAILED');
}

// ---------------------------------------------------------------------------
// Porcelain-v2 -z parser
// ---------------------------------------------------------------------------

export type GitObservationStatusResultV1 =
  | {
      readonly ok: true;
      readonly statusCompleteness: 'complete';
      readonly changedFiles: ChangedFilesV1;
    }
  | {
      readonly ok: false;
      readonly statusCompleteness: 'incomplete';
      readonly changedFiles: null;
      readonly error: GitObservationFailureV1;
    };

export interface ParseGitPorcelainV2StatusOptionsV1 {
  /** '' when Workspace root equals repository root; otherwise repo-relative. */
  readonly workspacePathFromRepositoryRoot: string;
  readonly limits?: GitChangedFilesLimitsV1;
}

class PorcelainParseError extends Error {
  constructor(readonly code: GitObservationErrorCodeV1) {
    super(code);
    this.name = 'PorcelainParseError';
  }
}

function invalidPath(code: 'GIT_STATUS_PATH_INVALID' | 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE'): never {
  throw new PorcelainParseError(code);
}

function validateRepositoryRelativePath(path: string, allowEmpty: boolean): string {
  if (path.length === 0) {
    if (allowEmpty) return path;
    return invalidPath('GIT_STATUS_PATH_INVALID');
  }
  if (
    path.includes('\0')
    || path.includes('\\')
    || path.startsWith('/')
    || path.startsWith('\\')
    || /^[A-Za-z]:/u.test(path)
  ) {
    return invalidPath('GIT_STATUS_PATH_INVALID');
  }
  const segments = path.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    return invalidPath('GIT_STATUS_PATH_INVALID');
  }
  return path;
}

function toWorkspaceRelativePath(path: string, workspacePrefix: string): string {
  const repositoryRelative = validateRepositoryRelativePath(path, false);
  if (workspacePrefix.length === 0) return repositoryRelative;
  const prefix = `${workspacePrefix}/`;
  if (!repositoryRelative.startsWith(prefix)) {
    return invalidPath('GIT_STATUS_PATH_OUTSIDE_WORKSPACE');
  }
  return validateRepositoryRelativePath(repositoryRelative.slice(prefix.length), false);
}

function splitNulRecords(stdout: Uint8Array): Uint8Array[] {
  if (stdout.byteLength === 0) return [];
  if (stdout[stdout.byteLength - 1] !== 0) throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
  const records: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < stdout.byteLength; index += 1) {
    if (stdout[index] !== 0) continue;
    records.push(stdout.subarray(start, index));
    start = index + 1;
  }
  if (records.some(record => record.byteLength === 0)) {
    throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
  }
  return records;
}

function decodeRecord(record: Uint8Array): string {
  const decoded = decodeUtf8(record, true);
  if (decoded === null) throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
  return decoded;
}

function splitHead(record: string, tokenCount: number): { tokens: string[]; path: string } {
  const tokens: string[] = [];
  let start = 0;
  for (let index = 0; index < tokenCount; index += 1) {
    const separator = record.indexOf(' ', start);
    if (separator < 0) throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
    tokens.push(record.slice(start, separator));
    start = separator + 1;
  }
  const path = record.slice(start);
  if (path.length === 0) throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
  return { tokens, path };
}

function validateXy(xy: string): void {
  if (!/^[.MADRCUT]{2}$/u.test(xy) || xy === '..') {
    throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
  }
}

function validateSubmoduleField(value: string): void {
  if (!/^(?:N\.\.\.|S[.C][.M][.U])$/u.test(value)) {
    throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
  }
}

function validateMode(value: string): void {
  if (!/^[0-7]{6}$/u.test(value)) throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
}

function validateObjectId(value: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
  }
}

function validateTrackedFields(
  tokens: readonly string[],
  modeIndexes: readonly number[],
  objectIdIndexes: readonly number[],
): void {
  validateSubmoduleField(tokens[2]!);
  for (const index of modeIndexes) validateMode(tokens[index]!);
  for (const index of objectIdIndexes) validateObjectId(tokens[index]!);
}

function validateOrdinaryXy(xy: string): void {
  validateXy(xy);
  if (/[RCU]/u.test(xy)) throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
}

function validateRenameCopyXy(xy: string, score: string): void {
  validateXy(xy);
  const expected = score[0];
  if ((expected !== 'R' && expected !== 'C') || !xy.includes(expected) || /U/u.test(xy)) {
    throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
  }
}

function validateUnmergedXy(xy: string): void {
  if (!new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']).has(xy)) {
    throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
  }
}

function kindFromXy(xy: string): GitChangedFileKindV1 {
  if (xy.includes('U')) return 'conflicted';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('C')) return 'copied';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  // Porcelain-v2 typechange (T) is normalized into the public modified kind.
  return 'modified';
}

function trackedEntry(
  xy: string,
  path: string,
  workspacePrefix: string,
  kind = kindFromXy(xy),
  previousPath: string | null = null,
): ChangedFileV1 {
  validateXy(xy);
  return {
    path: toWorkspaceRelativePath(path, workspacePrefix),
    kind,
    staged: xy[0] !== '.',
    unstaged: xy[1] !== '.',
    previousPath: previousPath === null
      ? null
      : toWorkspaceRelativePath(previousPath, workspacePrefix),
  };
}

function parsePorcelainRecords(
  records: readonly Uint8Array[],
  workspacePrefix: string,
): ChangedFileV1[] {
  const entries: ChangedFileV1[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = decodeRecord(records[index]!);
    if (record.startsWith('# ')) continue;
    if (record.startsWith('! ')) continue;
    if (record.startsWith('? ')) {
      entries.push({
        path: toWorkspaceRelativePath(record.slice(2), workspacePrefix),
        kind: 'untracked',
        staged: false,
        unstaged: true,
        previousPath: null,
      });
      continue;
    }
    if (record.startsWith('1 ')) {
      const { tokens, path } = splitHead(record, 8);
      if (tokens[0] !== '1') throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
      validateOrdinaryXy(tokens[1]!);
      validateTrackedFields(tokens, [3, 4, 5], [6, 7]);
      entries.push(trackedEntry(tokens[1]!, path, workspacePrefix));
      continue;
    }
    if (record.startsWith('2 ')) {
      const { tokens, path } = splitHead(record, 9);
      const score = tokens[8]!;
      if (
        tokens[0] !== '2'
        || !/^[RC][0-9]{1,3}$/u.test(score)
        || Number(score.slice(1)) > 100
      ) {
        throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
      }
      validateRenameCopyXy(tokens[1]!, score);
      validateTrackedFields(tokens, [3, 4, 5], [6, 7]);
      const originalRecord = records[index + 1];
      if (originalRecord === undefined || originalRecord.byteLength === 0) {
        throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
      }
      index += 1;
      entries.push(trackedEntry(
        tokens[1]!,
        path,
        workspacePrefix,
        score.startsWith('R') ? 'renamed' : 'copied',
        decodeRecord(originalRecord),
      ));
      continue;
    }
    if (record.startsWith('u ')) {
      const { tokens, path } = splitHead(record, 10);
      if (tokens[0] !== 'u') throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
      validateUnmergedXy(tokens[1]!);
      validateTrackedFields(tokens, [3, 4, 5, 6], [7, 8, 9]);
      entries.push({
        path: toWorkspaceRelativePath(path, workspacePrefix),
        kind: 'conflicted',
        staged: true,
        unstaged: true,
        previousPath: null,
      });
      continue;
    }
    throw new PorcelainParseError('GIT_STATUS_PARSE_FAILED');
  }
  return entries;
}

export function parseGitPorcelainV2StatusV1(
  stdout: Uint8Array,
  options: ParseGitPorcelainV2StatusOptionsV1,
): GitObservationStatusResultV1 {
  try {
    const workspacePrefix = validateRepositoryRelativePath(
      options.workspacePathFromRepositoryRoot,
      true,
    );
    const entries = parsePorcelainRecords(splitNulRecords(stdout), workspacePrefix);
    return {
      ok: true,
      statusCompleteness: 'complete',
      changedFiles: createChangedFilesV1(entries, options.limits),
    };
  } catch (error) {
    const code = error instanceof PorcelainParseError
      ? error.code
      : 'GIT_STATUS_PARSE_FAILED';
    return {
      ok: false,
      statusCompleteness: 'incomplete',
      changedFiles: null,
      error: failure(code.startsWith('GIT_STATUS_PATH_') ? 'path_validation' : 'status', code),
    };
  }
}

export function classifyDirtyStateV1(
  status: GitObservationStatusResultV1,
): 'clean' | 'dirty' | 'unknown' {
  if (!status.ok) return 'unknown';
  return status.changedFiles.totalEntries === 0 ? 'clean' : 'dirty';
}

// ---------------------------------------------------------------------------
// Pure observation/diff classification
// ---------------------------------------------------------------------------

export type GitHeadObservationV1 =
  | {
      readonly state: 'available';
      readonly baseCommitSha: GitCommitObjectIdV1;
      readonly finalCommitSha: GitCommitObjectIdV1;
    }
  | { readonly state: 'unborn' }
  | {
      readonly state: 'unavailable';
      readonly error: GitObservationFailureV1;
    };

export type GitDiffOutcomeV1 = {
  readonly diffState: GitDiffStateV1;
  readonly subfailure: GitObservationFailureV1 | null;
};

export type GitDiffClassificationInputV1 =
  | { readonly kind: 'not_requested' }
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'command'; readonly result: GitCommandResultV1 };

export function classifyDiffResultV1(input: GitDiffClassificationInputV1): GitDiffOutcomeV1 {
  if (input.kind === 'not_requested') return { diffState: 'not_requested', subfailure: null };
  if (input.kind === 'not_applicable') return { diffState: 'not_applicable', subfailure: null };
  const result = input.result;
  if (result.termination === 'output_limit') {
    return { diffState: 'truncated', subfailure: failure('diff', 'GIT_DIFF_TRUNCATED') };
  }
  if (result.termination === 'timed_out') {
    return { diffState: 'unavailable', subfailure: failure('diff', 'GIT_COMMAND_TIMEOUT') };
  }
  if (result.termination === 'cancelled') {
    return { diffState: 'unavailable', subfailure: failure('diff', 'GIT_COMMAND_CANCELLED') };
  }
  if (result.termination === 'spawn_failed') {
    const code = result.spawnFailure === 'not_found'
      ? 'GIT_EXECUTABLE_UNAVAILABLE'
      : result.spawnFailure === 'permission'
        ? 'GIT_PERMISSION_DENIED'
        : 'GIT_COMMAND_SPAWN_FAILED';
    return { diffState: 'unavailable', subfailure: failure('diff', code) };
  }
  if (result.exitCode === 0) return { diffState: 'available', subfailure: null };
  return { diffState: 'unavailable', subfailure: failure('diff', 'GIT_DIFF_UNAVAILABLE') };
}

interface ClassifyGitObservationInputBaseV1 {
  readonly trigger: GitObservationTriggerV1;
  readonly cwd: string;
}

export type GitUnbornDiffOutcomeV1 =
  | { readonly diffState: 'not_requested' | 'not_applicable'; readonly subfailure: null }
  | { readonly diffState: 'unavailable'; readonly subfailure: GitObservationFailureV1 };

/**
 * State-coupled classifier input. In particular, an unborn repository has no
 * commit basis, so an available/truncated commit-based diff is not
 * representable. Untyped callers are still normalized fail-closed below.
 */
export type ClassifyGitObservationInputV1 =
  | (ClassifyGitObservationInputBaseV1 & {
      readonly repository: Extract<GitRepositoryDiscoveryResultV1, {
        observationState: 'NOT_GIT' | 'UNAVAILABLE';
      }>;
      readonly status?: never;
      readonly head?: never;
      readonly diff?: never;
    })
  | (ClassifyGitObservationInputBaseV1 & {
      readonly repository: Extract<GitRepositoryDiscoveryResultV1, { observationState: 'GIT' }>;
      readonly status: GitObservationStatusResultV1;
      readonly head: Extract<GitHeadSemanticResultV1, { state: 'unborn' }>;
      readonly diff: GitUnbornDiffOutcomeV1;
    })
  | (ClassifyGitObservationInputBaseV1 & {
      readonly repository: Extract<GitRepositoryDiscoveryResultV1, { observationState: 'GIT' }>;
      readonly status: GitObservationStatusResultV1;
      readonly head: Exclude<GitHeadSemanticResultV1, { state: 'unborn' }>;
      readonly diff: GitDiffOutcomeV1;
    });

function unavailableSnapshot(
  input: ClassifyGitObservationInputV1,
  repositoryRoot: string | null,
  error: GitObservationFailureV1,
): GitObservationSnapshotV1 {
  return {
    schemaVersion: GIT_OBSERVATION_SCHEMA_VERSION,
    trigger: input.trigger,
    observationState: 'UNAVAILABLE',
    repositoryRoot,
    cwd: input.cwd,
    baseCommitSha: null,
    finalCommitSha: null,
    dirtyState: 'unknown',
    statusCompleteness: 'incomplete',
    changedFiles: null,
    diffState: 'unavailable',
    truncation: { changedFiles: false, diff: false },
    error,
    subfailures: [],
  };
}

export type GitHeadCommandSemanticResultV1 =
  | { readonly state: 'available'; readonly commitSha: GitCommitObjectIdV1 }
  | { readonly state: 'unborn' }
  | {
      readonly state: 'unavailable';
      readonly error: GitObservationFailureV1;
    };

/** Exact C-locale evidence reviewed for the frozen unborn HEAD probe. */
export const GIT_C_LOCALE_UNBORN_HEAD_DIAGNOSTIC_V1 =
  'fatal: Needed a single revision';

function unavailableHead(code: GitObservationErrorCodeV1): GitHeadCommandSemanticResultV1 {
  return { state: 'unavailable', error: failure('head', code) };
}

/**
 * Classifies one already-bounded HEAD command result. Only the reviewed
 * diagnostic can prove unborn; exit code alone never can.
 */
export function classifyHeadCommitResultV1(
  result: GitCommandResultV1,
): GitHeadCommandSemanticResultV1 {
  if (result.termination === 'timed_out') return unavailableHead('GIT_COMMAND_TIMEOUT');
  if (result.termination === 'cancelled') return unavailableHead('GIT_COMMAND_CANCELLED');
  if (result.termination === 'output_limit') return unavailableHead('GIT_OUTPUT_LIMIT_EXCEEDED');
  if (result.termination === 'spawn_failed') {
    if (result.spawnFailure === 'not_found') return unavailableHead('GIT_EXECUTABLE_UNAVAILABLE');
    if (result.spawnFailure === 'permission') return unavailableHead('GIT_PERMISSION_DENIED');
    return unavailableHead('GIT_COMMAND_SPAWN_FAILED');
  }

  if (result.exitCode === 0) {
    const decoded = decodeUtf8(result.stdout, true);
    const value = decoded === null ? null : parseGitCommitObjectIdV1(stripOneLineEnding(decoded));
    return value === null
      ? unavailableHead('GIT_HEAD_OUTPUT_INVALID')
      : { state: 'available', commitSha: value };
  }

  if (!result.stderrDiagnosticTruncated) {
    const diagnosticBytes = decodeUtf8(result.stderrDiagnostic, true);
    const diagnostic = diagnosticBytes === null ? null : stripOneLineEnding(diagnosticBytes);
    if (result.stdout.byteLength === 0 && diagnostic === GIT_C_LOCALE_UNBORN_HEAD_DIAGNOSTIC_V1) {
      return { state: 'unborn' };
    }
  }
  return unavailableHead('GIT_HEAD_UNAVAILABLE');
}

/** Either a single classified HEAD sample or a two-boundary observation. */
export type GitHeadSemanticResultV1 = GitHeadObservationV1 | GitHeadCommandSemanticResultV1;

export function classifyGitObservationV1(
  input: ClassifyGitObservationInputV1,
): GitObservationSnapshotV1 {
  if (input.repository.observationState === 'NOT_GIT') {
    return {
      schemaVersion: GIT_OBSERVATION_SCHEMA_VERSION,
      trigger: input.trigger,
      observationState: 'NOT_GIT',
      repositoryRoot: null,
      cwd: input.cwd,
      baseCommitSha: null,
      finalCommitSha: null,
      dirtyState: 'not_applicable',
      statusCompleteness: 'not_applicable',
      changedFiles: null,
      diffState: 'not_applicable',
      truncation: { changedFiles: false, diff: false },
      error: null,
      subfailures: [],
    };
  }
  if (input.repository.observationState === 'UNAVAILABLE') {
    return unavailableSnapshot(input, null, input.repository.error);
  }
  if (input.status === undefined || !input.status.ok) {
    return unavailableSnapshot(
      input,
      input.repository.repositoryRoot,
      input.status?.error ?? failure('status', 'GIT_STATUS_PARSE_FAILED'),
    );
  }

  const subfailures: GitObservationFailureV1[] = [];
  let baseCommitSha: GitCommitObjectIdV1 | null = null;
  let finalCommitSha: GitCommitObjectIdV1 | null = null;
  let diff = input.diff ?? { diffState: 'not_requested' as const, subfailure: null };
  if (input.head?.state === 'available') {
    if ('commitSha' in input.head) {
      // A single HEAD command is one observation point; callers that collect
      // two points use GitHeadObservationV1 to preserve distinct boundaries.
      baseCommitSha = input.head.commitSha;
      finalCommitSha = input.head.commitSha;
    } else {
      baseCommitSha = input.head.baseCommitSha;
      finalCommitSha = input.head.finalCommitSha;
    }
  } else if (input.head?.state === 'unborn') {
    // Frozen M1 rule: no HEAD means no commit basis. Even an untyped caller
    // that supplies an "available" diff is normalized to not_applicable.
    diff = { diffState: 'not_applicable', subfailure: null };
  } else {
    const headFailure = input.head?.error ?? failure('head', 'GIT_HEAD_UNAVAILABLE');
    subfailures.push(headFailure);
    if (diff.diffState === 'available' || diff.diffState === 'not_requested') {
      diff = { diffState: 'unavailable', subfailure: failure('diff', 'GIT_DIFF_UNAVAILABLE') };
    }
  }
  if (diff.subfailure !== null) subfailures.push(diff.subfailure);

  return {
    schemaVersion: GIT_OBSERVATION_SCHEMA_VERSION,
    trigger: input.trigger,
    observationState: 'GIT',
    repositoryRoot: input.repository.repositoryRoot,
    cwd: input.cwd,
    baseCommitSha,
    finalCommitSha,
    dirtyState: input.status.changedFiles.totalEntries === 0 ? 'clean' : 'dirty',
    statusCompleteness: 'complete',
    changedFiles: input.status.changedFiles,
    diffState: diff.diffState,
    truncation: {
      changedFiles: input.status.changedFiles.truncated,
      diff: diff.diffState === 'truncated',
    },
    error: null,
    subfailures,
  };
}

function compareFailures(a: GitObservationFailureV1, b: GitObservationFailureV1): number {
  return compareText(a.phase, b.phase) || compareText(a.code, b.code);
}

export function serializeGitObservationSnapshotV1(snapshot: GitObservationSnapshotV1): string {
  return JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    trigger: snapshot.trigger,
    observationState: snapshot.observationState,
    repositoryRoot: snapshot.repositoryRoot,
    cwd: snapshot.cwd,
    baseCommitSha: snapshot.baseCommitSha,
    finalCommitSha: snapshot.finalCommitSha,
    dirtyState: snapshot.dirtyState,
    statusCompleteness: snapshot.statusCompleteness,
    changedFiles: snapshot.changedFiles === null
      ? null
      : changedFilesWireValue(snapshot.changedFiles),
    diffState: snapshot.diffState,
    truncation: {
      changedFiles: snapshot.truncation.changedFiles,
      diff: snapshot.truncation.diff,
    },
    error: snapshot.error === null
      ? null
      : { phase: snapshot.error.phase, code: snapshot.error.code },
    subfailures: [...snapshot.subfailures].sort(compareFailures).map(item => ({
      phase: item.phase,
      code: item.code,
    })),
  });
}

/** Frozen mapping to the existing git.observation.completed payload. */
export function mapGitObservationEventDirtyStateV1(
  snapshot: GitObservationSnapshotV1,
): 'clean' | 'dirty' | 'unknown' {
  return snapshot.dirtyState === 'clean' || snapshot.dirtyState === 'dirty'
    ? snapshot.dirtyState
    : 'unknown';
}

// ---------------------------------------------------------------------------
// Future canonical Event causal seam (no writer/factory in M1)
// ---------------------------------------------------------------------------

export const GIT_OBSERVATION_EVENT_SOURCES_V1 = Object.freeze({
  observationCompleted: 'git-runtime',
  observationUnavailable: 'git-runtime',
  diffRegistered: 'artifact-manager',
} as const);

declare const AUTHORIZED_RUNTIME_EVENT_CONTEXT_V1: unique symbol;

/**
 * Opaque causal context. A plain RuntimeEventContext, Admission ID, random ID,
 * or guessed latest Event cannot satisfy this type. A later authority adapter
 * must derive it from a canonical command, persisted Operation, or persisted
 * Runtime Event causal chain.
 */
export interface AuthorizedRuntimeEventContextV1 extends RuntimeEventContext {
  readonly origin: 'canonical_command' | 'operation' | 'persisted_event';
  readonly authorityId: string;
  readonly [AUTHORIZED_RUNTIME_EVENT_CONTEXT_V1]: true;
}

export type RuntimeEventContextAuthoritySourceV1 =
  | {
      readonly origin: 'canonical_command';
      readonly commandId: string;
      readonly context: RuntimeEventContext;
    }
  | {
      readonly origin: 'operation';
      readonly operationId: string;
      readonly context: RuntimeEventContext;
    }
  | {
      readonly origin: 'persisted_event';
      readonly eventId: string;
      readonly context: RuntimeEventContext;
    };

/** Interface only; M1 intentionally provides no authority implementation. */
export interface GitObservationRuntimeEventContextAuthorityV1 {
  authorize(source: RuntimeEventContextAuthoritySourceV1): AuthorizedRuntimeEventContextV1;
}

export type GitObservationEventBindingV1 =
  | { readonly subjectKind: 'WORKSPACE_ONLY' }
  | {
      readonly subjectKind: 'LEGACY_AGENT_RUN';
      readonly legacyRunId: string;
    }
  | {
      readonly subjectKind: 'CANONICAL_RUN';
      readonly canonicalRunId: string;
      readonly runtimeEventContext: AuthorizedRuntimeEventContextV1;
    };

export function canEmitCanonicalGitObservationEventV1(
  binding: GitObservationEventBindingV1,
): binding is Extract<GitObservationEventBindingV1, { subjectKind: 'CANONICAL_RUN' }> {
  return binding.subjectKind === 'CANONICAL_RUN';
}

// ---------------------------------------------------------------------------
// Future M3 canonical diff Artifact crash-consistency contract
// ---------------------------------------------------------------------------

export const CANONICAL_DIFF_ARTIFACT_COMMIT_ORDER_V1 = Object.freeze([
  'collect_bytes',
  'validate_hash_and_size',
  'write_temporary_file',
  'rename_to_final_immutable_path',
  'begin_database_transaction',
  'insert_canonical_artifact',
  'insert_git_observation',
  'append_runtime_events',
  'insert_one_outbox_per_event',
  'commit_database_transaction',
] as const);

export const CANONICAL_DIFF_ARTIFACT_CRASH_POLICY_V1 = Object.freeze({
  failureBeforeCommit: 'rollback_and_remove_staged_and_final_artifact_directory',
  crashBeforeDatabaseCommit: 'orphan_file_allowed',
  crashAfterDatabaseCommit: 'database_never_points_to_missing_final_content',
} as const);

export function canCommitCanonicalDiffArtifactV1(input: {
  readonly contentAvailable: boolean;
  readonly immutableFinalContentExists: boolean;
}): boolean {
  return !input.contentAvailable || input.immutableFinalContentExists;
}
