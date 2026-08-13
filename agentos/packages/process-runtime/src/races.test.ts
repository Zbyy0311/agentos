import { describe, expect, it } from 'vitest';
import type { ProcessManager } from './manager.js';
import {
  completeStopPipeline,
  createManagerFixture,
  drainTurns,
} from './testing/fixture.js';
import type { ManagerFixture } from './testing/fixture.js';
import type { ClaimIdentity, ProcessId, ProcessSnapshot, StopTicket } from './types.js';

/**
 * Frozen RACE-S1..S5 schedules from the merged M4-P0 acceptance matrix.
 * Every interleaving is forced by invocation order at the serialized store
 * lock plus Mock Driver barriers and a FakeClock; no sleep is used anywhere.
 */

interface RaceContext {
  fx: ManagerFixture;
  id: ProcessId;
  claim: ClaimIdentity;
  start: { snapshot: ProcessSnapshot; settled: Promise<ProcessSnapshot> };
  ticket: StopTicket;
}

function terminalFacts(snapshot: ProcessSnapshot) {
  return snapshot.facts.filter(
    (f) => f.type === 'process.exited' || f.type === 'process.failed',
  );
}

/** Commit created -> starting, enter the Driver spawn, then commit cancel. */
async function setupStartingCancel(): Promise<RaceContext> {
  const fx = createManagerFixture();
  fx.driver.holdNextSpawn();
  const claim = fx.makeClaim();
  const { snapshot } = await fx.manager.reserve({
    claim,
    launch: fx.launch,
    timeouts: { startupMs: undefined, idleMs: undefined, totalMs: undefined, graceMs: 50 },
  });
  const id = snapshot.id;
  const start = await fx.manager.start(id, claim);
  await fx.driver.awaitSpawnEntered();
  const ticket = await fx.manager.stop(id, { reason: 'cancel', idempotencyKey: 'race-cancel' });
  return { fx, id, claim, start, ticket };
}

describe('RACE-S1: created cancel revokes the unconsumed spawn right', () => {
  it('cancel commits first; the held start joins the terminal result', async () => {
    const fx = createManagerFixture();
    const claim = fx.makeClaim();
    const { snapshot } = await fx.manager.reserve({ claim, launch: fx.launch });
    const id = snapshot.id;
    // Invocation order is the lock arrival order: cancel commits first.
    const stopP = fx.manager.stop(id, { reason: 'cancel', idempotencyKey: 's1' });
    const startP = fx.manager.start(id, claim);
    const ticket = await stopP;
    const start = await startP;
    const final = await ticket.result;
    expect(final.state).toBe('failed');
    expect(final.terminal?.outcome).toBe('cancelled-before-spawn');
    expect(final.terminal?.cancelCausation).toBe('cancel');
    expect(final.spawnAttempts).toBe(0);
    expect(fx.driver.spawnCalls).toHaveLength(0);
    expect(start.snapshot.state).toBe('failed');
    await start.settled;
    const again = await fx.manager.start(id, claim);
    expect(again.snapshot.state).toBe('failed');
    expect(fx.driver.spawnCalls).toHaveLength(0);
    const facts = terminalFacts(final);
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe('process.failed');
  });
});

describe('RACE-S2: starting x cancel persists stopping with a null PID', () => {
  it('cancel CASes starting -> stopping; spawn count stays exactly 1', async () => {
    const { fx, id, claim, ticket } = await setupStartingCancel();
    const stopping = fx.manager.getSnapshot(id);
    expect(stopping?.state).toBe('stopping');
    expect(stopping?.pid).toBeNull();
    expect(stopping?.spawnAttempts).toBe(1);
    expect(stopping?.terminal).toBeNull();
    expect(stopping?.stopReason).toBe('cancel');
    expect(stopping?.facts.map((f) => f.type)).toEqual([
      'process.launch_requested',
      'process.stopping',
    ]);
    expect(fx.driver.spawnCalls).toHaveLength(1);
    // The ticket stays open while the single spawn result is unresolved.
    let concluded = false;
    void ticket.result.then(() => {
      concluded = true;
    });
    await drainTurns();
    expect(concluded).toBe(false);
    // A duplicate start while the spawn is in flight joins; no second spawn.
    const dup = await fx.manager.start(id, claim);
    expect(['starting', 'stopping']).toContain(dup.snapshot.state);
    expect(fx.driver.spawnCalls).toHaveLength(1);
  });
});

