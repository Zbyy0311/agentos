import { join, sep } from 'node:path';
import { FakeClock } from '../clock.js';
import { ProcessManager } from '../manager.js';
import type { ProcessManagerOptions, ReserveRequest } from '../manager.js';
import type {
  ClaimIdentity,
  LaunchRequest,
  ProcessId,
  ProcessSnapshot,
} from '../types.js';
import { FakeFileSystemProbe } from './fake-probe.js';
import { MockProcessDriver } from './mock-driver.js';
import type { MockNativeProcessHandle } from './mock-driver.js';

export interface ManagerFixture {
  readonly manager: ProcessManager;
  readonly driver: MockProcessDriver;
  readonly clock: FakeClock;
  readonly probe: FakeFileSystemProbe;
  readonly workspaceRoot: string;
  readonly binDir: string;
  readonly launch: LaunchRequest;
  makeClaim(): ClaimIdentity;
  reserve(request?: Partial<ReserveRequest>): Promise<{
    id: ProcessId;
    claim: ClaimIdentity;
    snapshot: ProcessSnapshot;
  }>;
}

/** Grace/terminal-wait budget used by fixture pipelines. */
export const FIXTURE_GRACE_MS = 50;

export function createManagerFixture(
  options: Partial<ProcessManagerOptions> = {},
): ManagerFixture {
  const driver = new MockProcessDriver();
  const clock = new FakeClock();
  const probe = new FakeFileSystemProbe();
  const workspaceRoot = join(sep, 'ws');
  const binDir = join(sep, 'bin');
  probe.addDirectory(workspaceRoot);
  probe.addExecutable(join(binDir, 'tool'));
  const manager = new ProcessManager({
    driver,
    clock,
    probe,
    policy: {
      workspaceRoot,
      executablePathDirs: [binDir],
      executableExtensions: [''],
    },
    ...options,
  });
  let claimSeq = 0;
  const makeClaim = (): ClaimIdentity => ({
    key: 'claim-' + String(++claimSeq),
    owner: 'fixture',
    epoch: 1,
  });
  const launch: LaunchRequest = {
    executable: 'tool',
    args: ['--run', 'task'],
    cwd: workspaceRoot,
  };
  const reserve: ManagerFixture['reserve'] = async (request = {}) => {
    const claim = request.claim ?? makeClaim();
    const result = await manager.reserve({ claim, launch, ...request });
    return { id: result.snapshot.id, claim, snapshot: result.snapshot };
  };
  return { manager, driver, clock, probe, workspaceRoot, binDir, launch, makeClaim, reserve };
}

/** Reserve + start to running with timers disabled by default. */
export async function startRunning(
  fx: ManagerFixture,
  request: Partial<ReserveRequest> = {},
): Promise<{ id: ProcessId; claim: ClaimIdentity; handle: MockNativeProcessHandle }> {
  const { id, claim } = await fx.reserve({
    timeouts: {
      startupMs: undefined,
      idleMs: undefined,
      totalMs: undefined,
      graceMs: FIXTURE_GRACE_MS,
    },
    ...request,
  });
  const start = await fx.manager.start(id, claim);
  await start.settled;
  const handle = fx.driver.handles[fx.driver.handles.length - 1];
  return { id, claim, handle };
}

/**
 * Drive the bounded cleanup pipeline through its two clock-gated waits:
 * grace expiry, then the post-termination bounded wait.
 */
export async function completeStopPipeline(fx: ManagerFixture): Promise<void> {
  await fx.driver.awaitGracefulStopEntered();
  await drainTurns();
  fx.clock.advance(FIXTURE_GRACE_MS);
  await fx.driver.awaitTerminateTreeEntered();
  await drainTurns();
  fx.clock.advance(FIXTURE_GRACE_MS);
  await drainTurns();
}

/** Drain pending microtasks without any timer sleep. */
export function drainTurns(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
