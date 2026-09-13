import type { RuntimeEventContextAuthoritySourceV1 } from '@agentos/shared';
import type { TransactionDatabase } from '../store/Transaction.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';

/**
 * LITE-07-102 restart convergence.
 *
 * The terminal-outcome Candidate is written AFTER the terminal commit, so a
 * crash in that window would leave a terminal Run with no memory fact. This
 * sweep closes that window: it finds terminal Runs whose deterministic
 * Candidate is missing and generates it, using the Run's own persisted terminal
 * Runtime Event as the causal authority.
 *
 * Boundaries:
 *
 *   - It is idempotent by construction: the Candidate id is
 *     `mcand_terminal_<runId>` and the generator owns the find-before-create
 *     guard, so a repeated sweep converges instead of duplicating.
 *   - It never mutates the Run and never starts execution. It only reads Runs,
 *     the Run's Event, and the Candidate projection.
 *   - It never fabricates causation: a terminal Run with no persisted terminal
 *     Event is reported and skipped, because the Candidate's canonical Event
 *     must be authorized by a durable row.
 *   - A failing Run is contained and reported; one Run never stops the sweep.
 */

const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const;
const TERMINAL_RUN_EVENT_TYPES = ['run.completed', 'run.failed', 'run.cancelled'] as const;

/** Deterministic per-Run Candidate id; the generator owns the same value. */
export function terminalCandidateId(runId: string): string {
  return `mcand_terminal_${runId}`;
}

export interface TerminalCandidateReconcileOutcome {
  readonly workspaces: number;
  readonly terminalRuns: number;
  readonly generated: number;
  readonly existing: number;
  /** Terminal Runs whose terminal Event could not be proven; never fabricated. */
  readonly missingAuthority: number;
  /** Runs the generator refused or failed on; reported, never fatal. */
  readonly unresolved: number;
}

export interface TerminalMemoryCandidateReconcilerOptions {
  readonly store: { getDatabase(): TransactionDatabase };
  readonly generator: {
    generateForRunTerminal(input: {
      readonly workspaceId: string;
      readonly runId: string;
      readonly createdAt: string;
      readonly eventContext?: RuntimeEventContextAuthoritySourceV1;
    }): { readonly outcome: string };
  };
  readonly candidates?: Pick<MemoryCandidateRepository, 'findCandidateById'>;
  readonly now?: () => string;
  /** Bounded per Workspace, so a first startup on a large store stays bounded. */
  readonly limitPerWorkspace?: number;
  readonly onProblem?: (detail: string) => void;
}

interface TerminalRunRow {
  readonly id: string;
}

interface TerminalEventRow {
  readonly id: string;
  readonly correlation_id: string;
}

interface WorkspaceRow {
  readonly id: string;
}

const DEFAULT_LIMIT_PER_WORKSPACE = 200;

export class TerminalMemoryCandidateReconciler {
  private readonly db: TransactionDatabase;
  private readonly generator: TerminalMemoryCandidateReconcilerOptions['generator'];
  private readonly candidates: Pick<MemoryCandidateRepository, 'findCandidateById'>;
  private readonly now: () => string;
  private readonly limitPerWorkspace: number;
  private readonly onProblem: (detail: string) => void;

  constructor(options: TerminalMemoryCandidateReconcilerOptions) {
    this.db = options.store.getDatabase();
    this.generator = options.generator;
    this.candidates = options.candidates ?? new MemoryCandidateRepository(this.db);
    this.now = options.now ?? (() => new Date().toISOString());
    this.limitPerWorkspace = options.limitPerWorkspace ?? DEFAULT_LIMIT_PER_WORKSPACE;
    this.onProblem = options.onProblem ?? (() => undefined);
  }

  reconcileOnStartup(): TerminalCandidateReconcileOutcome {
    const workspaces = this.db
      .prepare('SELECT id FROM workspaces ORDER BY id')
      .all() as WorkspaceRow[];
    let outcome: TerminalCandidateReconcileOutcome = {
      workspaces: 0, terminalRuns: 0, generated: 0, existing: 0, missingAuthority: 0, unresolved: 0,
    };
    for (const workspace of workspaces) {
      outcome = sumOutcomes(outcome, this.reconcileWorkspace(workspace.id));
    }
    return outcome;
  }

  reconcileWorkspace(workspaceId: string): TerminalCandidateReconcileOutcome {
    const runs = this.db.prepare(
      'SELECT id FROM runs WHERE workspace_id = ? AND status IN (?, ?, ?) ORDER BY updated_at ASC, id ASC LIMIT ?',
    ).all(workspaceId, ...TERMINAL_RUN_STATUSES, this.limitPerWorkspace) as TerminalRunRow[];

    let outcome: TerminalCandidateReconcileOutcome = {
      workspaces: 1, terminalRuns: runs.length, generated: 0, existing: 0, missingAuthority: 0, unresolved: 0,
    };
    for (const run of runs) {
      if (this.candidates.findCandidateById(workspaceId, terminalCandidateId(run.id)) !== undefined) {
        outcome = { ...outcome, existing: outcome.existing + 1 };
        continue;
      }
      const event = this.db.prepare(
        'SELECT id, correlation_id FROM runtime_events WHERE workspace_id = ? AND run_id = ? AND type IN (?, ?, ?) ORDER BY sequence DESC LIMIT 1',
      ).get(workspaceId, run.id, ...TERMINAL_RUN_EVENT_TYPES) as TerminalEventRow | undefined;
      if (event === undefined || typeof event.correlation_id !== 'string' || event.correlation_id.length === 0) {
        this.onProblem(`TERMINAL_CANDIDATE_NO_AUTHORITY run=${run.id} workspace=${workspaceId}`);
        outcome = { ...outcome, missingAuthority: outcome.missingAuthority + 1 };
        continue;
      }
      try {
        const result = this.generator.generateForRunTerminal({
          workspaceId,
          runId: run.id,
          createdAt: this.now(),
          eventContext: {
            origin: 'persisted_event',
            eventId: event.id,
            context: { correlationId: event.correlation_id, causationId: event.id },
          },
        });
        if (result.outcome === 'created' || result.outcome === 'converged') {
          outcome = { ...outcome, generated: outcome.generated + 1 };
        } else if (result.outcome === 'existing') {
          outcome = { ...outcome, existing: outcome.existing + 1 };
        } else {
          // `not-terminal` and `run-not-found` are unreachable for a row the
          // sweep just read; anything else is a refusal worth surfacing.
          this.onProblem(`TERMINAL_CANDIDATE_UNRESOLVED run=${run.id} outcome=${result.outcome}`);
          outcome = { ...outcome, unresolved: outcome.unresolved + 1 };
        }
      } catch (error) {
        this.onProblem(`TERMINAL_CANDIDATE_FAILED run=${run.id}: ${error instanceof Error ? error.message : String(error)}`);
        outcome = { ...outcome, unresolved: outcome.unresolved + 1 };
      }
    }
    return outcome;
  }
}

function sumOutcomes(
  left: TerminalCandidateReconcileOutcome,
  right: TerminalCandidateReconcileOutcome,
): TerminalCandidateReconcileOutcome {
  return {
    workspaces: left.workspaces + right.workspaces,
    terminalRuns: left.terminalRuns + right.terminalRuns,
    generated: left.generated + right.generated,
    existing: left.existing + right.existing,
    missingAuthority: left.missingAuthority + right.missingAuthority,
    unresolved: left.unresolved + right.unresolved,
  };
}
