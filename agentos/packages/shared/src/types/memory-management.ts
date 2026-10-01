/** Additive memory management contracts; runtime ownership stays per aggregate. */
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
  readonly exclusions:readonly {memoryId:string;reason:string}[]|null;
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
