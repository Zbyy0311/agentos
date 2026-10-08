import type {
  MemoryFeedbackActionDtoV1,
  MemoryFeedbackActionApplyRequestV1,
  MemoryFeedbackResolutionKindV1,
  MemoryFeedbackResolutionDtoV1,
  MemoryVersionFeedbackDtoV1,
  MemoryVersionFeedbackRequestV1,
} from '@agentos/shared';
import type { MemoryContextKind, MemoryContextRecord, MemoryContextSelection } from './memoryContexts.js';
import { memoryEntryPath, type MemoryEntryDto } from '@/lib/memoryEntries';

export type MemoryFeedbackKind = MemoryVersionFeedbackRequestV1['kind'];
export type MemoryFeedbackActionKind = 'correction' | 'revalidation';
export type MemoryFeedbackActionStatus = 'pending' | 'resolved' | 'rejected';
export type MemoryFeedbackResolutionKind = MemoryFeedbackResolutionKindV1;
export type MemoryFeedbackActionApplyDetails = Omit<MemoryFeedbackActionApplyRequestV1, 'expectedActionVersion' | 'expectedEntryVersion'>;
export type MemoryFeedbackActionDto = MemoryFeedbackActionDtoV1;
export type MemoryFeedbackResolutionDto = MemoryFeedbackResolutionDtoV1;
export type MemoryVersionFeedbackDto = MemoryVersionFeedbackDtoV1;

const ACTION_DTO_KEYS = ['id', 'feedbackId', 'workspaceId', 'memoryId', 'memoryVersion', 'action', 'status',
  'version', 'resolvedByWorkspaceId', 'createdAt', 'resolution'] as const;
const RESOLUTION_DTO_KEYS = ['resolverWorkspaceId', 'expectedActionVersion', 'expectedEntryVersion',
  'resolvedEntryVersion', 'resolution', 'conclusion', 'evidence', 'createdAt'] as const;
const FEEDBACK_DTO_KEYS = ['id', 'workspaceId', 'memoryId', 'memoryVersion', 'currentEntryVersion',
  'contextKind', 'contextId', 'contextHash', 'kind', 'comment', 'createdAt', 'action'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.length && ownKeys.every(key => keys.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function positiveVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isMemoryFeedbackResolutionDto(value: unknown): value is MemoryFeedbackResolutionDto {
  if (!isRecord(value) || !hasExactKeys(value, RESOLUTION_DTO_KEYS)) return false;
  return (value.resolverWorkspaceId === null || nonEmptyString(value.resolverWorkspaceId))
    && positiveVersion(value.expectedActionVersion)
    && positiveVersion(value.expectedEntryVersion)
    && positiveVersion(value.resolvedEntryVersion)
    && value.resolvedEntryVersion === value.expectedEntryVersion + 1
    && ['corrected', 'archived', 'revalidated'].includes(String(value.resolution))
    && nonEmptyString(value.conclusion) && nonEmptyString(value.evidence) && nonEmptyString(value.createdAt);
}

export function isMemoryFeedbackActionDto(value: unknown): value is MemoryFeedbackActionDto {
  if (!isRecord(value) || !hasExactKeys(value, ACTION_DTO_KEYS)) return false;
  if (!nonEmptyString(value.id) || !nonEmptyString(value.feedbackId) || !nonEmptyString(value.workspaceId)
    || !nonEmptyString(value.memoryId) || !positiveVersion(value.memoryVersion)
    || !['correction', 'revalidation'].includes(String(value.action))
    || !['pending', 'resolved', 'rejected'].includes(String(value.status))
    || !positiveVersion(value.version)
    || !(value.resolvedByWorkspaceId === null || nonEmptyString(value.resolvedByWorkspaceId))
    || !nonEmptyString(value.createdAt)
    || !(value.resolution === null || isMemoryFeedbackResolutionDto(value.resolution))) return false;
  if (value.status === 'pending') return value.resolvedByWorkspaceId === null && value.resolution === null;
  if (value.status === 'rejected') return value.resolution === null;
  if (value.resolvedByWorkspaceId === null
    && (value.resolution === null || value.resolution.resolverWorkspaceId === null)) return true;
  return value.resolvedByWorkspaceId !== null && value.resolution !== null
    && value.resolution.resolverWorkspaceId === value.resolvedByWorkspaceId
    && value.resolution.expectedActionVersion + 1 === value.version;
}

export function isMemoryVersionFeedbackDto(value: unknown): value is MemoryVersionFeedbackDto {
  if (!isRecord(value) || !hasExactKeys(value, FEEDBACK_DTO_KEYS)) return false;
  if (!nonEmptyString(value.id) || !nonEmptyString(value.workspaceId) || !nonEmptyString(value.memoryId)
    || !positiveVersion(value.memoryVersion) || !positiveVersion(value.currentEntryVersion)
    || !['run', 'stage', 'turn', 'legacy-execution'].includes(String(value.contextKind))
    || !nonEmptyString(value.contextId) || !/^[0-9a-f]{64}$/i.test(String(value.contextHash))
    || !['helpful', 'wrong', 'outdated'].includes(String(value.kind))
    || typeof value.comment !== 'string' || !nonEmptyString(value.createdAt)
    || !(value.action === null || isMemoryFeedbackActionDto(value.action))) return false;
  if (value.action !== null) {
    return value.action.feedbackId === value.id && value.action.workspaceId === value.workspaceId
      && value.action.memoryId === value.memoryId && value.action.memoryVersion === value.memoryVersion;
  }
  return true;
}

export function parseMemoryFeedbackActionsResponse(value: unknown): readonly MemoryFeedbackActionDto[] | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['actions']) || !Array.isArray(value.actions)
    || !value.actions.every(isMemoryFeedbackActionDto)) return undefined;
  return value.actions;
}

