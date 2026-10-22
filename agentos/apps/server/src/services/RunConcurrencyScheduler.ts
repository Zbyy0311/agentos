/**
 * 02-Runtime-Lifecycle §8.3/§8.4 Run concurrency scheduling.
 *
 * authorizeRun() is a read-only preflight. reserveRun() is called from the
 * RunEngine claim transaction, where the capacity check, durable runtime lock,
 * and queued → starting transition commit together. Provider dimensions are
 * reserved around each actual StageExecutionCoordinator call, using that
 * Stage's frozen Agent and the current primary/fallback Provider snapshot.
 * Terminal release and startup reconciliation repair the persistent locks.
 *
 * Limits are runtime configuration only (AGENTOS_CONCURRENCY_* environment
 * variables); there is no policy table. Every limit is optional: an absent
 * limit means "unlimited" except global, which defaults conservatively to 4.
 * The per-Workspace single-writer semantics stay owned by
 * WorkspaceAdmissionAuthority; the modifyingRuns limit here is the §8.4
 * cross-workspace aggregate on top of it.
 */
import { createHash } from 'node:crypto';
import { createEntityId } from '../store/Identity.js';
import { RuntimeLockRepository } from '../store/RuntimeLockRepository.js';
import { inTransaction, isTransactionActive, type TransactionDatabase } from '../store/Transaction.js';

export type ConcurrencyLimitDimension =
  | 'global'
  | 'perWorkspace'
  | 'perProvider'
  | 'perProviderConfig'
  | 'perAgent'
  | 'modifyingRuns'
  | 'worktreeCreation';

export interface ConcurrencyLimits {
  readonly global?: number;
  readonly perWorkspace?: number;
  readonly perProvider?: number;
  readonly perProviderConfig?: number;
  readonly perAgent?: number;
  readonly modifyingRuns?: number;
  readonly worktreeCreation?: number;
}

/** Conservative default: only the global Run cap is on by default. */
export const DEFAULT_CONCURRENCY_LIMITS: ConcurrencyLimits = Object.freeze({ global: 4 });

const LIMIT_ENV_VARS: Record<ConcurrencyLimitDimension, string> = {
  global: 'AGENTOS_CONCURRENCY_GLOBAL',
  perWorkspace: 'AGENTOS_CONCURRENCY_PER_WORKSPACE',
  perProvider: 'AGENTOS_CONCURRENCY_PER_PROVIDER',
  perProviderConfig: 'AGENTOS_CONCURRENCY_PER_PROVIDER_CONFIG',
  perAgent: 'AGENTOS_CONCURRENCY_PER_AGENT',
  modifyingRuns: 'AGENTOS_CONCURRENCY_MODIFYING_RUNS',
  worktreeCreation: 'AGENTOS_CONCURRENCY_WORKTREE_CREATION',
};

function parseLimit(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error(`INVALID_CONCURRENCY_LIMIT: ${name} must be an integer between 1 and 1000000`);
  }
  return value;
}

/**
 * Resolve §8.4 limits from environment overrides over the conservative
 * defaults. A set-but-invalid variable fails fast at startup, never silently
 * degrades to "unlimited".
 */
export function concurrencyLimitsFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  defaults: ConcurrencyLimits = DEFAULT_CONCURRENCY_LIMITS,
): ConcurrencyLimits {
  const resolved: Record<string, number | undefined> = { ...defaults };
  for (const [dimension, name] of Object.entries(LIMIT_ENV_VARS) as [ConcurrencyLimitDimension, string][]) {
    const override = parseLimit(env[name], name);
    if (override !== undefined) resolved[dimension] = override;
  }
  return resolved as ConcurrencyLimits;
}

export interface RunDispatchDimensions {
  readonly providerType: string | null;
  readonly providerConfigId: string | null;
  readonly agentId: string | null;
  readonly modifying: boolean;
}

