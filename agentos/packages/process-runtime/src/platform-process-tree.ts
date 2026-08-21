import type { SurvivorVerification, TreeTerminationResult } from './driver.js';
import type { NativeIdentity } from './types.js';
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
      errors: [`platform-tree-unavailable:${this.reason}`],
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
