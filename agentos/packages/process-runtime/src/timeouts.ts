import type { Clock, ClockTimerHandle } from './clock.js';
import type { TimeoutPolicy } from './types.js';

export type ProcessTimerKind = 'startup' | 'idle' | 'total';

export interface ProcessTimersOptions {
  readonly clock: Clock;
  readonly policy: TimeoutPolicy;
  /** Fires once per Process; the first fired deadline owns the transition. */
  readonly onFire: (kind: ProcessTimerKind) => void;
}

/**
 * Startup / idle / total deadline machinery. Armed when the native start is
 * observed, never at reserve time. The idle deadline resets on activity and
 * pauses while the Process is in an approved waiting state. All waits are
 * observable through the injected clock; arbitrary sleep is not used.
 */
export class ProcessTimers {
  readonly #clock: Clock;
  readonly #policy: TimeoutPolicy;
  readonly #onFire: (kind: ProcessTimerKind) => void;

  #startup: ClockTimerHandle | null = null;
  #idle: ClockTimerHandle | null = null;
  #total: ClockTimerHandle | null = null;
  #idleRemainingMs: number | null = null;
  #idleArmedAt: number | null = null;
  #idlePaused = false;
  #fired = false;
  #disarmed = false;

  constructor(options: ProcessTimersOptions) {
    this.#clock = options.clock;
    this.#policy = options.policy;
    this.#onFire = options.onFire;
  }

  get fired(): boolean {
    return this.#fired;
  }

  get idlePaused(): boolean {
    return this.#idlePaused;
  }

  get pendingCount(): number {
    let count = 0;
    if (this.#startup !== null) count += 1;
    if (this.#idle !== null || this.#idlePaused) count += 1;
    if (this.#total !== null) count += 1;
    return count;
  }

  /** Arm every configured deadline from the native-start observation. */
  armFromNativeStart(): void {
    if (this.#disarmed || this.#fired) return;
    const { startupMs, idleMs, totalMs } = this.#policy;
    if (startupMs !== undefined && this.#startup === null) {
      this.#startup = this.#clock.setTimeout(() => this.#fire('startup'), startupMs);
    }
    if (idleMs !== undefined) this.#armIdle(idleMs);
    if (totalMs !== undefined && this.#total === null) {
      this.#total = this.#clock.setTimeout(() => this.#fire('total'), totalMs);
    }
  }

  /** Readiness mark: the startup deadline is satisfied exactly once. */
  markReady(): void {
    if (this.#startup !== null) {
      this.#clock.clearTimeout(this.#startup);
      this.#startup = null;
    }
  }

  /** Activity checkpoint: the idle deadline restarts. */
  notifyActivity(): void {
    if (this.#disarmed || this.#fired || this.#idlePaused) return;
    if (this.#policy.idleMs === undefined) return;
    this.#clearIdle();
    this.#armIdle(this.#policy.idleMs);
  }

  /** Approved wait: the idle deadline pauses with its remaining budget kept. */
  pauseIdle(): void {
    if (this.#idlePaused || this.#disarmed || this.#fired) return;
    if (this.#idle === null) return;
    const elapsed = this.#clock.now() - (this.#idleArmedAt ?? this.#clock.now());
    this.#idleRemainingMs = Math.max(0, (this.#policy.idleMs ?? 0) - elapsed);
    this.#clearIdle();
    this.#idlePaused = true;
  }

  resumeIdle(): void {
    if (!this.#idlePaused || this.#disarmed || this.#fired) return;
    this.#idlePaused = false;
    this.#armIdle(this.#idleRemainingMs ?? this.#policy.idleMs ?? 0);
    this.#idleRemainingMs = null;
  }

  disarmAll(): void {
    this.#disarmed = true;
    if (this.#startup !== null) {
      this.#clock.clearTimeout(this.#startup);
      this.#startup = null;
    }
    this.#clearIdle();
    if (this.#total !== null) {
      this.#clock.clearTimeout(this.#total);
      this.#total = null;
    }
    this.#idlePaused = false;
    this.#idleRemainingMs = null;
  }

  #armIdle(delayMs: number): void {
    this.#idleArmedAt = this.#clock.now();
    this.#idle = this.#clock.setTimeout(() => this.#fire('idle'), delayMs);
  }

  #clearIdle(): void {
    if (this.#idle !== null) {
      this.#clock.clearTimeout(this.#idle);
      this.#idle = null;
    }
  }

  #fire(kind: ProcessTimerKind): void {
    if (this.#fired || this.#disarmed) return;
    this.#fired = true;
    this.disarmAll();
    this.#onFire(kind);
  }
}
