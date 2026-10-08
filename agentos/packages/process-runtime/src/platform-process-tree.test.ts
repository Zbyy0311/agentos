import { describe, expect, it } from 'vitest';
import {
  groupsForPosixSession,
  membersForPosixSession,
  parsePosixProcessTable,
  PosixProcessTreeController,
  type PosixSessionEnumeration,
} from './posix-process-tree.js';
import { UnavailableProcessTreeController } from './platform-process-tree.js';
import { WindowsProcessTreeController } from './windows-process-tree.js';

const identity = {
  pid: 100,
  startedAtMs: 1,
  executablePath: 'node',
  groupId: '100',
};

function enumeration(members: readonly number[], groupIds: readonly number[]): PosixSessionEnumeration {
  return { members, groupIds };
}

describe('POSIX session-tree ownership', () => {
  it('parses the process table and rejects malformed rows instead of creating proof', () => {
    const entries = parsePosixProcessTable(' 103 100 100\n101 101 100\n200 201 201\n');
    expect(entries).toEqual([
      { pid: 103, groupId: 100, sessionId: 100 },
      { pid: 101, groupId: 101, sessionId: 100 },
      { pid: 200, groupId: 201, sessionId: 201 },
    ]);
    expect(() => parsePosixProcessTable('101 100 unexpected')).toThrow('invalid-posix-process-table-row');
    expect(() => parsePosixProcessTable('not-pids')).toThrow('invalid-posix-process-table-row');
  });

  it('P1: enumerates every same-session member across different process groups', () => {
    const entries = parsePosixProcessTable([
      '100 100 100',
      '101 101 100',
      '102 101 100',
      '200 200 200',
    ].join('\n'));
    expect(membersForPosixSession(entries, 100)).toEqual([100, 101, 102]);
    expect(groupsForPosixSession(entries, 100)).toEqual([100, 101]);
  });

  it('P4: an unrelated session is never enumerated as owned', () => {
    const entries = parsePosixProcessTable([
      '100 100 100',
      '101 101 100',
      '200 200 200',
    ].join('\n'));
    expect(membersForPosixSession(entries, 100)).not.toContain(200);
    expect(membersForPosixSession(entries, 200)).toEqual([200]);
  });

  it('P2: root group gone while a same-session subgroup lives reports survivors, never complete', async () => {
    const controller = new PosixProcessTreeController(
      async () => enumeration([101, 102], [101]),
      () => undefined,
    );
    const handle = await controller.attach(identity);
    const verification = await controller.verifySurvivors(handle);
    expect(verification).toEqual({ classification: 'survivors', knownPids: [101, 102] });
    expect(verification.proof).toBeUndefined();
  });

  it('P3/P6: terminates every owned session group, then proves an empty session', async () => {
    let table = enumeration([100, 101, 102], [100, 101]);
    const terminatedGroups: number[] = [];
    const controller = new PosixProcessTreeController(
      async () => table,
      groupId => { terminatedGroups.push(groupId); table = enumeration([], []); },
    );
    const handle = await controller.attach(identity);

    const before = await controller.verifySurvivors(handle);
    expect(before).toEqual({ classification: 'survivors', knownPids: [100, 101, 102] });

    const termination = await controller.terminateTree(handle);
    expect(terminatedGroups).toEqual([100, 101]);
    expect(termination).toEqual({ classification: 'complete', attemptedMembers: [100, 101, 102], errors: [] });

    const after = await controller.verifySurvivors(handle);
    expect(after).toEqual({
      classification: 'complete',
      knownPids: [],
      proof: { kind: 'owned-tree-enumeration' },
    });
  });

  it('P5: partial group termination yields unknown and never emits proof', async () => {
    const controller = new PosixProcessTreeController(
      async () => enumeration([100, 101], [100, 101]),
      groupId => { if (groupId === 101) throw new Error('group-101-termination-failed'); },
    );
    const handle = await controller.attach(identity);
    const termination = await controller.terminateTree(handle);
    expect(termination).toEqual({
      classification: 'unknown',
      attemptedMembers: [100, 101],
      errors: ['group-101-termination-failed'],
    });
    const verification = await controller.verifySurvivors(handle);
    expect(verification.classification).toBe('survivors');
    expect(verification.knownPids).toEqual([100, 101]);
    expect(verification.proof).toBeUndefined();
  });

  it('P7: a frozen terminal proof cannot re-target a numerically reused session', async () => {
    let table = enumeration([], []);
    const terminatedGroups: number[] = [];
    const controller = new PosixProcessTreeController(
      async () => table,
      groupId => { terminatedGroups.push(groupId); },
    );
    const handle = await controller.attach(identity);

    const proof = await controller.verifySurvivors(handle);
    expect(proof).toEqual({
      classification: 'complete',
      knownPids: [],
      proof: { kind: 'owned-tree-enumeration' },
    });

    // A future unrelated session reuses the numeric SID 100.
    table = enumeration([300, 301], [300]);
    const frozen = await controller.verifySurvivors(handle);
    expect(frozen).toEqual(proof);
    const termination = await controller.terminateTree(handle);
    expect(termination).toEqual({ classification: 'complete', attemptedMembers: [], errors: [] });
    expect(terminatedGroups).toEqual([]);
  });

  it('fails closed when session enumeration fails', async () => {
    const controller = new PosixProcessTreeController(async () => {
      throw new Error('enumeration-failed');
    });
    const handle = await controller.attach(identity);
    expect(await controller.verifySurvivors(handle)).toEqual({ classification: 'unknown', knownPids: [] });
    expect(await controller.terminateTree(handle)).toEqual({
      classification: 'unknown',
      attemptedMembers: [],
      errors: ['enumeration-failed'],
    });
  });

  it('does not synthesize proof when the platform is unavailable', async () => {
    const controller = new UnavailableProcessTreeController('test-unavailable');
    const handle = await controller.attach(identity);
    expect(await controller.verifySurvivors(handle)).toEqual({ classification: 'unknown', knownPids: [100] });
  });

  it.skipIf(process.platform !== 'win32')('fails closed when the Windows ownership helper is unavailable', async () => {
    const controller = new WindowsProcessTreeController({ shell: 'definitely-missing-powershell-for-agentos' });
    const handle = await controller.attach(identity);
    expect(handle.platform).toBe('unavailable');
    expect(await controller.verifySurvivors(handle)).toEqual({ classification: 'unknown', knownPids: [] });
  });

  it.skipIf(process.platform !== 'win32')('W8: a helper start failure during owned spawn rejects with no proof', { timeout: 30_000 }, async () => {
    const controller = new WindowsProcessTreeController({ shell: 'definitely-missing-powershell-for-agentos' });
    await expect(controller.spawnOwned({
      executable: process.execPath,
      args: ['-e', 'process.exit(0);'],
      cwd: process.cwd(),
      env: {},
      envDiagnostics: [],
      shell: false,
    })).rejects.toThrow();
  });
});
