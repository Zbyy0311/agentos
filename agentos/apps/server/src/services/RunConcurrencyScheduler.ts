/**
 * 02-Runtime-Lifecycle §8.3/§8.4 Run concurrency scheduling.
 *
 * The scheduler is a pure in-process admission gate over durable Run state:
 * it never mutates Runs and never owns dispatch. RunEngineProviderDispatcher
 * calls authorizeRun() before claiming a queued Run; on denial the Run simply
 * stays queued (the dispatcher reports a noop reason and a diagnostic is
 * logged, never a silent drop). When a Run reaches a terminal state the
 * execution chain calls pumpQueuedRuns(), which re-evaluates queued Runs in
 * §8.3 order (priority DESC, created_at ASC) and re-drives the first ones
 * that now fit — that is the release/backfill point.
 *
 * Limits are runtime configuration only (AGENTOS_CONCURRENCY_* environment
 * variables); there is no policy table. Every limit is optional: an absent
 * limit means "unlimited" except global, which defaults conservatively to 4.
 * The per-Workspace single-writer semantics stay owned by
 * WorkspaceAdmissionAuthority; the modifyingRuns limit here is the §8.4
 * cross-workspace aggregate on top of it.
 */
import type { TransactionDatabase } from '../store/Transaction.js';

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

const IN_FLIGHT_STATUSES = "('starting','running','waiting_approval','paused')";

/** Extract dispatch dimensions from one Run Snapshot payload (§8.4 keys). */
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
           WHERE status = 'queued' ORDER BY priority DESC, created_at ASC, id ASC`,
        ).all()
      : this.getDatabase().prepare(
          `SELECT workspace_id, id AS run_id, priority, created_at FROM runs
           WHERE status = 'queued' AND workspace_id = ? ORDER BY priority DESC, created_at ASC, id ASC`,
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
    if (candidate === undefined
      || candidate.status === 'completed'
      || candidate.status === 'failed'
      || candidate.status === 'cancelled') {
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
      this.countDimension(inFlight, 'perProvider', candidateDims.providerType),
      this.countDimension(inFlight, 'perProviderConfig', candidateDims.providerConfigId),
      this.countDimension(inFlight, 'perAgent', candidateDims.agentId),
    ].find(result => result !== undefined);
    return denial ?? { allowed: true };
  }

  /**
   * Release/backfill point: after a Run leaves the active set, re-scan the
   * queued Runs in §8.3 order and re-drive the FIRST candidate that now
   * passes the gate. One freed slot admits exactly one Run — drives are
   * asynchronous, so admitting more than one per pass could overshoot a
   * dimension limit before any claim lands. drive implementations own
   * claim/CAS/failure containment; the pump never awaits execution and
   * never throws. Additional free slots are filled by their own release
   * events and by every individually gated start-route drive.
   */
  pumpQueuedRuns(
    drive: (workspaceId: string, runId: string) => Promise<unknown>,
    workspaceId?: string,
  ): { readonly workspaceId: string; readonly runId: string }[] {
    for (const candidate of this.listQueuedCandidates(workspaceId)) {
      const authorization = this.authorizeRun(candidate);
      if (!authorization.allowed) continue;
      void drive(candidate.workspaceId, candidate.runId).catch(() => {
        // Containment backstop only; drive contains its own failures.
      });
      return [candidate];
    }
    return [];
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

  private countDimension(
    inFlight: readonly InFlightRow[],
    dimension: 'perProvider' | 'perProviderConfig' | 'perAgent',
    key: string | null,
  ): ConcurrencyAuthorization | undefined {
    if (key === null) return undefined;
    const limit = this.limits[dimension];
    if (limit === undefined) return undefined;
    const attribute = (row: InFlightRow): string | null =>
      dimensionsFromSnapshotJson(row.snapshot_json)[
        dimension === 'perProvider' ? 'providerType' : dimension === 'perProviderConfig' ? 'providerConfigId' : 'agentId'
      ];
    const current = inFlight.filter(row => attribute(row) === key).length;
    if (current < limit) return undefined;
    return { allowed: false, dimension, current, limit, reason: `${dimension} concurrency limit reached (${current}/${limit})` };
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
