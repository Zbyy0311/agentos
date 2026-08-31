/**
 * P6-L1C-M2 sealed, bounded read-only Git command adapter.
 *
 * This is the only server-side GitCommandPort implementation. It seals the
 * four frozen read-only observation families behind fixed executable/argv,
 * enforces a sanitized deterministic environment, streams bounded stdout and
 * a bounded stderr diagnostic prefix, and owns separate finite launch and
 * per-family runtime deadlines.
 *
 * The production factory exposes exactly one caller-owned execution control:
 * an AbortSignal. Deadlines, limits, executable, argv and pathspecs are
 * server-owned constants and are never accepted from callers.
 *
 * There is deliberately no persistence, event, API, or lifecycle wiring here.
 */

import {
  GIT_COMMAND_ARGUMENTS_V1,
  GIT_COMMAND_DIAGNOSTIC_LIMIT_BYTES_V1,
  GIT_COMMAND_EXECUTION_CONTRACT_V1,
  GIT_COMMAND_STDOUT_LIMITS_V1,
  parseGitCommitObjectIdV1,
  type GitCommandPort,
  type GitCommandRequestV1,
  type GitCommandResultV1,
} from '@agentos/shared';
import {
  NodeProcessDriver,
  type NativeProcessHandle,
  type PlatformProcessDriver,
  type ValidatedLaunch,
} from '@agentos/process-runtime';

/**
 * Thrown when owned-tree cleanup cannot be proven. The frozen M1 result
 * union cannot truthfully represent unproven cleanup, so the adapter fails
 * closed with a fixed data-free error instead of returning a misleading
 * bounded result. No driver or stream error text ever escapes.
 */
export const GIT_COMMAND_CLEANUP_UNPROVEN_MESSAGE = 'GIT_COMMAND_CLEANUP_UNPROVEN';

/**
 * Thrown when waitExit or a stream iterator rejects, after the owned tree
 * has been terminated and cleanup proven. Fixed and data-free: raw driver,
 * stream, and stderr details never escape the adapter boundary.
 */
export const GIT_COMMAND_IO_FAILED_MESSAGE = 'GIT_COMMAND_IO_FAILED';

/** Fixed data-free error for malformed caller execution control. */
export const GIT_COMMAND_SIGNAL_INVALID_MESSAGE = 'GIT_COMMAND_SIGNAL_INVALID';

type GitCommandWinner =
  | 'timed_out'
  | 'cancelled'
  | 'output_limit'
  | 'io_failed'
  | 'exited'
  | 'spawn_failed';

interface GitCommandWinnerLatch {
  readonly whenWon: Promise<GitCommandWinner>;
  current(): GitCommandWinner | null;
  win(reason: GitCommandWinner): boolean;
}

function createWinnerLatch(): GitCommandWinnerLatch {
  let winner: GitCommandWinner | null = null;
  let resolveWinner: (reason: GitCommandWinner) => void = () => undefined;
  const whenWon = new Promise<GitCommandWinner>(resolve => {
    resolveWinner = resolve;
  });
  return {
    whenWon,
    current: () => winner,
    win: reason => {
      if (winner !== null) return false;
      winner = reason;
      resolveWinner(reason);
      return true;
    },
  };
}

function invalidSignal(): never {
  throw new Error(GIT_COMMAND_SIGNAL_INVALID_MESSAGE);
}

function validateAbortSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  try {
    if (
      typeof value !== 'object'
      || value === null
      || typeof (value as { readonly aborted?: unknown }).aborted !== 'boolean'
      || typeof (value as { readonly addEventListener?: unknown }).addEventListener !== 'function'
      || typeof (value as { readonly removeEventListener?: unknown }).removeEventListener !== 'function'
    ) {
      return invalidSignal();
    }
  } catch {
    return invalidSignal();
  }
  return value as AbortSignal;
}

function signalFromOptions(options: GitCommandExecuteOptions): AbortSignal | undefined {
  try {
    return validateAbortSignal((options as { readonly signal?: unknown }).signal);
  } catch {
    return invalidSignal();
  }
}

function readSignalAborted(signal: AbortSignal): boolean {
  try {
    return signal.aborted;
  } catch {
    return invalidSignal();
  }
}

/** Fixed executable. Callers can never substitute it. */
export const GIT_EXECUTABLE = 'git';

/** Server-owned per-family deadlines in milliseconds. Not caller-tunable. */
export const GIT_COMMAND_DEADLINES_MS_V1 = Object.freeze({
  repository_root: 5000,
  head_commit: 5000,
  porcelain_v2_status: 15000,
  bounded_diff: 30000,
} as const);

