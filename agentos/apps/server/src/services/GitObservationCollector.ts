/**
 * P6-L1C-M2 Task 2: realpath-safe GitObservationCollector.
 *
 * Orchestrates the sealed Task 1 GitCommandPort around a canonical,
 * realpath-proven Workspace boundary and assembles the frozen M1 snapshot.
 * Raw command diagnostics and port rejection messages are contained here and
 * never copied into the public snapshot; only stable M1 failure codes leave.
 *
 * There is deliberately no persistence, event, artifact, API, or lifecycle
 * wiring in this slice.
 */

import { promises as nodeFs } from 'node:fs';
import nodePath from 'node:path';
import {
  classifyDiffResultV1,
  classifyGitObservationV1,
  classifyHeadCommitResultV1,
  classifyRepositoryDiscoveryResultV1,
  parseGitPorcelainV2StatusV1,
  type GitCommandPort,
  type GitCommandRequestV1,
  type GitCommandResultV1,
  type GitDiffClassificationInputV1,
  type GitHeadCommandSemanticResultV1,
  type GitHeadSemanticResultV1,
  type GitObservationFailureV1,
  type GitRepositoryDiscoveryResultV1,
  type GitObservationSnapshotV1,
  type GitObservationTriggerV1,
  type GitObservationStatusResultV1,
} from '@agentos/shared';
import {
  GIT_COMMAND_CLEANUP_UNPROVEN_MESSAGE,
  GitCommandPortFactory,
} from './GitCommandAdapter.js';

const GIT_OBSERVATION_TRIGGERS_V1: ReadonlySet<GitObservationTriggerV1> = new Set([
  'on_demand',
  'pre_start',
  'milestone',
  'terminal',
]);

export interface GitObservationCollectInputV1 {
  readonly cwd: string;
  readonly trigger: GitObservationTriggerV1;
  readonly signal?: AbortSignal;
}

export interface GitObservationCollectOutcomeV1 {
  readonly snapshot: GitObservationSnapshotV1;
  readonly diffBytes: Uint8Array | null;
}

/**
 * Server-local injectable dependencies. Tests may script the command port and
 * the realpath probe; no caller can tune argv, deadlines, limits, the
 * executable, or pathspecs.
 */
export interface GitObservationCollectorDependencies {
  readonly createCommandPort?: (
    options?: { signal?: AbortSignal },
  ) => GitCommandPort | Promise<GitCommandPort>;
  readonly realpath?: (value: string) => Promise<string>;
}

interface PathFailure {
  readonly code: 'GIT_STATUS_PATH_INVALID' | 'GIT_REPOSITORY_ROOT_INVALID' | 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE';
}

function pathFailure(code: PathFailure['code']): GitObservationFailureV1 {
  return { phase: 'path_validation', code };
}

/**
 * Stable path-validation status failure. The whole status is discarded:
 * changedFiles is null, so no partially-proven entry survives, and the M1
 * classifier maps this to dirtyState unknown and diffState unavailable.
 */
function physicalStatusFailure(
  code: 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE' | 'GIT_STATUS_PATH_INVALID',
): GitObservationStatusResultV1 {
  return {
    ok: false,
    statusCompleteness: 'incomplete',
    changedFiles: null,
    error: pathFailure(code),
  };
}

/** Contained stand-in for a port rejection; the raw error never escapes. */
function containedRejection(): GitCommandResultV1 {
  return {
    stdout: new Uint8Array(0),
    stderrDiagnostic: new Uint8Array(0),
    stderrDiagnosticTruncated: false,
    termination: 'spawn_failed',
    exitCode: null,
    spawnFailure: 'unknown',
  };
}

type CanonicalPathKind = 'posix' | 'windows_drive' | 'windows_unc';

interface CanonicalPath {
  readonly kind: CanonicalPathKind;
  readonly normalized: string;
}

function validCanonicalSegments(segments: readonly string[]): boolean {
  return segments.every(segment =>
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !segment.includes('\0'),
  );
}

function withoutTrailingEmptySegments(segments: string[]): string[] {
  while (segments[segments.length - 1] === '') segments.pop();
  return segments;
}

