import type {
  CleanupResult,
  ExitEvidence,
  NativeIdentity,
  ValidatedLaunch,
} from './types.js';

/** Byte streams exposed by a native process handle. Chunks are at most 64 KiB. */
export interface NativeProcessStreams {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
}

/** One backpressure-aware, bounded input write surface for an owned process. */
export interface NativeProcessStdin {
  /** Accepts one bounded chunk and resolves only after the native write settles. */
  write(chunk: Uint8Array): Promise<void>;
  /** Closes the child input exactly once; subsequent closes are idempotent. */
  close(): Promise<void>;
}

export const NATIVE_STDIN_MAX_CHUNK_BYTES = 16 * 1024;

export type ProcessControlResult =
  | { readonly status: 'completed' }
  | { readonly status: 'unsupported'; readonly reason: string }
  | { readonly status: 'rejected'; readonly reason: string };

/**
 * Opaque native process handle returned exactly once by the single Driver
 * spawn call. waitExit never rejects for a non-zero exit code.
 */
export interface NativeProcessHandle {
  readonly pid: number;
  readonly identity: NativeIdentity;
  readonly streams: NativeProcessStreams;
  /** Present only when spawn explicitly opted into stdinMode: 'pipe'. */
  readonly stdin?: NativeProcessStdin | null;
  waitExit(): Promise<ExitEvidence>;
}

export type SurvivorClassification = 'complete' | 'survivors' | 'unknown';

export interface TreeTerminationResult {
  readonly classification: SurvivorClassification;
  readonly attemptedMembers: readonly number[];
  readonly errors: readonly string[];
}

export interface GracefulStopResult {
  readonly delivered: boolean;
  readonly detail: string;
}

export interface SurvivorVerification {
  readonly classification: SurvivorClassification;
  readonly knownPids: readonly number[];
  /** Present only when the Driver established owned-tree enumeration proof. */
  readonly proof?: { readonly kind: 'owned-tree-enumeration' };
}

export type IdentityInspection =
  | { readonly kind: 'match'; readonly identity: NativeIdentity }
  | { readonly kind: 'missing' }
  | { readonly kind: 'mismatch'; readonly observed: NativeIdentity }
  | { readonly kind: 'unknown' };

/**
 * Injected platform port. Provider-neutral by construction: it knows native
 * processes, trees and identity evidence, never command semantics. Exactly
 * one spawn call is allowed per consumed spawn right; the Manager enforces
 * that and the Driver must never be asked twice for the same Process.
 */
export interface PlatformProcessDriver {
  spawn(launch: ValidatedLaunch): Promise<NativeProcessHandle>;
  gracefulStop(handle: NativeProcessHandle): Promise<GracefulStopResult>;
  terminateTree(handle: NativeProcessHandle): Promise<TreeTerminationResult>;
  verifySurvivors(handle: NativeProcessHandle): Promise<SurvivorVerification>;
  inspectIdentity(identity: NativeIdentity): Promise<IdentityInspection>;
  /** Process-level control. Unsupported platforms must return an explicit result. */
  suspend?(handle: NativeProcessHandle): Promise<ProcessControlResult>;
  resume?(handle: NativeProcessHandle): Promise<ProcessControlResult>;
}

export interface CleanupVerdict {
  readonly classification: SurvivorClassification;
  readonly cleanupResult: CleanupResult;
  readonly proven: boolean;
}

/**
 * The single cleanup-proof boundary. A bare `complete` is not evidence that
 * the owned tree was enumerated and is therefore deliberately unproven.
 */
export function cleanupVerdictFromVerification(
  verification: SurvivorVerification,
  exitedBeforeCleanup: boolean,
): CleanupVerdict {
  if (
    verification.classification === 'complete'
    && verification.proof?.kind === 'owned-tree-enumeration'
  ) {
    return {
      classification: 'complete',
      cleanupResult: exitedBeforeCleanup ? 'ALREADY_EXITED' : 'TERMINATED',
      proven: true,
    };
  }
  if (verification.classification === 'survivors') {
    return {
      classification: 'survivors',
      cleanupResult: 'SURVIVORS',
      proven: false,
    };
  }
  return {
    classification: 'unknown',
    cleanupResult: 'UNKNOWN_PLATFORM_UNAVAILABLE',
    proven: false,
  };
}

/**
 * Map exit observation and survivor classification onto the frozen cleanup
 * result vocabulary (TERMINATED / ALREADY_EXITED / SURVIVORS /
 * IDENTITY_MISMATCH / UNKNOWN_PLATFORM_UNAVAILABLE).
 */
export function cleanupResultFrom(
  classification: SurvivorClassification,
  exitedBeforeCleanup: boolean,
): CleanupResult {
  if (classification === 'complete') {
    return exitedBeforeCleanup ? 'ALREADY_EXITED' : 'TERMINATED';
  }
  if (classification === 'survivors') return 'SURVIVORS';
  return 'UNKNOWN_PLATFORM_UNAVAILABLE';
}
