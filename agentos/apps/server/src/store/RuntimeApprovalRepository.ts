import { isTransactionActive, type TransactionDatabase } from './Transaction.js';
import { isCanonicalUtcTimestamp } from './CanonicalTimestamp.js';
import { conversationIdsForRun } from './ConversationRunResolver.js';
import { ConversationEventRepository } from './ConversationEventRepository.js';
import {
  ConversationNotificationService,
  DEFAULT_CONVERSATION_NOTIFICATION_USER_ID,
} from '../services/ConversationNotificationService.js';

export type RuntimeApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';
export type RuntimeApprovalResolution = 'approve_once' | 'approve_run' | 'approve_workspace' | 'reject' | 'cancel_run';

export interface RuntimeApprovalRequestRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly conversationId: string | null;
  readonly runSnapshotId: string;
  readonly stageId: string | null;
  readonly stageAttempt: number;
  readonly operationId: string;
  readonly sourceKey: string;
  readonly requestRound: number;
  readonly category: string;
  readonly riskLevel: 'low' | 'medium' | 'high' | 'critical';
  readonly title: string;
  readonly description: string;
  readonly actionFingerprint: string;
  readonly agentSnapshotHash: string;
  readonly providerSnapshotHash: string;
  readonly launchPlanHash: string;
  readonly requestSnapshotJson: string;
  readonly snapshotHash: string;
  readonly policyVersion: string;
  readonly status: RuntimeApprovalStatus;
  readonly resolution: RuntimeApprovalResolution | null;
  readonly decisionRecordId: string | null;
  readonly approvalRequiredEventId: string | null;
  readonly approvalResolvedEventId: string | null;
  readonly candidateId: string | null;
  readonly candidateEventId: string | null;
  readonly decidedBy: string | null;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly consumedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export class RuntimeApprovalRepositoryError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'NOT_FOUND' | 'CONFLICT' | 'SOURCE_INVALID') {
    super('RUNTIME_APPROVAL_' + code);
    this.name = 'RuntimeApprovalRepositoryError';
  }
}

type CreateRuntimeApprovalInput = Omit<RuntimeApprovalRequestRecord,
  'conversationId' | 'status' | 'resolution' | 'decisionRecordId' | 'approvalRequiredEventId' | 'approvalResolvedEventId'
  | 'candidateId' | 'candidateEventId' | 'decidedBy' | 'decidedAt' | 'consumedAt' | 'version'>;

const HASH = /^[a-f0-9]{64}$/;
const CATEGORIES = new Set(['command', 'file-delete', 'git-push', 'network', 'package-install', 'secret-access', 'merge', 'custom']);
const RISKS = new Set(['low', 'medium', 'high', 'critical']);
const RESOLUTIONS = new Set(['approve_once', 'approve_run', 'approve_workspace', 'reject', 'cancel_run']);

export class RuntimeApprovalRepository {
  private conversationIdColumnAvailable: boolean | undefined;
  private readonly notifications: ConversationNotificationService;

  constructor(private readonly db: TransactionDatabase) {
    this.notifications = new ConversationNotificationService(db);
  }

