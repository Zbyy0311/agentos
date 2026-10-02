import type {
  CollaborationCandidate,
  CollaborationCandidateStatus,
  CollaborationReview,
  CollaborationReviewConclusion,
  CollaborationStatus,
  CollaborationTask,
  CollaborationTestStatus,
} from '@agentos/shared';
import type { TransactionDatabase } from './Transaction.js';
import { createEntityId } from './Identity.js';
import { collaborationCandidateContentHash } from '../services/CollaborationCandidateContentHash.js';

export class CollaborationRepositoryError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID' | 'STATE') {
    super(`COLLABORATION_${code}`);
    this.name = 'CollaborationRepositoryError';
  }
}

interface CollaborationTaskRow {
  id: string; workspace_id: string; conversation_id: string | null; source_message_id: string | null;
  title: string; objective: string; scope_json: string; acceptance_commands_json: string;
  planner_agent_id: string; implementer_agent_id: string; reviewer_agent_id: string;
  status: CollaborationStatus; version: number; plan_hash: string; base_commit: string;
  max_rework_rounds: number; rework_round: number; canonical_task_id: string | null;
  canonical_run_id: string | null; current_candidate_id: string | null; confirmed_at: string | null;
  applied_at: string | null; cancelled_at: string | null; failure_reason: string | null;
  confirm_idempotency_key: string | null; apply_idempotency_key: string | null;
  created_at: string; updated_at: string;
  control_epoch: number; scope_policy_version: number | null;
}

interface CandidateRow {
  id: string; collaboration_task_id: string; workspace_id: string; canonical_run_id: string;
  round: number; base_commit: string; head_commit: string; diff_hash: string; diff_text: string;
  snapshot_version: number; manifest_version: number;
  manifest_json: string; content_hash: string; test_status: CollaborationTestStatus; test_command: string | null;
  test_exit_code: number | null; test_output: string | null; status: CollaborationCandidateStatus;
  review_conclusion: CollaborationReviewConclusion | null; review_summary: string | null;
  review_agent_id: string | null; review_artifact_id: string | null; diff_artifact_id: string | null;
  manifest_artifact_id: string | null; version: number; created_at: string; updated_at: string;
}

interface ReviewRow {
  id: string; collaboration_task_id: string; candidate_id: string; workspace_id: string;
  canonical_run_id: string; stage_id: string; stage_attempt: number; reviewer_agent_id: string;
  candidate_diff_hash: string | null; conclusion: CollaborationReviewConclusion; summary: string; artifact_id: string | null; created_at: string;
}

interface StageOutputRow {
  workspace_id: string; collaboration_task_id: string; canonical_run_id: string; stage_id: string;
  stage_attempt: number; agent_id: string; role: string; output_status: 'available' | 'missing' | 'invalid';
  public_output: string | null; output_hash: string | null; missing_reason: string | null;
  review_candidate_id: string | null; review_candidate_hash: string | null;
  review_conclusion: CollaborationReviewConclusion | null; created_at: string;
}

export interface CollaborationStageOutput {
  workspaceId: string; collaborationTaskId: string; runId: string; stageId: string; stageAttempt: number;
  agentId: string; role: 'planner' | 'implementer' | 'reviewer' | 'other';
  status: 'available' | 'missing' | 'invalid'; publicOutput?: string; outputHash?: string; reason?: string; createdAt: string;
  reviewCandidateId?: string; reviewCandidateHash?: string; reviewConclusion?: CollaborationReviewConclusion;
}

function parseStringArray(raw: string): string[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new CollaborationRepositoryError('INVALID'); }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new CollaborationRepositoryError('INVALID');
  }
  return [...value];
}

