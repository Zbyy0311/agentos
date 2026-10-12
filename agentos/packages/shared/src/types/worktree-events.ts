/**
 * Worktree Runtime Event family (06-Worktree-Runtime §71-76/§57).
 *
 * Registers the canonical Worktree event vocabulary on the central Runtime
 * Event registry so worktree lifecycle facts flow through the merged
 * Event + Outbox seam. Every payload carries durable references
 * (worktreeId / runId / workspaceId) instead of filesystem-only identity
 * (§54: identity must not rely on directory names alone).
 *
 * This module defines payload guards and definitions only; it performs no
 * emission and no persistence. The Worktree manager and control/merge services
 * emit the registered vocabulary through the shared durable writer.
 *
 * All definitions are Run-scoped but Stage-free (`forbidsStageId`): a
 * worktree lease belongs to a Run/Execution, not to a single Stage.
 */

import type { RuntimeEventDefinition, RuntimeEventPayloadGuard } from './m3-runtime-registry.js';

type WorktreeLeaseStatus = 'creating' | 'active' | 'completed' | 'cleanup_pending' | 'cleaned' | 'failed';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}
function hasValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

const WORKTREE_LEASE_STATUSES: readonly WorktreeLeaseStatus[] = Object.freeze([
  'creating', 'active', 'completed', 'cleanup_pending', 'cleaned', 'failed',
]);

const WORKTREE_MERGE_STRATEGIES: readonly string[] = Object.freeze(['squash', 'merge-commit', 'ff']);

/** Shared reference block: every worktree Event names its durable identity. */
export interface WorktreeEventReferences {
  readonly worktreeId: string;
  readonly runId: string;
  readonly workspaceId: string;
}

/** Lifecycle payload shared by reserved/created/activated/deleted/abandoned/dirty/ready_for_review. */
export interface WorktreeLifecycleEventPayload extends WorktreeEventReferences {
  readonly executionId: string;
  readonly agentId: string;
  readonly branchName: string;
  readonly status: WorktreeLeaseStatus;
}

/** §72 `worktree.reserved`: durable identity exists before Git creation. */
export interface WorktreeReservedEventPayload extends WorktreeEventReferences {
  readonly branchName: string;
  readonly baseCommit: string;
}

/** `worktree.created`: emitted after `git worktree add` + lease persistence. */
export interface WorktreeCreatedEventPayload extends WorktreeLifecycleEventPayload {
  readonly baseCommit: string;
  readonly pathLabel: string;
  readonly controlledGitContent: boolean;
}

/** `worktree.activated`: creating → active transition (controlled checkout or reconcile). */
export type WorktreeActivatedEventPayload = WorktreeLifecycleEventPayload;

/** Selected paths were committed on the managed branch after the HEAD CAS. */
export interface WorktreeCommitCreatedEventPayload extends WorktreeEventReferences {
  readonly commitSha: string;
  readonly message: string;
  readonly filesChanged: number;
  readonly author?: string;
}

/** `worktree.deleted`: emitted when a verified-bundle lease is removed via git. */
export type WorktreeDeletedEventPayload = WorktreeLifecycleEventPayload;

/** `worktree.abandoned`: operator abandons a lease; its directory is preserved. */
export interface WorktreeAbandonedEventPayload extends WorktreeLifecycleEventPayload {
  readonly reason?: string;
}

/** `worktree.dirty` (§71): control preflight observes uncommitted content. */
export interface WorktreeDirtyEventPayload extends WorktreeEventReferences {
  readonly headCommit: string;
  readonly modifiedCount: number;
  readonly untrackedCount: number;
}

/** `worktree.ready_for_review` (§71): a clean worktree is submitted for review. */
export type WorktreeReadyForReviewEventPayload = WorktreeLifecycleEventPayload;

/** §75 `worktree.merge_requested`. */
export interface WorktreeMergeRequestedEventPayload extends WorktreeEventReferences {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly sourceHeadCommit: string;
  readonly expectedTargetCommit?: string;
  readonly strategy: string;
  readonly requestedBy: string;
}

/** `worktree.merged`: durable merge record committed. */
export interface WorktreeMergedEventPayload extends WorktreeEventReferences {
  readonly mergeRecordId: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly strategy: string;
  readonly resultingTargetCommit: string;
  readonly mergeCommit?: string;
}