export interface ConcurrencyAuthorization {
  readonly allowed: boolean;
  readonly dimension?: ConcurrencyLimitDimension;
  readonly current?: number;
  readonly limit?: number;
  readonly reason?: string;
}

interface InFlightRow {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly mutation_class: string | null;
  readonly snapshot_json: string | null;
}

interface QueuedRow {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly priority: number;
  readonly created_at: string;
}

export interface ProviderStageCapacityInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly stageAttempt: number;
  readonly providerAttempt?: number;
  readonly providerType: string;
  readonly providerConfigId: string;
  readonly agentId: string;
}

export interface ProviderStageCapacityReservation {
  readonly ownerId: string;
  readonly locks: readonly { readonly lockKey: string; readonly ownerId: string }[];
}

export type ProviderStageCapacityResult =
  | { readonly allowed: true; readonly reservation: ProviderStageCapacityReservation }
  | {
      readonly allowed: false;
      readonly dimension: 'perProvider' | 'perProviderConfig' | 'perAgent';
      readonly current: number;
      readonly limit: number;
      readonly reason: string;
      readonly sameStageAlreadyReserved?: boolean;
    };

const RUN_LOCK_PURPOSE = 'run-concurrency-run';
const STAGE_LOCK_PURPOSE = 'run-concurrency-stage';
const SCHEDULER_LOCK_PURPOSES = [RUN_LOCK_PURPOSE, STAGE_LOCK_PURPOSE] as const;

function stableKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseLockMetadata(value: Record<string, unknown> | null): Record<string, unknown> | undefined {
  return value ?? undefined;
}

const IN_FLIGHT_STATUSES = "('starting','running','waiting_approval','paused')";

/** Extract the first configured Stage dimensions for diagnostics and legacy callers. */
export function dimensionsFromSnapshotJson(snapshotJson: string | null): Omit<RunDispatchDimensions, 'modifying'> {
  const empty = { providerType: null, providerConfigId: null, agentId: null };
  if (snapshotJson === null) return empty;
  let payload: unknown;
  try {
    payload = JSON.parse(snapshotJson);
  } catch {
    return empty;
  }
  const stages = (payload as { workflow?: { stages?: unknown[] } })?.workflow?.stages;
  if (!Array.isArray(stages)) return empty;
  let providerType: string | null = null;
  let providerConfigId: string | null = null;
  let agentId: string | null = null;
  for (const stage of stages) {
    const provider = (stage as { provider?: { providerType?: unknown; providerConfigId?: unknown } | null })?.provider;
    if (providerType === null && provider !== null && provider !== undefined) {
      if (typeof provider.providerType === 'string') providerType = provider.providerType;
      if (typeof provider.providerConfigId === 'string') providerConfigId = provider.providerConfigId;
    }
    const agent = (stage as { agent?: { agentId?: unknown } | null })?.agent;
    if (agentId === null && agent !== null && agent !== undefined && typeof agent.agentId === 'string') {
      agentId = agent.agentId;
    }
    if (providerType !== null && agentId !== null) break;
  }
  return { providerType, providerConfigId, agentId };
}

export interface RunConcurrencySchedulerOptions {
  readonly getDatabase: () => TransactionDatabase;
  readonly limits?: ConcurrencyLimits;
}

export interface ConcurrencyCounts {
  readonly globalInFlight: number;
  readonly workspaceInFlight: number;
  readonly queued: number;
}

export class RunConcurrencyScheduler {
  private readonly getDatabase: () => TransactionDatabase;
  private readonly limits: ConcurrencyLimits;
  private pump: Promise<{ readonly workspaceId: string; readonly runId: string }[]> | undefined;
  private pumpRequested = false;

  constructor(options: RunConcurrencySchedulerOptions) {
    this.getDatabase = options.getDatabase;
    this.limits = options.limits ?? DEFAULT_CONCURRENCY_LIMITS;
  }

  resolvedLimits(): ConcurrencyLimits {
    return this.limits;
  }

