/**
 * Durable collaboration-task contracts.
 *
 * This is deliberately separate from the legacy Conversation pipeline. A
 * collaboration task owns a confirmed plan, one canonical Run at a time,
 * immutable candidate revisions, and evidence-backed review decisions.
 */

export const COLLABORATION_STATUSES = [
  'awaiting_confirmation',
  'queued',
  'running',
  'reviewing',
  'changes_requested',
  'awaiting_application',
  'applied',
  'failed',
  'blocked',
  'cancelled',
] as const;
export type CollaborationStatus = (typeof COLLABORATION_STATUSES)[number];

export const COLLABORATION_CANDIDATE_STATUSES = [
  'created',
  'reviewed',
  'superseded',
  'applied',
] as const;
export type CollaborationCandidateStatus = (typeof COLLABORATION_CANDIDATE_STATUSES)[number];

export type CollaborationReviewConclusion = 'approved' | 'changes_requested';
export type CollaborationTestStatus = 'not_run' | 'running' | 'passed' | 'failed' | 'evidence_missing' | 'unknown';

export interface CollaborationTask {
  id: string;
  workspaceId: string;
  conversationId?: string;
  sourceMessageId?: string;
  title: string;
  objective: string;
  scope: string[];
  acceptanceCommands: string[];
  plannerAgentId: string;
  implementerAgentId: string;
  reviewerAgentId: string;
  status: CollaborationStatus;
  version: number;
  /** Durable control fence; absent only on pre-control cached records. */
  controlEpoch?: number;
  scopePolicyVersion?: number;
  /** Business status is unchanged while an external control side effect is in progress. */
  pendingControl?: {
    id: string; action: 'confirm' | 'cancel' | 'apply' | 'rework';
    state: 'reserved' | 'running' | 'recovery_required'; epoch: number;
    reason?: string; recoveryReference?: string;
  };
  planHash: string;
  baseCommit: string;
  maxReworkRounds: number;
  reworkRound: number;
  canonicalTaskId?: string;
  canonicalRunId?: string;
  currentCandidateId?: string;
  confirmedAt?: string;
  appliedAt?: string;
  cancelledAt?: string;
  failureReason?: string;
  confirmIdempotencyKey?: string;
  applyIdempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CollaborationCandidate {
  id: string;
  collaborationTaskId: string;
  workspaceId: string;
  canonicalRunId: string;
  round: number;
  baseCommit: string;
  headCommit: string;
  diffHash: string;
  /** Canonical hash of the frozen patch digest and all persisted file metadata. */
  contentHash?: string;
  diffText: string;
  /** Version 2 snapshots include tracked and untracked content in diffText. */
  snapshotVersion?: number;
  /** Manifest v1 predates strict binary metadata completeness; new captures use v2. */
  manifestVersion?: number;
  manifest: CollaborationCandidateManifestEntry[];
  testStatus: CollaborationTestStatus;
  testCommand?: string;
  testExitCode?: number;
  testOutput?: string;
  status: CollaborationCandidateStatus;
  reviewConclusion?: CollaborationReviewConclusion;
  reviewSummary?: string;
  reviewAgentId?: string;
  reviewArtifactId?: string;
  diffArtifactId?: string;
  manifestArtifactId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Metadata returned before the user explicitly loads a frozen file diff. */
export interface CollaborationCandidateSummary {
  id: string;
  round: number;
  diffHash: string;
  contentHash: string;
  snapshotVersion?: number;
  manifestVersion?: number;
  testStatus: CollaborationTestStatus;
  testCommand?: string;
  testExitCode?: number;
  reviewConclusion?: CollaborationReviewConclusion;
  reviewSummary?: string;
}

export interface CollaborationCandidateManifestEntry {
  path: string;
  sizeBytes: number;
  /** Explicit binary/text classification for new manifests, including unchanged renames. */
  binary?: boolean;
  /** SHA-256 of the candidate-side file image when available. */
  sha256?: string;
  /** Git blob object id, always tied to diffText by the frozen diff hash. */
  gitObjectId?: string;
  /** Binary baseline metadata for modified or renamed files. */
  baseSizeBytes?: number;
  baseSha256?: string;
  baseObjectId?: string;
  /** True when sizeBytes and hashes describe the removed baseline image. */
  deleted?: boolean;
}

export interface CollaborationReview {
  id: string;
  collaborationTaskId: string;
  candidateId: string;
  workspaceId: string;
  canonicalRunId: string;
  stageId: string;
  stageAttempt: number;
  reviewerAgentId: string;
  /** Hash of the immutable candidate version the reviewer inspected. */
  candidateDiffHash?: string;
  conclusion: CollaborationReviewConclusion;
  summary: string;
  artifactId?: string;
  createdAt: string;
}

export interface CollaborationTaskDetails {
  task: CollaborationTask;
  candidate?: CollaborationCandidateSummary;
  candidates: CollaborationCandidateSummary[];
  reviews: CollaborationReview[];
}

export type CollaborationProgressRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export type CollaborationProgressStageStatus =
  | 'pending'
  | 'ready'
  | 'starting'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'unknown';

export type CollaborationProgressRole = 'planner' | 'implementer' | 'reviewer' | 'other';

export interface CollaborationProgressAgent {
  agentId: string;
  name: string;
  role: CollaborationProgressRole;
  roleTitle: string;
}

export interface CollaborationProgressEvidence {
  kind: 'candidate' | 'test' | 'review' | 'artifact' | 'runtime';
  label: string;
  status?: string;
  artifactId?: string;
  runId?: string;
}

export interface CollaborationProgressStage {
  runId: string;
  stageId: string;
  stageKey: string;
  label: string;
  sequence: number;
  attempt: number;
  status: CollaborationProgressStageStatus;
  agent?: CollaborationProgressAgent;
  startedAt?: string;
  completedAt?: string;
  failureMessage?: string;
  publicOutput?: string;
  publicOutputStatus?: 'available' | 'not_started' | 'not_recorded' | 'invalid' | 'unavailable';
  publicOutputReason?: string;
  evidence: CollaborationProgressEvidence[];
}

export interface CollaborationProgressEvent {
  eventId: string;
  runId: string;
  sequence: number;
  type: string;
  timestamp: string;
  stageId?: string;
  agentId?: string;
  summary?: string;
}

export interface CollaborationProgressRun {
  runId: string;
  parentRunId?: string;
  status: CollaborationProgressRunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failureMessage?: string;
  highWatermark: number;
  stages: CollaborationProgressStage[];
}

/** Lightweight summary used by the live progress view; patches and test logs load only on explicit request. */
export interface CollaborationProgressCandidate {
  id: string;
  round: number;
  diffHash: string;
  contentHash: string;
  snapshotVersion?: number;
  testStatus: CollaborationTestStatus;
  testCommand?: string;
  testExitCode?: number;
  reviewConclusion?: CollaborationReviewConclusion;
  reviewSummary?: string;
}

export interface CollaborationProgress {
  task: CollaborationTask;
  runs: CollaborationProgressRun[];
  currentRunId?: string;
  currentStage?: CollaborationProgressStage;
  currentAgent?: CollaborationProgressAgent;
  waitingReason?: string;
  warnings?: string[];
  events: CollaborationProgressEvent[];
  eventCursor: number;
  candidates: CollaborationProgressCandidate[];
  reviews: CollaborationReview[];
}
