import { isTransactionActive, type TransactionDatabase } from './Transaction.js';
import { isCanonicalUtcTimestamp } from './CanonicalTimestamp.js';

/**
 * S6 conversation compaction persistence (authorization:
 * S6-compaction-authorization.md). Policies are immutable versioned rows; a
 * compaction task moves pending -> running -> published | failed | retry-pending
 * under a version CAS with a durable lease. Published summaries are immutable.
 */

export type CompactionStatus = 'pending' | 'running' | 'published' | 'failed' | 'retry-pending';

export interface CompactionPolicyRecord {
  readonly id: string;
  readonly policyVersion: string;
  readonly triggerRatio: number;
  readonly targetRatio: number;
  readonly minRecentMessages: number;
  readonly summaryMaxTokens: number;
  readonly timeoutMs: number;
  readonly maxAutomaticRetries: number;
  readonly fallbackApplicationBudgetTokens: number;
  readonly parametersJson: string;
  readonly checksum: string;
  readonly createdAt: string;
}

export interface CreateCompactionPolicyInput {
  readonly id: string;
  readonly policyVersion: string;
  readonly triggerRatio: number;
  readonly targetRatio: number;
  readonly minRecentMessages: number;
  readonly summaryMaxTokens: number;
  readonly timeoutMs: number;
  readonly maxAutomaticRetries: number;
  readonly fallbackApplicationBudgetTokens: number;
  readonly parametersJson: string;
  readonly checksum: string;
  readonly createdAt: string;
}

export interface CompactionTaskRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly status: CompactionStatus;
  readonly policyId: string;
  readonly sourceStartMessageId: string | null;
  readonly sourceEndMessageId: string | null;
  readonly sourceMessageCount: number;
  readonly sourceHash: string;
  readonly priorSummaryId: string | null;
  readonly summary: string | null;
  readonly summaryHash: string | null;
  readonly summaryTokenEstimate: number | null;
  readonly budgetJson: string;
  readonly providerConfigId: string | null;
  readonly providerType: string | null;
  readonly adapterId: string | null;
  readonly adapterVersion: string | null;
  readonly model: string | null;
  readonly estimatorVersion: string;
  readonly attempts: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly candidateId: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
  readonly version: number;
}

export interface CreateCompactionTaskInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly policyId: string;
  readonly sourceStartMessageId: string | null;
  readonly sourceEndMessageId: string | null;
  readonly sourceMessageCount: number;
  readonly sourceHash: string;
  readonly priorSummaryId: string | null;
  readonly budgetJson: string;
  readonly providerConfigId: string | null;
  readonly providerType: string | null;
  readonly adapterId: string | null;
  readonly adapterVersion: string | null;
  readonly model: string | null;
  readonly estimatorVersion: string;
  readonly createdAt: string;
}

export class CompactionRepositoryError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'NOT_FOUND' | 'CONFLICT' | 'IMMUTABLE') {
    super('COMPACTION_' + code);
    this.name = 'CompactionRepositoryError';
  }
}

const HASH = /^[a-f0-9]{64}$/;

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertTransaction(db: TransactionDatabase): void {
  if (!isTransactionActive(db)) throw new CompactionRepositoryError('INPUT_INVALID');
}

const POLICY_COLUMNS = `id, policy_version AS policyVersion, trigger_ratio AS triggerRatio,
  target_ratio AS targetRatio, min_recent_messages AS minRecentMessages,
  summary_max_tokens AS summaryMaxTokens, timeout_ms AS timeoutMs,
  max_automatic_retries AS maxAutomaticRetries,
  fallback_application_budget_tokens AS fallbackApplicationBudgetTokens,
  parameters_json AS parametersJson, checksum, created_at AS createdAt`;