/**
 * §76 `worktree.conflicted`, adapted to the merge runtime: the conflict
 * artifact is produced by the caller's review flow, so `conflictArtifactId`
 * stays optional here (§76's required field assumes an artifact already
 * exists at emission time, which the merge runtime cannot guarantee).
 */
export interface WorktreeConflictedEventPayload extends WorktreeEventReferences {
  readonly mergeRecordId?: string;
  readonly operation: 'merge' | 'rebase' | 'cherry-pick' | 'patch';
  readonly conflictedFiles: readonly string[];
  readonly sourceBranch?: string;
  readonly targetBranch?: string;
  readonly conflictArtifactId?: string;
}

/** §57 `worktree.recovery_started`: startup recovery scan opened for one Run. */
export interface WorktreeRecoveryStartedEventPayload {
  readonly runId: string;
  readonly workspaceId: string;
  readonly scannedCount: number;
}

/** §53.3/§56/§57 `worktree.orphaned`: preserved, never auto-adopted or deleted. */
export interface WorktreeOrphanedEventPayload {
  readonly path: string;
  readonly classification: 'untracked-by-database';
  readonly action: 'preserve';
  readonly branch?: string;
  readonly headCommit?: string;
  readonly workspaceId?: string;
  readonly runId?: string;
}

function isReferences(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.worktreeId)
    && isNonEmptyString(value.runId)
    && isNonEmptyString(value.workspaceId);
}

function isLifecyclePayload(value: Record<string, unknown>): boolean {
  return isReferences(value)
    && isNonEmptyString(value.executionId)
    && isNonEmptyString(value.agentId)
    && isNonEmptyString(value.branchName)
    && hasValue(WORKTREE_LEASE_STATUSES, value.status);
}

export function isWorktreeReservedEventPayload(value: unknown): value is WorktreeReservedEventPayload {
  return isRecord(value)
    && hasOnly(value, ['worktreeId', 'runId', 'workspaceId', 'branchName', 'baseCommit'])
    && isReferences(value)
    && isNonEmptyString(value.branchName)
    && isNonEmptyString(value.baseCommit);
}

export function isWorktreeCreatedEventPayload(value: unknown): value is WorktreeCreatedEventPayload {
  return isRecord(value)
    && hasOnly(value, ['worktreeId', 'runId', 'workspaceId', 'executionId', 'agentId', 'branchName',
      'status', 'baseCommit', 'pathLabel', 'controlledGitContent'])
    && isLifecyclePayload(value)
    && isNonEmptyString(value.baseCommit)
    && isNonEmptyString(value.pathLabel)
    && typeof value.controlledGitContent === 'boolean';
}

export function isWorktreeActivatedEventPayload(value: unknown): value is WorktreeActivatedEventPayload {
  return isRecord(value)
    && hasOnly(value, ['worktreeId', 'runId', 'workspaceId', 'executionId', 'agentId', 'branchName', 'status'])
    && isLifecyclePayload(value);
}

export function isWorktreeDeletedEventPayload(value: unknown): value is WorktreeDeletedEventPayload {
  return isWorktreeActivatedEventPayload(value);
}

export function isWorktreeAbandonedEventPayload(value: unknown): value is WorktreeAbandonedEventPayload {
  return isRecord(value)
    && (hasOnly(value, ['worktreeId', 'runId', 'workspaceId', 'executionId', 'agentId', 'branchName', 'status'])
      || hasOnly(value, ['worktreeId', 'runId', 'workspaceId', 'executionId', 'agentId', 'branchName', 'status', 'reason']))
    && isLifecyclePayload(value)
    && (value.reason === undefined || isNonEmptyString(value.reason));
}

export function isWorktreeDirtyEventPayload(value: unknown): value is WorktreeDirtyEventPayload {
  return isRecord(value)
    && hasOnly(value, ['worktreeId', 'runId', 'workspaceId', 'headCommit', 'modifiedCount', 'untrackedCount'])
    && isReferences(value)
    && isNonEmptyString(value.headCommit)
    && typeof value.modifiedCount === 'number' && Number.isSafeInteger(value.modifiedCount) && value.modifiedCount >= 0
    && typeof value.untrackedCount === 'number' && Number.isSafeInteger(value.untrackedCount) && value.untrackedCount >= 0;
}