  createWithinTransaction(input: CreateRuntimeApprovalInput): RuntimeApprovalRequestRecord {
    this.assertTransaction();
    this.assertIdentity(input);
    const conversationIds = conversationIdsForRun(this.db, input.workspaceId, input.runId);
    const conversationId = conversationIds[0] ?? null;
    try {
      if (this.hasConversationIdColumn()) {
        this.db.prepare(`INSERT INTO runtime_approval_requests (
          id, workspace_id, run_id, conversation_id, run_snapshot_id, stage_id, stage_attempt, operation_id, source_key, request_round,
          category, risk_level, title, description, action_fingerprint, agent_snapshot_hash, provider_snapshot_hash,
          launch_plan_hash, request_snapshot_json, snapshot_hash,
          policy_version, status, requested_at, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`).run(
          input.id, input.workspaceId, input.runId, conversationId, input.runSnapshotId, input.stageId, input.stageAttempt, input.operationId,
          input.sourceKey, input.requestRound, input.category, input.riskLevel, input.title, input.description,
          input.actionFingerprint, input.agentSnapshotHash, input.providerSnapshotHash, input.launchPlanHash,
          input.requestSnapshotJson, input.snapshotHash, input.policyVersion,
          input.requestedAt, input.expiresAt, input.createdAt, input.updatedAt,
        );
      } else {
        this.db.prepare(`INSERT INTO runtime_approval_requests (
          id, workspace_id, run_id, run_snapshot_id, stage_id, stage_attempt, operation_id, source_key, request_round,
          category, risk_level, title, description, action_fingerprint, agent_snapshot_hash, provider_snapshot_hash,
          launch_plan_hash, request_snapshot_json, snapshot_hash,
          policy_version, status, requested_at, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`).run(
          input.id, input.workspaceId, input.runId, input.runSnapshotId, input.stageId, input.stageAttempt, input.operationId,
          input.sourceKey, input.requestRound, input.category, input.riskLevel, input.title, input.description,
          input.actionFingerprint, input.agentSnapshotHash, input.providerSnapshotHash, input.launchPlanHash,
          input.requestSnapshotJson, input.snapshotHash, input.policyVersion,
          input.requestedAt, input.expiresAt, input.createdAt, input.updatedAt,
        );
      }
    } catch (error) {
      if (/UNIQUE/.test(String(error))) throw new RuntimeApprovalRepositoryError('CONFLICT');
      if (/RUNTIME_APPROVAL_SOURCE_INVALID/.test(String(error))) throw new RuntimeApprovalRepositoryError('SOURCE_INVALID');
      throw error;
    }
    const created = this.requireById(input.workspaceId, input.id);
    for (const conversationId of conversationIds) {
      this.notifications.notify({
        workspaceId: input.workspaceId,
        userId: DEFAULT_CONVERSATION_NOTIFICATION_USER_ID,
        conversationId,
        type: 'approval',
        source: { kind: 'approval', requestId: input.id },
        payload: { approvalRequestId: input.id },
      });
    }
    this.publishReadStateChange(created);
    return created;
  }

