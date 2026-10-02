/** Additive memory management contracts; runtime ownership stays per aggregate. */
import type { MemoryScope } from './mf0-memory-contracts.js';

export type MemoryWorkspaceKnowledgePromotionScopeV1 = Extract<MemoryScope, 'task' | 'conversation' | 'run'>;

export interface MemoryWorkspaceKnowledgePromotionRequestV1 {
  readonly expectedVersion: number;
}

/** Immutable link between the exact source Entry version and its workspace copy. */
export interface MemoryEntrySourceBindingV1 {
  readonly workspaceId: string;
  readonly sourceEntryId: string;
  readonly sourceEntryVersion: number;
  readonly promotedEntryId: string;
  readonly promotedEntryVersion: number;
  readonly promotionEventId: string | null;
  readonly createdAt: string;
}

export interface MemoryWorkspaceKnowledgePromotionResponseV1<TEntry = unknown> {
  readonly outcome: 'created' | 'existing';
  readonly entry: TEntry;
  readonly sourceBinding: MemoryEntrySourceBindingV1;
}
export type MemoryContextOwnerKind = 'run'|'stage'|'turn'|'legacy-execution';
export interface MemoryVersionSelection {
  readonly memoryId:string; readonly memoryVersion:number|null; readonly rank:number;
  readonly tokenCost:number; readonly reasons:readonly string[];
}
export interface MemoryUsageContextV1 {
  readonly id:string; readonly workspaceId:string; readonly kind:MemoryContextOwnerKind;
  readonly ownerId:string|null; readonly contextText:string|null; readonly payloadAvailable:boolean;
  readonly queryHash:string|null; readonly totalTokens:number; readonly truncated:boolean;
  readonly retrievalStrategyVersion:string; readonly retrievalDegraded?:boolean;
  readonly selected:readonly MemoryVersionSelection[]|null;
  readonly exclusions:readonly {memoryId:string;memoryVersion?:number;reason:string}[]|null;
  readonly createdAt:string;
}
export interface MemoryLifecycleRequestV1 {
  readonly expectedVersion:number;
  readonly action:'archive'|'restore'|'delete'|'revalidate'|'set-validity';
  readonly validFrom?:string|null;readonly validUntil?:string|null;readonly expiresAt?:string|null;
}
export interface PreferenceConfirmationRequestV1 {
  readonly workspaceId:string;readonly expectedVersion:number;readonly confirmGlobal?:boolean;
}
export interface MemoryVersionFeedbackRequestV1 {
  readonly expectedVersion:number;readonly memoryId:string;readonly memoryVersion:number;
  readonly contextId:string;readonly contextKind:MemoryContextOwnerKind;
  readonly kind:'helpful'|'wrong'|'outdated';readonly comment?:string;
}
export type MemoryFeedbackResolutionKindV1 = 'corrected'|'archived'|'revalidated';
export interface MemoryFeedbackCorrectionV1 {
  readonly title:string;readonly summary?:string;readonly content:string;
}
export interface MemoryFeedbackResolutionV1 {
  readonly expectedActionVersion:number;
  readonly expectedEntryVersion:number;
  readonly resolvedEntryVersion:number;
  readonly resolution:MemoryFeedbackResolutionKindV1;
  readonly conclusion:string;
  readonly evidence:string;
  readonly createdAt:string;
}
/** Persisted resolution details; null resolver preserves legacy rows without actor provenance. */
export interface MemoryFeedbackResolutionDtoV1 extends MemoryFeedbackResolutionV1 {
  readonly resolverWorkspaceId:string|null;
}
/** Action identity remains the reporting workspace even when its global Entry owner resolves it. */
export interface MemoryFeedbackActionDtoV1 {
  readonly id:string; readonly feedbackId:string; readonly workspaceId:string; readonly memoryId:string;
  readonly memoryVersion:number; readonly action:'correction'|'revalidation';
  readonly status:'pending'|'resolved'|'rejected'; readonly version:number;
  readonly resolvedByWorkspaceId:string|null; readonly createdAt:string;
  readonly resolution:MemoryFeedbackResolutionDtoV1|null;
}
export interface MemoryVersionFeedbackDtoV1 {
  readonly id:string; readonly workspaceId:string; readonly memoryId:string;
  readonly memoryVersion:number; readonly currentEntryVersion:number;
  readonly contextKind:MemoryContextOwnerKind; readonly contextId:string; readonly contextHash:string;
  readonly kind:'helpful'|'wrong'|'outdated'; readonly comment:string; readonly createdAt:string;
  readonly action:MemoryFeedbackActionDtoV1|null;
}
/** A resolution must prove both the action CAS and the Entry version it applies to. */
export interface MemoryFeedbackActionApplyRequestV1 {
  readonly expectedActionVersion:number;
  readonly expectedEntryVersion:number;
  readonly resolution:MemoryFeedbackResolutionKindV1;
  readonly conclusion:string;
  readonly evidence:string;
  readonly correctedEntry?:MemoryFeedbackCorrectionV1;
}
/** Compatibility contract for clients that only reject a pending action. */
export interface MemoryFeedbackActionRejectRequestV1 {
  readonly expectedVersion:number;
  readonly status:'rejected';
}