const TASK_COLUMNS = `id, workspace_id AS workspaceId, conversation_id AS conversationId, status,
  policy_id AS policyId, source_start_message_id AS sourceStartMessageId,
  source_end_message_id AS sourceEndMessageId, source_message_count AS sourceMessageCount,
  source_hash AS sourceHash, prior_summary_id AS priorSummaryId, summary, summary_hash AS summaryHash,
  summary_token_estimate AS summaryTokenEstimate, budget_json AS budgetJson,
  provider_config_id AS providerConfigId, provider_type AS providerType, adapter_id AS adapterId,
  adapter_version AS adapterVersion, model, estimator_version AS estimatorVersion, attempts,
  lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt, candidate_id AS candidateId,
  failure_code AS failureCode, failure_message AS failureMessage, created_at AS createdAt,
  updated_at AS updatedAt, published_at AS publishedAt, version`;

export class CompactionPolicyRepository {
  constructor(private readonly db: TransactionDatabase) {}

  createWithinTransaction(input: CreateCompactionPolicyInput): CompactionPolicyRecord {
    assertTransaction(this.db);
    if (!nonBlank(input.id) || !nonBlank(input.policyVersion) || !nonBlank(input.parametersJson)
      || !HASH.test(input.checksum) || !isCanonicalUtcTimestamp(input.createdAt)
      || !(input.triggerRatio > 0 && input.triggerRatio < 1)
      || !(input.targetRatio > 0 && input.targetRatio < 1)
      || !Number.isSafeInteger(input.minRecentMessages) || input.minRecentMessages < 1
      || !Number.isSafeInteger(input.summaryMaxTokens) || input.summaryMaxTokens < 1
      || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1
      || !Number.isSafeInteger(input.maxAutomaticRetries) || input.maxAutomaticRetries < 0
      || !Number.isSafeInteger(input.fallbackApplicationBudgetTokens) || input.fallbackApplicationBudgetTokens < 1) {
      throw new CompactionRepositoryError('INPUT_INVALID');
    }
    try {
      this.db.prepare(`INSERT INTO conversation_compaction_policies (
        id, policy_version, trigger_ratio, target_ratio, min_recent_messages, summary_max_tokens,
        timeout_ms, max_automatic_retries, fallback_application_budget_tokens, parameters_json,
        checksum, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.id, input.policyVersion, input.triggerRatio, input.targetRatio, input.minRecentMessages,
        input.summaryMaxTokens, input.timeoutMs, input.maxAutomaticRetries,
        input.fallbackApplicationBudgetTokens, input.parametersJson, input.checksum, input.createdAt,
      );
    } catch (error) {
      if (/UNIQUE/.test(String(error))) throw new CompactionRepositoryError('CONFLICT');
      throw error;
    }
    return this.findByVersion(input.policyVersion)!;
  }

  findByVersion(policyVersion: string): CompactionPolicyRecord | undefined {
    return this.db.prepare(`SELECT ${POLICY_COLUMNS} FROM conversation_compaction_policies WHERE policy_version = ?`)
      .get(policyVersion) as CompactionPolicyRecord | undefined;
  }

  findById(id: string): CompactionPolicyRecord | undefined {
    return this.db.prepare(`SELECT ${POLICY_COLUMNS} FROM conversation_compaction_policies WHERE id = ?`)
      .get(id) as CompactionPolicyRecord | undefined;
  }
}

export class CompactionRepository {
  constructor(private readonly db: TransactionDatabase) {}

  createTaskWithinTransaction(input: CreateCompactionTaskInput): CompactionTaskRecord {
    assertTransaction(this.db);
    if (!nonBlank(input.id) || !nonBlank(input.workspaceId) || !nonBlank(input.conversationId)
      || !nonBlank(input.policyId) || !HASH.test(input.sourceHash)
      || !Number.isSafeInteger(input.sourceMessageCount) || input.sourceMessageCount < 0
      || !nonBlank(input.budgetJson) || !nonBlank(input.estimatorVersion)
      || !isCanonicalUtcTimestamp(input.createdAt)) {
      throw new CompactionRepositoryError('INPUT_INVALID');
    }
    try {
      JSON.parse(input.budgetJson);
    } catch {
      throw new CompactionRepositoryError('INPUT_INVALID');
    }
    try {
      this.db.prepare(`INSERT INTO conversation_compactions (
        id, workspace_id, conversation_id, status, policy_id, source_start_message_id,
        source_end_message_id, source_message_count, source_hash, prior_summary_id, budget_json,
        provider_config_id, provider_type, adapter_id, adapter_version, model, estimator_version,
        attempts, created_at, updated_at, version
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1)`).run(
        input.id, input.workspaceId, input.conversationId, input.policyId, input.sourceStartMessageId,
        input.sourceEndMessageId, input.sourceMessageCount, input.sourceHash, input.priorSummaryId,
        input.budgetJson, input.providerConfigId, input.providerType, input.adapterId,
        input.adapterVersion, input.model, input.estimatorVersion, input.createdAt, input.createdAt,
      );
    } catch (error) {
      if (/UNIQUE/.test(String(error))) throw new CompactionRepositoryError('CONFLICT');
      throw error;
    }
    return this.requireById(input.workspaceId, input.id);
  }

  findById(workspaceId: string, id: string): CompactionTaskRecord | undefined {
    return this.db.prepare(`SELECT ${TASK_COLUMNS} FROM conversation_compactions WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, id) as CompactionTaskRecord | undefined;
  }

  listForConversation(workspaceId: string, conversationId: string): CompactionTaskRecord[] {
    return this.db.prepare(`SELECT ${TASK_COLUMNS} FROM conversation_compactions
      WHERE workspace_id = ? AND conversation_id = ? ORDER BY created_at ASC, id ASC`)
      .all(workspaceId, conversationId) as unknown as CompactionTaskRecord[];
  }

  findLatestPublished(workspaceId: string, conversationId: string): CompactionTaskRecord | undefined {
    return this.db.prepare(`SELECT ${TASK_COLUMNS} FROM conversation_compactions
      WHERE workspace_id = ? AND conversation_id = ? AND status = 'published'
      ORDER BY published_at DESC, id DESC LIMIT 1`).get(workspaceId, conversationId) as CompactionTaskRecord | undefined;
  }

  findActive(workspaceId: string, conversationId: string): CompactionTaskRecord | undefined {
    return this.db.prepare(`SELECT ${TASK_COLUMNS} FROM conversation_compactions
      WHERE workspace_id = ? AND conversation_id = ? AND status IN ('pending','running','retry-pending')
      ORDER BY created_at ASC, id ASC LIMIT 1`).get(workspaceId, conversationId) as CompactionTaskRecord | undefined;
  }

  /** pending -> running under a version CAS with a durable lease. */
  claimRunningWithinTransaction(input: {
    workspaceId: string; id: string; expectedVersion: number; leaseOwner: string;
    leaseExpiresAt: string; now: string; attempt?: number;
  }): CompactionTaskRecord {
    assertTransaction(this.db);
    if (!nonBlank(input.leaseOwner) || !isCanonicalUtcTimestamp(input.now) || !isCanonicalUtcTimestamp(input.leaseExpiresAt)) {
      throw new CompactionRepositoryError('INPUT_INVALID');
    }
    let changed: { changes?: number | bigint };
    try {
      changed = this.db.prepare(`UPDATE conversation_compactions
        SET status = 'running', lease_owner = ?, lease_expires_at = ?, attempts = ?, updated_at = ?, version = version + 1
        WHERE workspace_id = ? AND id = ? AND version = ? AND status IN ('pending','retry-pending')`).run(
        input.leaseOwner, input.leaseExpiresAt, input.attempt ?? 1, input.now,
        input.workspaceId, input.id, input.expectedVersion,
      ) as { changes?: number | bigint };
    } catch (error) {
      // The one-running-per-conversation partial unique index is the durable
      // single-holder fence; a losing claim converges on the same conflict.
      if (/UNIQUE/.test(String(error))) throw new CompactionRepositoryError('CONFLICT');
      throw error;
    }
    if (Number(changed.changes ?? 0) !== 1) throw new CompactionRepositoryError('CONFLICT');
    return this.requireById(input.workspaceId, input.id);
  }

  /** running -> published with the bounded immutable summary and its Candidate. */
  publishWithinTransaction(input: {
    workspaceId: string; id: string; expectedVersion: number; leaseOwner: string;
    summary: string; summaryHash: string; summaryTokenEstimate: number;
    candidateId: string; publishedAt: string;
  }): CompactionTaskRecord {
    assertTransaction(this.db);
    if (!nonBlank(input.summary) || !HASH.test(input.summaryHash)
      || !Number.isSafeInteger(input.summaryTokenEstimate) || input.summaryTokenEstimate < 1
      || !nonBlank(input.candidateId) || !isCanonicalUtcTimestamp(input.publishedAt)) {
      throw new CompactionRepositoryError('INPUT_INVALID');
    }
    const changed = this.db.prepare(`UPDATE conversation_compactions
      SET status = 'published', summary = ?, summary_hash = ?, summary_token_estimate = ?,
        candidate_id = ?, published_at = ?, lease_owner = NULL, lease_expires_at = NULL,
        updated_at = ?, version = version + 1
      WHERE workspace_id = ? AND id = ? AND version = ? AND status = 'running' AND lease_owner = ?`).run(
      input.summary, input.summaryHash, input.summaryTokenEstimate, input.candidateId, input.publishedAt,
      input.publishedAt, input.workspaceId, input.id, input.expectedVersion, input.leaseOwner,
    ) as { changes?: number | bigint };
    if (Number(changed.changes ?? 0) !== 1) throw new CompactionRepositoryError('CONFLICT');
    return this.requireById(input.workspaceId, input.id);
  }

  /** running -> failed with a stable code; the lease is released. */
  failWithinTransaction(input: {
    workspaceId: string; id: string; expectedVersion: number; failureCode: string;
    failureMessage: string; now: string;
  }): CompactionTaskRecord {
    assertTransaction(this.db);
    if (!nonBlank(input.failureCode) || !nonBlank(input.failureMessage) || !isCanonicalUtcTimestamp(input.now)) {
      throw new CompactionRepositoryError('INPUT_INVALID');
    }
    const changed = this.db.prepare(`UPDATE conversation_compactions
      SET status = 'failed', failure_code = ?, failure_message = ?, lease_owner = NULL,
        lease_expires_at = NULL, updated_at = ?, version = version + 1
      WHERE workspace_id = ? AND id = ? AND version = ? AND status = 'running'`).run(
      input.failureCode, input.failureMessage, input.now, input.workspaceId, input.id, input.expectedVersion,
    ) as { changes?: number | bigint };
    if (Number(changed.changes ?? 0) !== 1) throw new CompactionRepositoryError('CONFLICT');
    return this.requireById(input.workspaceId, input.id);
  }

  /** running -> retry-pending while the retry budget lasts. */
  retryPendingWithinTransaction(input: {
    workspaceId: string; id: string; expectedVersion: number; failureCode: string;
    failureMessage: string; now: string;
  }): CompactionTaskRecord {
    assertTransaction(this.db);
    if (!nonBlank(input.failureCode) || !nonBlank(input.failureMessage) || !isCanonicalUtcTimestamp(input.now)) {
      throw new CompactionRepositoryError('INPUT_INVALID');
    }
    const changed = this.db.prepare(`UPDATE conversation_compactions
      SET status = 'retry-pending', failure_code = ?, failure_message = ?, lease_owner = NULL,
        lease_expires_at = NULL, updated_at = ?, version = version + 1
      WHERE workspace_id = ? AND id = ? AND version = ? AND status = 'running'`).run(
      input.failureCode, input.failureMessage, input.now, input.workspaceId, input.id, input.expectedVersion,
    ) as { changes?: number | bigint };
    if (Number(changed.changes ?? 0) !== 1) throw new CompactionRepositoryError('CONFLICT');
    return this.requireById(input.workspaceId, input.id);
  }

  private requireById(workspaceId: string, id: string): CompactionTaskRecord {
    const found = this.findById(workspaceId, id);
    if (!found) throw new CompactionRepositoryError('NOT_FOUND');
    return found;
  }
}
