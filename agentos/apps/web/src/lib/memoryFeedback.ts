import type { MemoryVersionFeedbackRequestV1 } from '@agentos/shared';
import type { MemoryContextKind, MemoryContextRecord, MemoryContextSelection } from './memoryContexts.js';
import { memoryEntryPath, type MemoryEntryDto } from '@/lib/memoryEntries';

export type MemoryFeedbackKind = MemoryVersionFeedbackRequestV1['kind'];
export type MemoryFeedbackActionKind = 'correction' | 'revalidation';
export type MemoryFeedbackActionStatus = 'pending' | 'resolved' | 'rejected';
export type MemoryFeedbackActionResolution = Exclude<MemoryFeedbackActionStatus, 'pending'>;

export interface MemoryFeedbackActionDto {
  readonly id: string;
  readonly feedbackId: string;
  readonly workspaceId: string;
  readonly memoryId: string;
  readonly memoryVersion: number;
  readonly action: MemoryFeedbackActionKind;
  readonly status: MemoryFeedbackActionStatus;
  readonly version: number;
  readonly createdAt: string;
}

export interface MemoryVersionFeedbackDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly memoryId: string;
  readonly memoryVersion: number;
  readonly currentEntryVersion: number;
  readonly contextKind: MemoryContextKind;
  readonly contextId: string;
  readonly contextHash: string;
  readonly kind: MemoryFeedbackKind;
  readonly comment: string;
  readonly createdAt: string;
  readonly action: MemoryFeedbackActionDto | null;
}

export interface MemoryFeedbackActionResolutionPayload {
  readonly expectedVersion: number;
  readonly status: MemoryFeedbackActionResolution;
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
  let result: { feedback: MemoryVersionFeedbackDto };
  try {
    result = await request<{ feedback: MemoryVersionFeedbackDto }>(memoryFeedbackPath(workspaceId), {
      method: 'POST',
      body: payload,
    });
  } catch (error) {
    if (isEntryNotFound(error)) throw entryNotFoundGuidance();
    throw error;
  }
  return result.feedback;
}

export function memoryFeedbackActionResolutionPayload(
  action: Pick<MemoryFeedbackActionDto, 'version'>,
  status: MemoryFeedbackActionResolution,
): MemoryFeedbackActionResolutionPayload {
  return { expectedVersion: action.version, status };
}

export function joinMemoryFeedbackActions(
  actions: readonly MemoryFeedbackActionDto[],
  feedback: readonly MemoryVersionFeedbackDto[],
): MemoryFeedbackActionView[] {
  const feedbackById = new Map(feedback.map(item => [item.id, item]));
  return actions.map(action => ({ action, feedback: feedbackById.get(action.feedbackId) ?? null }));
}
