import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { MaintenanceActivitySnapshot, MaintenanceDrainSnapshot } from './MaintenanceBarrier.js';
import { MaintenanceBarrier } from './MaintenanceBarrier.js';

export const MAINTENANCE_LEASE_MS = 60_000;
export const MAINTENANCE_MAX_DURATION_MS = 15 * 60_000;
export const MAINTENANCE_DRAIN_TIMEOUT_MS = 30_000;
export const MAINTENANCE_SHUTDOWN_DRAIN_TIMEOUT_MS = 20 * 60_000;

export interface DurableMaintenanceState {
  readonly formatVersion: 1;
  readonly operationId: string;
  readonly kind: string;
  readonly status: 'active' | 'completed' | 'expired' | 'failed';
  readonly ownerInstanceId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly leaseExpiresAt: string;
  readonly resultCode?: string;
}

export interface MaintenanceStatus {
  readonly active: boolean;
  readonly quiescing: boolean;
  readonly state?: DurableMaintenanceState;
  readonly recoveredAfterRestart: boolean;
}

export interface MaintenanceCoordinatorOptions {
  readonly now?: () => Date;
  readonly inspectActivity: () => MaintenanceActivitySnapshot;
  readonly onPauseBackground?: () => void | Promise<void>;
  readonly onResumeBackground?: () => void;
  readonly drainTimeoutMs?: number;
  readonly maxDurationMs?: number;
}

export class MaintenanceError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'MaintenanceError';
  }
}

/** Coordinates a durable, expiring write/dispatch fence around maintenance work. */
export class MaintenanceCoordinator {
  private readonly statePath: string;
  private readonly now: () => Date;
  private state: DurableMaintenanceState | undefined;
  private recoveredAfterRestart = false;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private accepting = true;
  private activeRun: Promise<void> | undefined;
  private readonly drainTimeoutMs: number;
  private readonly maxDurationMs: number;

  constructor(
    private readonly dataRoot: string,
    private readonly instanceId: string,
    private readonly barrier: MaintenanceBarrier,
    private readonly options: MaintenanceCoordinatorOptions,
  ) {
    this.statePath = join(dataRoot, '.agentos', 'maintenance-state.json');
    this.now = options.now ?? (() => new Date());
    this.drainTimeoutMs = options.drainTimeoutMs ?? MAINTENANCE_DRAIN_TIMEOUT_MS;
    this.maxDurationMs = Math.min(options.maxDurationMs ?? MAINTENANCE_MAX_DURATION_MS, MAINTENANCE_MAX_DURATION_MS);
  }

  async initialize(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new MaintenanceError('MAINTENANCE_STATE_UNREADABLE');
    }