  /** §8.3 queue order across the whole store (or one workspace): priority DESC, created_at ASC. */
  listQueuedCandidates(workspaceId?: string): { readonly workspaceId: string; readonly runId: string }[] {
    const rows = (workspaceId === undefined
      ? this.getDatabase().prepare(
          `SELECT workspace_id, id AS run_id, priority, created_at FROM runs
           WHERE status = 'queued' AND COALESCE(recovery_required, 0) = 0 ORDER BY priority DESC, created_at ASC, id ASC`,
        ).all()
      : this.getDatabase().prepare(
          `SELECT workspace_id, id AS run_id, priority, created_at FROM runs
           WHERE status = 'queued' AND COALESCE(recovery_required, 0) = 0 AND workspace_id = ? ORDER BY priority DESC, created_at ASC, id ASC`,
        ).all(workspaceId)) as unknown as QueuedRow[];
    return rows.map(row => ({ workspaceId: row.workspace_id, runId: row.run_id }));
  }

  /**
   * The §8.4 admission gate. Counts in-flight (non-queued active) Runs per
   * dimension from durable state — no process memory, restart-safe — and
   * returns the first exceeded limit. Queued Runs occupy no slot.
   */
  authorizeRun(input: { readonly workspaceId: string; readonly runId: string }): ConcurrencyAuthorization {
    const db = this.getDatabase();
    const candidate = this.candidateRow(db, input.workspaceId, input.runId);
    // Terminal Runs never need admission; missing Runs are not this gate's job.
    if (candidate === undefined || candidate.status !== 'queued') {
      return { allowed: true, reason: 'run-not-queued' };
    }
    const candidateDims: RunDispatchDimensions = {
      ...dimensionsFromSnapshotJson(candidate.snapshot_json),
      modifying: candidate.mutation_class === 'MODIFYING',
    };

    const inFlight = this.inFlightRows(db).filter(row => !(row.workspace_id === input.workspaceId && row.run_id === input.runId));
    const globalCount = inFlight.length;
    const workspaceCount = inFlight.filter(row => row.workspace_id === input.workspaceId).length;
    const modifyingCount = candidateDims.modifying
      ? inFlight.filter(row => row.mutation_class === 'MODIFYING').length
      : 0;

    const limited = (
      dimension: ConcurrencyLimitDimension,
      current: number,
      matches: boolean,
    ): ConcurrencyAuthorization | undefined => {
      if (!matches) return undefined;
      const limit = this.limits[dimension];
      if (limit === undefined) return undefined;
      if (current < limit) return undefined;
      return { allowed: false, dimension, current, limit, reason: `${dimension} concurrency limit reached (${current}/${limit})` };
    };

    const denial = [
      limited('global', globalCount, true),
      limited('perWorkspace', workspaceCount, true),
      limited('modifyingRuns', modifyingCount, candidateDims.modifying),
    ].find(result => result !== undefined);
    return denial ?? { allowed: true };
  }

  /**
   * Persist the Run-level reservation in the same transaction that claims the
   * Run. This method intentionally refuses to open its own transaction: a
   * separate check/claim transaction would reintroduce the await race.
   */
  reserveRun(input: { readonly workspaceId: string; readonly runId: string }): ConcurrencyAuthorization {
    const db = this.getDatabase();
    if (!isTransactionActive(db)) {
      throw new Error('RUN_CONCURRENCY_RESERVATION_REQUIRES_CLAIM_TRANSACTION');
    }
    const authorization = this.authorizeRun(input);
    if (!authorization.allowed) return authorization;
    const candidate = this.candidateRow(db, input.workspaceId, input.runId);
    if (candidate?.status !== 'queued') return { allowed: true, reason: 'run-not-queued' };

    const ownerId = this.runOwnerId(input.workspaceId, input.runId);
    const lockKey = `run-concurrency:run:${stableKey(`${input.workspaceId}\0${input.runId}`)}`;
    const acquired = new RuntimeLockRepository(db).tryAcquire({
      id: createEntityId('runtimeLock'), lockKey, ownerId, purpose: RUN_LOCK_PURPOSE,
      now: new Date().toISOString(),
      metadata: { kind: 'run', workspaceId: input.workspaceId, runId: input.runId },
    });
    if (!acquired) {
      return {
        allowed: false, dimension: 'global', current: this.counts().globalInFlight,
        limit: this.limits.global ?? Number.MAX_SAFE_INTEGER,
        reason: 'Run concurrency reservation is held by another claimant',
      };
    }
    return authorization;
  }

