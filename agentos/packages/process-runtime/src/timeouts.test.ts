import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { ProcessTimers } from './timeouts.js';
import type { ProcessTimerKind } from './timeouts.js';
import type { TimeoutPolicy } from './types.js';

function makeTimers(policy: Partial<TimeoutPolicy>) {
  const clock = new FakeClock();
  const fired: ProcessTimerKind[] = [];
  const timers = new ProcessTimers({
    clock,
    policy: { graceMs: 50, ...policy },
    onFire: (kind) => fired.push(kind),
  });
  return { clock, timers, fired };
}

describe('ProcessTimers', () => {
  it('arms only configured deadlines from native start', () => {
    const { clock, timers } = makeTimers({ startupMs: 100, idleMs: undefined, totalMs: 300 });
    timers.armFromNativeStart();
    expect(clock.pendingCount).toBe(2);
  });

  it('fires the startup deadline once unless readiness is marked', () => {
    const { clock, timers, fired } = makeTimers({ startupMs: 100 });
    timers.armFromNativeStart();
    clock.advance(99);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual(['startup']);
    clock.advance(1000);
    expect(fired).toEqual(['startup']);
  });

  it('markReady disarms only the startup deadline', () => {
    const { clock, timers, fired } = makeTimers({ startupMs: 100, totalMs: 300 });
    timers.armFromNativeStart();
    timers.markReady();
    clock.advance(100);
    expect(fired).toEqual([]);
    clock.advance(200);
    expect(fired).toEqual(['total']);
  });

  it('resets the idle deadline on activity', () => {
    const { clock, timers, fired } = makeTimers({ idleMs: 200 });
    timers.armFromNativeStart();
    clock.advance(150);
    timers.notifyActivity();
    clock.advance(199);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual(['idle']);
  });

  it('pauses the idle deadline while waiting and resumes with the remainder', () => {
    const { clock, timers, fired } = makeTimers({ idleMs: 200 });
    timers.armFromNativeStart();
    clock.advance(50);
    timers.pauseIdle();
    clock.advance(10_000);
    expect(fired).toEqual([]);
    expect(timers.idlePaused).toBe(true);
    timers.resumeIdle();
    clock.advance(149);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual(['idle']);
  });

  it('keeps total timeout running while idle is paused', () => {
    const { clock, timers, fired } = makeTimers({ idleMs: 200, totalMs: 300 });
    timers.armFromNativeStart();
    clock.advance(50);
    timers.pauseIdle();
    clock.advance(249);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual(['total']);
  });

  it('disarmAll silences every deadline', () => {
    const { clock, timers, fired } = makeTimers({ startupMs: 100, idleMs: 200, totalMs: 300 });
    timers.armFromNativeStart();
    timers.disarmAll();
    clock.advance(10_000);
    expect(fired).toEqual([]);
    expect(clock.pendingCount).toBe(0);
  });
});