function parseManifest(raw: string): CollaborationCandidate['manifest'] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new CollaborationRepositoryError('INVALID'); }
  if (!Array.isArray(value)) throw new CollaborationRepositoryError('INVALID');
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new CollaborationRepositoryError('INVALID');
    const row = item as Record<string, unknown>;
    if (typeof row.path !== 'string' || typeof row.sizeBytes !== 'number' || !Number.isSafeInteger(row.sizeBytes)
      || row.sizeBytes < 0 || (row.sha256 !== undefined && (typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256)))
      || (row.gitObjectId !== undefined && (typeof row.gitObjectId !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(row.gitObjectId)))
      || (row.sha256 === undefined && row.gitObjectId === undefined)
      || (row.baseSizeBytes !== undefined && (typeof row.baseSizeBytes !== 'number' || !Number.isSafeInteger(row.baseSizeBytes) || row.baseSizeBytes < 0))
      || (row.baseSha256 !== undefined && (typeof row.baseSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.baseSha256)))
      || (row.baseObjectId !== undefined && (typeof row.baseObjectId !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(row.baseObjectId)))
      || (row.binary !== undefined && typeof row.binary !== 'boolean')
      || (row.baseSizeBytes === undefined && (row.baseSha256 !== undefined || row.baseObjectId !== undefined))
      || (row.baseSizeBytes !== undefined && row.baseSha256 === undefined && row.baseObjectId === undefined)
      || (row.deleted !== undefined && typeof row.deleted !== 'boolean')) throw new CollaborationRepositoryError('INVALID');
    return {
      path: row.path, sizeBytes: row.sizeBytes,
      ...(row.sha256 === undefined ? {} : { sha256: row.sha256 as string }),
      ...(row.gitObjectId === undefined ? {} : { gitObjectId: row.gitObjectId as string }),
      ...(row.baseSizeBytes === undefined ? {} : { baseSizeBytes: row.baseSizeBytes as number }),
      ...(row.baseSha256 === undefined ? {} : { baseSha256: row.baseSha256 as string }),
      ...(row.baseObjectId === undefined ? {} : { baseObjectId: row.baseObjectId as string }),
      ...(row.binary === undefined ? {} : { binary: row.binary as boolean }),
      ...(row.deleted === undefined ? {} : { deleted: row.deleted as boolean }),
    };
  });
}

function mapTask(row: CollaborationTaskRow): CollaborationTask {
  return {
    id: row.id, workspaceId: row.workspace_id,
    ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
    ...(row.source_message_id === null ? {} : { sourceMessageId: row.source_message_id }),
    title: row.title, objective: row.objective, scope: parseStringArray(row.scope_json),
    acceptanceCommands: parseStringArray(row.acceptance_commands_json),
    plannerAgentId: row.planner_agent_id, implementerAgentId: row.implementer_agent_id,
    reviewerAgentId: row.reviewer_agent_id, status: row.status, version: row.version,
    planHash: row.plan_hash, baseCommit: row.base_commit, maxReworkRounds: row.max_rework_rounds,
    reworkRound: row.rework_round,
    ...(row.canonical_task_id === null ? {} : { canonicalTaskId: row.canonical_task_id }),
    ...(row.canonical_run_id === null ? {} : { canonicalRunId: row.canonical_run_id }),
    ...(row.current_candidate_id === null ? {} : { currentCandidateId: row.current_candidate_id }),
    ...(row.confirmed_at === null ? {} : { confirmedAt: row.confirmed_at }),
    ...(row.applied_at === null ? {} : { appliedAt: row.applied_at }),
    ...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at }),
    ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
    ...(row.confirm_idempotency_key === null ? {} : { confirmIdempotencyKey: row.confirm_idempotency_key }),
    ...(row.apply_idempotency_key === null ? {} : { applyIdempotencyKey: row.apply_idempotency_key }),
    createdAt: row.created_at, updatedAt: row.updated_at,
    controlEpoch: row.control_epoch,
    ...(row.scope_policy_version === null ? {} : { scopePolicyVersion: row.scope_policy_version }),
  };
}

