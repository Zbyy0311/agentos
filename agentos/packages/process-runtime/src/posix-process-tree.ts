import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { ProcessControlResult, SurvivorVerification, TreeTerminationResult } from './driver.js';
import type { NativeIdentity } from './types.js';
import { boundedErrorDetail, type ProcessTreeController, type ProcessTreeHandle } from './platform-process-tree.js';

const execFileAsync = promisify(execFile);
const ENUMERATION_TIMEOUT_MS = 2_000;
const ENUMERATION_MAX_BUFFER = 64 * 1024;
const CLEANUP_DEADLINE_MS = 2_000;
const CLEANUP_POLL_MS = 25;

export interface PosixProcessTableEntry {
  readonly pid: number;
  readonly groupId: number;
  readonly sessionId: number;
}

/**
 * One enumeration of the complete owned SESSION. AgentOS spawns detached, so
 * the root PID is the session id; every process with that session id belongs
 * to AgentOS regardless of its process group.
 */
export interface PosixSessionEnumeration {
  readonly members: readonly number[];
  readonly groupIds: readonly number[];
}

export type PosixSessionReader = (sessionId: number) => Promise<PosixSessionEnumeration>;
export type PosixGroupTerminator = (groupId: number) => void;

/** Lossless Linux /proc start-time token captured from the spawned child. */
export function readLinuxProcessBirthIdentity(pid: number): string | null {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    const startTicks = fields[19]; // proc stat field 22; comm is field 2.
    return startTicks !== undefined && /^\d+$/.test(startTicks)
      ? 'linux:proc-start-ticks:' + startTicks
      : null;
  } catch {
    return null;
  }
}

interface PosixTreeState {
  readonly sessionId: number;
  readonly readSession: PosixSessionReader;
  readonly terminateGroup: PosixGroupTerminator;
  cleanupRequested: boolean;
  suspendedByAgentOs: boolean;
  nativeBirthIdentity: string | null;
  closedVerification?: SurvivorVerification;
}

export function parsePosixProcessTable(output: string): readonly PosixProcessTableEntry[] {
  const entries: PosixProcessTableEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length !== 3 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1]) || !/^\d+$/.test(fields[2])) {
      throw new Error('invalid-posix-process-table-row');
    }
    const pid = Number(fields[0]);
    const groupId = Number(fields[1]);
    const sessionId = Number(fields[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(groupId) || groupId <= 0 || !Number.isSafeInteger(sessionId) || sessionId <= 0) {
      throw new Error('invalid-posix-process-table-pid');
    }
    entries.push({ pid, groupId, sessionId });
  }
  return entries;
}

/** All processes in the owned session, across every owned process group. */
export function membersForPosixSession(
  entries: readonly PosixProcessTableEntry[],
  sessionId: number,
): readonly number[] {
  return [...new Set(entries.filter(entry => entry.sessionId === sessionId).map(entry => entry.pid))].sort((a, b) => a - b);
}

/** All distinct process groups inside the owned session. */
export function groupsForPosixSession(
  entries: readonly PosixProcessTableEntry[],
  sessionId: number,
): readonly number[] {
  return [...new Set(entries.filter(entry => entry.sessionId === sessionId).map(entry => entry.groupId))].sort((a, b) => a - b);
}

async function readPosixSession(sessionId: number): Promise<PosixSessionEnumeration> {
  const result = await execFileAsync('ps', ['-eo', 'pid=,pgid=,sid='], {
    shell: false,
    windowsHide: true,
    timeout: ENUMERATION_TIMEOUT_MS,
    maxBuffer: ENUMERATION_MAX_BUFFER,
  });
  const entries = parsePosixProcessTable(result.stdout);
  return {
    members: membersForPosixSession(entries, sessionId),
    groupIds: groupsForPosixSession(entries, sessionId),
  };
}