export function parseMemoryVersionFeedbackResponse(value: unknown): MemoryVersionFeedbackDto | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['feedback']) || !isMemoryVersionFeedbackDto(value.feedback)) return undefined;
  return value.feedback;
}

export function parseMemoryVersionFeedbackListResponse(value: unknown): readonly MemoryVersionFeedbackDto[] | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['feedback']) || !Array.isArray(value.feedback)
    || !value.feedback.every(isMemoryVersionFeedbackDto)) return undefined;
  return value.feedback;
}

export function parseMemoryFeedbackActionResult(value: unknown): {
  readonly action: MemoryFeedbackActionDto;
  readonly entry?: MemoryEntryDto;
} | undefined {
  if (!isRecord(value) || !isMemoryFeedbackActionDto(value.action)
    || !(Object.keys(value).length === 1 && Object.hasOwn(value, 'action')
      || Object.keys(value).length === 2 && Object.hasOwn(value, 'action') && Object.hasOwn(value, 'entry'))
    || (Object.hasOwn(value, 'entry') && (!isRecord(value.entry)
      || !nonEmptyString(value.entry.id) || !nonEmptyString(value.entry.workspaceId)
      || !positiveVersion(value.entry.version)))) return undefined;
  return { action: value.action, ...(Object.hasOwn(value, 'entry') ? { entry: value.entry as unknown as MemoryEntryDto } : {}) };
}

export interface MemoryFeedbackActionResolutionPayload {
  readonly expectedVersion: number;
  readonly status: 'rejected';
}

export interface MemoryAutoAcceptPolicyDto {
  readonly enabled: boolean;
  readonly version: number;
}

export interface MemoryAutoAcceptPolicyPayload {
  readonly expectedVersion: number;
  readonly enabled: boolean;
}

export interface MemoryFeedbackActionView {
  readonly action: MemoryFeedbackActionDto;
  readonly feedback: MemoryVersionFeedbackDto | null;
}

export interface MemoryFeedbackRequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
}

export interface MemoryFeedbackRequester {
  <T = unknown>(path: string, options?: MemoryFeedbackRequestOptions): Promise<T>;
}

export function memoryFeedbackPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/memory/feedback`;
}

export function memoryFeedbackActionsPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/memory/feedback-actions`;
}

export function memoryFeedbackActionResolvePath(workspaceId: string, actionId: string): string {
  return `${memoryFeedbackActionsPath(workspaceId)}/${encodeURIComponent(actionId)}/resolve`;
}

export function memoryAutoAcceptPolicyPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/memory/auto-accept-policy`;
}

export function memoryAutoAcceptPolicyPayload(
  policy: MemoryAutoAcceptPolicyDto,
  enabled: boolean,
): MemoryAutoAcceptPolicyPayload {
  return { expectedVersion: policy.version, enabled };
}

export function isMemoryAutoAcceptPolicyDto(value: unknown): value is MemoryAutoAcceptPolicyDto {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return typeof policy.enabled === 'boolean'
    && typeof policy.version === 'number'
    && Number.isSafeInteger(policy.version)
    && policy.version >= 0;
}

export function memoryFeedbackResponseIsCurrent(
  requestWorkspaceId: string,
  activeWorkspaceId: string,
  requestGeneration: number,
  currentGeneration: number,
): boolean {
  return requestWorkspaceId === activeWorkspaceId && requestGeneration === currentGeneration;
}

export function canProvideMemoryVersionFeedback(
  contextKind: MemoryContextKind,
  selection: Pick<MemoryContextSelection, 'memoryVersion' | 'store'>,
): boolean {
  return Number.isSafeInteger(selection.memoryVersion)
    && (selection.memoryVersion ?? 0) >= 1
    && selection.store !== 'legacy'
    && (contextKind !== 'legacy-execution' || selection.store === 'canonical');
}

function isEntryNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b|MEMORY_ENTRY_NOT_FOUND|MEMORY_ENTRY_UNAVAILABLE|MEMORY_FEEDBACK_ENTRY_UNAVAILABLE/i.test(message);
}

function entryNotFoundGuidance(): Error {
  return new Error('当前工作区无法读取或反馈这条正式记忆（404），未提交反馈。若这是全局记忆，请确认服务端已授权当前工作区读取并反馈后再试。');
}

export function buildMemoryVersionFeedbackPayload(
  entry: Pick<MemoryEntryDto, 'version'>,
  context: Pick<MemoryContextRecord, 'id' | 'kind'>,
  selection: Pick<MemoryContextSelection, 'memoryId' | 'memoryVersion' | 'store'>,
  kind: MemoryFeedbackKind,
  comment = '',
): MemoryVersionFeedbackRequestV1 {
  if (!canProvideMemoryVersionFeedback(context.kind, selection) || selection.memoryVersion === null) {
    throw new Error('此历史选择没有可反馈的正式记忆版本');
  }
  const trimmedComment = comment.trim();
  return {
    expectedVersion: entry.version,
    memoryId: selection.memoryId,
    memoryVersion: selection.memoryVersion,
    contextId: context.id,
    contextKind: context.kind,
    kind,
    ...(trimmedComment ? { comment: trimmedComment } : {}),
  };
}

/** Reads the live Entry version immediately before posting feedback for a frozen selection. */
export async function submitMemoryVersionFeedback(
  request: MemoryFeedbackRequester,
  workspaceId: string,
  context: Pick<MemoryContextRecord, 'id' | 'kind'>,
  selection: Pick<MemoryContextSelection, 'memoryId' | 'memoryVersion' | 'store'>,
  kind: MemoryFeedbackKind,
  comment = '',
  isCurrent: () => boolean = () => true,
): Promise<MemoryVersionFeedbackDto | undefined> {
  if (!canProvideMemoryVersionFeedback(context.kind, selection)) {
    throw new Error('此历史选择没有可反馈的正式记忆版本');
  }
  let entryResult: { entry: MemoryEntryDto };
  try {
    entryResult = await request<{ entry: MemoryEntryDto }>(memoryEntryPath(workspaceId, selection.memoryId));
  } catch (error) {
    if (isEntryNotFound(error)) throw entryNotFoundGuidance();
    throw error;
  }
  if (!isCurrent()) return undefined;
  const entry = entryResult.entry;
  if (!entry || entry.id !== selection.memoryId
    || (entry.workspaceId !== workspaceId && entry.scope !== 'global')
    || !Number.isSafeInteger(entry.version) || entry.version < 1) {
    throw new Error('正式记忆响应与当前工作区或历史选择不匹配');
  }
  const payload = buildMemoryVersionFeedbackPayload(entry, context, selection, kind, comment);
  let response: unknown;
  try {
    response = await request<unknown>(memoryFeedbackPath(workspaceId), {
      method: 'POST',
      body: payload,
    });
  } catch (error) {
    if (isEntryNotFound(error)) throw entryNotFoundGuidance();
    throw error;
  }
  const feedback = parseMemoryVersionFeedbackResponse(response);
  if (!feedback) throw new Error('记忆反馈接口响应格式无效');
  return feedback;
}

export function memoryFeedbackActionResolutionPayload(
  action: Pick<MemoryFeedbackActionDto, 'version'>,
  status: 'rejected',
): MemoryFeedbackActionResolutionPayload {
  return { expectedVersion: action.version, status };
}

export function memoryFeedbackActionApplyPayload(
  action: Pick<MemoryFeedbackActionDto, 'version'>,
  entry: Pick<MemoryEntryDto, 'version'>,
  details: MemoryFeedbackActionApplyDetails,
): MemoryFeedbackActionApplyRequestV1 {
  return {
    expectedActionVersion: action.version,
    expectedEntryVersion: entry.version,
    ...details,
  };
}

/** The route workspace is the acting owner; action.workspaceId remains the reporter workspace. */
export function memoryFeedbackActionResponseMatchesRequest(
  requestedAction: Pick<MemoryFeedbackActionDto, 'id' | 'workspaceId'>,
  returnedAction: Pick<MemoryFeedbackActionDto, 'id' | 'workspaceId' | 'status' | 'resolvedByWorkspaceId' | 'resolution'> | null | undefined,
  actorWorkspaceId: string,
): boolean {
  return returnedAction !== null && returnedAction !== undefined
    && returnedAction.id === requestedAction.id
    && returnedAction.workspaceId === requestedAction.workspaceId
    && returnedAction.status !== 'pending'
    && returnedAction.resolvedByWorkspaceId === actorWorkspaceId
    && (returnedAction.status !== 'resolved'
      || returnedAction.resolution?.resolverWorkspaceId === actorWorkspaceId);
}

export function joinMemoryFeedbackActions(
  actions: readonly MemoryFeedbackActionDto[],
  feedback: readonly MemoryVersionFeedbackDto[],
): MemoryFeedbackActionView[] {
  const feedbackById = new Map(feedback.map(item => [item.id, item]));
  return actions.map(action => ({ action, feedback: feedbackById.get(action.feedbackId) ?? null }));
}
