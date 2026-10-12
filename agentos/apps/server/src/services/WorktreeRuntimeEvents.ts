import type {
  WorktreeActivatedEventPayload,
} from '@agentos/shared';
import { inTransaction, isTransactionActive, type TransactionDatabase } from '../store/Transaction.js';
import type { DurableRuntimeFactWriter } from '../store/RuntimeEventRepository.js';
import type { WorktreeLeaseRecord } from '../store/WorktreeRepository.js';

/**
 * Worktree Runtime Event sink (06-Worktree-Runtime §71-76/§57).
 *
 * `WorktreeManager` and `WorktreeMergeService` depend on the narrow
 * `WorktreeEventSink` interface only, so lease behavior is unchanged when no
 * sink is supplied (embedded/test call sites). The production implementation
 * (`WorktreeRuntimeEventEmitter`) appends through the standard merged Runtime
 * Event + Outbox seam, bound to the same SQLite connection as the lease row.
 *
 * Durable lease mutations and their Event + Outbox commit in one transaction.
 * A persistence failure is surfaced rather than committing a partial audit fact.
 * When the canonical Run is not
 * persisted (legacy/imported leases whose run never entered the runs table),
 * no envelope can be formed, so the emitter records an audit line through the
 * injected `onAudit` callback instead of fabricating a Workspace/Run binding.
 */

export type WorktreeLeaseEventType =
  | 'worktree.reserved'
  | 'worktree.created'
  | 'worktree.activated'
  | 'worktree.abandoned'
  | 'worktree.deleted';

/** One preserved untracked-by-database observation from `git worktree list --porcelain` reconciliation. */
export interface WorktreeOrphanObservation {
  readonly path: string;
  readonly branch: string | null;
  readonly headCommit: string | null;
  readonly workspaceRoot: string;
  readonly classification: 'untracked-by-database';
  readonly action: 'preserve';
}

/** Optional Workspace/Run context used when an orphan Event can be bound to a persisted Run. */
export interface WorktreeOrphanEventContext {
  readonly workspaceId: string;
  readonly runId: string;
}

export interface WorktreeRecoveryScope {
  readonly workspaceId: string;
  readonly runId: string;
  readonly scannedCount: number;
}

export interface WorktreeEventSink {
  emitFact(type: string, record: WorktreeLeaseRecord, payload: Record<string, unknown>): void;
  /** Emit a lease lifecycle Event (created/activated/abandoned/deleted). */
  emitLeaseEvent(
    type: WorktreeLeaseEventType,
    record: WorktreeLeaseRecord,
    details?: { readonly reason?: string; readonly controlledGitContent?: boolean },
  ): void;
  /** Emit §57 worktree.recovery_started for one reconciled Run scope. */
  emitRecoveryStarted(scope: WorktreeRecoveryScope): void;
  /**
   * Emit worktree.orphaned for a preserved untracked worktree. Implementations
   * without a resolvable persisted Run must record an audit line instead —
   * an orphan by definition has no lease row to derive a Run binding from.
   */
  emitOrphan(orphan: WorktreeOrphanObservation, context?: WorktreeOrphanEventContext): void;
}

/** No-op sink used when the caller wires no event channel. */
export const NOOP_WORKTREE_EVENT_SINK: WorktreeEventSink = {
  emitFact() { /* events disabled */ },
  emitLeaseEvent() { /* events disabled */ },
  emitRecoveryStarted() { /* events disabled */ },
  emitOrphan() { /* events disabled */ },
};

function lifecyclePayload(
  record: WorktreeLeaseRecord,
): WorktreeActivatedEventPayload {
  return {
    worktreeId: record.id,
    runId: record.runId,
    workspaceId: record.workspaceId,
    executionId: record.executionId,
    agentId: record.agentId,
    branchName: record.branchName,
    status: record.status,
  };
}

export interface WorktreeRuntimeEventEmitterOptions {
  readonly now?: () => Date;
  /** Audit-line fallback target (diagnostic log); receives one line per skipped/failed emission. */
  readonly onAudit?: (line: string) => void;
}

/**
 * Production sink: appends worktree Events through the merged Runtime Event +
 * Outbox writer on the store's single SQLite connection. Every append opens
 * (or joins, via `isTransactionActive`) one transaction, so the Event and its
 * Outbox handoff commit atomically.
 */