  findById(workspaceId: string, id: string): RuntimeApprovalRequestRecord | undefined {
    return this.db.prepare(`SELECT ${this.columns()} FROM runtime_approval_requests WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, id) as RuntimeApprovalRequestRecord | undefined;
  }

  findLatestBySourceKey(workspaceId: string, sourceKey: string): RuntimeApprovalRequestRecord | undefined {
    return this.db.prepare(`SELECT ${this.columns()} FROM runtime_approval_requests
      WHERE workspace_id = ? AND source_key = ? ORDER BY request_round DESC, requested_at DESC LIMIT 1`)
      .get(workspaceId, sourceKey) as RuntimeApprovalRequestRecord | undefined;
  }

  listForWorkspace(workspaceId: string): RuntimeApprovalRequestRecord[] {
    return this.db.prepare(`SELECT ${this.columns()} FROM runtime_approval_requests WHERE workspace_id = ?
      ORDER BY requested_at, id`).all(workspaceId) as unknown as RuntimeApprovalRequestRecord[];
  }

  listApprovedUnconsumed(): RuntimeApprovalRequestRecord[] {
    return this.db.prepare(`SELECT ${this.columns()} FROM runtime_approval_requests
      WHERE status = 'approved' AND consumed_at IS NULL ORDER BY decided_at, id`).all() as unknown as RuntimeApprovalRequestRecord[];
  }

  linkRequiredEventWithinTransaction(input: { workspaceId: string; id: string; expectedVersion: number; eventId: string; now: string }): RuntimeApprovalRequestRecord {
    this.assertDecisionInput(input);
    const changed = this.db.prepare(`UPDATE runtime_approval_requests SET approval_required_event_id = ?, updated_at = ?, version = version + 1
      WHERE workspace_id = ? AND id = ? AND version = ? AND approval_required_event_id IS NULL AND status = 'pending'`)
      .run(input.eventId, input.now, input.workspaceId, input.id, input.expectedVersion) as { changes?: number | bigint };
    if (Number(changed.changes ?? 0) !== 1) throw new RuntimeApprovalRepositoryError('CONFLICT');
    return this.requireById(input.workspaceId, input.id);
  }

  linkResolutionEvidenceWithinTransaction(input: {
    workspaceId: string; id: string; expectedVersion: number; now: string;
    approvalResolvedEventId: string; candidateId?: string; candidateEventId?: string;
  }): RuntimeApprovalRequestRecord {
    this.assertDecisionInput(input);
    const current = this.requireById(input.workspaceId, input.id);
    if (current.version !== input.expectedVersion || current.status === 'pending') throw new RuntimeApprovalRepositoryError('CONFLICT');
    const changed = this.db.prepare(`UPDATE runtime_approval_requests SET
      approval_resolved_event_id = ?, candidate_id = ?, candidate_event_id = ?, updated_at = ?, version = version + 1
      WHERE workspace_id = ? AND id = ? AND version = ? AND approval_resolved_event_id IS NULL`).run(
      input.approvalResolvedEventId, input.candidateId ?? null, input.candidateEventId ?? null,
      input.now, input.workspaceId, input.id, input.expectedVersion,
    ) as { changes?: number | bigint };
    if (Number(changed.changes ?? 0) !== 1) throw new RuntimeApprovalRepositoryError('CONFLICT');
    return this.requireById(input.workspaceId, input.id);
  }

  markExpiredWithinTransaction(input: { workspaceId: string; id: string; expectedVersion: number; now: string }): RuntimeApprovalRequestRecord {
    this.assertDecisionInput(input);
    const current = this.requireById(input.workspaceId, input.id);
    if (current.status !== 'pending' || current.version !== input.expectedVersion || current.expiresAt > input.now) {
      throw new RuntimeApprovalRepositoryError('CONFLICT');
    }
    this.updateDecision(input, { status: 'expired', resolution: null, decisionRecordId: null, decidedBy: null, decidedAt: input.now });
    return this.requireById(input.workspaceId, input.id);
  }

  markDecisionWithinTransaction(input: {
    workspaceId: string; id: string; expectedVersion: number; now: string;
    status: 'approved' | 'rejected' | 'cancelled'; resolution: RuntimeApprovalResolution;
    decisionRecordId: string; decidedBy: string; decidedAt: string;
  }): RuntimeApprovalRequestRecord {
    this.assertDecisionInput(input);
    const current = this.requireById(input.workspaceId, input.id);
    if (current.status !== 'pending' || current.version !== input.expectedVersion || current.expiresAt <= input.now) {
      throw new RuntimeApprovalRepositoryError('CONFLICT');
    }
    this.updateDecision(input, {
      status: input.status, resolution: input.resolution, decisionRecordId: input.decisionRecordId,
      decidedBy: input.decidedBy, decidedAt: input.decidedAt,
    });
    return this.requireById(input.workspaceId, input.id);
  }

  markConsumedWithinTransaction(input: { workspaceId: string; id: string; expectedVersion: number; consumedAt: string }): RuntimeApprovalRequestRecord {
    this.assertDecisionInput({ ...input, now: input.consumedAt });
    const current = this.requireById(input.workspaceId, input.id);
    if (current.status !== 'approved' || current.consumedAt !== null || current.version !== input.expectedVersion) {
      throw new RuntimeApprovalRepositoryError('CONFLICT');
    }
    const changed = this.db.prepare(`UPDATE runtime_approval_requests SET consumed_at = ?, updated_at = ?, version = version + 1
      WHERE workspace_id = ? AND id = ? AND version = ? AND status = 'approved' AND consumed_at IS NULL`)
      .run(input.consumedAt, input.consumedAt, input.workspaceId, input.id, input.expectedVersion) as { changes?: number | bigint };
    if (Number(changed.changes ?? 0) !== 1) throw new RuntimeApprovalRepositoryError('CONFLICT');
    return this.requireById(input.workspaceId, input.id);
  }

  private updateDecision(
    input: { workspaceId: string; id: string; expectedVersion: number; now: string },
    decision: { status: RuntimeApprovalStatus; resolution: RuntimeApprovalResolution | null; decisionRecordId: string | null; decidedBy: string | null; decidedAt: string },
  ): void {
    const changed = this.db.prepare(`UPDATE runtime_approval_requests SET
      status = ?, resolution = ?, decision_record_id = ?, decided_by = ?, decided_at = ?, updated_at = ?, version = version + 1
      WHERE workspace_id = ? AND id = ? AND version = ? AND status = 'pending'`).run(
      decision.status, decision.resolution, decision.decisionRecordId, decision.decidedBy, decision.decidedAt,
      input.now, input.workspaceId, input.id, input.expectedVersion,
    ) as { changes?: number | bigint };
    if (Number(changed.changes ?? 0) !== 1) throw new RuntimeApprovalRepositoryError('CONFLICT');
    this.publishReadStateChange(this.requireById(input.workspaceId, input.id));
  }

  private publishReadStateChange(approval: RuntimeApprovalRequestRecord): void {
    const conversationIds = new Set(conversationIdsForRun(this.db, approval.workspaceId, approval.runId));
    if (approval.conversationId !== null) conversationIds.add(approval.conversationId);
    for (const conversationId of conversationIds) new ConversationEventRepository(this.db).appendWithinTransaction({
      workspaceId: approval.workspaceId, conversationId, userId: DEFAULT_CONVERSATION_NOTIFICATION_USER_ID,
      type: 'conversation.read_state_updated', dedupeKey: `approval-count:${approval.id}:${approval.version}`,
      timestamp: approval.updatedAt,
      payload: { conversationId, approvalRequestId: approval.id, approvalCountChanged: true },
    });
  }

  private columns(): string {
    const conversationId = this.hasConversationIdColumn()
      ? 'conversation_id AS conversationId'
      : 'NULL AS conversationId';
    return conversationId + ', ' + COLUMNS;
  }

  private hasConversationIdColumn(): boolean {
    if (this.conversationIdColumnAvailable === undefined) {
      const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_approval_requests'").get();
      const columns = table === undefined ? [] : this.db.prepare('PRAGMA table_info(runtime_approval_requests)').all() as Array<{ name: string }>;
      this.conversationIdColumnAvailable = columns.some(column => column.name === 'conversation_id');
    }
    return this.conversationIdColumnAvailable;
  }

  private requireById(workspaceId: string, id: string): RuntimeApprovalRequestRecord {
    const found = this.findById(workspaceId, id);
    if (!found) throw new RuntimeApprovalRepositoryError('NOT_FOUND');
    return found;
  }

  private assertTransaction(): void {
    if (!isTransactionActive(this.db)) throw new RuntimeApprovalRepositoryError('INPUT_INVALID');
  }

  private assertDecisionInput(input: { workspaceId: string; id: string; expectedVersion: number; now: string }): void {
    this.assertTransaction();
    if (!input.workspaceId.trim() || !input.id.trim() || !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1 || !isCanonicalUtcTimestamp(input.now)) {
      throw new RuntimeApprovalRepositoryError('INPUT_INVALID');
    }
  }

  private assertIdentity(input: CreateRuntimeApprovalInput): void {
    const strings = [input.id, input.workspaceId, input.runId, input.operationId, input.sourceKey,
      input.title, input.description, input.policyVersion];
    if (strings.some(value => typeof value !== 'string' || value.trim().length === 0) ||
      (input.stageId !== null && input.stageId.trim().length === 0) ||
      !Number.isSafeInteger(input.stageAttempt) || input.stageAttempt < 1 ||
      !Number.isSafeInteger(input.requestRound) || input.requestRound < 1 ||
      !CATEGORIES.has(input.category) || !RISKS.has(input.riskLevel) ||
      input.title.length > 200 || input.description.length > 2000 || input.sourceKey.length > 256 ||
      !HASH.test(input.actionFingerprint) || !HASH.test(input.agentSnapshotHash) ||
      !HASH.test(input.providerSnapshotHash) || !HASH.test(input.launchPlanHash) || !HASH.test(input.snapshotHash) ||
      Buffer.byteLength(input.requestSnapshotJson, 'utf8') > 16384 ||
      ![input.requestedAt, input.expiresAt, input.createdAt, input.updatedAt].every(isCanonicalUtcTimestamp) ||
      input.expiresAt <= input.requestedAt) {
      throw new RuntimeApprovalRepositoryError('INPUT_INVALID');
    }
    try {
      const parsed = JSON.parse(input.requestSnapshotJson) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not object');
    } catch {
      throw new RuntimeApprovalRepositoryError('INPUT_INVALID');
    }
  }
}

const COLUMNS = `id, workspace_id AS workspaceId, run_id AS runId, run_snapshot_id AS runSnapshotId, stage_id AS stageId,
  stage_attempt AS stageAttempt, operation_id AS operationId, source_key AS sourceKey,
  request_round AS requestRound, category, risk_level AS riskLevel, title, description,
  action_fingerprint AS actionFingerprint, request_snapshot_json AS requestSnapshotJson,
  agent_snapshot_hash AS agentSnapshotHash, provider_snapshot_hash AS providerSnapshotHash,
  launch_plan_hash AS launchPlanHash, snapshot_hash AS snapshotHash, policy_version AS policyVersion, status, resolution,
  decision_record_id AS decisionRecordId, approval_required_event_id AS approvalRequiredEventId,
  approval_resolved_event_id AS approvalResolvedEventId, candidate_id AS candidateId,
  candidate_event_id AS candidateEventId, decided_by AS decidedBy, requested_at AS requestedAt,
  expires_at AS expiresAt, decided_at AS decidedAt, consumed_at AS consumedAt,
  created_at AS createdAt, updated_at AS updatedAt, version`;
