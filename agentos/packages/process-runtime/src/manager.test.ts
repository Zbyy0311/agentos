import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MockNativeProcessHandle } from './testing/mock-driver.js';
import {
  completeStopPipeline,
  createManagerFixture,
  drainTurns,
  startRunning,
} from './testing/fixture.js';
import type { ClaimIdentity, ProcessId, ProcessSnapshot } from './types.js';

function claimOf(snapshot: ProcessSnapshot): ClaimIdentity {
  return {
    key: snapshot.claimKey,
    owner: snapshot.claimOwner,
    epoch: snapshot.claimEpoch,
  };
}

function terminalFacts(snapshot: ProcessSnapshot) {
  return snapshot.facts.filter(
    (f) => f.type === 'process.exited' || f.type === 'process.failed',
  );
}

describe('ProcessManager reserve', () => {
  it('creates a created reservation; duplicate claims join without side effects', async () => {
    const fx = createManagerFixture();
    const claim = fx.makeClaim();
    const first = await fx.manager.reserve({ claim, launch: fx.launch });
    expect(first.joinedExisting).toBe(false);
    expect(first.snapshot.state).toBe('created');
    expect(first.snapshot.spawnAttempts).toBe(0);
    expect(first.snapshot.pid).toBeNull();
    expect(first.snapshot.facts.map((f) => f.type)).toEqual(['process.launch_requested']);

    const again = await fx.manager.reserve({ claim, launch: fx.launch });
    expect(again.joinedExisting).toBe(true);
    expect(again.snapshot.id).toBe(first.snapshot.id);
    expect(again.snapshot.facts).toHaveLength(1);
    expect(fx.driver.spawnCalls).toHaveLength(0);
  });

  it('rejects a conflicting claim owner for the same claim key', async () => {
    const fx = createManagerFixture();
    const claim = fx.makeClaim();
    await fx.manager.reserve({ claim, launch: fx.launch });
    await expect(
      fx.manager.reserve({ claim: { ...claim, owner: 'other' }, launch: fx.launch }),
    ).rejects.toMatchObject({ code: 'PROCESS_REQUEST_INVALID' });
  });
});