/**
 * Parses canonical filesystem syntax independently of the collector host.
 * Slash normalization is representation-only: path kind and case rules come
 * from the path itself, never process.platform.
 */
function parseCanonicalPath(value: string): CanonicalPath | null {
  if (value.length === 0 || value.includes('\0')) return null;
  const slashPath = value.replace(/\\/gu, '/');

  const drive = /^([A-Za-z]):\/(.*)$/u.exec(slashPath);
  if (drive !== null) {
    const driveName = drive[1]!;
    const segments = withoutTrailingEmptySegments(drive[2]!.split('/'));
    if (segments.length === 0) {
      return { kind: 'windows_drive', normalized: driveName + ':/' };
    }
    if (!validCanonicalSegments(segments)) return null;
    return {
      kind: 'windows_drive',
      normalized: driveName + ':/' + segments.join('/'),
    };
  }

  if (slashPath.startsWith('//')) {
    if (slashPath.startsWith('///')) return null;
    const segments = withoutTrailingEmptySegments(slashPath.slice(2).split('/'));
    if (segments.length < 2 || !validCanonicalSegments(segments)) return null;
    return {
      kind: 'windows_unc',
      normalized: '//' + segments.join('/') + (segments.length === 2 ? '/' : ''),
    };
  }

  if (slashPath.startsWith('/')) {
    const segments = withoutTrailingEmptySegments(slashPath.slice(1).split('/'));
    if (segments.length === 0) return { kind: 'posix', normalized: '/' };
    if (!validCanonicalSegments(segments)) return null;
    return { kind: 'posix', normalized: '/' + segments.join('/') };
  }

  return null;
}

function isAbsolutePathSyntax(value: string): boolean {
  return parseCanonicalPath(value) !== null;
}

/**
 * Separator-aware containment proof after realpath. An exact match yields the
 * empty prefix; otherwise the canonical Workspace must sit strictly below the
 * canonical repository root on the same Windows drive. The comparison is
 * case-insensitive only for Windows drive/UNC syntax; POSIX containment is
 * case-sensitive. The returned prefix preserves the canonical Workspace's
 * original casing for the M1 parser.
 */