    let state: DurableMaintenanceState | undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<DurableMaintenanceState>;
      if (parsed.formatVersion === 1 && typeof parsed.operationId === 'string'
        && typeof parsed.kind === 'string' && ['active', 'completed', 'expired', 'failed'].includes(parsed.status ?? '')
        && typeof parsed.leaseExpiresAt === 'string' && typeof parsed.ownerInstanceId === 'string'
        && typeof parsed.startedAt === 'string' && typeof parsed.updatedAt === 'string'
        && [parsed.startedAt, parsed.updatedAt, parsed.leaseExpiresAt].every(value => Number.isFinite(Date.parse(value)))) {
        state = parsed as DurableMaintenanceState;
      }
    } catch { /* malformed state is handled fail-closed below */ }

    if (!state) {
      // Preserve damaged recovery evidence. A fabricated expiring lease would
      // silently permit database writes later without proving maintenance ended.
      this.barrier.begin();
      throw new MaintenanceError('MAINTENANCE_STATE_INVALID');
    }

    if (state.status !== 'active') {
      this.state = state;
      return;
    }

    this.recoveredAfterRestart = true;
    this.state = state;
    this.barrier.begin();
    const expiresAt = Date.parse(state.leaseExpiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) {
      await this.expireLease();
      return;
    }
    this.scheduleExpiry(expiresAt - this.now().getTime());
  }

  get status(): MaintenanceStatus {
    return Object.freeze({
      active: this.state?.status === 'active',
      quiescing: this.barrier.snapshot.quiescing,
      ...(this.state ? { state: this.state } : {}),
      recoveredAfterRestart: this.recoveredAfterRestart,
    });
  }

  /** Must run before opening SQLite: migration and recovery are writes too. */
  assertStartupWritable(): void {
    if (this.state?.status === 'active' || this.barrier.snapshot.quiescing) {
      throw new MaintenanceError('MAINTENANCE_IN_PROGRESS');
    }
  }

  async run<T>(kind: string, operation: (context: { signal: AbortSignal; operationId: string }) => Promise<T>): Promise<{
    readonly result: T;
    readonly drain: MaintenanceDrainSnapshot;
    readonly operationId: string;
  }> {
    if (!this.accepting) throw new MaintenanceError('MAINTENANCE_SHUTTING_DOWN');
    if (this.running || this.state?.status === 'active' || !this.barrier.begin()) {
      throw new MaintenanceError('MAINTENANCE_ALREADY_ACTIVE');
    }
    this.running = true;
    let finishRun!: () => void;
    this.activeRun = new Promise<void>(resolvePromise => { finishRun = resolvePromise; });
    const operationId = randomUUID();
    const startedAt = this.now();
    const deadline = startedAt.getTime() + this.maxDurationMs;
    const abortController = new AbortController();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let persisted = false;
    try {
      this.state = this.newState(operationId, kind, 'active', startedAt, new Date(startedAt.getTime() + MAINTENANCE_LEASE_MS));
      await this.persist(this.state);
      persisted = true;
      await this.options.onPauseBackground?.();
      heartbeat = setInterval(() => {
        void this.renewLease(operationId).catch(() => abortController.abort(new MaintenanceError('MAINTENANCE_LEASE_RENEWAL_FAILED')));
      }, Math.max(1000, Math.floor(MAINTENANCE_LEASE_MS / 4)));
      heartbeat.unref?.();
      deadlineTimer = setTimeout(() => abortController.abort(new MaintenanceError('MAINTENANCE_MAX_DURATION_EXCEEDED')), Math.max(1, deadline - this.now().getTime()));
      deadlineTimer.unref?.();

      const drain = await this.barrier.waitForDrain(
        this.options.inspectActivity,
        this.drainTimeoutMs,
        25,
      );
      if (!isDrained(drain)) throw new MaintenanceError('MAINTENANCE_DRAIN_TIMEOUT');
      this.throwIfAborted(abortController.signal);
      const result = await operation({ signal: abortController.signal, operationId });
      this.throwIfAborted(abortController.signal);
      const completed = this.newState(operationId, kind, 'completed', startedAt, this.now());
      this.state = completed;
      await this.persist(completed);
      return { result, drain, operationId };
    } catch (error) {
      const failed = this.newState(
        operationId,
        kind,
        'failed',
        startedAt,
        this.now(),
        error instanceof MaintenanceError ? error.code : 'MAINTENANCE_OPERATION_FAILED',
      );
      this.state = failed;
      if (persisted) {
        try { await this.persist(failed); } catch { /* preserve the operation error; lease file remains fail-closed */ }
      }
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.clearExpiryTimer();
      this.barrier.end();
      this.running = false;
      this.activeRun = undefined;
      finishRun();
      this.options.onResumeBackground?.();
    }
  }

  /** Stop new maintenance work and wait for the owned operation to settle. */
  async closeAndDrain(timeoutMs = MAINTENANCE_SHUTDOWN_DRAIN_TIMEOUT_MS): Promise<boolean> {
    this.accepting = false;
    this.barrier.close();
    const activeRun = this.activeRun;
    if (!activeRun) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        activeRun.then(() => true),
        new Promise<boolean>(resolvePromise => {
          timer = setTimeout(() => resolvePromise(false), Math.max(0, timeoutMs));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  whenIdle(): Promise<void> { return this.activeRun ?? Promise.resolve(); }

  async releaseExpiredLease(): Promise<boolean> {
    if (!this.accepting) throw new MaintenanceError('MAINTENANCE_SHUTTING_DOWN');
    if (this.state?.status !== 'active') return false;
    const expiresAt = Date.parse(this.state.leaseExpiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt > this.now().getTime()) {
      throw new MaintenanceError('MAINTENANCE_LEASE_NOT_EXPIRED');
    }
    await this.expireLease();
    return true;
  }

  private newState(
    operationId: string,
    kind: string,
    status: DurableMaintenanceState['status'],
    startedAt: Date,
    leaseExpiresAt: Date,
    resultCode?: string,
  ): DurableMaintenanceState {
    return {
      formatVersion: 1,
      operationId,
      kind,
      status,
      ownerInstanceId: this.instanceId,
      startedAt: startedAt.toISOString(),
      updatedAt: this.now().toISOString(),
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      ...(resultCode ? { resultCode } : {}),
    };
  }

  private async renewLease(operationId: string): Promise<void> {
    if (!this.running || this.state?.operationId !== operationId || this.state.status !== 'active') return;
    const now = this.now();
    const absoluteExpiry = Date.parse(this.state.startedAt) + this.maxDurationMs;
    if (now.getTime() >= absoluteExpiry) return;
    this.state = this.newState(operationId, this.state.kind, 'active', new Date(this.state.startedAt),
      new Date(Math.min(now.getTime() + MAINTENANCE_LEASE_MS, absoluteExpiry)));
    await this.persist(this.state);
  }

  private async expireLease(): Promise<void> {
    this.clearExpiryTimer();
    const previous = this.state;
    if (!previous || previous.status !== 'active') return;
    this.state = {
      ...previous,
      status: 'expired',
      updatedAt: this.now().toISOString(),
      resultCode: 'MAINTENANCE_LEASE_EXPIRED',
    };
    try { await this.persist(this.state); } finally {
      this.barrier.end();
      this.options.onResumeBackground?.();
    }
  }

  private scheduleExpiry(delayMs: number): void {
    this.clearExpiryTimer();
    this.expiryTimer = setTimeout(() => { void this.expireLease(); }, Math.max(1, delayMs));
    this.expiryTimer.unref?.();
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private async persist(state: DurableMaintenanceState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
      await rename(temporary, this.statePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    if (signal.reason instanceof MaintenanceError) throw signal.reason;
    throw new MaintenanceError('MAINTENANCE_ABORTED');
  }
}

export function isDrained(snapshot: MaintenanceDrainSnapshot): boolean {
  return snapshot.activeMutatingRequests === 0
    && snapshot.activeDispatcherStarts === 0
    && snapshot.activity.unknown !== true
    && Object.values(snapshot.activity.counts).every(count => count === 0);
}
