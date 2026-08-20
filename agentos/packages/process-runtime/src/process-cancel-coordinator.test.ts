import { describe, expect, it } from 'vitest';
import type {
  DurableCasOutcome,
  DurableProcessRepository,
  DurableProcessView,
  ProcessTransitionInput,
  RuntimeEventContext,
} from './repository-port.js';
import { FakeClock } from './clock.js';
import { MockNativeProcessHandle, MockProcessDriver } from './testing/mock-driver.js';
import { ProcessCancelCoordinator } from './process-cancel-coordinator.js';

const NOW = '2026-08-20T00:00:00.000Z';
const CONTEXT: RuntimeEventContext = { correlationId: 'corr_1', causationId: 'cause_1' };

function processView(overrides: Partial<DurableProcessView> = {}): DurableProcessView {
  return {
    processId: 'proc_1',
    workspaceId: 'ws_1',
    taskId: 'task_1',
    runId: 'run_1',
    stageId: 'stage_1',
    stageAttempt: 1,
    providerSessionId: 'session_1',
    parentProcessId: null,
    authorityRole: 'primary-provider',
    claimEpoch: 1,
    claimOwnerId: 'owner_1',
    claimLeaseExpiresAt: NOW,
    processType: 'provider',
    platform: 'test',
    status: 'running',
    executableResolved: 'agent',
    executableFingerprint: null,
    argsRedactedJson: '[]',
    cwdResolved: '.',
    shell: 0,
    detached: 0,
    stdinMode: 'closed',
    stdoutMode: 'capture',
    stderrMode: 'capture',
    timeoutPolicyJson: JSON.stringify({ graceMs: 0 }),
    securityProfileRef: 'default',
    nativePid: 4100,
    nativeParentPid: null,
    nativeStartedAt: NOW,
    processGroupId: null,
    treeOwnershipMode: null,
    platformHandleId: null,
    recoveryTokenHash: null,
    recoveryClassification: null,
    recoveryEvidenceJson: null,
    recoveryCheckedAt: null,
    recoveryClassifierVersion: null,
    startedAt: NOW,
    readyAt: NOW,
    lastActivityAt: NOW,
    stoppingAt: null,
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
    terminationReason: null,
    cleanupResult: null,
    survivorPidsRedactedJson: null,
    errorCode: null,
    errorDetailRedacted: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

class FakeProcessRepository implements DurableProcessRepository {
  process: DurableProcessView;
  readonly transitions: ProcessTransitionInput[] = [];

  constructor(process: DurableProcessView) {
    this.process = process;
  }

  async createProcessReservation(): Promise<never> {
    throw new Error('not used');
  }

  async casConsumeSpawnRight(): Promise<never> {
    throw new Error('not used');
  }

  async casBindNativeIdentity(): Promise<never> {
    throw new Error('not used');
  }

  async casProcessTransition(input: ProcessTransitionInput): Promise<DurableCasOutcome<DurableProcessView>> {
    this.transitions.push(input);
    if (input.expectedVersion !== this.process.version || input.expectedFrom !== this.process.status) {
      return { kind: 'version-conflict', value: this.process };
    }
    this.process = {
      ...this.process,
      status: input.to,
      version: this.process.version + 1,
      stoppingAt: input.to === 'stopping' ? input.timestamp : this.process.stoppingAt,
      exitedAt: input.to === 'exited' || input.to === 'failed' || input.to === 'orphaned' ? input.timestamp : this.process.exitedAt,
      terminationReason: input.terminationReason ?? this.process.terminationReason,
      cleanupResult: input.cleanupResult ?? this.process.cleanupResult,
      errorCode: input.errorCode ?? this.process.errorCode,
      errorDetailRedacted: input.errorDetailRedacted ?? this.process.errorDetailRedacted,
    };
    return { kind: 'applied', value: this.process, eventId: `evt_${this.process.version}` };
  }

  async getProcess(): Promise<DurableProcessView | null> {
    return this.process;
  }

  async getRootProcessByClaim(): Promise<DurableProcessView | null> {
    return this.process;
  }
}

function request(overrides: Partial<Parameters<ProcessCancelCoordinator['acceptStop']>[0]> = {}) {
  return {
    workspaceId: 'ws_1',
    processId: 'proc_1',
    expectedClaimEpoch: 1,
    expectedClaimOwner: 'owner_1',
    reason: 'cancel',
    idempotencyKey: 'cancel_1',
    timestamp: NOW,
    eventContext: CONTEXT,
    ...overrides,
  };
}

describe('ProcessCancelCoordinator', () => {
  it('accepts one durable stop ticket and joins duplicate requests', async () => {
    const repository = new FakeProcessRepository(processView());
    const driver = new MockProcessDriver();
    driver.verifyProofMode = 'bare';
    const handle = new MockNativeProcessHandle(4100, 'agent');
    const coordinator = new ProcessCancelCoordinator({
      processRepository: repository,
      driver,
      now: () => NOW,
      gracePeriodMs: 0,
    });
    coordinator.attachHandle('proc_1', handle);

    const [first, duplicate] = await Promise.all([
      coordinator.acceptStop(request()),
      coordinator.acceptStop(request({ idempotencyKey: 'cancel_2', reason: 'timeout' })),
    ]);

    expect(duplicate).toBe(first);
    const result = await first.result;
    expect(result.proven).toBe(false);
    expect(result.cleanup?.cleanupResult).toBe('UNKNOWN_PLATFORM_UNAVAILABLE');
    expect(repository.process.status).toBe('orphaned');
    expect(repository.transitions.filter(transition => transition.to === 'stopping')).toHaveLength(1);
    expect(driver.gracefulStopCalls).toBe(1);
    expect(driver.terminateTreeCalls).toBe(1);
    expect(driver.verifySurvivorsCalls).toBe(1);
  });

  it('terminalizes stopping only with valid owned-tree proof', async () => {
    const repository = new FakeProcessRepository(processView());
    const driver = new MockProcessDriver();
    const handle = new MockNativeProcessHandle(4100, 'agent');
    const coordinator = new ProcessCancelCoordinator({
      processRepository: repository,
      driver,
      now: () => NOW,
      gracePeriodMs: 0,
    });
    coordinator.attachHandle('proc_1', handle);

    const ticket = await coordinator.acceptStop(request());
    const result = await ticket.result;

    expect(result.proven).toBe(true);
    expect(result.cleanup).toMatchObject({
      classification: 'complete',
      cleanupResult: 'TERMINATED',
      proven: true,
    });
    expect(result.process.status).toBe('exited');
  });

  it('uses the persisted process grace policy for bounded cleanup', async () => {
    const repository = new FakeProcessRepository(processView({
      timeoutPolicyJson: JSON.stringify({ graceMs: 17 }),
    }));
    const driver = new MockProcessDriver();
    const handle = new MockNativeProcessHandle(4100, 'agent');
    const clock = new FakeClock();
    const coordinator = new ProcessCancelCoordinator({
      processRepository: repository,
      driver,
      clock,
      now: () => NOW,
      gracePeriodMs: 99,
    });
    coordinator.attachHandle('proc_1', handle);

    const ticket = await coordinator.acceptStop(request());
    await driver.awaitGracefulStopEntered();
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    clock.advance(16);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    expect(driver.terminateTreeCalls).toBe(0);
    clock.advance(1);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    expect(driver.terminateTreeCalls).toBe(1);
    clock.advance(17);
    const result = await ticket.result;
    expect(result.proven).toBe(true);
  });

  it('does not spawn or require a native handle for created-before-spawn cancellation', async () => {
    const repository = new FakeProcessRepository(processView({ status: 'created', nativePid: null, version: 1 }));
    const driver = new MockProcessDriver();
    const coordinator = new ProcessCancelCoordinator({
      processRepository: repository,
      driver,
      now: () => NOW,
      gracePeriodMs: 0,
    });

    const ticket = await coordinator.acceptStop(request());
    const result = await ticket.result;

    expect(result.process.status).toBe('failed');
    expect(result.proven).toBe(true);
    expect(result.cleanup).toBeNull();
    expect(repository.transitions[0]).toMatchObject({
      expectedFrom: 'created',
      to: 'failed',
      failureOutcome: 'cancelled-before-spawn',
    });
    expect(driver.spawnCalls).toHaveLength(0);
  });

  it('resolves a stop waiting on a starting handle when spawn fails durably', async () => {
    const repository = new FakeProcessRepository(processView({ status: 'starting', nativePid: null }));
    const coordinator = new ProcessCancelCoordinator({
      processRepository: repository,
      driver: new MockProcessDriver(),
      now: () => NOW,
      gracePeriodMs: 0,
    });

    const ticketPromise = coordinator.acceptStop(request());
    for (let turn = 0; repository.process.status !== 'stopping' && turn < 20; turn += 1) {
      await Promise.resolve();
    }
    repository.process = { ...repository.process, status: 'failed', version: repository.process.version + 1 };
    coordinator.observeTerminal(repository.process);

    const result = await (await ticketPromise).result;
    expect(result.process.status).toBe('failed');
    expect(result.cleanup).toBeNull();
    expect(result.proven).toBe(true);
  });
});