export function isWorktreeReadyForReviewEventPayload(value: unknown): value is WorktreeReadyForReviewEventPayload {
  return isWorktreeActivatedEventPayload(value);
}

export function isWorktreeCommitCreatedEventPayload(value: unknown): value is WorktreeCommitCreatedEventPayload {
  return isRecord(value)
    && (hasOnly(value, ['worktreeId', 'runId', 'workspaceId', 'commitSha', 'message', 'filesChanged'])
      || hasOnly(value, ['worktreeId', 'runId', 'workspaceId', 'commitSha', 'message', 'filesChanged', 'author']))
    && isReferences(value)
    && typeof value.commitSha === 'string' && /^[0-9a-f]{40}$/.test(value.commitSha)
    && isNonEmptyString(value.message)
    && typeof value.filesChanged === 'number' && Number.isSafeInteger(value.filesChanged) && value.filesChanged > 0
    && (value.author === undefined || isNonEmptyString(value.author));
}

export function isWorktreeMergeRequestedEventPayload(value: unknown): value is WorktreeMergeRequestedEventPayload {
  return isRecord(value)
    && (hasOnly(value, ['worktreeId', 'runId', 'workspaceId', 'sourceBranch', 'targetBranch', 'sourceHeadCommit', 'strategy', 'requestedBy'])
      || hasOnly(value, ['worktreeId', 'runId', 'workspaceId', 'sourceBranch', 'targetBranch', 'sourceHeadCommit', 'strategy', 'requestedBy', 'expectedTargetCommit']))
    && isReferences(value)
    && isNonEmptyString(value.sourceBranch)
    && isNonEmptyString(value.targetBranch)
    && isNonEmptyString(value.sourceHeadCommit)
    && hasValue(WORKTREE_MERGE_STRATEGIES, value.strategy)
    && isNonEmptyString(value.requestedBy)
    && (value.expectedTargetCommit === undefined || isNonEmptyString(value.expectedTargetCommit));
}

export function isWorktreeMergedEventPayload(value: unknown): value is WorktreeMergedEventPayload {
  return isRecord(value)
    && (hasOnly(value, ['worktreeId', 'runId', 'workspaceId', 'mergeRecordId', 'sourceBranch', 'targetBranch', 'strategy', 'resultingTargetCommit'])
      || hasOnly(value, ['worktreeId', 'runId', 'workspaceId', 'mergeRecordId', 'sourceBranch', 'targetBranch', 'strategy', 'resultingTargetCommit', 'mergeCommit']))
    && isReferences(value)
    && isNonEmptyString(value.mergeRecordId)
    && isNonEmptyString(value.sourceBranch)
    && isNonEmptyString(value.targetBranch)
    && hasValue(WORKTREE_MERGE_STRATEGIES, value.strategy)
    && isNonEmptyString(value.resultingTargetCommit)
    && (value.mergeCommit === undefined || isNonEmptyString(value.mergeCommit));
}

export function isWorktreeConflictedEventPayload(value: unknown): value is WorktreeConflictedEventPayload {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = ['worktreeId', 'runId', 'workspaceId', 'mergeRecordId', 'operation', 'conflictedFiles',
    'sourceBranch', 'targetBranch', 'conflictArtifactId'];
  if (!keys.every(key => allowed.includes(key)) || !isReferences(value)) return false;
  if (value.mergeRecordId !== undefined && !isNonEmptyString(value.mergeRecordId)) return false;
  if (!hasValue(['merge', 'rebase', 'cherry-pick', 'patch'] as const, value.operation)) return false;
  if (!Array.isArray(value.conflictedFiles) || !value.conflictedFiles.every(isNonEmptyString)) return false;
  if (value.sourceBranch !== undefined && !isNonEmptyString(value.sourceBranch)) return false;
  if (value.targetBranch !== undefined && !isNonEmptyString(value.targetBranch)) return false;
  if (value.conflictArtifactId !== undefined && !isNonEmptyString(value.conflictArtifactId)) return false;
  return true;
}

export function isWorktreeRecoveryStartedEventPayload(value: unknown): value is WorktreeRecoveryStartedEventPayload {
  return isRecord(value)
    && hasOnly(value, ['runId', 'workspaceId', 'scannedCount'])
    && isNonEmptyString(value.runId)
    && isNonEmptyString(value.workspaceId)
    && typeof value.scannedCount === 'number' && Number.isSafeInteger(value.scannedCount) && value.scannedCount >= 0;
}