function workspacePrefixFromRepositoryRoot(
  canonicalWorkspace: string,
  canonicalRoot: string,
): string | null {
  const workspace = parseCanonicalPath(canonicalWorkspace);
  const root = parseCanonicalPath(canonicalRoot);
  if (workspace === null || root === null || workspace.kind !== root.kind) return null;

  const caseInsensitive = workspace.kind !== 'posix';
  const compare = (value: string): string =>
    caseInsensitive ? value.toLowerCase() : value;
  if (compare(workspace.normalized) === compare(root.normalized)) return '';

  const boundary = root.normalized.endsWith('/')
    ? root.normalized
    : root.normalized + '/';
  const workspaceCmp = compare(workspace.normalized);
  const boundaryCmp = compare(boundary);
  if (!workspaceCmp.startsWith(boundaryCmp)) return null;
  const relative = workspace.normalized.slice(boundary.length);
  if (
    relative.length === 0
    || relative.startsWith('/')
    || relative.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return relative;
}

/**
 * Lexical at-or-below check on the raw joined candidate. The candidate is
 * always built from the canonical Workspace prefix, so the comparison is
 * prefix-exact; it only bounds the ENOENT ancestor walk so it never climbs
 * above the Workspace.
 */
function lexicallyAtOrBelow(candidate: string, canonicalWorkspace: string): boolean {
  const candidateSlashes = candidate.replace(/\\/gu, '/');
  const workspaceSlashes = canonicalWorkspace.replace(/\\/gu, '/');
  if (candidateSlashes === workspaceSlashes) return true;
  const boundary = workspaceSlashes.endsWith('/')
    ? workspaceSlashes
    : workspaceSlashes + '/';
  return candidateSlashes.startsWith(boundary);
}

export class GitObservationCollector {
  private readonly createCommandPort: (
    options?: { signal?: AbortSignal },
  ) => GitCommandPort | Promise<GitCommandPort>;
  private readonly realpath: (value: string) => Promise<string>;

  constructor(dependencies: GitObservationCollectorDependencies = {}) {
    this.createCommandPort = dependencies.createCommandPort
      ?? ((options?: { signal?: AbortSignal }) => GitCommandPortFactory.create(options));
    this.realpath = dependencies.realpath ?? (value => nodeFs.realpath(value));
  }

  /**
   * Physical containment proof for one M1-validated Workspace-relative path.
   * The candidate is resolved through the same realpath seam used for the
   * Workspace, so junction/symlink escapes are caught after resolution.
   *
   * Missing candidates (deleted files, rename sources) walk upward through
   * ENOENT/ENOTDIR only, to the nearest existing ancestor, and that ancestor
   * must itself be within the canonical Workspace. Any permission or unknown
   * resolution error is unproven and fails closed. The walk never climbs
   * above the canonical Workspace.
   */
  private async provePathInsideWorkspace(
    workspaceRelativePath: string,
    canonicalWorkspace: string,
  ): Promise<'inside' | 'outside' | 'unproven'> {
    let candidate = nodePath.join(
      canonicalWorkspace,
      ...workspaceRelativePath.split('/'),
    );
    while (lexicallyAtOrBelow(candidate, canonicalWorkspace)) {
      let canonicalCandidate: string;
      try {
        canonicalCandidate = await this.realpath(candidate);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          const parent = nodePath.dirname(candidate);
          if (parent === candidate) return 'unproven';
          candidate = parent;
          continue;
        }
        return 'unproven';
      }
      return workspacePrefixFromRepositoryRoot(canonicalCandidate, canonicalWorkspace) === null
        ? 'outside'
        : 'inside';
    }
    return 'unproven';
  }

  /**
   * Proves every parsed changed path and rename source. Truncated containers
   * fail closed because omitted entries cannot be physically proven. Returns
   * null when the parsed status is fully proven inside the Workspace.
   */
  private async proveChangedFilesInsideWorkspace(
    status: GitObservationStatusResultV1,
    canonicalWorkspace: string,
  ): Promise<GitObservationStatusResultV1 | null> {
    if (!status.ok) return null;
    if (status.changedFiles.truncated || status.changedFiles.omittedEntries > 0) {
      return physicalStatusFailure('GIT_STATUS_PATH_INVALID');
    }
    for (const entry of status.changedFiles.entries) {
      const pathProof = await this.provePathInsideWorkspace(entry.path, canonicalWorkspace);
      if (pathProof !== 'inside') {
        return physicalStatusFailure(
          pathProof === 'outside'
            ? 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE'
            : 'GIT_STATUS_PATH_INVALID',
        );
      }
      if (entry.previousPath !== null) {
        const previousProof = await this.provePathInsideWorkspace(
          entry.previousPath,
          canonicalWorkspace,
        );
        if (previousProof !== 'inside') {
          return physicalStatusFailure(
            previousProof === 'outside'
              ? 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE'
              : 'GIT_STATUS_PATH_INVALID',
          );
        }
      }
    }
    return null;
  }

  async collect(input: GitObservationCollectInputV1): Promise<GitObservationCollectOutcomeV1> {
    const requestInput = input as { readonly cwd?: unknown; readonly trigger?: unknown };
    const rawCwd = typeof requestInput.cwd === 'string' ? requestInput.cwd : '';
    const trigger = GIT_OBSERVATION_TRIGGERS_V1.has(requestInput.trigger as GitObservationTriggerV1)
      ? (requestInput.trigger as GitObservationTriggerV1)
      : 'on_demand';
    const classifyInput = { trigger, cwd: rawCwd };

    const pathUnavailable = (
      failure: GitObservationFailureV1,
      cwd: string = rawCwd,
    ): GitObservationCollectOutcomeV1 => ({
      snapshot: classifyGitObservationV1({
        ...classifyInput,
        cwd,
        repository: { observationState: 'UNAVAILABLE', repositoryRoot: null, error: failure },
      }),
      diffBytes: null,
    });

    if (
      rawCwd.length === 0
      || !isAbsolutePathSyntax(rawCwd)
      || !GIT_OBSERVATION_TRIGGERS_V1.has(requestInput.trigger as GitObservationTriggerV1)
    ) {
      return pathUnavailable(pathFailure('GIT_STATUS_PATH_INVALID'));
    }

    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = await this.realpath(rawCwd);
    } catch {
      return pathUnavailable(pathFailure('GIT_STATUS_PATH_INVALID'));
    }

    const boundaryInput = { ...classifyInput, cwd: canonicalWorkspace };
    let port: GitCommandPort;
    try {
      port = await this.createCommandPort(
        input.signal === undefined ? undefined : { signal: input.signal },
      );
    } catch {
      const repository = classifyRepositoryDiscoveryResultV1(
        containedRejection(),
      ) as Extract<GitRepositoryDiscoveryResultV1, { observationState: 'UNAVAILABLE' }>;
      return {
        snapshot: classifyGitObservationV1({ ...boundaryInput, repository }),
        diffBytes: null,
      };
    }
    const execute = async (request: GitCommandRequestV1): Promise<GitCommandResultV1> => {
      try {
        return await port.execute(request);
      } catch (error) {
        // HIGH-1: a cleanup-unproven rejection means an owned Git process tree
        // may still be alive. It is not an ordinary command failure: abort the
        // collection immediately by rethrowing the fixed data-free error, so no
        // subsequent Git command (status/diff/final HEAD) may spawn.
        if (error instanceof Error && error.message === GIT_COMMAND_CLEANUP_UNPROVEN_MESSAGE) {
          throw error;
        }
        return containedRejection();
      }
    };

    const discovery = classifyRepositoryDiscoveryResultV1(
      await execute({ family: 'repository_root', cwd: canonicalWorkspace }),
    );
    if (discovery.observationState !== 'GIT') {
      return {
        snapshot: classifyGitObservationV1({ ...boundaryInput, repository: discovery }),
        diffBytes: null,
      };
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = await this.realpath(discovery.repositoryRoot);
    } catch {
      return pathUnavailable(pathFailure('GIT_REPOSITORY_ROOT_INVALID'), canonicalWorkspace);
    }

    const workspacePrefix = workspacePrefixFromRepositoryRoot(canonicalWorkspace, canonicalRoot);
    if (workspacePrefix === null) {
      return pathUnavailable(pathFailure('GIT_STATUS_PATH_OUTSIDE_WORKSPACE'), canonicalWorkspace);
    }

    const repository = {
      observationState: 'GIT' as const,
      repositoryRoot: canonicalRoot,
      error: null,
    };

    // Frozen order after GIT discovery: first HEAD, status, the conditional
    // diff (only when the first HEAD supplies a valid commit basis), then the
    // final HEAD. The final HEAD is always sampled, even when status or diff
    // fails, so the boundary is never silently dropped.
    const firstHead = classifyHeadCommitResultV1(
      await execute({ family: 'head_commit', cwd: canonicalWorkspace }),
    );

    const statusResult = await execute({
      family: 'porcelain_v2_status',
      cwd: canonicalWorkspace,
      workspacePathFromRepositoryRoot: workspacePrefix,
    });
    const status = (statusResult.termination === 'exited' && statusResult.exitCode === 0)
      ? parseGitPorcelainV2StatusV1(statusResult.stdout, {
          workspacePathFromRepositoryRoot: workspacePrefix,
        })
      : statusResult.termination === 'exited'
        ? {
            ok: false as const,
            statusCompleteness: 'incomplete' as const,
            changedFiles: null,
            error: { phase: 'status' as const, code: 'GIT_STATUS_PARSE_FAILED' as const },
          }
        : {
            ok: false as const,
            statusCompleteness: 'incomplete' as const,
            changedFiles: null,
            error: statusCommandFailure(statusResult),
          };

    // Physical containment proof: every parsed changed path and rename source
    // must resolve inside the canonical Workspace, and truncated containers
    // fail closed because omitted paths cannot be proven. A failed proof
    // discards the whole status (changedFiles null) before any bounded_diff.
    const physicalFailure = await this.proveChangedFilesInsideWorkspace(
      status,
      canonicalWorkspace,
    );

    let diffInput: GitDiffClassificationInputV1;
    let diffResult: GitCommandResultV1 | null = null;
    if (physicalFailure !== null) {
      // Boundary failure: the diff must not run; the final HEAD is still
      // sampled below to preserve the observation boundary.
      diffInput = { kind: 'not_requested' };
    } else if (firstHead.state === 'available') {
      diffResult = await execute({
        family: 'bounded_diff',
        cwd: canonicalWorkspace,
        baseCommitSha: firstHead.commitSha,
        workspacePathFromRepositoryRoot: workspacePrefix,
      });
      diffInput = { kind: 'command', result: diffResult };
    } else if (firstHead.state === 'unborn') {
      diffInput = { kind: 'not_applicable' };
    } else {
      diffInput = { kind: 'not_requested' };
    }
    const diff = classifyDiffResultV1(diffInput);

    const finalHead = classifyHeadCommitResultV1(
      await execute({ family: 'head_commit', cwd: canonicalWorkspace }),
    );

    const effectiveStatus = physicalFailure ?? status;
    if (!effectiveStatus.ok) {
      return {
        snapshot: classifyGitObservationV1({
          ...boundaryInput,
          repository,
          status: effectiveStatus,
        } as Parameters<typeof classifyGitObservationV1>[0]),
        diffBytes: null,
      };
    }

    const head = combineHeadBoundaries(firstHead, finalHead);
    const snapshot = classifyGitObservationV1({
      ...boundaryInput,
      repository,
      status,
      head,
      diff,
    } as Parameters<typeof classifyGitObservationV1>[0]);

    const diffBytes = snapshot.observationState === 'GIT'
      && snapshot.diffState === 'available'
      && diffResult !== null
      && diffResult.termination === 'exited'
      && diffResult.exitCode === 0
      ? diffResult.stdout
      : null;

    return { snapshot, diffBytes };
  }
}

