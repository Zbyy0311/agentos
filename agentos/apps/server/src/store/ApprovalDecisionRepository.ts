import type { TransactionDatabase } from './Transaction.js';

/**
 * Durable, restart-safe record of an accepted or rejected approval decision
 * (migration 026; authorization PR #139). The row is immutable once written
 * and carries ids, the decision, the risk level, and the action fingerprint
 * only — never a secret value or raw tool output.
 */
export class ApprovalDecisionRepositoryError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'PERSISTENCE_FAILED' | 'READ_FAILED', message: string) {
    super(code + ': ' + message);
    this.name = 'ApprovalDecisionRepositoryError';
  }
}

export type ApprovalDecisionValue = 'allow_once' | 'allow_run' | 'allow_conversation' | 'deny';

export interface ApprovalDecisionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly approvalRequestId: string | null;
  readonly agentId: string;
  readonly provider: string;
  readonly toolName: string;
  readonly actionFingerprint: string;
  readonly riskLevel: 'low' | 'medium' | 'high' | 'critical';
  readonly decision: ApprovalDecisionValue;
  readonly decidedBy: string | null;
  readonly decidedAt: string;
  readonly createdAt: string;
}

export interface RecordApprovalDecisionInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId?: string;
  readonly approvalRequestId?: string;
  readonly agentId: string;
  readonly provider: string;
  readonly toolName: string;
  readonly actionFingerprint: string;
  readonly riskLevel: 'low' | 'medium' | 'high' | 'critical';
  readonly decision: ApprovalDecisionValue;
  readonly decidedBy?: string;
  readonly decidedAt: string;
  readonly createdAt: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const ACCEPTED = new Set<ApprovalDecisionValue>(['allow_once', 'allow_run', 'allow_conversation']);
const DECISIONS = new Set<string>(['allow_once', 'allow_run', 'allow_conversation', 'deny']);
const RISK_LEVELS = new Set<string>(['low', 'medium', 'high', 'critical']);

function toRecord(row: Record<string, unknown>): ApprovalDecisionRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    runId: (row.run_id as string | null) ?? null,
    approvalRequestId: (row.approval_request_id as string | null) ?? null,
    agentId: row.agent_id as string,
    provider: row.provider as string,
    toolName: row.tool_name as string,
    actionFingerprint: row.action_fingerprint as string,
    riskLevel: row.risk_level as ApprovalDecisionRecord['riskLevel'],
    decision: row.decision as ApprovalDecisionValue,
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedAt: row.decided_at as string,
    createdAt: row.created_at as string,
  };
}

export class ApprovalDecisionRepository {
  constructor(private readonly db: TransactionDatabase) {}

  /** True when the decision is an acceptance that should generate a Candidate. */
  static isAccepted(decision: ApprovalDecisionValue): boolean {
    return ACCEPTED.has(decision);
  }

  /**
   * Record one decision inside the caller's transaction. The table is
   * immutable; the row can never be updated once written.
   */
  recordDecision(input: RecordApprovalDecisionInput): ApprovalDecisionRecord {
    if (!nonBlank(input.id) || !nonBlank(input.workspaceId) || !nonBlank(input.agentId)
      || !nonBlank(input.provider) || !nonBlank(input.toolName) || !nonBlank(input.actionFingerprint)
      || !nonBlank(input.decidedAt) || !nonBlank(input.createdAt)) {
      throw new ApprovalDecisionRepositoryError('INPUT_INVALID', 'a required field is missing or blank');
    }
    if (!DECISIONS.has(input.decision)) {
      throw new ApprovalDecisionRepositoryError('INPUT_INVALID', 'unknown decision: ' + String(input.decision));
    }
    if (!RISK_LEVELS.has(input.riskLevel)) {
      throw new ApprovalDecisionRepositoryError('INPUT_INVALID', 'unknown risk level: ' + String(input.riskLevel));
    }
    try {
      this.db.prepare(
        'INSERT INTO approval_decisions (id, workspace_id, run_id, approval_request_id, agent_id, provider, tool_name, action_fingerprint, risk_level, decision, decided_by, decided_at, created_at)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        input.id, input.workspaceId, input.runId ?? null, input.approvalRequestId ?? null,
        input.agentId, input.provider, input.toolName, input.actionFingerprint,
        input.riskLevel, input.decision, input.decidedBy ?? null, input.decidedAt, input.createdAt,
      );
    } catch (error) {
      throw new ApprovalDecisionRepositoryError(
        'PERSISTENCE_FAILED',
        error instanceof Error ? error.message : 'approval decision could not be persisted',
      );
    }
    return this.requireById(input.workspaceId, input.id);
  }

  findById(workspaceId: string, id: string): ApprovalDecisionRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(id)) return undefined;
    try {
      const row = this.db.prepare(
        'SELECT * FROM approval_decisions WHERE workspace_id = ? AND id = ?',
      ).get(workspaceId, id) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : toRecord(row);
    } catch (error) {
      throw new ApprovalDecisionRepositoryError('READ_FAILED', error instanceof Error ? error.message : 'read failed');
    }
  }

  private requireById(workspaceId: string, id: string): ApprovalDecisionRecord {
    const found = this.findById(workspaceId, id);
    if (found === undefined) {
      throw new ApprovalDecisionRepositoryError('PERSISTENCE_FAILED', 'decision row not readable after write: ' + id);
    }
    return found;
  }

  listForWorkspace(workspaceId: string): ApprovalDecisionRecord[] {
    if (!nonBlank(workspaceId)) return [];
    try {
      const rows = this.db.prepare(
        'SELECT * FROM approval_decisions WHERE workspace_id = ? ORDER BY decided_at ASC, id ASC',
      ).all(workspaceId) as Array<Record<string, unknown>>;
      return rows.map(toRecord);
    } catch (error) {
      throw new ApprovalDecisionRepositoryError('READ_FAILED', error instanceof Error ? error.message : 'read failed');
    }
  }

  countForWorkspace(workspaceId: string): number {
    if (!nonBlank(workspaceId)) return 0;
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM approval_decisions WHERE workspace_id = ?')
      .get(workspaceId) as { readonly n: number | bigint };
    return Number(row.n);
  }
}
