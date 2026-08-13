import type { P1ProcessErrorCode, ProcessErrorPhase } from './errors.js';

/** Runtime Specification Process vocabulary, adopted exactly. */
export const PROCESS_STATES = [
  'created',
  'starting',
  'running',
  'waiting',
  'stopping',
  'exited',
  'failed',
  'orphaned',
  'unknown',
] as const;

export type ProcessState = (typeof PROCESS_STATES)[number];

export const TERMINAL_PROCESS_STATES = ['exited', 'failed'] as const;
export type TerminalProcessState = (typeof TERMINAL_PROCESS_STATES)[number];

export function isTerminalState(state: ProcessState): state is TerminalProcessState {
  return state === 'exited' || state === 'failed';
}

/** AgentOS canonical Process identity. Never derived from an OS PID. */
export type ProcessId = `proc_${string}`;

/** Fenced claim identity attached to a reservation. */
export interface ClaimIdentity {
  readonly key: string;
  readonly owner: string;
  readonly epoch: number;
}

/** Caller-supplied launch request. Executable and arguments stay separated. */
export interface LaunchRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: LaunchEnvironmentInput;
  /** Only false/absent is accepted; true is denied by policy. */
  readonly shell?: boolean;
  /** Detached/daemon behavior is denied in P1. */
  readonly detached?: boolean;
}

export interface LaunchEnvironmentInput {
  /** Explicit safe base; defaults to an allowlisted pick of the host env. */
  readonly base?: Readonly<Record<string, string | undefined>>;
  /** Declared non-secret profile values. */
  readonly profile?: Readonly<Record<string, string>>;
  /** Declared non-secret Run overrides. */
  readonly overrides?: Readonly<Record<string, string>>;
  /** Ephemeral secret references; values never enter diagnostics. */
  readonly secretRefs?: Readonly<Record<string, string>>;
}

export interface EnvironmentDiagnostic {
  readonly key: string;
  readonly source: 'base' | 'profile' | 'override' | 'secret-ref';
  readonly classification: 'plain' | 'secret-ephemeral';
}

/** Validated launch: separated args, resolved cwd, safe env. */
export interface ValidatedLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly envDiagnostics: readonly EnvironmentDiagnostic[];
  readonly shell: false;
}

/** Redacted launch facts safe for diagnostics. No raw arg/env values. */
export interface RedactedLaunchFacts {
  readonly executable: string;
  readonly argCount: number;
  readonly redactedArgs: readonly string[];
  readonly envKeys: readonly string[];
}

export interface TimeoutPolicy {
  /** Deadline from native start to readiness mark. */
  readonly startupMs?: number;
  /** Idle deadline between activity checkpoints; paused while waiting. */
  readonly idleMs?: number;
  /** Total deadline from native start. */
  readonly totalMs?: number;
  /** Graceful-stop grace before force tree termination. */
  readonly graceMs: number;
}

export const DEFAULT_TIMEOUT_POLICY: TimeoutPolicy = {
  startupMs: 30_000,
  idleMs: 300_000,
  totalMs: 3_600_000,
  graceMs: 5_000,
};

export type CleanupResult =
  | 'TERMINATED'
  | 'ALREADY_EXITED'
  | 'SURVIVORS'
  | 'IDENTITY_MISMATCH'
  | 'UNKNOWN_PLATFORM_UNAVAILABLE';

export interface NativeIdentity {
  readonly pid: number;
  readonly startedAtMs: number;
  readonly executablePath: string;
  readonly parentPid?: number;
  readonly groupId?: string;
}

export interface ExitEvidence {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly exitedAt: number;
}

export type StopReason = 'cancel' | P1ProcessErrorCode | (string & {});

export interface StopRequest {
  readonly reason: StopReason;
  readonly idempotencyKey: string;
  readonly claim?: ClaimIdentity;
}

export interface ProcessErrorEvidence {
  readonly code: P1ProcessErrorCode;
  readonly phase: ProcessErrorPhase;
  readonly detail: string;
}

/** One immutable terminal result. First terminal CAS wins; never overwritten. */
export interface TerminalResult {
  readonly state: TerminalProcessState;
  readonly outcome:
    | 'validation-failure'
    | 'spawn-failure'
    | 'spawn-failure-after-cancel'
    | 'registration-failure'
    | 'cancelled-before-spawn'
    | 'exit'
    | 'cancelled'
    | 'timeout';
  readonly terminationReason: StopReason | null;
  readonly cancelCausation: StopReason | null;
  readonly error: ProcessErrorEvidence | null;
  readonly exit: ExitEvidence | null;
  readonly cleanup: CleanupResult | null;
  readonly version: number;
  readonly terminalAt: number;
}

export type ProcessFactType =
  | 'process.launch_requested'
  | 'process.started'
  | 'process.stopping'
  | 'process.exited'
  | 'process.failed';

export interface ProcessFact {
  readonly type: ProcessFactType;
  readonly at: number;
  readonly version: number;
}

/** Immutable external view of a Process record. */
export interface ProcessSnapshot {
  readonly id: ProcessId;
  readonly claimKey: string;
  readonly claimOwner: string;
  readonly claimEpoch: number;
  readonly state: ProcessState;
  readonly version: number;
  readonly launch: RedactedLaunchFacts;
  readonly createdAt: number;
  readonly startingAt: number | null;
  /** Null while the consumed spawn call is unresolved; never means unspawned. */
  readonly pid: number | null;
  readonly spawnAttempts: number;
  readonly startedAt: number | null;
  readonly readyAt: number | null;
  readonly stopReason: StopReason | null;
  readonly terminal: TerminalResult | null;
  /** Non-terminal cleanup evidence (for example an orphaned classification). */
  readonly cleanupEvidence: { readonly result: CleanupResult; readonly at: number } | null;
  readonly facts: readonly ProcessFact[];
}

export interface ReservationResult {
  readonly snapshot: ProcessSnapshot;
  readonly joinedExisting: boolean;
}

export interface StartResult {
  readonly snapshot: ProcessSnapshot;
  /** Resolves when the single spawn continuation has fully settled. */
  readonly settled: Promise<ProcessSnapshot>;
}

export interface StopTicket {
  readonly idempotencyKey: string;
  readonly reason: StopReason;
  readonly acceptedAt: number;
  /** Joins the single stop result; duplicates never create a new ticket. */
  readonly result: Promise<ProcessSnapshot>;
}