/**
 * Maps a non-exited status command to the stable M1 status-phase failure.
 * Exited-nonzero is always GIT_STATUS_PARSE_FAILED; the raw diagnostic stays
 * adapter-private.
 */
function statusCommandFailure(result: GitCommandResultV1): GitObservationFailureV1 {
  if (result.termination === 'timed_out') {
    return { phase: 'status', code: 'GIT_COMMAND_TIMEOUT' };
  }
  if (result.termination === 'cancelled') {
    return { phase: 'status', code: 'GIT_COMMAND_CANCELLED' };
  }
  if (result.termination === 'output_limit') {
    return { phase: 'status', code: 'GIT_OUTPUT_LIMIT_EXCEEDED' };
  }
  if (result.termination === 'spawn_failed') {
    const code = result.spawnFailure === 'not_found'
      ? 'GIT_EXECUTABLE_UNAVAILABLE'
      : result.spawnFailure === 'permission'
        ? 'GIT_PERMISSION_DENIED'
        : 'GIT_COMMAND_SPAWN_FAILED';
    return { phase: 'status', code };
  }
  return { phase: 'status', code: 'GIT_STATUS_PARSE_FAILED' };
}

/**
 * Two-boundary HEAD semantics. Both available preserves distinct base/final
 * SHAs; both unborn is unborn; every transition or unsafe combination is a
 * fail-closed generic head failure; a single unavailable boundary preserves
 * its stable error.
 */
function combineHeadBoundaries(
  first: GitHeadCommandSemanticResultV1,
  final: GitHeadCommandSemanticResultV1,
): GitHeadSemanticResultV1 {
  if (first.state === 'available' && final.state === 'available') {
    return { state: 'available', baseCommitSha: first.commitSha, finalCommitSha: final.commitSha };
  }
  if (first.state === 'unborn' && final.state === 'unborn') {
    return { state: 'unborn' };
  }
  if (first.state === 'unavailable' && final.state === 'unavailable') {
    if (
      first.error.phase === final.error.phase
      && first.error.code === final.error.code
    ) {
      return first;
    }
    return { state: 'unavailable', error: { phase: 'head', code: 'GIT_HEAD_UNAVAILABLE' } };
  }
  if (first.state === 'unavailable') return first;
  if (final.state === 'unavailable') return final;
  return { state: 'unavailable', error: { phase: 'head', code: 'GIT_HEAD_UNAVAILABLE' } };
}

