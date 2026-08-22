import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SurvivorVerification, TreeTerminationResult } from './driver.js';
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

interface PosixTreeState {
  readonly sessionId: number;
  readonly readSession: PosixSessionReader;
  readonly terminateGroup: PosixGroupTerminator;
  cleanupRequested: boolean;
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
    let members: readonly number[] = [];
    try {
      const enumeration = await state.readSession(state.sessionId);
      members = enumeration.members;
      state.cleanupRequested = true;
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

  async dispose(_handle: ProcessTreeHandle): Promise<void> {
    // POSIX session ownership has no persistent helper resource.
  }
}
