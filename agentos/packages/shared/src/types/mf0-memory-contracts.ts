/**
 * MF-0 Memory Foundation contracts.
 *
 * This module freezes the shared/domain contracts required by later Memory
 * Foundation slices WITHOUT activating Memory persistence, retrieval,
 * snapshots, or Provider injection. It contains only pure types, deterministic
 * orderings, and fail-closed validators/deciders.
 *
 * Authority: `docs/Runtime-Specification lite/07-Memory-Runtime.md`.
 * Entry audit: `docs/implementation/milestones/MF-entry-audit.md`.
 *
 * Explicitly out of scope for MF-0 (deferred to later slices):
 *   - any Memory migration or table/column change (migration 017);
 *   - any repository, FTS writer, retrieval service, or Context Snapshot writer;
 *   - any Run/Provider injection wiring;
 *   - any API, UI, or Inspector surface;
 *   - any embedding or Vector Database requirement.
 */

// ---------------------------------------------------------------------------
// Scope, category, authority, status vocabulary
// ---------------------------------------------------------------------------

/** Reach of a Memory Entry. Narrower scopes are closer to the Run. */
export const MEMORY_SCOPES = [
  'global',
  'workspace',
  'agent',
  'conversation',
  'task',
  'run',
] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_CATEGORIES = [
  'decision',
  'knowledge',
  'preference',
  'constraint',
  'failure',
  'review',
  'test',
  'architecture',
  'workflow',
  'provider',
  'environment',
  'security',
  'summary',
  'reference',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_AUTHORITIES = [
  'user-explicit',
  'system-verified',
  'imported-verified',
  'agent-derived',
  'user-inferred',
  'unknown',
] as const;
export type MemoryAuthority = (typeof MEMORY_AUTHORITIES)[number];

export const MEMORY_ENTRY_STATUSES = [
  'candidate',
  'active',
  'conflicted',
  'superseded',
  'expired',
  'archived',
  'rejected',
  'deleted',
] as const;
export type MemoryEntryStatus = (typeof MEMORY_ENTRY_STATUSES)[number];

/** Statuses excluded from default retrieval. */
export const MEMORY_NON_RETRIEVABLE_STATUSES = [
  'expired',
  'archived',
  'rejected',
  'superseded',
  'deleted',
] as const satisfies readonly MemoryEntryStatus[];

// ---------------------------------------------------------------------------
// Scope/owner binding
// ---------------------------------------------------------------------------

/**
 * Owner references must match Scope. A `global` Entry carries no owner; every
 * narrower Scope names exactly the canonical owners for that reach. A Run
 * Entry must identify its Workspace, Task, and Run.
 */
export type MemoryScopeOwner =
  | { readonly scope: 'global' }
  | { readonly scope: 'workspace'; readonly workspaceId: string }
  | { readonly scope: 'agent'; readonly workspaceId: string; readonly agentId: string }
  | { readonly scope: 'conversation'; readonly workspaceId: string; readonly conversationId: string }
  | { readonly scope: 'task'; readonly workspaceId: string; readonly taskId: string }
  | {
      readonly scope: 'run';
      readonly workspaceId: string;
      readonly taskId: string;
      readonly runId: string;
    };

export type MemoryScopeOwnerError =
  | 'SCOPE_UNKNOWN'
  | 'OWNER_MISSING'
  | 'OWNER_NOT_ALLOWED';

/** Stable, data-free error for untyped callers. */
export class MemoryScopeOwnerError_ extends Error {
  constructor(readonly code: MemoryScopeOwnerError) {
    super(`MEMORY_SCOPE_OWNER_${code}`);
    this.name = 'MemoryScopeOwnerError';
  }
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Fail-closed runtime validation for untyped/JavaScript callers. Returns a
 * stable reason instead of guessing an owner.
 */
export function validateMemoryScopeOwner(input: unknown): {
  readonly valid: boolean;
  readonly reason?: MemoryScopeOwnerError;
} {
  if (typeof input !== 'object' || input === null) return { valid: false, reason: 'SCOPE_UNKNOWN' };
  const scope = (input as { scope?: unknown }).scope;
  if (!(MEMORY_SCOPES as readonly unknown[]).includes(scope)) {
    return { valid: false, reason: 'SCOPE_UNKNOWN' };
  }
  const owner = input as Record<string, unknown>;
  const required: Record<MemoryScope, readonly string[]> = {
    global: [],
    workspace: ['workspaceId'],
    agent: ['workspaceId', 'agentId'],
    conversation: ['workspaceId', 'conversationId'],
    task: ['workspaceId', 'taskId'],
    run: ['workspaceId', 'taskId', 'runId'],
  };
  const allowed = new Set(required[scope as MemoryScope]);
  for (const key of required[scope as MemoryScope]) {
    if (!nonBlank(owner[key])) return { valid: false, reason: 'OWNER_MISSING' };
  }
  for (const key of Object.keys(owner)) {
    if (key === 'scope') continue;
    if (!allowed.has(key)) return { valid: false, reason: 'OWNER_NOT_ALLOWED' };
  }
  return { valid: true };
}

/** Assert form; throws the stable data-free error on any invalid binding. */
export function assertMemoryScopeOwner(input: unknown): asserts input is MemoryScopeOwner {
  const result = validateMemoryScopeOwner(input);
  if (!result.valid) throw new MemoryScopeOwnerError_(result.reason ?? 'SCOPE_UNKNOWN');
}

// ---------------------------------------------------------------------------
// Deterministic orderings (ranking hints, never authorization)
// ---------------------------------------------------------------------------

/**
 * Default retrieval scope proximity. Lower rank is closer to the Run and is an
 * eligibility/ranking hint only; it never authorizes crossing Scope.
 */
export const MEMORY_SCOPE_PROXIMITY: Readonly<Record<MemoryScope, number>> = Object.freeze({
  run: 0,
  task: 1,
  conversation: 2,
  agent: 3,
  workspace: 4,
  global: 5,
});

/** Authority default ordering. Lower rank is stronger. */
export const MEMORY_AUTHORITY_RANK: Readonly<Record<MemoryAuthority, number>> = Object.freeze({
  'user-explicit': 0,
  'system-verified': 1,
  'imported-verified': 2,
  'agent-derived': 3,
  'user-inferred': 4,
  unknown: 5,
});

/** Authorities that are never sufficient for automatic promotion. */
export const MEMORY_WEAK_AUTHORITIES = [
  'agent-derived',
  'user-inferred',
  'unknown',
] as const satisfies readonly MemoryAuthority[];

export function compareMemoryScopeProximity(a: MemoryScope, b: MemoryScope): number {
  return MEMORY_SCOPE_PROXIMITY[a] - MEMORY_SCOPE_PROXIMITY[b];
}

export function compareMemoryAuthority(a: MemoryAuthority, b: MemoryAuthority): number {
  return MEMORY_AUTHORITY_RANK[a] - MEMORY_AUTHORITY_RANK[b];
}

/** True when an Authority is too weak to auto-promote an Entry. */
export function isWeakMemoryAuthority(authority: MemoryAuthority): boolean {
  return (MEMORY_WEAK_AUTHORITIES as readonly MemoryAuthority[]).includes(authority);
}

// ---------------------------------------------------------------------------
// Source requirement
// ---------------------------------------------------------------------------

export const MEMORY_SOURCE_KINDS = [
  'user',
  'message',
  'conversation',
  'task',
  'run',
  'stage',
  'event',
  'artifact',
  'import',
] as const;
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

export interface MemorySourceRefV1 {
  readonly kind: MemorySourceKind;
  readonly id: string;
}

/**
 * Automatic (non-user-explicit) Memory requires at least one stable source
 * reference before it may become active.
 */
export function requiresMemorySource(authority: MemoryAuthority): boolean {
  return authority !== 'user-explicit';
}

// ---------------------------------------------------------------------------
// Deduplication and conflict
// ---------------------------------------------------------------------------

/** Deduplication runs in this order. Optional embedding similarity is last. */
export const MEMORY_DEDUPLICATION_ORDER = [
  'exact-content-hash',
  'normalized-text-hash',
  'same-stable-source',
  'fts-similarity',
  'category-entity-key',
  'optional-embedding-similarity',
] as const;
export type MemoryDeduplicationSignal = (typeof MEMORY_DEDUPLICATION_ORDER)[number];

/** A conflict is not a duplicate. Conflicts are preserved, never overwritten. */
export const MEMORY_CONFLICT_TYPES = [
  'contradiction',
  'overlapping-scope',
  'authority-disagreement',
  'temporal-disagreement',
] as const;
export type MemoryConflictType = (typeof MEMORY_CONFLICT_TYPES)[number];

/** Conflicted Entries survive until an explicit resolution. */
export const MEMORY_CONFLICT_DISPOSITIONS = [
  'keep-both',
  'supersede-earlier',
  'supersede-later',
  'promote-source',
  'reject-both',
] as const;
export type MemoryConflictDisposition = (typeof MEMORY_CONFLICT_DISPOSITIONS)[number];

// ---------------------------------------------------------------------------
// Candidate promotion gate (fail-closed)
// ---------------------------------------------------------------------------

export const MEMORY_CANDIDATE_OUTCOMES = [
  'accept',
  'edit-and-accept',
  'reject',
  'merge-with-existing',
  'review-required',
] as const;
export type MemoryCandidateOutcome = (typeof MEMORY_CANDIDATE_OUTCOMES)[number];

export type MemoryPromotionDecision = 'auto-accept' | 'review-required' | 'reject';

export interface MemoryPromotionGateInput {
  readonly scope: MemoryScope;
  readonly category: MemoryCategory;
  readonly authority: MemoryAuthority;
  /** 0..1 current truth estimate. */
  readonly confidence: number;
  /** Count of stable source references attached to the candidate. */
  readonly sourceCount: number;
  readonly hasUnresolvedConflict: boolean;
  /** True when this candidate would widen the Entry's Scope. */
  readonly scopePromotion: boolean;
  /** True when the candidate encodes an inferred preference. */
  readonly inferredPreference: boolean;
  /** True when secret detection/redaction could not clear the content. */
  readonly containsSecret: boolean;
  readonly tokenEstimate: number;
  /** Bounded size limit for automatic acceptance. */
  readonly maxTokenEstimate: number;
  /** True when duplicate handling completed without an unresolved conflict. */
  readonly duplicateResolved: boolean;
  /** Minimum Confidence for automatic acceptance. */
  readonly minConfidence: number;
}

/**
 * Deterministic, fail-closed promotion gate.
 *
 * Rejects when a hard safety rule fails (secret, no stable source). Otherwise
 * requires review for Global Scope, security category, weak Authority, inferred
 * preference, Scope promotion, unresolved conflict, incomplete duplicate
 * handling, insufficient Confidence, or bounded-size violation.
 */
export function decideMemoryPromotion(input: MemoryPromotionGateInput): MemoryPromotionDecision {
  if (input.containsSecret) return 'reject';
  if (requiresMemorySource(input.authority) && input.sourceCount < 1) return 'reject';

  if (input.scope === 'global') return 'review-required';
  if (input.category === 'security') return 'review-required';
  if (isWeakMemoryAuthority(input.authority)) return 'review-required';
  if (input.inferredPreference) return 'review-required';
  if (input.scopePromotion) return 'review-required';
  if (input.hasUnresolvedConflict) return 'review-required';
  if (!input.duplicateResolved) return 'review-required';
  if (!Number.isFinite(input.confidence) || input.confidence < input.minConfidence) {
    return 'review-required';
  }
  if (
    !Number.isFinite(input.tokenEstimate)
    || !Number.isFinite(input.maxTokenEstimate)
    || input.tokenEstimate > input.maxTokenEstimate
  ) {
    return 'review-required';
  }
  return 'auto-accept';
}

// ---------------------------------------------------------------------------
// Context budget policy
// ---------------------------------------------------------------------------

export interface MemoryBudgetPolicyV1 {
  readonly maxTokens: number;
  readonly maxEntries: number;
  readonly perScopeLimits: Partial<Record<MemoryScope, number>>;
  readonly perCategoryLimits: Partial<Record<MemoryCategory, number>>;
  readonly minConfidence: number;
  readonly minImportance: number;
  /** Maximum entries that may be truncated to fit the budget. */
  readonly maxTruncation: number;
  readonly requireDiversity: boolean;
}

export type MemoryBudgetPolicyError =
  | 'NOT_OBJECT'
  | 'MAX_TOKENS_INVALID'
  | 'MAX_ENTRIES_INVALID'
  | 'LIMIT_INVALID'
  | 'THRESHOLD_INVALID'
  | 'MAX_TRUNCATION_INVALID'
  | 'DIVERSITY_INVALID';

/** Fail-closed validation of a budget policy for untyped callers. */
export function validateMemoryBudgetPolicy(input: unknown): {
  readonly valid: boolean;
  readonly reason?: MemoryBudgetPolicyError;
} {
  if (typeof input !== 'object' || input === null) return { valid: false, reason: 'NOT_OBJECT' };
  const policy = input as Record<string, unknown>;
  if (!Number.isSafeInteger(policy.maxTokens) || (policy.maxTokens as number) < 1) {
    return { valid: false, reason: 'MAX_TOKENS_INVALID' };
  }
  if (!Number.isSafeInteger(policy.maxEntries) || (policy.maxEntries as number) < 1) {
    return { valid: false, reason: 'MAX_ENTRIES_INVALID' };
  }
  for (const key of ['perScopeLimits', 'perCategoryLimits'] as const) {
    const limits = policy[key];
    if (typeof limits !== 'object' || limits === null) return { valid: false, reason: 'LIMIT_INVALID' };
    for (const value of Object.values(limits as Record<string, unknown>)) {
      if (!Number.isSafeInteger(value) || (value as number) < 0) {
        return { valid: false, reason: 'LIMIT_INVALID' };
      }
    }
  }
  for (const key of ['minConfidence', 'minImportance'] as const) {
    const value = policy[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      return { valid: false, reason: 'THRESHOLD_INVALID' };
    }
  }
  if (!Number.isSafeInteger(policy.maxTruncation) || (policy.maxTruncation as number) < 0) {
    return { valid: false, reason: 'MAX_TRUNCATION_INVALID' };
  }
  if (typeof policy.requireDiversity !== 'boolean') {
    return { valid: false, reason: 'DIVERSITY_INVALID' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Selection explanation and immutable Context Snapshot identity
// ---------------------------------------------------------------------------

export const MEMORY_SELECTION_REASONS = [
  'scope-match',
  'fts-relevance',
  'importance',
  'confidence',
  'authority',
  'recency',
  'pin',
  'category-budget',
  'diversity',
  'high-authority-reserve',
  'truncation',
] as const;
export type MemorySelectionReasonCode = (typeof MEMORY_SELECTION_REASONS)[number];

export interface MemorySelectionExplanationV1 {
  readonly memoryId: string;
  readonly memoryVersion: number;
  readonly rank: number;
  readonly score: number;
  readonly scope: MemoryScope;
  readonly category: MemoryCategory;
  readonly authority: MemoryAuthority;
  readonly confidence: number;
  readonly importance: number;
  readonly tokenCost: number;
  readonly reasons: readonly MemorySelectionReasonCode[];
  readonly sourceRefs: readonly MemorySourceRefV1[];
}

export const MEMORY_EXCLUSION_REASONS = [
  'scope-excluded',
  'status-excluded',
  'validity-expired',
  'below-confidence',
  'below-importance',
  'entry-budget',
  'token-budget',
  'category-budget',
  'diversity-limit',
  'truncated',
  'conflict-penalty',
] as const;
export type MemoryExclusionReasonCode = (typeof MEMORY_EXCLUSION_REASONS)[number];

export interface MemoryExclusionExplanationV1 {
  readonly memoryId: string;
  readonly reason: MemoryExclusionReasonCode;
}

/**
 * Immutable Context Snapshot identity. A later slice persists this before
 * Provider injection; persistence failure must block injection because the Run
 * would otherwise be unreproducible.
 */
export interface MemoryContextSnapshotV1 {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly runId: string;
  readonly stageId?: string;
  readonly providerConfigId?: string;
  readonly queryHash: string;
  readonly retrievalStrategyVersion: string;
  readonly budget: MemoryBudgetPolicyV1;
  readonly selected: readonly MemorySelectionExplanationV1[];
  readonly exclusions: readonly MemoryExclusionExplanationV1[];
  readonly totalTokens: number;
  readonly truncated: boolean;
  readonly createdAt: string;
  readonly promptArtifactId?: string;
}

/**
 * Frozen immutability rule for Context Snapshots. Later Entry edits must never
 * rewrite a Run's Snapshot; schema enforcement is a later-slice requirement.
 */
export const MEMORY_CONTEXT_SNAPSHOT_IMMUTABILITY = Object.freeze({
  mutable: false,
  rewrittenByLaterEntryEdits: false,
  persistenceFailureBlocksInjection: true,
} as const);

// ---------------------------------------------------------------------------
// Event vocabulary
// ---------------------------------------------------------------------------

export const MEMORY_EVENT_TYPES = [
  'memory.candidate_created',
  'memory.candidate_reviewed',
  'memory.entry_created',
  'memory.entry_updated',
  'memory.entry_conflicted',
  'memory.entry_deduplicated',
  'memory.entry_superseded',
  'memory.entry_expired',
  'memory.entry_archived',
  'memory.retrieval_completed',
  'memory.retrieval_failed',
  'memory.context_created',
  'memory.injected',
  'memory.revalidation_completed',
] as const;
export type MemoryEventType = (typeof MEMORY_EVENT_TYPES)[number];

/**
 * Events carry stable references, scores, reasons, and budget facts rather than
 * sensitive full Memory content.
 */
export const MEMORY_EVENT_PAYLOAD_RULE = Object.freeze({
  referencesAndScoresOnly: true,
  carriesFullMemoryContent: false,
  carriesSecretValues: false,
} as const);
