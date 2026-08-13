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

/**
 * Opaque native process handle returned exactly once by the single Driver
 * spawn call. waitExit never rejects for a non-zero exit code.
 */
export interface NativeProcessHandle {
  readonly pid: number;
  readonly identity: NativeIdentity;
  readonly streams: NativeProcessStreams;
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
