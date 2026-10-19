import { describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { DurableProcessCoordinator } from './durable-coordinator.js';
import type {
  DurableAtomicSeam,
  DurableCasOutcome,
  DurableOutputReferenceRepository,
  DurableProcessRepository,
  DurableProcessView,
  DurableSessionRepository,
  ProcessReservationCreate,
  RuntimeEventContext,
} from './repository-port.js';
import type { RestrictedArtifactSink } from './artifact-sink.js';
import type { NativeProcessHandle, PlatformProcessDriver } from './driver.js';
import type { ExitEvidence } from './types.js';
import { NodeProcessDriver } from './node-driver.js';
import {
  buildSpawnRecoveryEvidence,
  classifyRecoveredProcess,
  recoveryTokenHash,
} from './recovery-classifier.js';
import type { RecoveryClassification } from './recovery-classifier.js';
import { createProductionRecoveredProcessVerifier } from './platform-recovery-verifier.js';
import { WindowsProcessTreeController } from './windows-process-tree.js';

/**
 * P5B Scenario-E reattach tests. Real local subprocesses stand in for
 * provider processes; a DurableProcessCoordinator with in-memory repository
 * fakes stands in for the restarted server. Identity proof uses the same
 * production classifier + platform verifier the recovery preflight uses, so
 * 'same' here means genuinely re-observed native creation identity, never
 * PID alone.
 */

const NOW = '2026-10-17T00:00:00.000Z';
const EVENT_CONTEXT: RuntimeEventContext = {
  correlationId: 'op_reattach',
  causationId: 'op_reattach',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function emptyExitPromise(): Promise<ExitEvidence> {
  return new Promise<ExitEvidence>(() => undefined);
}

function baseProcessView(overrides: Partial<DurableProcessView> = {}): DurableProcessView {
  return {
    processId: 'proc_reattach_1',
    workspaceId: 'ws_1',
    taskId: 'task_1',
    runId: 'run_1',
    stageId: 'stage_1',
    stageAttempt: 1,
    providerSessionId: null,
    parentProcessId: null,
    authorityRole: 'primary-provider',
    claimEpoch: 1,
    claimOwnerId: 'server-a',
    claimLeaseExpiresAt: null,
    processType: 'provider',
    platform: 'win32',
    status: 'running',
    executableResolved: process.execPath,
    executableFingerprint: null,
    argsRedactedJson: '[]',
    cwdResolved: process.cwd(),
    shell: 0,
    detached: 0,
    stdinMode: 'closed',
    stdoutMode: 'capture',
    stderrMode: 'capture',
    timeoutPolicyJson: '{"graceMs":1000}',
    securityProfileRef: 'secprofile_default',
    nativePid: null,
    nativeParentPid: null,
    nativeStartedAt: null,
    nativeBirthIdentity: null,
    processGroupId: null,
    treeOwnershipMode: null,
    platformHandleId: null,
    recoveryTokenHash: null,
    recoveryClassification: null,
    recoveryEvidenceJson: null,
    recoveryCheckedAt: null,
    recoveryClassifierVersion: null,
    startedAt: NOW,
    readyAt: null,
    lastActivityAt: null,
    stoppingAt: null,
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
    terminationReason: null,
    cleanupResult: null,
    survivorPidsRedactedJson: null,
    errorCode: null,
    errorDetailRedacted: null,
    version: 3,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

class FakeProcessRepository implements DurableProcessRepository {
  constructor(public process: DurableProcessView) {}

  async createProcessReservation(_input: ProcessReservationCreate): Promise<never> {
    throw new Error('not used');
  }

  async casConsumeSpawnRight(): Promise<never> {
    throw new Error('not used');
  }

  async casBindNativeIdentity(): Promise<never> {
    throw new Error('not used');
  }

  async casTransferClaim(): Promise<never> {
    throw new Error('not used');
  }

  async casProcessTransition(
    input: Parameters<DurableProcessRepository['casProcessTransition']>[0],
  ): Promise<DurableCasOutcome<DurableProcessView>> {
    if (input.processId !== this.process.processId) return { kind: 'not-found' };
    if (this.process.status === 'exited' || this.process.status === 'failed') {
      return { kind: 'terminal', value: this.process };
    }
    if (this.process.status !== input.expectedFrom) {
      return { kind: 'state-mismatch', value: this.process };
    }
    if (this.process.version !== input.expectedVersion) {
      return { kind: 'version-conflict', value: this.process };
    }
    this.process = {
      ...this.process,
      status: input.to,
      version: this.process.version + 1,
      exitedAt: input.to === 'exited' ? input.timestamp : this.process.exitedAt,
      exitCode: input.exitCode === undefined ? this.process.exitCode : input.exitCode,
      terminationReason: input.terminationReason ?? this.process.terminationReason,
    };
    return { kind: 'applied', value: this.process };
  }

  async getProcess(workspaceId: string, processId: string) {
    return this.process.workspaceId === workspaceId && this.process.processId === processId
      ? this.process
      : null;
  }

  async getRootProcessByClaim(): Promise<DurableProcessView | null> {
    return this.process;
  }
}

const notUsedSessionRepository = new Proxy({} as DurableSessionRepository, {
  get: () => () => { throw new Error('not used'); },
});
const notUsedOutputRepository = new Proxy({} as DurableOutputReferenceRepository, {
  get: () => () => { throw new Error('not used'); },
});
const notUsedArtifactSink = new Proxy({} as RestrictedArtifactSink, {
  get: () => () => { throw new Error('not used'); },
});
const notUsedAtomicSeam = new Proxy({} as DurableAtomicSeam, {
  get: () => () => { throw new Error('not used'); },
});

function createCoordinator(
  repository: FakeProcessRepository,
  driver: PlatformProcessDriver,
): DurableProcessCoordinator {
  return new DurableProcessCoordinator({
    sessionRepository: notUsedSessionRepository,
    processRepository: repository,
    outputReferenceRepository: notUsedOutputRepository,
    artifactSink: notUsedArtifactSink,
    atomicSeam: notUsedAtomicSeam,
    driver,
    now: () => new Date().toISOString(),
  });
}

/** Spawn a long-lived real subprocess and observe its native birth identity. */
async function spawnProbeableChild(): Promise<{ child: ChildProcess; pid: number; birth: string | null }> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  const pid = child.pid!;
  const controller = new WindowsProcessTreeController();
  const birth = await controller.probeNativeBirthIdentity(pid);
  return { child, pid, birth };
}

function processRowFor(
  pid: number,
  birth: string | null,
  overrides: Partial<DurableProcessView> = {},
): { process: DurableProcessView } {
  const nativeStartedAt = new Date().toISOString();
  const token = 'token-' + pid;
  const evidence = buildSpawnRecoveryEvidence({
    nativePid: pid,
    nativeStartedAt,
    nativeBirthIdentity: birth,
    rawRecoveryToken: token,
    platform: 'win32',
  });
  const process = baseProcessView({
    nativePid: pid,
    nativeStartedAt,
    nativeBirthIdentity: birth,
    recoveryTokenHash: recoveryTokenHash(token),
    recoveryEvidenceJson: JSON.stringify(evidence),
    ...overrides,
  });
  return { process };
}

async function classify(process: DurableProcessView): Promise<RecoveryClassification> {
  const result = await classifyRecoveredProcess(
    process,
    createProductionRecoveredProcessVerifier(),
  );
  return result.classification;
}

describe('P5B process reattach (Scenario E)', { timeout: 60000 }, () => {
  it('in-flight duplicate waits for the one attach and only reports already after success', async () => {
    const row = baseProcessView({ nativePid: 424242 });
    const repository = new FakeProcessRepository(row);
    const attachStarted = deferred<void>();
    const attachResult = deferred<NativeProcessHandle>();
    let attachCalls = 0;
    let exitObserverCalls = 0;
    const handle = {
      pid: row.nativePid!,
      waitExit() {
        exitObserverCalls += 1;
        return emptyExitPromise();
      },
    } as NativeProcessHandle;
    const driver: PlatformProcessDriver = {
      async spawn() { throw new Error('not used'); },
      async attach() {
        attachCalls += 1;
        attachStarted.resolve();
        return attachResult.promise;
      },
      async gracefulStop() { return { delivered: false, detail: 'not-used' }; },
      async terminateTree() { return { classification: 'unknown', attemptedMembers: [], errors: [] }; },
      async verifySurvivors() { return { classification: 'unknown', knownPids: [] }; },
      async inspectIdentity() { return { kind: 'unknown' }; },
    };
    const coordinator = createCoordinator(repository, driver);
    const input = {
      workspaceId: row.workspaceId,
      processId: row.processId,
      expectedClaimEpoch: row.claimEpoch,
      expectedClaimOwner: row.claimOwnerId,
      eventContext: EVENT_CONTEXT,
    };
    const firstPromise = coordinator.reattachProcess(input);
    await attachStarted.promise;
    let secondSettled = false;
    const secondPromise = coordinator.reattachProcess(input).then(result => {
      secondSettled = true;
      return result;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(secondSettled, false, 'a concurrent caller must join the in-flight attach');
    attachResult.resolve(handle);
    assert.equal((await firstPromise).kind, 'reattached');
    assert.equal((await secondPromise).kind, 'already');
    assert.equal(attachCalls, 1, 'concurrent calls must create one native handle');
    assert.equal(exitObserverCalls, 1, 'one native handle must install one exit observer');
    assert.equal(coordinator.retainedHandleCount, 1);
  });

  it('in-flight attach failure is shared and never reported as already', async () => {
    const row = baseProcessView({ nativePid: 424243 });
    const repository = new FakeProcessRepository(row);
    const attachStarted = deferred<void>();
    const attachResult = deferred<NativeProcessHandle>();
    let attachCalls = 0;
    const driver: PlatformProcessDriver = {
      async spawn() { throw new Error('not used'); },
      async attach() {
        attachCalls += 1;
        attachStarted.resolve();
        return attachResult.promise;
      },
      async gracefulStop() { return { delivered: false, detail: 'not-used' }; },
      async terminateTree() { return { classification: 'unknown', attemptedMembers: [], errors: [] }; },
      async verifySurvivors() { return { classification: 'unknown', knownPids: [] }; },
      async inspectIdentity() { return { kind: 'unknown' }; },
    };
    const coordinator = createCoordinator(repository, driver);
    const input = {
      workspaceId: row.workspaceId,
      processId: row.processId,
      expectedClaimEpoch: row.claimEpoch,
      expectedClaimOwner: row.claimOwnerId,
      eventContext: EVENT_CONTEXT,
    };
    const firstPromise = coordinator.reattachProcess(input);
    await attachStarted.promise;
    let secondSettled = false;
    const secondPromise = coordinator.reattachProcess(input).then(result => {
      secondSettled = true;
      return result;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(secondSettled, false, 'a concurrent caller must not race ahead of attach');
    attachResult.reject(new Error('reattach-test-failure'));
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.deepEqual(first, {
      kind: 'failed',
      reason: 'attach-failed:reattach-test-failure',
    });
    assert.deepEqual(second, first);
    assert.equal(attachCalls, 1, 'concurrent calls must share the failed native attach');
    assert.equal(coordinator.retainedHandleCount, 0);
  });

  it('waitExit rejection does not synthesize process exit or release ownership', async () => {
    const row = baseProcessView({ nativePid: 424244 });
    const repository = new FakeProcessRepository(row);
    const handle = {
      pid: row.nativePid!,
      waitExit: () => Promise.reject(new Error('observer-failure')),
    } as NativeProcessHandle;
    const driver: PlatformProcessDriver = {
      async spawn() { throw new Error('not used'); },
      async attach() { return handle; },
      async gracefulStop() { return { delivered: false, detail: 'not-used' }; },
      async terminateTree() { return { classification: 'unknown', attemptedMembers: [], errors: [] }; },
      async verifySurvivors() { return { classification: 'unknown', knownPids: [] }; },
      async inspectIdentity() { return { kind: 'unknown' }; },
    };
    const coordinator = createCoordinator(repository, driver);
    const result = await coordinator.reattachProcess({
      workspaceId: row.workspaceId,
      processId: row.processId,
      expectedClaimEpoch: row.claimEpoch,
      expectedClaimOwner: row.claimOwnerId,
      eventContext: EVENT_CONTEXT,
    });
    assert.equal(result.kind, 'reattached');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(repository.process.status, 'running');
    assert.equal(coordinator.retainedHandleCount, 1);
  });

  it(
    'Windows read-only adoption leaves the provider outside a kill-on-close Job',
    { skip: process.platform !== 'win32' },
    async () => {
      const { child, pid, birth } = await spawnProbeableChild();
      try {
        assert.ok(birth !== null);
        const controller = new WindowsProcessTreeController();
        const tree = await controller.attachReadOnly({
          pid,
          startedAtMs: Date.parse(NOW),
          executablePath: process.execPath,
          groupId: undefined,
          nativeBirthIdentity: birth,
        });
        assert.equal(tree.platform, 'windows');
        await controller.dispose(tree);
        process.kill(pid, 0);
        assert.equal(await controller.probeNativeBirthIdentity(pid), birth);
      } finally {
        child.kill();
      }
    },
  );

  it(
    'same classification reattaches: ownership restored, exit observed, run finalized once',
    { skip: process.platform !== 'win32' },
    async () => {
      const { child, pid, birth } = await spawnProbeableChild();
      try {
        assert.ok(birth !== null, 'birth identity must be observable on win32');
        const { process: row } = processRowFor(pid, birth);
        assert.equal(await classify(row), 'same');

        // The restarted server: a FRESH coordinator over the durable row.
        const repository = new FakeProcessRepository(row);
        const coordinator = createCoordinator(repository, new NodeProcessDriver());

        let exitCalls = 0;
        let resolveNatural!: (proc: DurableProcessView) => void;
        const naturalExit = new Promise<DurableProcessView>((resolve) => { resolveNatural = resolve; });
        const first = await coordinator.reattachProcess({
          workspaceId: row.workspaceId,
          processId: row.processId,
          expectedClaimEpoch: row.claimEpoch,
          expectedClaimOwner: row.claimOwnerId,
          eventContext: EVENT_CONTEXT,
          onNaturalExit: proc => { exitCalls += 1; resolveNatural(proc); },
        });
        assert.equal(first.kind, 'reattached');

        // Idempotency: a second adoption of the same process joins, never
        // creating a second owner or exit observer.
        const second = await coordinator.reattachProcess({
          workspaceId: row.workspaceId,
          processId: row.processId,
          expectedClaimEpoch: row.claimEpoch,
          expectedClaimOwner: row.claimOwnerId,
          eventContext: EVENT_CONTEXT,
        });
        assert.equal(second.kind, 'already');
        assert.equal(coordinator.retainedHandleCount, 1);

        child.kill();
        const terminal = await naturalExit;
        assert.equal(terminal.status, 'exited');
        assert.equal(terminal.exitCode, null, 'exit code is unknowable post-restart');
        assert.equal(exitCalls, 1, 'natural exit must be reported exactly once');

        // After conclusion the adoption is released; the durable row is the
        // terminal fact and no handle is retained.
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(coordinator.retainedHandleCount, 0);
      } finally {
        child.kill();
      }
    },
  );

  it(
    'missing classification: reattach fails closed, no adoption',
    { skip: process.platform !== 'win32' },
    async () => {
      const { child, pid, birth } = await spawnProbeableChild();
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
      const { process: row } = processRowFor(pid, birth);
      assert.equal(await classify(row), 'missing');

      const repository = new FakeProcessRepository(row);
      const coordinator = createCoordinator(repository, new NodeProcessDriver());
      const result = await coordinator.reattachProcess({
        workspaceId: row.workspaceId,
        processId: row.processId,
        expectedClaimEpoch: row.claimEpoch,
        expectedClaimOwner: row.claimOwnerId,
        eventContext: EVENT_CONTEXT,
      });
      assert.equal(result.kind, 'failed');
      assert.match(result.reason, /attach-failed:process-reattach-target-missing/);
      assert.equal(coordinator.retainedHandleCount, 0);
    },
  );

  it(
    'mismatch classification: PID reuse is not adopted',
    { skip: process.platform !== 'win32' },
    async () => {
      const { child, pid } = await spawnProbeableChild();
      try {
        // A consistent column+mirror row whose birth identity positively
        // differs from the live process simulates PID reuse.
        const { process: row } = processRowFor(pid, 'win32:filetime:1');
        assert.equal(await classify(row), 'mismatch');
        const repository = new FakeProcessRepository(row);
        const coordinator = createCoordinator(repository, new NodeProcessDriver());
        const result = await coordinator.reattachProcess({
          workspaceId: row.workspaceId,
          processId: row.processId,
          expectedClaimEpoch: row.claimEpoch,
          expectedClaimOwner: row.claimOwnerId,
          eventContext: EVENT_CONTEXT,
        });
        // The classifier, and independently the Driver's birth-identity
        // re-probe, both refuse PID reuse: the live birth identity positively
        // differs from the persisted one, so adoption fails closed without
        // killing anything.
        assert.equal(result.kind, 'failed');
        assert.match(result.reason, /process-reattach-identity-mismatch/);
        assert.equal(coordinator.retainedHandleCount, 0);
      } finally {
        child.kill();
      }
    },
  );

  it(
    'unknown classification (v1 evidence): live PID stays fail-safe, no adoption decision',
    { skip: process.platform !== 'win32' },
    async () => {
      const { child, pid } = await spawnProbeableChild();
      try {
        const nativeStartedAt = new Date().toISOString();
        const token = 'token-v1-' + pid;
        const v1Evidence = {
          schemaVersion: 1,
          nativePid: pid,
          nativeStartedAt,
          recoveryTokenHash: recoveryTokenHash(token),
          platform: 'win32',
        };
        const row = baseProcessView({
          nativePid: pid,
          nativeStartedAt,
          recoveryTokenHash: recoveryTokenHash(token),
          recoveryEvidenceJson: JSON.stringify(v1Evidence),
        });
        assert.equal(await classify(row), 'unknown');
      } finally {
        child.kill();
      }
    },
  );

  it('driver without attach support reports unsupported (externally running path)', async () => {
    const row = baseProcessView();
    const repository = new FakeProcessRepository(row);
    const bareDriver: PlatformProcessDriver = {
      async spawn(): Promise<NativeProcessHandle> { throw new Error('not used'); },
      async gracefulStop() { return { delivered: false, detail: 'not-used' }; },
      async terminateTree() { return { classification: 'unknown', attemptedMembers: [], errors: [] }; },
      async verifySurvivors() { return { classification: 'unknown', knownPids: [] }; },
      async inspectIdentity() { return { kind: 'unknown' }; },
    };
    const coordinator = createCoordinator(repository, bareDriver);
    const result = await coordinator.reattachProcess({
      workspaceId: row.workspaceId,
      processId: row.processId,
      expectedClaimEpoch: row.claimEpoch,
      expectedClaimOwner: row.claimOwnerId,
      eventContext: EVENT_CONTEXT,
    });
    assert.deepEqual(result, { kind: 'unsupported', reason: 'driver-attach-unavailable' });
  });

  it('claim fence conflict is diagnosable and adopts nothing', async () => {
    const row = baseProcessView({ nativePid: 424242 });
    const repository = new FakeProcessRepository(row);
    const coordinator = createCoordinator(repository, new NodeProcessDriver());
    const result = await coordinator.reattachProcess({
      workspaceId: row.workspaceId,
      processId: row.processId,
      expectedClaimEpoch: 99,
      expectedClaimOwner: 'server-b',
      eventContext: EVENT_CONTEXT,
    });
    assert.equal(result.kind, 'conflict');
    assert.equal(result.process.claimEpoch, 1);
    assert.equal(coordinator.retainedHandleCount, 0);
  });

  it('claim fence is rechecked after native attach and a losing handle is not retained', async () => {
    const row = baseProcessView({ nativePid: 424245 });
    const repository = new FakeProcessRepository(row);
    let exitObserverCalls = 0;
    const driver: PlatformProcessDriver = {
      async spawn() { throw new Error('not used'); },
      async attach() {
        repository.process = {
          ...repository.process,
          claimEpoch: repository.process.claimEpoch + 1,
          claimOwnerId: 'server-b',
        };
        return {
          pid: row.nativePid!,
          waitExit() {
            exitObserverCalls += 1;
            return emptyExitPromise();
          },
        } as NativeProcessHandle;
      },
      async gracefulStop() { return { delivered: false, detail: 'not-used' }; },
      async terminateTree() { return { classification: 'unknown', attemptedMembers: [], errors: [] }; },
      async verifySurvivors() { return { classification: 'unknown', knownPids: [] }; },
      async inspectIdentity() { return { kind: 'unknown' }; },
    };
    const coordinator = createCoordinator(repository, driver);
    const result = await coordinator.reattachProcess({
      workspaceId: row.workspaceId,
      processId: row.processId,
      expectedClaimEpoch: row.claimEpoch,
      expectedClaimOwner: row.claimOwnerId,
      eventContext: EVENT_CONTEXT,
    });
    assert.equal(result.kind, 'conflict');
    assert.equal(result.process.claimEpoch, row.claimEpoch + 1);
    assert.equal(result.process.claimOwnerId, 'server-b');
    assert.equal(coordinator.retainedHandleCount, 0);
    assert.equal(exitObserverCalls, 0, 'a claim-losing handle must not install an exit observer');
  });
});
