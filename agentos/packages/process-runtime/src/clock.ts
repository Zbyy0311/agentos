/** Injected clock seam. All waits use this; arbitrary sleep is not a correctness primitive. */
export interface ClockTimerHandle {
  readonly id: number;
}

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ClockTimerHandle;
  clearTimeout(handle: ClockTimerHandle): void;
}

export class SystemClock implements Clock {
  #nextId = 1;
  #handles = new Map<number, NodeJS.Timeout>();

  now(): number {
    return Date.now();
  }

  setTimeout(callback: () => void, delayMs: number): ClockTimerHandle {
    const id = this.#nextId++;
    this.#handles.set(id, setTimeout(() => {
      this.#handles.delete(id);
      callback();
    }, delayMs));
    return { id };
  }

  clearTimeout(handle: ClockTimerHandle): void {
    const native = this.#handles.get(handle.id);
    if (native !== undefined) {
      clearTimeout(native);
      this.#handles.delete(handle.id);
    }
  }
}

/** Deterministic clock for tests: timers fire only from advance(). */
export class FakeClock implements Clock {
  #now = 0;
  #nextId = 1;
  #timers: Array<{ id: number; at: number; callback: () => void }> = [];

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): ClockTimerHandle {
    const id = this.#nextId++;
    this.#timers.push({ id, at: this.#now + delayMs, callback });
    this.#timers.sort((a, b) => a.at - b.at || a.id - b.id);
    return { id };
  }

  clearTimeout(handle: ClockTimerHandle): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle.id);
  }

  get pendingCount(): number {
    return this.#timers.length;
  }

  advance(deltaMs: number): void {
    if (deltaMs < 0) throw new Error('FakeClock cannot advance backwards');
    const target = this.#now + deltaMs;
    for (;;) {
      const next = this.#timers[0];
      if (!next || next.at > target) break;
      this.#timers.shift();
      this.#now = next.at;
      next.callback();
    }
    this.#now = target;
  }
}

