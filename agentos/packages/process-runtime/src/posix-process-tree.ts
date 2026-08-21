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

export type PosixGroupReader = (groupId: number) => Promise<readonly number[]>;
export type PosixGroupTerminator = (groupId: number) => void;

interface PosixTreeState {
  readonly groupId: number;
  readonly readMembers: PosixGroupReader;
  readonly terminateGroup: PosixGroupTerminator;
  cleanupRequested: boolean;
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

export function membersForPosixGroup(
  entries: readonly PosixProcessTableEntry[],
  groupId: number,
): readonly number[] {
  return [...new Set(entries.filter(entry => entry.groupId === groupId && entry.sessionId === groupId).map(entry => entry.pid))].sort((a, b) => a - b);
}

async function readPosixGroup(groupId: number): Promise<readonly number[]> {
  const result = await execFileAsync('ps', ['-eo', 'pid=,pgid=,sid='], {
    shell: false,
    windowsHide: true,
    timeout: ENUMERATION_TIMEOUT_MS,
    maxBuffer: ENUMERATION_MAX_BUFFER,
  });
  return membersForPosixGroup(parsePosixProcessTable(result.stdout), groupId);
}

function terminatePosixGroup(groupId: number): void {
  process.kill(-groupId, 'SIGKILL');
}

export class PosixProcessTreeController implements ProcessTreeController {
  constructor(
    private readonly readGroup: PosixGroupReader = readPosixGroup,
    private readonly terminateGroup: PosixGroupTerminator = terminatePosixGroup,
  ) {}

  async attach(identity: NativeIdentity): Promise<ProcessTreeHandle> {
    const groupId = Number(identity.groupId ?? identity.pid);
    if (!Number.isSafeInteger(groupId) || groupId <= 0) {
      return { platform: 'unavailable', rootPid: identity.pid, state: undefined };
    }
    const state: PosixTreeState = {
      groupId,
      readMembers: this.readGroup,
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
    let members: readonly number[] = [];
    try {
      members = await state.readMembers(state.groupId);
      state.cleanupRequested = true;
      if (members.length > 0) state.terminateGroup(state.groupId);
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
    const deadline = Date.now() + (state.cleanupRequested ? CLEANUP_DEADLINE_MS : 0);
    while (true) {
      try {
        const members = [...await state.readMembers(state.groupId)];
        if (members.length === 0) {
          return { classification: 'complete', knownPids: [], proof: { kind: 'owned-tree-enumeration' } };
        }
        if (!state.cleanupRequested || Date.now() >= deadline) {
          return { classification: 'survivors', knownPids: members };
        }
      } catch {
        return { classification: 'unknown', knownPids: [] };
      }
      await new Promise(resolve => setTimeout(resolve, CLEANUP_POLL_MS));
    }
  }

  async dispose(_handle: ProcessTreeHandle): Promise<void> {
    // POSIX process-group ownership has no persistent helper resource.
  }
}