/**
 * Server-owned deadline for platform launch and ownership bootstrap. This is
 * deliberately separate from Git runtime: the Windows owned-spawn path may
 * legitimately consume its 30s helper-readiness plus 5s response bounds
 * before it can return a native handle. The 45s budget leaves a conservative
 * 10s scheduling margin without weakening any per-family runtime deadline.
 */
export const GIT_COMMAND_LAUNCH_DEADLINE_MS_V1 = 45_000;

/**
 * Deterministic observation environment overlay. Applied after host GIT_*
 * redirection keys are stripped, so the host cannot override any of them.
 *
 * - M1 frozen locale/lock/prompt values.
 * - Pager disabled without config mutation.
 * - Global/system config reads neutralized (no repository/global writes).
 * - System attributes (external diff drivers) disabled.
 * - Parent-directory discovery is pinned to the validated Workspace cwd, so
 *   repository discovery cannot escape upward into an unrelated repository.
 * - Repository-local core.fsmonitor is disabled and status.relativePaths is
 *   forced to false at command scope through controlled
 *   GIT_CONFIG_COUNT/KEY_n/VALUE_n entries (no config write). A real Git
 *   probe confirmed default porcelain-v2 emits cwd-relative paths for a
 *   nested Workspace cwd, while the frozen M1 parser requires
 *   repository-relative paths; status.relativePaths=false restores them.
 *   Host-provided GIT_CONFIG_* can never win because every host GIT_* key is
 *   stripped before this overlay is applied.
 */
export const GIT_ENVIRONMENT_OVERLAY_V1: Readonly<Record<string, string>> = Object.freeze({
  ...GIT_COMMAND_EXECUTION_CONTRACT_V1.environment,
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CEILING_DIRECTORIES: '',
  GIT_DISCOVERY_ACROSS_FILESYSTEM: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'status.relativePaths',
  GIT_CONFIG_VALUE_1: 'false',
});

/**
 * Cross-platform allowlist of host keys required to locate/execute Git.
 * Everything else from the host environment is dropped: arbitrary non-GIT
 * keys (PATH_INFO, HOME, ...) are not needed to spawn or run Git and would
 * only widen the trust surface.
 */
const HOST_ENVIRONMENT_ALLOWLIST_V1: ReadonlySet<string> = new Set(
  process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP']
    : ['PATH', 'TMPDIR', 'TEMP', 'TMP'],
);

/**
 * Host environment keys that could redirect the command to an unrelated
 * repository, re-enable prompting, or inject behavior are always stripped.
 * The '^GIT_' prefix covers every Git configuration surface (GIT_DIR,
 * GIT_WORK_TREE, GIT_EXEC_PATH, GIT_SSH_COMMAND, GIT_CONFIG_*,
 * GIT_EXTERNAL_DIFF, GIT_FSMONITOR_TEST, credential helpers, ...).
 */
const STRIPPED_ENVIRONMENT_KEY_PATTERN = /^(GIT_|SSH_ASKPASS)/u;

export function sanitizeGitEnvironment(
  base: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  // Windows environment keys are case-insensitive; canonicalize the
  // allowlist comparison so 'SystemRoot' and 'SYSTEMROOT' both resolve.
  for (const [key, value] of Object.entries(base)) {
    const normalized = process.platform === 'win32' ? key.toUpperCase() : key;
    if (!HOST_ENVIRONMENT_ALLOWLIST_V1.has(normalized)) continue;
    if (STRIPPED_ENVIRONMENT_KEY_PATTERN.test(normalized)) continue;
    env[key] = value;
  }
  Object.assign(env, GIT_ENVIRONMENT_OVERLAY_V1);
  return env;
}

export interface ScheduledTimer {
  cancel(): void;
}

/**
 * Test seam: driver, base environment and timer scheduling may be injected,
 * but never deadlines, stdout limits, the executable, argv, or a pathspec.
 * The production factory does not accept any of these dependencies.
 */
export interface GitCommandAdapterDependencies {
  readonly driver: PlatformProcessDriver;
  readonly baseEnvironment?: Readonly<Record<string, string>>;
  readonly schedule?: (callback: () => void, delayMs: number) => ScheduledTimer;
}

export interface GitCommandExecuteOptions {
  /** The only caller-owned execution control. */
  readonly signal?: AbortSignal;
}