export class WorktreeRuntimeEventEmitter implements WorktreeEventSink {
  private readonly now: () => Date;
  private readonly onAudit: (line: string) => void;

  constructor(
    private readonly db: TransactionDatabase,
    private readonly writer: DurableRuntimeFactWriter,
    options: WorktreeRuntimeEventEmitterOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.onAudit = options.onAudit ?? (() => undefined);
  }

  emitFact(type: string, record: WorktreeLeaseRecord, payload: Record<string, unknown>): void {
    this.append(type, record.workspaceId, record.runId, record.id, {
      ...payload, worktreeId: record.id, workspaceId: record.workspaceId, runId: record.runId,
    });
  }

  emitLeaseEvent(type: WorktreeLeaseEventType, record: WorktreeLeaseRecord, details?: { readonly reason?: string; readonly controlledGitContent?: boolean }): void {
    if (type === 'worktree.reserved') {
      this.append(type, record.workspaceId, record.runId, record.id, {
        worktreeId: record.id, runId: record.runId, workspaceId: record.workspaceId,
        branchName: record.branchName, baseCommit: record.baseCommit,
      });
      return;
    }
    const payload: Record<string, unknown> = { ...lifecyclePayload(record) };
    if (type === 'worktree.created') {
      payload.baseCommit = record.baseCommit;
      payload.pathLabel = record.pathLabel;
      // The lease row does not persist the controlled-checkout flag; the
      // manager supplies it for the created Event.
      payload.controlledGitContent = details?.controlledGitContent === true;
    }
    if (type === 'worktree.abandoned' && details?.reason !== undefined) payload.reason = details.reason;
    this.append(type, record.workspaceId, record.runId, record.id, payload);
  }

  emitRecoveryStarted(scope: WorktreeRecoveryScope): void {
    this.append('worktree.recovery_started', scope.workspaceId, scope.runId, null, {
      runId: scope.runId,
      workspaceId: scope.workspaceId,
      scannedCount: scope.scannedCount,
    });
  }

  emitOrphan(orphan: WorktreeOrphanObservation, context?: WorktreeOrphanEventContext): void {
    const payload: Record<string, unknown> = {
      path: orphan.path,
      classification: orphan.classification,
      action: orphan.action,
      ...(orphan.branch === null ? {} : { branch: orphan.branch }),
      ...(orphan.headCommit === null ? {} : { headCommit: orphan.headCommit }),
      ...(context?.workspaceId === undefined ? {} : { workspaceId: context.workspaceId }),
      ...(context?.runId === undefined ? {} : { runId: context.runId }),
    };
    if (context === undefined) {
      this.onAudit(`WORKTREE_ORPHAN_PRESERVED path=${orphan.path} branch=${orphan.branch ?? 'unknown'} reason=untracked-by-database (no persisted Run context; directory preserved, adoption requires the explicit adopt API)`);
      return;
    }
    this.append('worktree.orphaned', context.workspaceId, context.runId, null, payload);
  }

  private append(
    type: string,
    workspaceId: string,
    runId: string,
    worktreeId: string | null,
    payload: Record<string, unknown>,
  ): void {
    if (!this.runExists(workspaceId, runId)) {
      this.onAudit(`WORKTREE_EVENT_SKIPPED type=${type} worktreeId=${worktreeId ?? 'n/a'} runId=${runId} reason=run-not-persisted`);
      return;
    }
    const appendOnce = (): void => {
      this.writer.appendWithinTransaction({
        type,
        workspaceId,
        runId,
        timestamp: this.now().toISOString(),
        source: 'worktree-manager',
        eventContext: {
          correlationId: `worktree:${worktreeId ?? runId}:${type}`,
          causationId: `worktree:${worktreeId ?? runId}`,
        },
        ...(worktreeId === null ? {} : { worktreeId }),
        payload,
      });
    };
    if (isTransactionActive(this.db)) appendOnce();
    else inTransaction(this.db, appendOnce);
  }

  private runExists(workspaceId: string, runId: string): boolean {
    return this.db.prepare('SELECT 1 AS present FROM runs WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, runId) !== undefined;
  }
}
