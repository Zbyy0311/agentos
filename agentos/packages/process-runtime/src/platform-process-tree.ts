import type { Readable } from 'node:stream';
import type { SurvivorVerification, TreeTerminationResult } from './driver.js';
import type { ExitEvidence, NativeIdentity, ValidatedLaunch } from './types.js';
import { PosixProcessTreeController } from './posix-process-tree.js';
import { WindowsProcessTreeController } from './windows-process-tree.js';

export interface ProcessTreeHandle {
  readonly platform: 'posix' | 'windows' | 'unavailable';
  readonly rootPid: number;
  readonly state: unknown;
}

export interface ProcessTreeController {
  attach(identity: NativeIdentity): Promise<ProcessTreeHandle>;
  terminateTree(handle: ProcessTreeHandle): Promise<TreeTerminationResult>;
  verifySurvivors(handle: ProcessTreeHandle): Promise<SurvivorVerification>;
  dispose(handle: ProcessTreeHandle): Promise<void>;
}

/**
 * Result of an atomic owned spawn: the provider process was placed under
 * platform ownership BEFORE any provider-controlled instruction executed, so
 * no descendant can pre-date ownership. The reported PID is the actual
 * provider PID, never a wrapper/helper PID.
 */
export interface OwnedSpawnResult {
  readonly pid: number;
  /**
   * P6-M3b: lossless native process-creation (birth) identity captured from the
   * real provider handle at spawn, before ResumeThread. Canonical form is
   * platform-tagged invariant text (e.g. win32:filetime unsigned decimal). It
   * is additional evidence only and NEVER replaces nativeStartedAt. Null when
   * capture was unavailable (fail-closed; never fabricated from the wall clock).
   */
  readonly nativeBirthIdentity?: string | null;
  readonly executablePath: string;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly waitExit: () => Promise<ExitEvidence>;
  /** Terminates the provider root only (Windows SIGTERM-equivalent). */
  readonly requestGracefulStop: () => Promise<boolean>;
  readonly tree: ProcessTreeHandle;
}

export interface OwnedSpawnCapableController extends ProcessTreeController {
  spawnOwned(launch: ValidatedLaunch): Promise<OwnedSpawnResult>;
}

export function supportsOwnedSpawn(
  controller: ProcessTreeController,
): controller is OwnedSpawnCapableController {
  return typeof (controller as Partial<OwnedSpawnCapableController>).spawnOwned === 'function';
}

export function createPlatformProcessTreeController(): ProcessTreeController {
  if (process.platform === 'win32') return new WindowsProcessTreeController();
  if (process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'freebsd') {
    return new PosixProcessTreeController();
  }
  return new UnavailableProcessTreeController('unsupported-platform');
}

export class UnavailableProcessTreeController implements ProcessTreeController {
  constructor(private readonly reason: string) {}

  async attach(identity: NativeIdentity): Promise<ProcessTreeHandle> {
    return { platform: 'unavailable', rootPid: identity.pid, state: undefined };
  }

  async terminateTree(handle: ProcessTreeHandle): Promise<TreeTerminationResult> {
    return {
      classification: 'unknown',
      attemptedMembers: handle.rootPid > 0 ? [handle.rootPid] : [],
      errors: ['platform-tree-unavailable:' + this.reason],
    };
  }

  async verifySurvivors(handle: ProcessTreeHandle): Promise<SurvivorVerification> {
    return {
      classification: 'unknown',
      knownPids: handle.rootPid > 0 ? [handle.rootPid] : [],
    };
  }

  async dispose(_handle: ProcessTreeHandle): Promise<void> {
    // There is no platform resource to release.
  }
}

export function boundedErrorDetail(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/[\r\n|]/g, ' ').trim();
  return (normalized || fallback).slice(0, 200);
}