  /** Atomically reserve limits for the exact Stage/provider attempt about to run. */
  reserveProviderStage(input: ProviderStageCapacityInput): ProviderStageCapacityResult {
    const db = this.getDatabase();
    return inTransaction(db, () => {
      const now = new Date().toISOString();
      const lockRepository = new RuntimeLockRepository(db);
      const ownerId = `stage:${stableKey([
        input.workspaceId, input.runId, input.stageId, String(input.stageAttempt),
        String(input.providerAttempt ?? input.stageAttempt),
      ].join('\0'))}`;
      const dimensions = [
        { dimension: 'perProvider' as const, value: input.providerType },
        { dimension: 'perProviderConfig' as const, value: input.providerConfigId },
        { dimension: 'perAgent' as const, value: input.agentId },
      ].flatMap(item => {
        const limit = this.limits[item.dimension];
        return limit === undefined ? [] : [{ ...item, limit, capacityKey: `${item.dimension}:${item.value}` }];
      });
      const reservationKeys = dimensions.map(item => ({
        ...item,
        lockKey: `run-concurrency:stage:${stableKey(`${item.capacityKey}\0${ownerId}`)}`,
      }));

      const ownedKeys = reservationKeys.filter(item => {
        const held = lockRepository.findByKey(item.lockKey);
        return held !== undefined && held.releasedAt === null
          && (held.expiresAt === null || held.expiresAt > now);
      });
      if (ownedKeys.length === reservationKeys.length) {
        // Replaying/resuming the same attempt joins its durable Provider claim.
        // In particular an `active` result must retain capacity until completion.
        return { allowed: true, reservation: { ownerId, locks: reservationKeys.map(item => ({ lockKey: item.lockKey, ownerId })) } };
      }

      const active = lockRepository.listActive(now).filter(lock => lock.purpose === STAGE_LOCK_PURPOSE);
      if (active.some(lock => lock.ownerId !== ownerId
        && lock.metadata?.workspaceId === input.workspaceId && lock.metadata?.runId === input.runId
        && lock.metadata?.stageId === input.stageId && lock.metadata?.stageAttempt === input.stageAttempt)) {
        return {
          allowed: false, dimension: reservationKeys[0]?.dimension ?? 'perProvider',
          current: 1, limit: reservationKeys[0]?.limit ?? 1,
          reason: 'Another Provider attempt for this Stage still owns capacity', sameStageAlreadyReserved: true,
        };
      }
      for (const item of reservationKeys) {
        const current = active.filter(lock => {
          const metadata = parseLockMetadata(lock.metadata);
          return metadata?.capacityKey === item.capacityKey && lock.ownerId !== ownerId;
        }).length;
        if (current >= item.limit) {
          return {
            allowed: false, dimension: item.dimension, current, limit: item.limit,
            reason: `${item.dimension} concurrency limit reached (${current}/${item.limit})`,
          };
        }
      }

      const acquired: { lockKey: string; ownerId: string }[] = [];
      for (const item of reservationKeys) {
        const result = lockRepository.tryAcquire({
          id: createEntityId('runtimeLock'), lockKey: item.lockKey, ownerId, purpose: STAGE_LOCK_PURPOSE,
          now,
          metadata: {
            kind: 'stage', workspaceId: input.workspaceId, runId: input.runId,
            stageId: input.stageId, stageAttempt: input.stageAttempt,
            providerAttempt: input.providerAttempt ?? input.stageAttempt,
            dimension: item.dimension, capacityKey: item.capacityKey,
          },
        });
        if (!result) {
          for (const held of acquired) lockRepository.release(held.lockKey, held.ownerId, now);
          const current = lockRepository.listActive(now).filter(lock => {
            const metadata = lock.metadata;
            return lock.purpose === STAGE_LOCK_PURPOSE && metadata?.capacityKey === item.capacityKey;
          }).length;
          return {
            allowed: false, dimension: item.dimension, current, limit: item.limit,
            reason: `${item.dimension} reservation was concurrently acquired (${current}/${item.limit})`,
          };
        }
        acquired.push({ lockKey: item.lockKey, ownerId });
      }
      return { allowed: true, reservation: { ownerId, locks: acquired } };
    });
  }