/** RACE-S3 flow, shared with RACE-S5. Drives the late success to terminal. */
async function runLateSuccessFlow(): Promise<RaceContext & { final: ProcessSnapshot }> {
  const ctx = await setupStartingCancel();
  const { fx, id } = ctx;
  fx.driver.holdVerifySurvivors();
  fx.driver.settleSpawnSuccess();
  await fx.driver.awaitGracefulStopEntered();
  await drainTurns();
  // Late success binds the same Process with factual start evidence, not running.
  const bound = fx.manager.getSnapshot(id);
  expect(bound?.state).toBe('stopping');
  expect(bound?.pid).toBe(fx.driver.handles[0].pid);
  expect(bound?.startedAt).not.toBeNull();
  expect(bound?.facts.some((f) => f.type === 'process.started')).toBe(true);
  expect(bound?.facts.some((f) => f.type === 'process.exited')).toBe(false);
  fx.clock.advance(50);
  await fx.driver.awaitTerminateTreeEntered();
  await drainTurns();
  fx.clock.advance(50);
  await fx.driver.awaitVerifySurvivorsEntered();
  // Verification is still held: no terminal fact yet.
  expect(fx.manager.getSnapshot(id)?.state).toBe('stopping');
  fx.driver.settleVerifySurvivors('complete');
  const final = await ctx.ticket.result;
  return { ...ctx, final };
}

describe('RACE-S3: late spawn success binds, cleans up and exits once', () => {
  it('terminates the bound tree, verifies survivors and terminalizes exited', async () => {
    const { fx, id, start, final } = await runLateSuccessFlow();
    expect(final.state).toBe('exited');
    expect(final.terminal?.outcome).toBe('cancelled');
    expect(final.terminal?.terminationReason).toBe('cancel');
    expect(final.terminal?.cancelCausation).toBe('cancel');
    expect(final.terminal?.cleanup).toBe('TERMINATED');
    expect(fx.driver.spawnCalls).toHaveLength(1);
    expect(fx.driver.gracefulStopCalls).toBe(1);
    expect(fx.driver.terminateTreeCalls).toBe(1);
    expect(fx.driver.verifySurvivorsCalls).toBe(1);
    const facts = terminalFacts(final);
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe('process.exited');
    const settledSnapshot = await start.settled;
    expect(settledSnapshot.state).toBe('exited');
    expect(fx.manager.getSnapshot(id)?.version).toBe(final.version);
  });
});

describe('RACE-S4: late spawn failure writes one compound failed fact', () => {
  it('records cancel causation plus spawn-failure evidence; no exit, no retry', async () => {
    const { fx, id, claim, start, ticket } = await setupStartingCancel();
    fx.driver.settleSpawnFailure(new Error('native spawn exploded'));
    const final = await ticket.result;
    expect(final.state).toBe('failed');
    expect(final.terminal?.outcome).toBe('spawn-failure-after-cancel');
    expect(final.terminal?.cancelCausation).toBe('cancel');
    expect(final.terminal?.terminationReason).toBe('cancel');
    expect(final.terminal?.error?.code).toBe('PROCESS_SPAWN_FAILED');
    expect(final.terminal?.error?.detail).not.toContain('exploded');
    expect(final.facts.some((f) => f.type === 'process.exited')).toBe(false);
    const facts = terminalFacts(final);
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe('process.failed');
    expect(fx.driver.spawnCalls).toHaveLength(1);
    expect(fx.driver.terminateTreeCalls).toBe(0);
    expect(fx.driver.verifySurvivorsCalls).toBe(0);
    await start.settled;
    // No retry or takeover spawn is possible after the compound terminal.
    const again = await fx.manager.start(id, claim);
    expect(again.snapshot.state).toBe('failed');
    expect(fx.driver.spawnCalls).toHaveLength(1);
  });
});

describe('RACE-S5: terminal boundary joins every late caller', () => {
  it('duplicate starts, cancels, stale claims and late callbacks all join', async () => {
    const { fx, id, claim, ticket, final } = await runLateSuccessFlow();
    const manager: ProcessManager = fx.manager;
    const versionAtTerminal = final.version;
    // Duplicate start callers join the terminal result.
    const dupStart = await manager.start(id, claim);
    expect(dupStart.snapshot.state).toBe('exited');
    // Duplicate cancel keys join the same stop ticket.
    const sameKey = await manager.stop(id, { reason: 'cancel', idempotencyKey: 'race-cancel' });
    const otherKey = await manager.stop(id, { reason: 'cancel', idempotencyKey: 'race-other' });
    expect(sameKey).toBe(ticket);
    expect(otherKey).toBe(ticket);
    // Stale owner and stale epoch are rejected without side effects.
    await expect(
      manager.start(id, { key: claim.key, owner: 'intruder', epoch: 9 }),
    ).rejects.toMatchObject({ code: 'PROCESS_POLICY_DENIED' });
    await expect(
      manager.start(id, { key: claim.key, owner: claim.owner, epoch: 0 }),
    ).rejects.toMatchObject({ code: 'PROCESS_REQUEST_INVALID' });
    // A duplicate late exit observation is ignored.
    fx.driver.handles[0].emitExit({ exitCode: 0 });
    await drainTurns();
    const after = manager.getSnapshot(id);
    expect(after?.state).toBe('exited');
    expect(after?.version).toBe(versionAtTerminal);
    expect(after ? terminalFacts(after) : []).toHaveLength(1);
    // Spawn, cleanup and finalization happened at most once.
    expect(fx.driver.spawnCalls).toHaveLength(1);
    expect(fx.driver.terminateTreeCalls).toBe(1);
    expect(fx.driver.verifySurvivorsCalls).toBe(1);
  });
});