export interface GitCommandPortFactoryOptions {
  readonly signal?: AbortSignal;
}

function defaultSchedule(callback: () => void, delayMs: number): ScheduledTimer {
  const timer = setTimeout(callback, delayMs);
  return { cancel: () => clearTimeout(timer) };
}

function validateRepositoryRelativePrefix(prefix: string): string {
  if (prefix.length === 0) return prefix;
  if (
    prefix.includes('\0')
    || prefix.includes('\\')
    || prefix.startsWith('/')
    || /^[A-Za-z]:/u.test(prefix)
    || prefix.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('GIT_COMMAND_REQUEST_INVALID: workspacePathFromRepositoryRoot');
  }
  return prefix;
}

/**
 * Fixed argv per sealed family. The pathspec is always the literal '-- .'
 * relative to the validated Workspace cwd; workspacePathFromRepositoryRoot
 * is validated here but is reserved for M1 parser path projection and is
 * never substituted into Git argv.
 */
export function gitCommandArgv(request: GitCommandRequestV1): readonly string[] {
  switch (request.family) {
    case 'repository_root':
      return Object.freeze(['rev-parse', '--show-toplevel']);
    case 'head_commit':
      return GIT_COMMAND_ARGUMENTS_V1.head_commit;
    case 'porcelain_v2_status': {
      validateRepositoryRelativePrefix(request.workspacePathFromRepositoryRoot);
      return Object.freeze([
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--no-ahead-behind',
        '--',
        '.',
      ]);
    }
    case 'bounded_diff': {
      if (parseGitCommitObjectIdV1(request.baseCommitSha) !== request.baseCommitSha) {
        throw new Error('GIT_COMMAND_REQUEST_INVALID: baseCommitSha');
      }
      validateRepositoryRelativePrefix(request.workspacePathFromRepositoryRoot);
      return Object.freeze([
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        request.baseCommitSha,
        '--',
        '.',
      ]);
    }
    default:
      throw new Error('GIT_COMMAND_REQUEST_INVALID: family');
  }
}

function boundedResult(
  stdout: Uint8Array,
  stderrDiagnostic: Uint8Array,
  stderrDiagnosticTruncated: boolean,
  termination: GitCommandResultV1['termination'],
  exitCode: number | null,
  spawnFailure?: 'not_found' | 'permission' | 'unknown',
): GitCommandResultV1 {
  const base = {
    stdout,
    stderrDiagnostic,
    stderrDiagnosticTruncated,
  };
  if (termination === 'exited') {
    return { ...base, termination, exitCode: exitCode ?? -1 };
  }
  if (termination === 'spawn_failed') {
    return { ...base, termination, exitCode: null, spawnFailure: spawnFailure ?? 'unknown' };
  }
  return { ...base, termination, exitCode: null };
}

function emptyCancelledResult(): GitCommandResultV1 {
  return boundedResult(new Uint8Array(0), new Uint8Array(0), false, 'cancelled', null);
}

function mapSpawnFailure(error: unknown): 'not_found' | 'permission' | 'unknown' {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return 'not_found';
  if (code === 'EPERM' || code === 'EACCES') return 'permission';
  return 'unknown';
}

export class GitCommandAdapter implements GitCommandPort {
  readonly executionContract = GIT_COMMAND_EXECUTION_CONTRACT_V1;

  private readonly driver: PlatformProcessDriver;
  private readonly baseEnvironment: Readonly<Record<string, string>>;
  private readonly schedule: (callback: () => void, delayMs: number) => ScheduledTimer;

  constructor(dependencies: GitCommandAdapterDependencies) {
    this.driver = dependencies.driver;
    this.baseEnvironment = dependencies.baseEnvironment ?? (process.env as Record<string, string>);
    this.schedule = dependencies.schedule ?? defaultSchedule;
  }