  releaseProviderStage(reservation: ProviderStageCapacityReservation): void {
    const db = this.getDatabase();
    inTransaction(db, () => {
      const repository = new RuntimeLockRepository(db);
      const now = new Date().toISOString();
      for (const lock of reservation.locks) repository.release(lock.lockKey, reservation.ownerId, now);
    });
  }

  /** Release all Run and Stage reservations after a committed terminal transition. */
  releaseRun(workspaceId: string, runId: string): void {
    const db = this.getDatabase();
    inTransaction(db, () => {
      const repository = new RuntimeLockRepository(db);
      const rows = db.prepare(
        `SELECT lock_key, owner_id, metadata_json FROM runtime_locks
         WHERE purpose IN (?, ?) AND released_at IS NULL`,
      ).all(...SCHEDULER_LOCK_PURPOSES) as Record<string, unknown>[];
      const now = new Date().toISOString();
      for (const row of rows) {
        let metadata: Record<string, unknown> | null = null;
        try { metadata = row.metadata_json == null ? null : JSON.parse(row.metadata_json as string) as Record<string, unknown>; }
        catch { continue; }
        if (metadata?.workspaceId === workspaceId && metadata?.runId === runId) {
          repository.release(row.lock_key as string, row.owner_id as string, now);
        }
      }
    });
  }

  /** Drop locks made obsolete by terminal/recovered Stage state after restart. */
  reconcileReservations(): number {
    const db = this.getDatabase();
    return inTransaction(db, () => {
      const rows = db.prepare(
        `SELECT lock_key, owner_id, purpose, metadata_json FROM runtime_locks
         WHERE purpose IN (?, ?) AND released_at IS NULL`,
      ).all(...SCHEDULER_LOCK_PURPOSES) as Record<string, unknown>[];
      const repository = new RuntimeLockRepository(db);
      let released = 0;
      const now = new Date().toISOString();
      for (const row of rows) {
        let metadata: Record<string, unknown> | null = null;
        try { metadata = row.metadata_json == null ? null : JSON.parse(row.metadata_json as string) as Record<string, unknown>; }
        catch { continue; }
        const workspaceId = metadata?.workspaceId;
        const runId = metadata?.runId;
        if (typeof workspaceId !== 'string' || typeof runId !== 'string') continue;
        const run = db.prepare('SELECT status FROM runs WHERE workspace_id = ? AND id = ?').get(workspaceId, runId) as { status: string } | undefined;
        let stale = run === undefined || !['starting', 'running', 'waiting_approval', 'paused'].includes(run.status);
        if (!stale && row.purpose === STAGE_LOCK_PURPOSE) {
          const stageId = metadata?.stageId;
          const attempt = metadata?.stageAttempt;
          const stage = typeof stageId === 'string' && typeof attempt === 'number'
            ? db.prepare('SELECT status FROM run_stages WHERE workspace_id = ? AND run_id = ? AND id = ? AND attempt = ?')
              .get(workspaceId, runId, stageId, attempt) as { status: string } | undefined
            : undefined;
          stale = stage === undefined || !['starting', 'running', 'waiting_approval', 'paused'].includes(stage.status);
        }
        if (stale && repository.release(row.lock_key as string, row.owner_id as string, now)) released += 1;
      }
      return released;
    });
  }