describe('ProcessManager start', () => {
  it('validates, consumes the one spawn right and reaches running', async () => {
    const fx = createManagerFixture();
    const { id, claim } = await fx.reserve();
    const start = await fx.manager.start(id, claim);
    // The spawn right is consumed before the Driver call: starting, PID null.
    expect(start.snapshot.state).toBe('starting');
    expect(start.snapshot.spawnAttempts).toBe(1);
    expect(start.snapshot.pid).toBeNull();
    const final = await start.settled;
    expect(final.state).toBe('running');
    expect(final.pid).toBe(fx.driver.handles[0].pid);
    expect(final.startedAt).not.toBeNull();
    expect(final.facts.map((f) => f.type)).toEqual([
      'process.launch_requested',
      'process.started',
    ]);
    expect(fx.driver.spawnCalls).toHaveLength(1);
    const spawned = fx.driver.spawnCalls[0];
    expect(spawned.shell).toBe(false);
    expect(spawned.args).toEqual(['--run', 'task']);
  });

  it('passes ephemeral secrets to the Driver but never into diagnostics', async () => {
    const fx = createManagerFixture();
    const secret = 'supersecret-value-9001';
    const { id, claim } = await fx.reserve({
      launch: {
        ...fx.launch,
        env: {
          base: {},
          profile: { MODE: 'test' },
          secretRefs: { RUNTIME_API_KEY: secret },
        },
      },
    });
    const start = await fx.manager.start(id, claim);
    await start.settled;
    expect(fx.driver.spawnCalls[0].env.MODE).toBe('test');
    expect(fx.driver.spawnCalls[0].env.RUNTIME_API_KEY).toBe(secret);
    const snapshot = fx.manager.getSnapshot(id);
    expect(snapshot?.launch.envKeys).toContain('RUNTIME_API_KEY');
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  it('joins duplicate starts onto the single spawn', async () => {
    const fx = createManagerFixture();
    const { id, claim } = await fx.reserve();
    const [a, b] = await Promise.all([
      fx.manager.start(id, claim),
      fx.manager.start(id, claim),
    ]);
    await Promise.all([a.settled, b.settled]);
    expect(fx.driver.spawnCalls).toHaveLength(1);
    expect(fx.manager.getSnapshot(id)?.state).toBe('running');
    const third = await fx.manager.start(id, claim);
    expect(third.snapshot.state).toBe('running');
    expect(fx.driver.spawnCalls).toHaveLength(1);
  });

  it('terminalizes failed with the stable spawn error on spawn failure', async () => {
    const fx = createManagerFixture();
    fx.driver.spawnError = new Error('boom');
    const { id, claim } = await fx.reserve();
    const start = await fx.manager.start(id, claim);
    const final = await start.settled;
    expect(final.state).toBe('failed');
    expect(final.terminal?.outcome).toBe('spawn-failure');
    expect(final.terminal?.error?.code).toBe('PROCESS_SPAWN_FAILED');
    expect(final.terminal?.error?.detail).not.toContain('boom');
    expect(final.spawnAttempts).toBe(1);
    expect(terminalFacts(final)).toHaveLength(1);
    expect(terminalFacts(final)[0].type).toBe('process.failed');
  });

  it('terminalizes failed on validation failure without ever spawning', async () => {
    const fx = createManagerFixture();
    const { id, claim } = await fx.reserve({
      launch: { ...fx.launch, shell: true },
    });
    const start = await fx.manager.start(id, claim);
    const final = await start.settled;
    expect(final.state).toBe('failed');
    expect(final.terminal?.outcome).toBe('validation-failure');
    expect(final.terminal?.error?.code).toBe('PROCESS_POLICY_DENIED');
    expect(final.spawnAttempts).toBe(0);
    expect(fx.driver.spawnCalls).toHaveLength(0);
  });

  it('maps a missing executable to the stable validation error', async () => {
    const fx = createManagerFixture();
    const { id, claim } = await fx.reserve({
      launch: { ...fx.launch, executable: 'missing-tool' },
    });
    const start = await fx.manager.start(id, claim);
    const final = await start.settled;
    expect(final.state).toBe('failed');
    expect(final.terminal?.error?.code).toBe('PROCESS_EXECUTABLE_NOT_FOUND');
    expect(fx.driver.spawnCalls).toHaveLength(0);
  });

  it('rejects stale, foreign and greater epochs without adoption', async () => {
    const fx = createManagerFixture();
    const { id, claim } = await fx.reserve();
    await expect(fx.manager.start(id, { ...claim, owner: 'other' })).rejects.toMatchObject({
      code: 'PROCESS_POLICY_DENIED',
    });
    await expect(fx.manager.start(id, { ...claim, epoch: 0 })).rejects.toMatchObject({
      code: 'PROCESS_REQUEST_INVALID',
    });
    // Exact-epoch fencing: a greater epoch is never auto-adopted in P1.
    await expect(fx.manager.start(id, { ...claim, epoch: 5 })).rejects.toMatchObject({
      code: 'PROCESS_REQUEST_INVALID',
    });
    expect(fx.manager.getSnapshot(id)?.claimEpoch).toBe(1);
    await expect(fx.reserve({ claim: { ...claim, epoch: 9 } })).rejects.toMatchObject({
      code: 'PROCESS_REQUEST_INVALID',
    });
    const joined = await fx.reserve({ claim });
    expect(joined.snapshot.id).toBe(id);
    const start = await fx.manager.start(id, claim);
    await start.settled;
    expect(fx.manager.getSnapshot(id)?.state).toBe('running');
  });
});

describe('ProcessManager exit and stop', () => {
  it('terminalizes exited on natural exit with exit evidence', async () => {
    const fx = createManagerFixture();
    const { id, handle } = await startRunning(fx);
    handle.emitExit({ exitCode: 3, signal: null, exitedAt: 42 });
    const final = await fx.manager.waitForTerminal(id);
    expect(final.state).toBe('exited');
    expect(final.terminal?.outcome).toBe('exit');
    expect(final.terminal?.exit?.exitCode).toBe(3);
    expect(final.terminal?.terminationReason).toBeNull();
    expect(terminalFacts(final)).toHaveLength(1);
  });

  it('stop is idempotent, joins one ticket and the first reason wins', async () => {
    const fx = createManagerFixture();
    const { id } = await startRunning(fx);
    const t1 = await fx.manager.stop(id, { reason: 'cancel', idempotencyKey: 'k1' });
    const t2 = await fx.manager.stop(id, {
      reason: 'PROCESS_TOTAL_TIMEOUT',
      idempotencyKey: 'k2',
    });
    expect(t2).toBe(t1);
    expect(t2.idempotencyKey).toBe('k1');
    await completeStopPipeline(fx);
    const final = await t1.result;
    expect(final.state).toBe('exited');
    expect(final.terminal?.outcome).toBe('cancelled');
    expect(final.terminal?.terminationReason).toBe('cancel');
    expect(final.terminal?.cleanup).toBe('TERMINATED');
    expect(fx.driver.gracefulStopCalls).toBe(1);
    expect(fx.driver.terminateTreeCalls).toBe(1);
    expect(fx.driver.verifySurvivorsCalls).toBe(1);
  });

  it('keeps the terminal result immutable against late stops, starts and exits', async () => {
    const fx = createManagerFixture();
    const { id, claim, handle } = await startRunning(fx);
    handle.emitExit({ exitCode: 0 });
    const terminal = await fx.manager.waitForTerminal(id);
    const stop = await fx.manager.stop(id, { reason: 'cancel', idempotencyKey: 'late' });
    expect((await stop.result).terminal).toEqual(terminal.terminal);
    const start = await fx.manager.start(id, claim);
    expect(start.snapshot.state).toBe('exited');
    expect(start.snapshot.version).toBe(terminal.version);
    handle.emitExit({ exitCode: 9 });
    const after = fx.manager.getSnapshot(id);
    expect(after?.version).toBe(terminal.version);
    expect(after ? terminalFacts(after) : []).toHaveLength(1);
    expect(fx.driver.spawnCalls).toHaveLength(1);
  });

  it('fails closed to orphaned on survivors and never reports cancel success', async () => {
    const fx = createManagerFixture();
    fx.driver.verifyClassification = 'survivors';
    const { id } = await startRunning(fx);
    const ticket = await fx.manager.stop(id, { reason: 'cancel', idempotencyKey: 'sv' });
    await completeStopPipeline(fx);
    const final = await ticket.result;
    expect(final.state).toBe('orphaned');
    expect(final.terminal).toBeNull();
    expect(final.cleanupEvidence?.result).toBe('SURVIVORS');
    expect(terminalFacts(final)).toHaveLength(0);
    const dup = await fx.manager.stop(id, { reason: 'cancel', idempotencyKey: 'sv-2' });
    expect(dup).toBe(ticket);
  });

  it('never signals a mismatched identity', async () => {
    const fx = createManagerFixture();
    fx.driver.inspectKind = 'mismatch';
    const { id } = await startRunning(fx);
    const ticket = await fx.manager.stop(id, { reason: 'cancel', idempotencyKey: 'mm' });
    const final = await ticket.result;
    expect(final.state).toBe('orphaned');
    expect(final.cleanupEvidence?.result).toBe('IDENTITY_MISMATCH');
    expect(fx.driver.gracefulStopCalls).toBe(0);
    expect(fx.driver.terminateTreeCalls).toBe(0);
  });

  it('rejects a pid that is already bound to another Process', async () => {
    const fx = createManagerFixture();
    const first = await startRunning(fx);
    fx.driver.holdNextSpawn();
    const second = await fx.reserve();
    const start2 = await fx.manager.start(second.id, second.claim);
    await fx.driver.awaitSpawnEntered();
    fx.driver.settleSpawnSuccess(new MockNativeProcessHandle(first.handle.pid, 'tool'));
    const final2 = await start2.settled;
    expect(final2.state).toBe('failed');
    expect(final2.terminal?.outcome).toBe('registration-failure');
    expect(final2.terminal?.error?.code).toBe('PROCESS_REGISTRATION_FAILED');
    expect(final2.terminal?.cleanup).toBe('TERMINATED');
    expect(fx.driver.terminateTreeCalls).toBe(1);
    expect(fx.driver.verifySurvivorsCalls).toBe(1);
    expect(fx.manager.getSnapshot(first.id)?.state).toBe('running');
  });

  it('does not treat bare complete registration cleanup as proven', async () => {
    const fx = createManagerFixture();
    const first = await startRunning(fx);
    fx.driver.verifyProofMode = 'bare';
    fx.driver.holdNextSpawn();
    const second = await fx.reserve();
    const start2 = await fx.manager.start(second.id, second.claim);
    await fx.driver.awaitSpawnEntered();
    fx.driver.settleSpawnSuccess(new MockNativeProcessHandle(first.handle.pid, 'tool'));

    const final2 = await start2.settled;
    expect(final2.state).toBe('unknown');
    expect(final2.terminal).toBeNull();
    expect(final2.cleanupEvidence?.result).toBe('UNKNOWN_PLATFORM_UNAVAILABLE');
  });
});

describe('ProcessManager tree fail-closed cleanup', () => {
  it('verifies survivors after a root exit during stopping before reporting success', async () => {
    const fx = createManagerFixture();
    const { id, handle } = await startRunning(fx);
    fx.driver.holdVerifySurvivors();
    const stopP = fx.manager.stop(id, { reason: 'cancel', idempotencyKey: 'tf1' });
    handle.emitExit({ exitCode: 0 });
    const ticket = await stopP;
    await fx.driver.awaitVerifySurvivorsEntered();
    // The root exit alone is not tree evidence: no terminal result yet.
    const pending = fx.manager.getSnapshot(id);
    expect(pending?.state).toBe('stopping');
    expect(pending?.terminal).toBeNull();
    fx.driver.settleVerifySurvivors('complete');
    const final = await ticket.result;
    expect(final.state).toBe('exited');
    expect(final.terminal?.outcome).toBe('cancelled');
    expect(final.terminal?.terminationReason).toBe('cancel');
    expect(final.terminal?.cleanup).toBe('ALREADY_EXITED');
    expect(final.terminal?.exit?.exitCode).toBe(0);
    expect(fx.driver.gracefulStopCalls).toBe(1);
    expect(fx.driver.terminateTreeCalls).toBe(0);
    expect(fx.driver.verifySurvivorsCalls).toBe(1);
    expect(terminalFacts(final)).toHaveLength(1);
    expect(terminalFacts(final)[0].type).toBe('process.exited');
  });

  it('keeps survivor uncertainty non-terminal with cleanup evidence', async () => {
    const fx = createManagerFixture();
    const { id, handle } = await startRunning(fx);
    fx.driver.holdVerifySurvivors();
    const ticket = await fx.manager.stop(id, { reason: 'cancel', idempotencyKey: 'tf2' });
    handle.emitExit({ exitCode: 0 });
    await fx.driver.awaitVerifySurvivorsEntered();
    fx.driver.settleVerifySurvivors('survivors', [handle.pid]);
    const final = await ticket.result;
    expect(final.state).toBe('orphaned');
    expect(final.terminal).toBeNull();
    expect(final.cleanupEvidence?.result).toBe('SURVIVORS');
    expect(terminalFacts(final)).toHaveLength(0);
    expect(fx.driver.terminateTreeCalls).toBe(0);
  });

  it('keeps an unknown verification non-terminal instead of reporting cancel success', async () => {
    const fx = createManagerFixture();
    const { id, handle } = await startRunning(fx);
    fx.driver.verifyError = new Error('platform cannot verify');
    const ticket = await fx.manager.stop(id, { reason: 'cancel', idempotencyKey: 'tf3' });
    handle.emitExit({ exitCode: 0 });
    const final = await ticket.result;
    expect(final.state).toBe('orphaned');
    expect(final.terminal).toBeNull();
    expect(final.cleanupEvidence?.result).toBe('UNKNOWN_PLATFORM_UNAVAILABLE');
    expect(terminalFacts(final)).toHaveLength(0);
  });

  it('registration failure with survivors keeps tree uncertainty non-terminal', async () => {
    const fx = createManagerFixture();
    const first = await startRunning(fx);
    fx.driver.holdNextSpawn();
    const second = await fx.reserve();
    const start2 = await fx.manager.start(second.id, second.claim);
    await fx.driver.awaitSpawnEntered();
    fx.driver.holdVerifySurvivors();
    fx.driver.settleSpawnSuccess(new MockNativeProcessHandle(first.handle.pid, 'tool'));
    await fx.driver.awaitVerifySurvivorsEntered();
    // The stray verdict is pending: no failed terminal may be reported yet.
    expect(fx.manager.getSnapshot(second.id)?.terminal).toBeNull();
    fx.driver.settleVerifySurvivors('survivors', [first.handle.pid]);
    const final2 = await start2.settled;
    expect(final2.state).toBe('unknown');
    expect(final2.terminal).toBeNull();
    expect(final2.cleanupEvidence?.result).toBe('SURVIVORS');
    expect(terminalFacts(final2)).toHaveLength(0);
    expect(fx.driver.terminateTreeCalls).toBe(1);
    expect(fx.driver.verifySurvivorsCalls).toBe(1);
    expect(fx.manager.getSnapshot(first.id)?.state).toBe('running');
  });

  it('registration failure with a verify failure records platform uncertainty', async () => {
    const fx = createManagerFixture();
    const first = await startRunning(fx);
    fx.driver.holdNextSpawn();
    const second = await fx.reserve();
    const start2 = await fx.manager.start(second.id, second.claim);
    await fx.driver.awaitSpawnEntered();
    fx.driver.verifyError = new Error('verify unsupported');
    fx.driver.settleSpawnSuccess(new MockNativeProcessHandle(first.handle.pid, 'tool'));
    const final2 = await start2.settled;
    expect(final2.state).toBe('unknown');
    expect(final2.terminal).toBeNull();
    expect(final2.cleanupEvidence?.result).toBe('UNKNOWN_PLATFORM_UNAVAILABLE');
    expect(terminalFacts(final2)).toHaveLength(0);
    expect(fx.manager.getSnapshot(first.id)?.state).toBe('running');
  });
});

describe('ProcessManager output observation', () => {
  it('exposes bounded process-scoped stdout/stderr pages without native handles', async () => {
    const fx = createManagerFixture();
    const { id, handle } = await startRunning(fx);
    handle.pushStdout('hello ');
    handle.pushStdout('world');
    handle.pushStderr('err-line');
    await drainTurns();
    const page = fx.manager.readProcessOutput(id, 'stdout');
    expect(page?.text).toBe('hello world');
    expect(page?.ended).toBe(false);
    expect(page?.sourceBytes).toBe(11);
    expect(fx.manager.readProcessOutput(id, 'stderr')?.text).toBe('err-line');
    const first = fx.manager.readProcessOutput(id, 'stdout', { maxBytes: 5 });
    expect(first?.text).toBe('hello');
    expect(first?.nextOffsetBytes).toBe(5);
    const rest = fx.manager.readProcessOutput(id, 'stdout', {
      offsetBytes: first?.nextOffsetBytes ?? 0,
      maxBytes: 10_000,
    });
    expect(rest?.text).toBe(' world');
    expect(fx.manager.readProcessOutput('proc_nope' as ProcessId, 'stdout')).toBeUndefined();
  });

  it('keeps trailing output observable when native exit precedes stream close', async () => {
    const fx = createManagerFixture();
    const { id, handle } = await startRunning(fx);
    handle.pushStdout('head-');
    await drainTurns();
    handle.emitExit({ exitCode: 0 }, { endStreams: false });
    const terminal = await fx.manager.waitForTerminal(id);
    expect(terminal.state).toBe('exited');
    // The tail arrives only after the native exit observation.
    handle.pushStdout('tail');
    handle.endStreams();
    await drainTurns();
    const out = fx.manager.readProcessOutput(id, 'stdout');
    expect(out?.text).toBe('head-tail');
    expect(out?.ended).toBe(true);
    expect(out?.truncatedSourceBytes).toBe(0);
  });
});

describe('ProcessManager deadlines', () => {
  it('startup timeout runs the bounded stop pipeline', async () => {
    const fx = createManagerFixture();
    const { id } = await startRunning(fx, {
      timeouts: { startupMs: 100, idleMs: undefined, totalMs: undefined, graceMs: 50 },
    });
    fx.clock.advance(100);
    await completeStopPipeline(fx);
    const final = await fx.manager.waitForTerminal(id);
    expect(final.state).toBe('exited');
    expect(final.terminal?.outcome).toBe('timeout');
    expect(final.terminal?.terminationReason).toBe('PROCESS_STARTUP_TIMEOUT');
  });

  it('idle timeout resets on activity', async () => {
    const fx = createManagerFixture();
    const { id } = await startRunning(fx, {
      timeouts: { startupMs: 1000, idleMs: 200, totalMs: undefined, graceMs: 50 },
    });
    await fx.manager.markReady(id);
    fx.clock.advance(150);
    fx.manager.notifyActivity(id);
    fx.clock.advance(199);
    expect(fx.manager.getSnapshot(id)?.state).toBe('running');
    fx.clock.advance(1);
    await completeStopPipeline(fx);
    const final = await fx.manager.waitForTerminal(id);
    expect(final.terminal?.terminationReason).toBe('PROCESS_IDLE_TIMEOUT');
  });

  it('idle deadline pauses during an approved wait', async () => {
    const fx = createManagerFixture();
    const { id } = await startRunning(fx, {
      timeouts: { startupMs: 1000, idleMs: 200, totalMs: undefined, graceMs: 50 },
    });
    await fx.manager.markReady(id);
    await fx.manager.enterWaiting(id, 'approval');
    fx.clock.advance(10_000);
    expect(fx.manager.getSnapshot(id)?.state).toBe('waiting');
    await fx.manager.exitWaiting(id);
    fx.clock.advance(199);
    expect(fx.manager.getSnapshot(id)?.state).toBe('running');
    fx.clock.advance(1);
    await completeStopPipeline(fx);
    const final = await fx.manager.waitForTerminal(id);
    expect(final.terminal?.terminationReason).toBe('PROCESS_IDLE_TIMEOUT');
  });

  it('total timeout fires from native start', async () => {
    const fx = createManagerFixture();
    const { id } = await startRunning(fx, {
      timeouts: { startupMs: undefined, idleMs: undefined, totalMs: 500, graceMs: 50 },
    });
    fx.clock.advance(500);
    await completeStopPipeline(fx);
    const final = await fx.manager.waitForTerminal(id);
    expect(final.terminal?.outcome).toBe('timeout');
    expect(final.terminal?.terminationReason).toBe('PROCESS_TOTAL_TIMEOUT');
  });
});

describe('ProcessManager output and shutdown gates', () => {
  it('output overflow initiates a fail-closed stop', async () => {
    const fx = createManagerFixture({
      streamLimits: { pendingHardBytes: 4, pendingHighBytes: 3, pendingLowBytes: 1 },
    });
    const { id, handle } = await startRunning(fx);
    handle.pushStdout('12345');
    await completeStopPipeline(fx);
    const final = await fx.manager.waitForTerminal(id);
    expect(final.state).toBe('exited');
    expect(final.terminal?.terminationReason).toBe('PROCESS_OUTPUT_LIMIT_EXCEEDED');
  });

  it('shutdown rejects new operations with the stable code', async () => {
    const fx = createManagerFixture();
    const { id, claim } = await fx.reserve();
    await fx.manager.shutdown();
    await expect(
      fx.manager.reserve({ claim: fx.makeClaim(), launch: fx.launch }),
    ).rejects.toMatchObject({ code: 'PROCESS_MANAGER_SHUTTING_DOWN' });
    await expect(fx.manager.start(id, claim)).rejects.toMatchObject({
      code: 'PROCESS_MANAGER_SHUTTING_DOWN',
    });
    await expect(
      fx.manager.stop(id, { reason: 'cancel', idempotencyKey: 'x' }),
    ).rejects.toMatchObject({ code: 'PROCESS_MANAGER_SHUTTING_DOWN' });
  });
});

describe('provider neutrality', () => {
  it('sources contain no provider semantics', () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const files = [
      ...readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')),
      ...readdirSync(join(srcDir, 'testing'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => join('testing', f)),
    ];
    const banned =
      /kimi|kimicode|codex|opencode|RunEngine|StageExecution|ProviderAdapter|ProviderRegistry/i;
    for (const file of files) {
      const content = readFileSync(join(srcDir, file), 'utf8');
      expect(content, file).not.toMatch(banned);
    }
    const manifest = readFileSync(join(srcDir, '..', 'package.json'), 'utf8');
    expect(manifest).not.toMatch(banned);
  });
});
