import { describe, expect, it } from 'vitest';
import {
  membersForPosixGroup,
  parsePosixProcessTable,
  PosixProcessTreeController,
} from './posix-process-tree.js';
import { UnavailableProcessTreeController } from './platform-process-tree.js';
import { WindowsProcessTreeController } from './windows-process-tree.js';

const identity = {
  pid: 100,
  startedAtMs: 1,
  executablePath: 'node',
  groupId: '100',
};

describe('POSIX process-tree ownership', () => {
  it('parses and deterministically selects numeric process-group members', () => {
    const entries = parsePosixProcessTable(' 103 100 100\n101 100 100\n103 100 100\n200 201 201\n');
    expect(entries).toEqual([
      { pid: 103, groupId: 100, sessionId: 100 },
      { pid: 101, groupId: 100, sessionId: 100 },
      { pid: 103, groupId: 100, sessionId: 100 },
      { pid: 200, groupId: 201, sessionId: 201 },
    ]);
    expect(membersForPosixGroup(entries, 100)).toEqual([101, 103]);
  });

  it('rejects malformed process-table output instead of creating proof', () => {
    expect(() => parsePosixProcessTable('101 100 unexpected')).toThrow('invalid-posix-process-table-row');
    expect(() => parsePosixProcessTable('not-pids')).toThrow('invalid-posix-process-table-row');
  });

  it('reports root-exited group members, then emits proof only after empty enumeration', async () => {
    let members: readonly number[] = [100, 101];
    let terminated = false;
    const controller = new PosixProcessTreeController(
      async () => members,
      () => { terminated = true; members = []; },
    );
    const handle = await controller.attach(identity);

    const before = await controller.verifySurvivors(handle);
    expect(before).toEqual({ classification: 'survivors', knownPids: [100, 101] });
    await controller.terminateTree(handle);
    const after = await controller.verifySurvivors(handle);
    expect(terminated).toBe(true);
    expect(after).toEqual({
      classification: 'complete',
      knownPids: [],
      proof: { kind: 'owned-tree-enumeration' },
    });
  });

  it('fails closed when process-group enumeration fails', async () => {
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

  it('fails closed when group termination fails and never emits proof', async () => {
    const controller = new PosixProcessTreeController(
      async () => [100],
      () => { throw new Error('termination-failed'); },
    );
    const handle = await controller.attach(identity);
    expect(await controller.terminateTree(handle)).toEqual({
      classification: 'unknown',
      attemptedMembers: [100],
      errors: ['termination-failed'],
    });
    const verification = await controller.verifySurvivors(handle);
    expect(verification.classification).toBe('survivors');
    expect(verification.proof).toBeUndefined();
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
});