  async execute(
    request: GitCommandRequestV1,
    options: GitCommandExecuteOptions = {},
  ): Promise<GitCommandResultV1> {
    // Runtime validation precedes timer scheduling, listener installation,
    // and every process interaction. Malformed controls fail with one fixed,
    // data-free error and can never strand an owned handle.
    const signal = signalFromOptions(options);
    // Validate (and seal) argv before any process interaction.
    const argv = gitCommandArgv(request);

    if (signal !== undefined && readSignalAborted(signal)) {
      return emptyCancelledResult();
    }

    const launch: ValidatedLaunch = {
      executable: GIT_EXECUTABLE,
      args: argv,
      cwd: request.cwd,
      env: sanitizeGitEnvironment(this.baseEnvironment),
      envDiagnostics: [],
      shell: false,
    };

    const winner = createWinnerLatch();
    let launchTimer: ScheduledTimer | null = null;
    let familyTimer: ScheduledTimer | null = null;
    let onAbort: (() => void) | null = null;
    let listenerInstalled = false;
    let controlsCleaned = false;

    const cancelLaunchTimer = (): void => {
      if (launchTimer === null) return;
      launchTimer.cancel();
      launchTimer = null;
    };

    const cancelFamilyTimer = (): void => {
      if (familyTimer === null) return;
      familyTimer.cancel();
      familyTimer = null;
    };

    const cleanupControls = (): void => {
      if (controlsCleaned) return;
      controlsCleaned = true;
      cancelLaunchTimer();
      cancelFamilyTimer();
      if (listenerInstalled && onAbort !== null && signal !== undefined) {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          // A validated native AbortSignal does not throw here. Keep cleanup
          // data-free if a hostile duck-typed signal changes after validation.
        }
        listenerInstalled = false;
        onAbort = null;
      }
    };

