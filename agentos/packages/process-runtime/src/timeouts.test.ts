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

  it('performs zero timer operations on the activity path', () => {
    const { clock, timers, fired } = makeTimers({ idleMs: 200 });
    timers.armFromNativeStart();
    expect(clock.setTimeoutCallCount).toBe(1);
    clock.advance(50);
    timers.notifyActivity();
    clock.advance(80);
    timers.notifyActivity();
    // The activity path never clears or re-arms the idle timer.
    expect(clock.setTimeoutCallCount).toBe(1);
    // The deadline still follows the latest activity (50 + 80 + 199/1).
    clock.advance(199);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual(['idle']);
  });

  it('the armed tick re-checks the deadline against the last activity', () => {
    const { clock, timers, fired } = makeTimers({ idleMs: 200 });
    timers.armFromNativeStart();
    clock.advance(150);
    timers.notifyActivity();
    // Crossing the stale arm point (t=200) must not fire: the tick observes
    // recent activity and re-arms for the remainder instead.
    clock.advance(60);
    expect(fired).toEqual([]);
    clock.advance(140);
    expect(fired).toEqual(['idle']);
  });
});