function terminatePosixGroup(groupId: number): void {
  try {
    process.kill(-groupId, 'SIGKILL');
  } catch (error) {
    // A group that vanished between enumeration and signalling is already
    // terminated; that is success, not partial termination.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
}

export class PosixProcessTreeController implements ProcessTreeController {
  constructor(
    private readonly readSession: PosixSessionReader = readPosixSession,
    private readonly terminateGroup: PosixGroupTerminator = terminatePosixGroup,
  ) {}

  async attach(identity: NativeIdentity): Promise<ProcessTreeHandle> {
    // Detached spawn makes the root PID the session id of the owned session.
    const sessionId = identity.pid;
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      return { platform: 'unavailable', rootPid: identity.pid, state: undefined };
    }
    const state: PosixTreeState = {
      sessionId,
      readSession: this.readSession,
      terminateGroup: this.terminateGroup,
      cleanupRequested: false,
      suspendedByAgentOs: false,
      nativeBirthIdentity: identity.nativeBirthIdentity ?? null,
    };
    return { platform: 'posix', rootPid: identity.pid, state };
  }

  async terminateTree(handle: ProcessTreeHandle): Promise<TreeTerminationResult> {
    if (handle.platform !== 'posix') {
      return { classification: 'unknown', attemptedMembers: [], errors: ['posix-handle-mismatch'] };
    }
    const state = handle.state as PosixTreeState;
    // A frozen terminal proof must never re-target a numerically reused
    // session that appeared after the owned session was proven empty.
    if (state.closedVerification?.classification === 'complete') {
      return { classification: 'complete', attemptedMembers: [], errors: [] };
    }
    state.cleanupRequested = true;
    let members: readonly number[] = [];
    try {
      const enumeration = await state.readSession(state.sessionId);
      members = enumeration.members;
      const errors: string[] = [];
      for (const groupId of enumeration.groupIds) {
        // Only groups observed inside the owned session are ever signalled.
        try {
          state.terminateGroup(groupId);
        } catch (error) {
          errors.push(boundedErrorDetail(error, 'posix-group-termination-failed'));
        }
      }
      if (errors.length > 0) {
        return { classification: 'unknown', attemptedMembers: members, errors };
      }
      return { classification: 'complete', attemptedMembers: members, errors: [] };
    } catch (error) {
      return {
        classification: 'unknown',
        attemptedMembers: members,
        errors: [boundedErrorDetail(error, 'posix-tree-termination-failed')],
      };
    }
  }

  async verifySurvivors(handle: ProcessTreeHandle): Promise<SurvivorVerification> {
    if (handle.platform !== 'posix') return { classification: 'unknown', knownPids: [] };
    const state = handle.state as PosixTreeState;
    if (state.closedVerification !== undefined) return state.closedVerification;
    const deadline = Date.now() + (state.cleanupRequested ? CLEANUP_DEADLINE_MS : 0);
    while (true) {
      try {
        const enumeration = await state.readSession(state.sessionId);
        if (enumeration.members.length === 0) {
          const verification: SurvivorVerification = {
            classification: 'complete',
            knownPids: [],
            proof: { kind: 'owned-tree-enumeration' },
          };
          state.closedVerification = verification;
          return verification;
        }
        if (!state.cleanupRequested || Date.now() >= deadline) {
          return { classification: 'survivors', knownPids: enumeration.members };
        }
      } catch {
        if (state.closedVerification !== undefined) return state.closedVerification;
        return { classification: 'unknown', knownPids: [] };
      }
      await new Promise(resolve => setTimeout(resolve, CLEANUP_POLL_MS));
    }
  }

  async suspend(handle: ProcessTreeHandle, identity: NativeIdentity): Promise<ProcessControlResult> {
    return this.controlRoot(handle, identity, 'SIGSTOP');
  }

  async resume(handle: ProcessTreeHandle, identity: NativeIdentity): Promise<ProcessControlResult> {
    return this.controlRoot(handle, identity, 'SIGCONT');
  }

  private async controlRoot(
    handle: ProcessTreeHandle,
    identity: NativeIdentity,
    signal: 'SIGSTOP' | 'SIGCONT',
  ): Promise<ProcessControlResult> {
    if (handle.platform !== 'posix') return { status: 'unsupported', reason: 'posix-process-control-unavailable' };
    if (process.platform !== 'linux') {
      return { status: 'unsupported', reason: 'posix-process-control-requires-linux-birth-identity' };
    }
    const state = handle.state as PosixTreeState;
    if (
      handle.rootPid !== identity.pid
      || state.sessionId !== identity.pid
      || identity.groupId !== String(state.sessionId)
      || !identity.nativeBirthIdentity
      || state.nativeBirthIdentity !== identity.nativeBirthIdentity
    ) return { status: 'rejected', reason: 'process-identity-mismatch' };
    if (state.cleanupRequested || state.closedVerification?.classification === 'complete') {
      return { status: 'rejected', reason: 'process-cleanup-started' };
    }
    if (signal === 'SIGCONT' && !state.suspendedByAgentOs) {
      return { status: 'rejected', reason: 'process-not-suspended-by-agentos' };
    }

    let enumeration: PosixSessionEnumeration;
    try {
      enumeration = await state.readSession(state.sessionId);
    } catch {
      return { status: 'rejected', reason: 'process-ownership-unavailable' };
    }
    if (state.cleanupRequested) return { status: 'rejected', reason: 'process-cleanup-started' };
    if (!enumeration.members.includes(identity.pid)) {
      return { status: 'rejected', reason: 'process-identity-not-in-owned-session' };
    }
    if (readLinuxProcessBirthIdentity(identity.pid) !== identity.nativeBirthIdentity) {
      return { status: 'rejected', reason: 'process-birth-identity-mismatch' };
    }
    try {
      process.kill(identity.pid, signal);
      state.suspendedByAgentOs = signal === 'SIGSTOP';
      return { status: 'completed' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { status: 'rejected', reason: code === 'ESRCH' ? 'process-already-exited' : 'native-process-control-failed' };
    }
  }

  async dispose(_handle: ProcessTreeHandle): Promise<void> {
    // POSIX session ownership has no persistent helper resource.
  }
}