function mapCandidate(row: CandidateRow): CollaborationCandidate {
  const manifest = parseManifest(row.manifest_json);
  if (row.manifest_version !== 1 && row.manifest_version !== 2) throw new CollaborationRepositoryError('INVALID');
  const contentHash = collaborationCandidateContentHash({
    diffHash: row.diff_hash, snapshotVersion: row.snapshot_version, manifestVersion: row.manifest_version, manifest,
  });
  if (row.content_hash !== '' && row.content_hash !== contentHash) throw new CollaborationRepositoryError('INVALID');
  return {
    id: row.id, collaborationTaskId: row.collaboration_task_id, workspaceId: row.workspace_id,
    canonicalRunId: row.canonical_run_id, round: row.round, baseCommit: row.base_commit,
    headCommit: row.head_commit, diffHash: row.diff_hash, contentHash, diffText: row.diff_text,
    snapshotVersion: row.snapshot_version,
    manifestVersion: row.manifest_version,
    manifest, testStatus: row.test_status,
    ...(row.test_command === null ? {} : { testCommand: row.test_command }),
    ...(row.test_exit_code === null ? {} : { testExitCode: row.test_exit_code }),
    ...(row.test_output === null ? {} : { testOutput: row.test_output }),
    status: row.status,
    ...(row.review_conclusion === null ? {} : { reviewConclusion: row.review_conclusion }),
    ...(row.review_summary === null ? {} : { reviewSummary: row.review_summary }),
    ...(row.review_agent_id === null ? {} : { reviewAgentId: row.review_agent_id }),
    ...(row.review_artifact_id === null ? {} : { reviewArtifactId: row.review_artifact_id }),
    ...(row.diff_artifact_id === null ? {} : { diffArtifactId: row.diff_artifact_id }),
    ...(row.manifest_artifact_id === null ? {} : { manifestArtifactId: row.manifest_artifact_id }),
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapReview(row: ReviewRow): CollaborationReview {
  return {
    id: row.id, collaborationTaskId: row.collaboration_task_id, candidateId: row.candidate_id,
    workspaceId: row.workspace_id, canonicalRunId: row.canonical_run_id, stageId: row.stage_id,
    stageAttempt: row.stage_attempt, reviewerAgentId: row.reviewer_agent_id,
    ...(row.candidate_diff_hash === null ? {} : { candidateDiffHash: row.candidate_diff_hash }),
    conclusion: row.conclusion, summary: row.summary,
    ...(row.artifact_id === null ? {} : { artifactId: row.artifact_id }), createdAt: row.created_at,
  };
}

function mapStageOutput(row: StageOutputRow): CollaborationStageOutput {
  return {
    workspaceId: row.workspace_id, collaborationTaskId: row.collaboration_task_id,
    runId: row.canonical_run_id, stageId: row.stage_id, stageAttempt: row.stage_attempt,
    agentId: row.agent_id, role: row.role as CollaborationStageOutput['role'], status: row.output_status,
    ...(row.public_output === null ? {} : { publicOutput: row.public_output }),
    ...(row.output_hash === null ? {} : { outputHash: row.output_hash }),
    ...(row.missing_reason === null ? {} : { reason: row.missing_reason }),
    ...(row.review_candidate_id === null ? {} : { reviewCandidateId: row.review_candidate_id }),
    ...(row.review_candidate_hash === null ? {} : { reviewCandidateHash: row.review_candidate_hash }),
    ...(row.review_conclusion === null ? {} : { reviewConclusion: row.review_conclusion }), createdAt: row.created_at,
  };
}

export interface CreateCollaborationTaskInput {
  workspaceId: string; conversationId?: string; sourceMessageId?: string; title: string; objective: string;
  scope: string[]; acceptanceCommands: string[]; plannerAgentId: string; implementerAgentId: string;
  reviewerAgentId: string; planHash: string; baseCommit: string; maxReworkRounds: number; createdAt: string;
  scopePolicyVersion?: number;
}

export interface ConfirmCollaborationTaskInput {
  workspaceId: string; id: string; expectedVersion: number; canonicalTaskId: string; canonicalRunId: string;
  confirmedAt: string; idempotencyKey?: string;
  controlId?: string;
}

export interface ProgressCollaborationTaskInput {
  workspaceId: string; id: string; expectedVersion: number; status: CollaborationStatus;
  canonicalRunId?: string; currentCandidateId?: string; reworkRound?: number; failureReason?: string;
  expectedRunId?: string; expectedControlEpoch?: number; controlId?: string;
}

export class CollaborationRepository {
  constructor(private readonly db: TransactionDatabase) {}

  create(input: CreateCollaborationTaskInput): CollaborationTask {
    const id = createEntityId('task').replace(/^task_/, 'collab_');
    this.db.prepare(`INSERT INTO collaboration_tasks (
      id, workspace_id, conversation_id, source_message_id, title, objective, scope_json,
      acceptance_commands_json, planner_agent_id, implementer_agent_id, reviewer_agent_id,
      status, version, plan_hash, base_commit, max_rework_rounds, rework_round,
      canonical_task_id, canonical_run_id, current_candidate_id, confirmed_at, applied_at,
      cancelled_at, failure_reason, confirm_idempotency_key, apply_idempotency_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_confirmation', 1, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`).run(
      id, input.workspaceId, input.conversationId ?? null, input.sourceMessageId ?? null, input.title,
      input.objective, JSON.stringify(input.scope), JSON.stringify(input.acceptanceCommands),
      input.plannerAgentId, input.implementerAgentId, input.reviewerAgentId, input.planHash, input.baseCommit,
      input.maxReworkRounds, input.createdAt, input.createdAt,
    );
    if (input.scopePolicyVersion !== undefined) this.db.prepare('UPDATE collaboration_tasks SET scope_policy_version = ? WHERE workspace_id = ? AND id = ?').run(input.scopePolicyVersion, input.workspaceId, id);
    return this.findById(input.workspaceId, id)!;
  }

  findById(workspaceId: string, id: string): CollaborationTask | undefined {
    const row = this.db.prepare('SELECT * FROM collaboration_tasks WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, id) as CollaborationTaskRow | undefined;
    return row ? mapTask(row) : undefined;
  }

  findByCanonicalRun(workspaceId: string, runId: string): CollaborationTask | undefined {
    const row = this.db.prepare('SELECT * FROM collaboration_tasks WHERE workspace_id = ? AND canonical_run_id = ?')
      .get(workspaceId, runId) as CollaborationTaskRow | undefined;
    return row ? mapTask(row) : undefined;
  }

  list(workspaceId: string, options: { conversationId?: string; limit?: number; offset?: number } = {}): CollaborationTask[] {
    const conditions = ['workspace_id = ?'];
    const parameters: unknown[] = [workspaceId];
    if (options.conversationId !== undefined) {
      conditions.push('conversation_id = ?');
      parameters.push(options.conversationId);
    }
    const limit = options.limit === undefined ? 100 : Math.max(1, Math.min(100, Math.floor(options.limit)));
    const offset = options.offset === undefined ? 0 : Math.max(0, Math.floor(options.offset));
    const rows = this.db.prepare(`SELECT * FROM collaboration_tasks WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`)
      .all(...parameters, limit, offset) as CollaborationTaskRow[];
    return rows.map(mapTask);
  }

  confirm(input: ConfirmCollaborationTaskInput): CollaborationTask {
    this.assertControlAccess(input.workspaceId, input.id, input.controlId);
    const result = this.db.prepare(`UPDATE collaboration_tasks SET status = 'queued', version = version + 1,
      canonical_task_id = ?, canonical_run_id = ?, confirmed_at = ?, confirm_idempotency_key = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND version = ? AND status = 'awaiting_confirmation'`).run(
      input.canonicalTaskId, input.canonicalRunId, input.confirmedAt, input.idempotencyKey ?? null,
      input.confirmedAt, input.workspaceId, input.id, input.expectedVersion,
    ) as { changes: number };
    if (result.changes !== 1) throw new CollaborationRepositoryError('CONFLICT');
    return this.findById(input.workspaceId, input.id)!;
  }

  progress(input: ProgressCollaborationTaskInput): CollaborationTask {
    this.assertControlAccess(input.workspaceId, input.id, input.controlId);
    const current = this.findById(input.workspaceId, input.id);
    const allowed: Readonly<Record<CollaborationStatus, readonly CollaborationStatus[]>> = {
      awaiting_confirmation: ['failed', 'blocked', 'cancelled'],
      queued: ['running', 'failed', 'blocked', 'cancelled'],
      running: ['running', 'reviewing', 'failed', 'blocked', 'cancelled'],
      reviewing: ['reviewing', 'awaiting_application', 'changes_requested', 'failed', 'blocked', 'cancelled'],
      changes_requested: ['running', 'queued', 'failed', 'blocked', 'cancelled'],
      awaiting_application: ['blocked'], applied: [], cancelled: [], failed: [], blocked: [],
    };
    if (!current || current.version !== input.expectedVersion || !allowed[current.status].includes(input.status)
      || (input.expectedRunId !== undefined && current.canonicalRunId !== input.expectedRunId)
      || (input.expectedControlEpoch !== undefined && current.controlEpoch !== input.expectedControlEpoch)) {
      throw new CollaborationRepositoryError('CONFLICT');
    }
    const result = this.db.prepare(`UPDATE collaboration_tasks SET status = ?, version = version + 1,
      canonical_run_id = COALESCE(?, canonical_run_id), current_candidate_id = COALESCE(?, current_candidate_id),
      rework_round = COALESCE(?, rework_round), failure_reason = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND version = ?`).run(
      input.status, input.canonicalRunId ?? null, input.currentCandidateId ?? null, input.reworkRound ?? null,
      input.failureReason ?? null, new Date().toISOString(), input.workspaceId, input.id, input.expectedVersion,
    ) as { changes: number };
    if (result.changes !== 1) throw new CollaborationRepositoryError('CONFLICT');
    return this.findById(input.workspaceId, input.id)!;
  }

  markApplied(workspaceId: string, id: string, expectedVersion: number, key: string | undefined, appliedAt: string, controlId?: string): CollaborationTask {
    this.assertControlAccess(workspaceId, id, controlId);
    const result = this.db.prepare(`UPDATE collaboration_tasks SET status = 'applied', version = version + 1,
      applied_at = ?, apply_idempotency_key = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND version = ? AND status = 'awaiting_application'`).run(
      appliedAt, key ?? null, appliedAt, workspaceId, id, expectedVersion,
    ) as { changes: number };
    if (result.changes !== 1) throw new CollaborationRepositoryError('CONFLICT');
    return this.findById(workspaceId, id)!;
  }

  cancel(workspaceId: string, id: string, expectedVersion: number, cancelledAt: string, controlId?: string): CollaborationTask {
    this.assertControlAccess(workspaceId, id, controlId);
    const result = this.db.prepare(`UPDATE collaboration_tasks SET status = 'cancelled', version = version + 1,
      cancelled_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ?
      AND status IN ('awaiting_confirmation','queued','running','reviewing','changes_requested')`).run(
      cancelledAt, cancelledAt, workspaceId, id, expectedVersion,
    ) as { changes: number };
    if (result.changes !== 1) throw new CollaborationRepositoryError('CONFLICT');
    return this.findById(workspaceId, id)!;
  }

  private assertControlAccess(workspaceId: string, id: string, controlId?: string): void {
    const active = this.db.prepare("SELECT id FROM collaboration_controls WHERE workspace_id = ? AND collaboration_task_id = ? AND state IN ('reserved','running','recovery_required')")
      .get(workspaceId, id) as { id: string } | undefined;
    if (active && active.id !== controlId) throw new CollaborationRepositoryError('CONFLICT');
  }

  createCandidate(input: Omit<CollaborationCandidate, 'version' | 'createdAt' | 'updatedAt' | 'reviewConclusion' | 'reviewSummary' | 'reviewAgentId' | 'reviewArtifactId'> & { createdAt: string }): CollaborationCandidate {
    const version = 1;
    const manifestVersion = input.manifestVersion ?? 2;
    if (manifestVersion !== 1 && manifestVersion !== 2) throw new CollaborationRepositoryError('INVALID');
    const contentHash = collaborationCandidateContentHash({
      diffHash: input.diffHash, snapshotVersion: input.snapshotVersion ?? 1, manifestVersion, manifest: input.manifest,
    });
    this.db.prepare(`INSERT INTO collaboration_candidates (
      id, collaboration_task_id, workspace_id, canonical_run_id, round, base_commit, head_commit,
      diff_hash, diff_text, snapshot_version, manifest_json, manifest_version, content_hash, test_status, test_command, test_exit_code, test_output,
      status, review_conclusion, review_summary, review_agent_id, review_artifact_id,
      diff_artifact_id, manifest_artifact_id, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`).run(
      input.id, input.collaborationTaskId, input.workspaceId, input.canonicalRunId, input.round,
      input.baseCommit, input.headCommit, input.diffHash, input.diffText, input.snapshotVersion ?? 1, JSON.stringify(input.manifest),
      manifestVersion, contentHash, input.testStatus, input.testCommand ?? null, input.testExitCode ?? null, input.testOutput ?? null,
      input.status, input.diffArtifactId ?? null, input.manifestArtifactId ?? null, version,
      input.createdAt, input.createdAt,
    );
    return this.findCandidate(input.workspaceId, input.id)!;
  }

  findCandidate(workspaceId: string, id: string): CollaborationCandidate | undefined {
    const row = this.db.prepare('SELECT * FROM collaboration_candidates WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, id) as CandidateRow | undefined;
    return row ? mapCandidate(row) : undefined;
  }

  listCandidates(workspaceId: string, collaborationTaskId: string): CollaborationCandidate[] {
    return (this.db.prepare(`SELECT * FROM collaboration_candidates WHERE workspace_id = ? AND collaboration_task_id = ? ORDER BY round ASC, id ASC`)
      .all(workspaceId, collaborationTaskId) as CandidateRow[]).map(mapCandidate);
  }

  findCandidateForRun(workspaceId: string, collaborationTaskId: string, runId: string): CollaborationCandidate | undefined {
    const row = this.db.prepare(`SELECT * FROM collaboration_candidates
      WHERE workspace_id = ? AND collaboration_task_id = ? AND canonical_run_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(workspaceId, collaborationTaskId, runId) as CandidateRow | undefined;
    return row ? mapCandidate(row) : undefined;
  }

  reviewCandidate(input: { workspaceId: string; candidateId: string; conclusion: CollaborationReviewConclusion; summary: string; reviewerAgentId: string; artifactId?: string }): CollaborationCandidate {
    const result = this.db.prepare(`UPDATE collaboration_candidates SET status = 'reviewed', version = version + 1,
      review_conclusion = ?, review_summary = ?, review_agent_id = ?, review_artifact_id = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND status = 'created'`).run(
      input.conclusion, input.summary, input.reviewerAgentId, input.artifactId ?? null,
      new Date().toISOString(), input.workspaceId, input.candidateId,
    ) as { changes: number };
    if (result.changes !== 1) throw new CollaborationRepositoryError('CONFLICT');
    return this.findCandidate(input.workspaceId, input.candidateId)!;
  }

  markCandidateApplied(workspaceId: string, candidateId: string): CollaborationCandidate {
    const result = this.db.prepare(`UPDATE collaboration_candidates SET status = 'applied', version = version + 1,
      updated_at = ? WHERE workspace_id = ? AND id = ? AND status = 'reviewed'`).run(
      new Date().toISOString(), workspaceId, candidateId,
    ) as { changes: number };
    if (result.changes !== 1) throw new CollaborationRepositoryError('CONFLICT');
    return this.findCandidate(workspaceId, candidateId)!;
  }

  createReview(input: Omit<CollaborationReview, 'createdAt'> & { createdAt: string }): CollaborationReview {
    this.db.prepare(`INSERT INTO collaboration_reviews (
      id, collaboration_task_id, candidate_id, workspace_id, canonical_run_id, stage_id, stage_attempt,
      reviewer_agent_id, candidate_diff_hash, conclusion, summary, artifact_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.collaborationTaskId, input.candidateId, input.workspaceId, input.canonicalRunId,
      input.stageId, input.stageAttempt, input.reviewerAgentId, input.candidateDiffHash ?? null, input.conclusion, input.summary,
      input.artifactId ?? null, input.createdAt,
    );
    return this.listReviews(input.workspaceId, input.collaborationTaskId).find(review => review.id === input.id)!;
  }

  listReviews(workspaceId: string, collaborationTaskId: string): CollaborationReview[] {
    return (this.db.prepare(`SELECT * FROM collaboration_reviews WHERE workspace_id = ? AND collaboration_task_id = ? ORDER BY created_at ASC, id ASC`)
      .all(workspaceId, collaborationTaskId) as ReviewRow[]).map(mapReview);
  }

  findReviewForCandidate(workspaceId: string, candidateId: string): CollaborationReview | undefined {
    const row = this.db.prepare('SELECT * FROM collaboration_reviews WHERE workspace_id = ? AND candidate_id = ?')
      .get(workspaceId, candidateId) as ReviewRow | undefined;
    return row ? mapReview(row) : undefined;
  }

  recordStageOutput(input: CollaborationStageOutput): CollaborationStageOutput {
    this.db.prepare(`INSERT INTO collaboration_stage_outputs (
      workspace_id, collaboration_task_id, canonical_run_id, stage_id, stage_attempt,
      agent_id, role, output_status, public_output, output_hash, missing_reason,
      review_candidate_id, review_candidate_hash, review_conclusion, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, canonical_run_id, stage_id, stage_attempt) DO UPDATE SET
      agent_id = excluded.agent_id, role = excluded.role, output_status = excluded.output_status,
      public_output = excluded.public_output, output_hash = excluded.output_hash,
      missing_reason = excluded.missing_reason, review_candidate_id = excluded.review_candidate_id,
      review_candidate_hash = excluded.review_candidate_hash, review_conclusion = excluded.review_conclusion,
      created_at = excluded.created_at
    WHERE collaboration_stage_outputs.collaboration_task_id = excluded.collaboration_task_id
      AND (collaboration_stage_outputs.output_hash IS NULL OR excluded.output_hash IS NULL
        OR collaboration_stage_outputs.output_hash = excluded.output_hash)`)
      .run(input.workspaceId, input.collaborationTaskId, input.runId, input.stageId, input.stageAttempt,
        input.agentId, input.role, input.status, input.publicOutput ?? null, input.outputHash ?? null,
        input.reason ?? null, input.reviewCandidateId ?? null, input.reviewCandidateHash ?? null,
        input.reviewConclusion ?? null, input.createdAt);
    const row = this.db.prepare(`SELECT * FROM collaboration_stage_outputs WHERE workspace_id = ?
      AND canonical_run_id = ? AND stage_id = ? AND stage_attempt = ?`)
      .get(input.workspaceId, input.runId, input.stageId, input.stageAttempt) as StageOutputRow | undefined;
    if (!row || row.collaboration_task_id !== input.collaborationTaskId || row.output_hash !== (input.outputHash ?? null)
      || row.review_candidate_hash !== (input.reviewCandidateHash ?? null)) throw new CollaborationRepositoryError('CONFLICT');
    return mapStageOutput(row);
  }

  findStageOutput(workspaceId: string, runId: string, stageId: string, stageAttempt: number): CollaborationStageOutput | undefined {
    const row = this.db.prepare(`SELECT * FROM collaboration_stage_outputs WHERE workspace_id = ?
      AND canonical_run_id = ? AND stage_id = ? AND stage_attempt = ?`)
      .get(workspaceId, runId, stageId, stageAttempt) as StageOutputRow | undefined;
    return row ? mapStageOutput(row) : undefined;
  }
}