  /**
   * Release/backfill point: after a Run leaves the active set, re-scan the
   * queued Runs in §8.3 order. `schedule` resolves after admission/claim,
   * without waiting for Provider execution. Serial claims preserve priority
   * across asynchronous workspace authorization and fill every available slot.
   * Overlapping release notifications request another scan of the global queue.
   */
  pumpQueuedRuns(
    schedule: (workspaceId: string, runId: string) => Promise<unknown>,
  ): Promise<{ readonly workspaceId: string; readonly runId: string }[]> {
    this.pumpRequested = true;
    if (this.pump !== undefined) return this.pump;
    this.pump = Promise.resolve().then(async () => {
      const dispatched: { readonly workspaceId: string; readonly runId: string }[] = [];
      do {
        this.pumpRequested = false;
        for (const candidate of this.listQueuedCandidates()) {
          if (!this.authorizeRun(candidate).allowed) continue;
          try {
            await schedule(candidate.workspaceId, candidate.runId);
            dispatched.push(candidate);
          } catch (error) {
            // One failed admission cannot strand other Workspaces.
            console.error(`RUN_QUEUE_SCHEDULE_FAILED run=${candidate.runId}:`, error);
          }
        }
      } while (this.pumpRequested);
      return dispatched;
    }).finally(() => { this.pump = undefined; });
    return this.pump;
  }

  /** Observability for the metrics summary: why-queued counters. */
  counts(workspaceId?: string): ConcurrencyCounts {
    const db = this.getDatabase();
    const globalInFlight = (db.prepare(
      `SELECT COUNT(*) AS count FROM runs WHERE status IN ${IN_FLIGHT_STATUSES}`,
    ).get() as { count: number }).count;
    const workspaceInFlight = (db.prepare(
      `SELECT COUNT(*) AS count FROM runs WHERE status IN ${IN_FLIGHT_STATUSES} AND workspace_id = ?`,
    ).get(workspaceId ?? '') as { count: number }).count;
    const queued = (db.prepare(
      `SELECT COUNT(*) AS count FROM runs WHERE status = 'queued'${workspaceId === undefined ? '' : ' AND workspace_id = ?'}`,
    ).get(...(workspaceId === undefined ? [] : [workspaceId])) as { count: number }).count;
    return { globalInFlight, workspaceInFlight, queued };
  }

  private runOwnerId(workspaceId: string, runId: string): string {
    return `run:${stableKey(`${workspaceId}\0${runId}`)}`;
  }

  private inFlightRows(db: TransactionDatabase): InFlightRow[] {
    return db.prepare(`
      SELECT r.workspace_id AS workspace_id, r.id AS run_id,
        a.effective_mutation_class AS mutation_class,
        s.snapshot_json AS snapshot_json
      FROM runs r
      LEFT JOIN workspace_admissions a
        ON a.workspace_id = r.workspace_id AND a.canonical_run_id = r.id
      LEFT JOIN run_snapshots s
        ON s.workspace_id = r.workspace_id AND s.run_id = r.id
      WHERE r.status IN ${IN_FLIGHT_STATUSES}
    `).all() as unknown as InFlightRow[];
  }

  private candidateRow(db: TransactionDatabase, workspaceId: string, runId: string): (InFlightRow & { readonly status: string }) | undefined {
    return db.prepare(`
      SELECT r.workspace_id AS workspace_id, r.id AS run_id, r.status AS status,
        a.effective_mutation_class AS mutation_class,
        s.snapshot_json AS snapshot_json
      FROM runs r
      LEFT JOIN workspace_admissions a
        ON a.workspace_id = r.workspace_id AND a.canonical_run_id = r.id
      LEFT JOIN run_snapshots s
        ON s.workspace_id = r.workspace_id AND s.run_id = r.id
      WHERE r.workspace_id = ? AND r.id = ?
    `).get(workspaceId, runId) as (InFlightRow & { readonly status: string }) | undefined;
  }
}