    try {
      if (signal !== undefined) {
        onAbort = () => {
          winner.win('cancelled');
        };
        try {
          signal.addEventListener('abort', onAbort, { once: true });
          listenerInstalled = true;
          // Close the check/install race: an abort between the initial read
          // and listener installation still becomes the single winner.
          if (readSignalAborted(signal)) winner.win('cancelled');
        } catch {
          cleanupControls();
          return invalidSignal();
        }
      }

      if (winner.current() === 'cancelled') {
        return emptyCancelledResult();
      }

      launchTimer = this.schedule(() => {
        winner.win('timed_out');
      }, GIT_COMMAND_LAUNCH_DEADLINE_MS_V1);

      // A synchronous injected scheduler can win before spawn. No handle can
      // escape because spawn has not begun.
      if (winner.current() === 'timed_out') {
        return boundedResult(
          new Uint8Array(0),
          new Uint8Array(0),
          false,
          'timed_out',
          null,
        );
      }

      let handle: NativeProcessHandle;
      try {
        handle = await this.driver.spawn(launch);
      } catch (error) {
        cancelLaunchTimer();
        const priorWinner = winner.current();
        if (priorWinner === 'timed_out' || priorWinner === 'cancelled') {
          return boundedResult(
            new Uint8Array(0),
            new Uint8Array(0),
            false,
            priorWinner,
            null,
          );
        }
        winner.win('spawn_failed');
        // Ordinary spawn rejection won before timeout/abort. It carries no
        // bounded process evidence and exposes no raw driver detail.
        return boundedResult(
          new Uint8Array(0),
          new Uint8Array(0),
          false,
          'spawn_failed',
          null,
          mapSpawnFailure(error),
        );
      }

      // Native ownership is now established. Stop the platform-bootstrap
      // budget before arming Git runtime so the two phases never overlap.
      cancelLaunchTimer();
      if (winner.current() === null) {
        familyTimer = this.schedule(() => {
          winner.win('timed_out');
        }, GIT_COMMAND_DEADLINES_MS_V1[request.family]);
      }

      return await this.runOwned(handle, request.family, winner);
    } finally {
      cleanupControls();
    }
  }

  /**
   * Streaming state machine for one owned child. Settlement is exactly-once;
   * on any non-exit termination the owned tree is terminated and verified.
   */
  private async runOwned(
    handle: NativeProcessHandle,
    family: GitCommandRequestV1['family'],
    winner: GitCommandWinnerLatch,
  ): Promise<GitCommandResultV1> {
    const stdoutLimit = GIT_COMMAND_STDOUT_LIMITS_V1[family];

    const stdoutChunks: Uint8Array[] = [];
    let stdoutBytes = 0;
    const stderrChunks: Uint8Array[] = [];
    let stderrBytes = 0;
    let stderrTruncated = false;

    // Exactly-once owned-tree cleanup with proof. A terminateTree rejection
    // never prevents the final verification attempt; every raw driver error
    // is contained here so nothing unbounded escapes the adapter boundary.
    let cleanupPromise: Promise<boolean> | null = null;
    const runCleanup = (): Promise<boolean> => {
      cleanupPromise ??= (async (): Promise<boolean> => {
        try {
          await this.driver.terminateTree(handle);
        } catch {
          // Best-effort termination; the verification below is authoritative.
        }
        try {
          const verification = await this.driver.verifySurvivors(handle);
          return (
            verification.classification === 'complete'
            && verification.proof?.kind === 'owned-tree-enumeration'
          );
        } catch {
          return false;
        }
      })();
      return cleanupPromise;
    };

    const requiresCleanup = (reason: GitCommandWinner): boolean => (
      reason === 'timed_out'
      || reason === 'cancelled'
      || reason === 'output_limit'
      || reason === 'io_failed'
    );
    const cleanupForWinner = winner.whenWon.then(reason => (
      requiresCleanup(reason) ? runCleanup() : true
    ));

    const pumpStdout = async (): Promise<void> => {
      for await (const chunk of handle.streams.stdout) {
        // Any winner stops stdout retention, but the stream remains drained.
        if (winner.current() !== null) continue;
        const remaining = stdoutLimit - stdoutBytes;
        if (chunk.byteLength <= remaining) {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.byteLength;
          continue;
        }
        if (remaining > 0) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes += remaining;
        }
        winner.win('output_limit');
      }
    };

    const pumpStderr = async (): Promise<void> => {
      for await (const chunk of handle.streams.stderr) {
        // Continue retaining the bounded diagnostic prefix after timeout,
        // cancellation, output overflow, or IO settlement. Omitted bytes set
        // the truncation fact while the remaining pipe is still drained.
        const remaining = GIT_COMMAND_DIAGNOSTIC_LIMIT_BYTES_V1 - stderrBytes;
        if (chunk.byteLength <= remaining) {
          stderrChunks.push(chunk);
          stderrBytes += chunk.byteLength;
        } else {
          if (remaining > 0) {
            stderrChunks.push(chunk.subarray(0, remaining));
            stderrBytes += remaining;
          }
          stderrTruncated = true;
        }
      }
    };

    type IoObservation<T> =
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false };
    const observeIo = async <T>(operation: () => Promise<T>): Promise<IoObservation<T>> => {
      try {
        return { ok: true, value: await operation() };
      } catch {
        // IO only wins when no earlier reason exists. A late iterator/wait
        // rejection cannot overwrite timeout/cancel/output_limit.
        winner.win('io_failed');
        return { ok: false };
      }
    };

    const [exitObservation] = await Promise.all([
      observeIo(() => handle.waitExit()),
      observeIo(pumpStdout),
      observeIo(pumpStderr),
    ]);

    let finalWinner = winner.current();
    if (finalWinner === null) {
      winner.win('exited');
      finalWinner = 'exited';
    }

    if (requiresCleanup(finalWinner)) {
      const cleanupProven = await cleanupForWinner;
      if (!cleanupProven) throw new Error(GIT_COMMAND_CLEANUP_UNPROVEN_MESSAGE);
      if (finalWinner === 'io_failed') {
        throw new Error(GIT_COMMAND_IO_FAILED_MESSAGE);
      }
      return boundedResult(
        concatChunks(stdoutChunks, stdoutBytes),
        concatChunks(stderrChunks, stderrBytes),
        stderrTruncated,
        finalWinner,
        null,
      );
    }

    if (finalWinner !== 'exited' || !exitObservation.ok) {
      // No other winner can reach an owned handle. Keep this internal
      // invariant data-free if a test seam violates the contract.
      throw new Error(GIT_COMMAND_IO_FAILED_MESSAGE);
    }

    return boundedResult(
      concatChunks(stdoutChunks, stdoutBytes),
      concatChunks(stderrChunks, stderrBytes),
      stderrTruncated,
      'exited',
      exitObservation.value.exitCode,
    );
  }
}

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]!.byteLength === totalBytes) return chunks[0]!;
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Production factory. The only caller-owned execution control is an
 * AbortSignal; deadlines, limits, executable, argv, environment policy and
 * the process driver are server-owned and frozen.
 */
export class GitCommandPortFactory {
  private constructor() {
    // static-only
  }

  static create(options?: GitCommandPortFactoryOptions): GitCommandPort {
    if (options !== undefined) {
      const keys = Object.keys(options);
      for (const key of keys) {
        if (key !== 'signal') {
          throw new Error('GIT_COMMAND_FACTORY_INVALID_OPTION');
        }
      }
    }
    const adapter = new GitCommandAdapter({ driver: new NodeProcessDriver() });
    const signal = options?.signal;
    if (signal === undefined) return adapter;
    return {
      executionContract: adapter.executionContract,
      execute: request => adapter.execute(request, { signal }),
    };
  }
}