export function isWorktreeOrphanedEventPayload(value: unknown): value is WorktreeOrphanedEventPayload {
  if (!isRecord(value)) return false;
  const allowed = ['path', 'classification', 'action', 'branch', 'headCommit', 'workspaceId', 'runId'];
  if (!Object.keys(value).every(key => allowed.includes(key))) return false;
  return isNonEmptyString(value.path)
    && value.classification === 'untracked-by-database'
    && value.action === 'preserve'
    && (value.branch === undefined || isNonEmptyString(value.branch))
    && (value.headCommit === undefined || isNonEmptyString(value.headCommit))
    && (value.workspaceId === undefined || isNonEmptyString(value.workspaceId))
    && (value.runId === undefined || isNonEmptyString(value.runId));
}

const WORKTREE_LIFECYCLE_SCHEMA = Object.freeze({
  required: ['worktreeId', 'runId', 'workspaceId', 'executionId', 'agentId', 'branchName', 'status'],
  optional: [] as string[],
});

export const WORKTREE_EVENT_DEFINITIONS: readonly RuntimeEventDefinition[] = [
  {
    type: 'worktree.reserved',
    domain: 'worktree',
    description: 'A worktree branch/path reservation was persisted before git worktree add (§72).',
    schemaVersion: 1,
    source: 'worktree-manager',
    defaultSeverity: 'info',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    forbidsStageId: true,
    payloadSchema: {
      required: ['worktreeId', 'runId', 'workspaceId', 'branchName', 'baseCommit'],
      optional: [],
    },
    validatePayload: isWorktreeReservedEventPayload as RuntimeEventPayloadGuard<unknown>,
  },
  {
    type: 'worktree.created',
    domain: 'worktree',
    description: 'A worktree lease was created with git worktree add and persisted.',
    schemaVersion: 1,
    source: 'worktree-manager',
    defaultSeverity: 'info',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    forbidsStageId: true,
    payloadSchema: {
      required: [...WORKTREE_LIFECYCLE_SCHEMA.required, 'baseCommit', 'pathLabel', 'controlledGitContent'],
      optional: [],
    },
    validatePayload: isWorktreeCreatedEventPayload as RuntimeEventPayloadGuard<unknown>,
  },
  {
    type: 'worktree.activated',
    domain: 'worktree',
    description: 'A worktree lease transitioned creating → active.',
    schemaVersion: 1,
    source: 'worktree-manager',
    defaultSeverity: 'info',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    forbidsStageId: true,
    payloadSchema: { required: [...WORKTREE_LIFECYCLE_SCHEMA.required], optional: [] },
    validatePayload: isWorktreeActivatedEventPayload as RuntimeEventPayloadGuard<unknown>,
  },
  {
    type: 'worktree.commit_created',
    domain: 'worktree',
    description: 'Selected changes were committed on a managed worktree branch.',
    schemaVersion: 1,
    source: 'worktree-manager',
    defaultSeverity: 'info',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    forbidsStageId: true,
    payloadSchema: {
      required: ['worktreeId', 'runId', 'workspaceId', 'commitSha', 'message', 'filesChanged'],
      optional: ['author'],
    },
    validatePayload: isWorktreeCommitCreatedEventPayload as RuntimeEventPayloadGuard<unknown>,
  },
  {
    type: 'worktree.dirty',
    domain: 'worktree',
    description: 'A worktree checkout carries uncommitted changes (§71).',
    schemaVersion: 1,
    source: 'worktree-manager',
    defaultSeverity: 'notice',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    forbidsStageId: true,
    payloadSchema: {
      required: ['worktreeId', 'runId', 'workspaceId', 'headCommit', 'modifiedCount', 'untrackedCount'],
      optional: [],
    },
    validatePayload: isWorktreeDirtyEventPayload as RuntimeEventPayloadGuard<unknown>,
  },
  {
    type: 'worktree.ready_for_review',
    domain: 'worktree',
    description: 'A worktree lease is ready for review (§71).',
    schemaVersion: 1,
    source: 'worktree-manager',
    defaultSeverity: 'info',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    forbidsStageId: true,
    payloadSchema: { required: [...WORKTREE_LIFECYCLE_SCHEMA.required], optional: [] },
    validatePayload: isWorktreeReadyForReviewEventPayload as RuntimeEventPayloadGuard<unknown>,
  },
  {
    type: 'worktree.merge_requested',
    domain: 'worktree',
    description: 'A merge of the worktree lease branch into a target branch was requested (§75).',
    schemaVersion: 1,
    source: 'worktree-manager',
    defaultSeverity: 'info',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    forbidsStageId: true,
    payloadSchema: {
      required: ['worktreeId', 'runId', 'workspaceId', 'sourceBranch', 'targetBranch', 'sourceHeadCommit', 'strategy', 'requestedBy'],
      optional: ['expectedTargetCommit'],
    },
    validatePayload: isWorktreeMergeRequestedEventPayload as RuntimeEventPayloadGuard<unknown>,
  },
  {
    type: 'worktree.merged',
    domain: 'worktree',
    description: 'A worktree lease branch was merged into the target branch.',
    schemaVersion: 1,
    source: 'worktree-manager',
    defaultSeverity: 'info',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    forbidsStageId: true,
    payloadSchema: {
      required: ['worktreeId', 'runId', 'workspaceId', 'mergeRecordId', 'sourceBranch', 'targetBranch', 'strategy', 'resultingTargetCommit'],
      optional: ['mergeCommit'],
    },
    validatePayload: isWorktreeMergedEventPayload as RuntimeEventPayloadGuard<unknown>,
  },
  {
    type: 'worktree.conflicted',
    domain: 'worktree',
    description: 'A merge against the worktree lease branch conflicted (§76).',
    schemaVersion: 1,
    source: 'worktree-manager',
    defaultSeverity: 'warning',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    forbidsStageId: true,
    payloadSchema: {
      required: ['worktreeId', 'runId', 'workspaceId', 'operation', 'conflictedFiles'],
      optional: ['mergeRecordId', 'sourceBranch', 'targetBranch', 'conflictArtifactId'],
    },
    validatePayload: isWorktreeConflictedEventPayload as RuntimeEventPayloadGuard<unknown>,
  },
  {
    type: 'worktree.abandoned',
    domain: 'worktree',
    description: 'A worktree lease was abandoned by the operator; cleanup is pending.',
    schemaVersion: 1,
    source: 'worktree-manager',
    defaultSeverity: 'notice',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    forbidsStageId: true,
    payloadSchema: { required: [...WORKTREE_LIFECYCLE_SCHEMA.required], optional: ['reason'] },
    validatePayload: isWorktreeAbandonedEventPayload as RuntimeEventPayloadGuard<unknown>,
  },
  {
    type: 'worktree.deleted',
    domain: 'worktree',
    description: 'A worktree lease with a verified recovery bundle was removed via git worktree remove.',
    schemaVersion: 1,
    source: 'worktree-manager',
    defaultSeverity: 'notice',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    forbidsStageId: true,
    payloadSchema: { required: [...WORKTREE_LIFECYCLE_SCHEMA.required], optional: [] },
    validatePayload: isWorktreeDeletedEventPayload as RuntimeEventPayloadGuard<unknown>,
  },
  {
    type: 'worktree.recovery_started',
    domain: 'worktree',
    description: 'Startup recovery reconciliation started scanning one Run’s worktree leases (§57).',
    schemaVersion: 1,
    source: 'worktree-manager',
    defaultSeverity: 'info',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    forbidsStageId: true,
    payloadSchema: {
      required: ['runId', 'workspaceId', 'scannedCount'],
      optional: [],
    },
    validatePayload: isWorktreeRecoveryStartedEventPayload as RuntimeEventPayloadGuard<unknown>,
  },
  {
    type: 'worktree.orphaned',
    domain: 'worktree',
    description: 'A git-registered worktree has no database record; it is preserved, never auto-adopted or deleted (§53.3/§56/§57).',
    schemaVersion: 1,
    source: 'worktree-manager',
    defaultSeverity: 'warning',
    defaultVisibility: 'restricted',
    defaultDurability: 'durable',
    forbidsStageId: true,
    payloadSchema: {
      required: ['path', 'classification', 'action'],
      optional: ['branch', 'headCommit', 'workspaceId', 'runId'],
    },
    validatePayload: isWorktreeOrphanedEventPayload as RuntimeEventPayloadGuard<unknown>,
  },
];
