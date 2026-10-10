import type {
  MemoryConflictDisposition,
  MemoryConflictType,
  MemoryWorkspaceKnowledgePromotionRequestV1,
  PreferenceEvidence,
} from '@agentos/shared';
import type { MemoryEntryDto } from './memoryEntries.js';

export type MemoryLifecycleAction = 'archive' | 'restore' | 'delete' | 'revalidate' | 'set-validity';

export function memoryCandidatesPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/memory/candidates?outcome=review-required`;
}

export function memoryCandidateReviewPath(workspaceId: string, candidateId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/memory/candidates/${encodeURIComponent(candidateId)}/review`;
}

export type MemoryConflictStatusFilter = 'open' | 'resolved' | 'all';

export interface MemoryConflictDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly conflictType: MemoryConflictType;
  readonly entryAId: string;
  readonly entryBId: string;
  readonly status: 'open' | 'resolved';
  readonly disposition: MemoryConflictDisposition | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly version: number;
}

export function memoryConflictsPath(workspaceId: string, status: MemoryConflictStatusFilter = 'open'): string {
  const query = new URLSearchParams({ status });
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/memory/conflicts?${query.toString()}`;
}

export function memoryConflictResolutionPath(workspaceId: string, conflictId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/memory-conflicts/${encodeURIComponent(conflictId)}/resolve`;
}

export interface MemoryConflictResolutionPayload {
  readonly expectedVersion: number;
  readonly disposition: MemoryConflictDisposition;
}

export function memoryConflictResolutionPayload(
  conflict: Pick<MemoryConflictDto, 'version'>,
  disposition: MemoryConflictDisposition,
): MemoryConflictResolutionPayload {
  return { expectedVersion: conflict.version, disposition };
}

export interface MemoryEntryLifecyclePayload {
  readonly expectedVersion: number;
  readonly action: MemoryLifecycleAction;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  readonly expiresAt?: string | null;
}

export interface MemoryEntryValidity {
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  readonly expiresAt?: string | null;
}

export function memoryEntryLifecyclePath(workspaceId: string, entryId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/memory/entries/${encodeURIComponent(entryId)}/lifecycle`;
}

export function memoryEntryWorkspacePromotionPath(workspaceId: string, entryId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/memory/entries/${encodeURIComponent(entryId)}/promote-to-workspace-knowledge`;
}

export function memoryEntryWorkspacePromotionPayload(entry: Pick<MemoryEntryDto, 'version'>): MemoryWorkspaceKnowledgePromotionRequestV1 {
  return { expectedVersion: entry.version };
}

export function memoryEntryLifecyclePayload(
  entry: Pick<MemoryEntryDto, 'version'>,
  action: MemoryLifecycleAction,
  validity?: MemoryEntryValidity,
): MemoryEntryLifecyclePayload {
  if (action === 'set-validity') {
    if (!validity || !Object.keys(validity).some(key => ['validFrom', 'validUntil', 'expiresAt'].includes(key))) {
      throw new Error('至少指定一个有效期字段');
    }
    return { expectedVersion: entry.version, action, ...validity };
  }
  if (validity !== undefined) throw new Error('只有设置有效期操作可以携带日期');
  return { expectedVersion: entry.version, action };
}

export function confirmedMemoryEntryLifecyclePayload(
  entry: Pick<MemoryEntryDto, 'version'>,
  action: MemoryLifecycleAction,
  confirmed: boolean,
): MemoryEntryLifecyclePayload | undefined {
  return confirmed ? memoryEntryLifecyclePayload(entry, action) : undefined;
}

export interface PreferenceSuggestionDto {
  readonly id: string;
  readonly projectionId: string;
  readonly workspaceId: string;
  readonly status: 'pending' | 'confirmed' | 'rejected' | 'revoked';
  readonly version: number;
  readonly entryId: string | null;
  readonly preferredValue: string;
  readonly dimension: string;
  readonly contextKind: string;
  readonly scope: 'global' | 'workspace';
  readonly confidence: number;
  readonly evidenceCount: number;
}

export type PreferenceEvidenceDto = PreferenceEvidence;

export type PreferenceSuggestionAction = 'confirm' | 'reject' | 'revoke';

export interface PreferenceSuggestionActionPayload {
  readonly workspaceId: string;
  readonly expectedVersion: number;
  readonly confirmGlobal?: boolean;
}

export function preferenceSuggestionsPath(workspaceId: string): string {
  const query = new URLSearchParams({ workspaceId });
  return `/api/preferences/suggestions?${query.toString()}`;
}

export function preferenceEvidencePath(workspaceId: string, projectionId: string): string {
  const query = new URLSearchParams({ projectionId });
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/preferences/evidence?${query.toString()}`;
}

export function preferenceSuggestionActionPath(projectionId: string, action: PreferenceSuggestionAction): string {
  return `/api/preferences/${encodeURIComponent(projectionId)}/${action}`;
}

export function preferenceSuggestionActionPayload(
  suggestion: Pick<PreferenceSuggestionDto, 'version'>,
  workspaceId: string,
  action: PreferenceSuggestionAction,
  confirmGlobal = false,
): PreferenceSuggestionActionPayload {
  return {
    workspaceId,
    expectedVersion: suggestion.version,
    ...(action === 'confirm' && confirmGlobal ? { confirmGlobal: true } : {}),
  };
}

export function workspaceResponseIsCurrent(
  requestWorkspaceId: string,
  activeWorkspaceId: string,
  requestGeneration: number,
  currentGeneration: number,
): boolean {
  return requestWorkspaceId === activeWorkspaceId && requestGeneration === currentGeneration;
}

export function isMemoryVersionConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b409\b|VERSION_CONFLICT|VERSION_SKEW|CANDIDATE_NOT_REVIEWABLE|CONFLICT_NOT_RESOLVABLE/i.test(message)) return true;
  // ApiProblem responses carry the stable code on the thrown error as `code`.
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /VERSION_CONFLICT|VERSION_SKEW|CANDIDATE_NOT_REVIEWABLE|CONFLICT_NOT_RESOLVABLE/i.test(code);
}

export function memoryVersionConflictGuidance(error: unknown): string | undefined {
  return isMemoryVersionConflict(error)
    ? '这条记录已被其他操作更新。请重新加载最新版本后再试。'
    : undefined;
}

export function memoryDateTimeLocalValue(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function memoryDateTimeToIso(value: string): string | null | undefined {
  if (value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
