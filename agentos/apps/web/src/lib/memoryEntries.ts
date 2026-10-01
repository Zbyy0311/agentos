import {
  MEMORY_CATEGORIES,
  type MemoryAuthority,
  type MemoryCategory,
  type MemoryEntryStatus,
  type MemoryScope,
} from '@agentos/shared';

export interface MemoryEntrySourceDto {
  readonly kind: string;
  readonly id: string;
}

/** Client-side mirror of the server MemoryEntryRecord response DTO. */
export interface MemoryEntryDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly scope: MemoryScope;
  readonly ownerAgentId: string | null;
  readonly ownerConversationId: string | null;
  readonly ownerTaskId: string | null;
  readonly ownerRunId: string | null;
  readonly category: MemoryCategory;
  readonly authority: MemoryAuthority;
  readonly confidence: number;
  readonly importance: number;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly status: MemoryEntryStatus;
  readonly pinned: boolean;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly expiresAt: string | null;
  readonly exactContentHash: string | null;
  readonly normalizedTextHash: string | null;
  readonly tokenEstimate: number;
  readonly sensitivity: 'ordinary' | 'restricted';
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sources: readonly MemoryEntrySourceDto[];
}

export type MemoryEntryStatusFilter = 'active' | 'archived' | 'all';

export interface MemoryEntryFormValues {
  category: MemoryCategory;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  confidence: number;
  importance: number;
  pinned: boolean;
}

export const memoryCategoryLabels: Record<MemoryCategory, string> = {
  decision: '决策',
  knowledge: '知识',
  preference: '偏好',
  constraint: '约束',
  failure: '故障与失败',
  review: '评审',
  test: '测试',
  architecture: '架构',
  workflow: '工作流',
  provider: '服务提供方',
  environment: '环境',
  security: '安全',
  summary: '摘要',
  reference: '参考资料',
};

const memoryStatusLabels: Record<MemoryEntryStatus, string> = {
  candidate: '待审候选',
  active: '生效中',
  conflicted: '存在冲突',
  superseded: '已被替代',
  expired: '已过期',
  archived: '已归档',
  rejected: '已拒绝',
  deleted: '已删除',
};

const memoryScopeLabels: Record<MemoryScope, string> = {
  global: '全局',
  workspace: '工作区',
  agent: 'Agent',
  conversation: '会话',
  task: '任务',
  run: 'Run',
};

const memoryAuthorityLabels: Record<MemoryAuthority, string> = {
  'user-explicit': '用户明确提供',
  'system-verified': '系统已验证',
  'imported-verified': '导入并验证',
  'agent-derived': 'Agent 推导',
  'user-inferred': '用户偏好推测',
  unknown: '未知来源',
};

export function memoryCategoryLabel(category: string): string {
  return memoryCategoryLabels[category as MemoryCategory] ?? category;
}

export function memoryStatusLabel(status: MemoryEntryStatus): string {
  return memoryStatusLabels[status];
}

export function memoryScopeLabel(scope: MemoryScope): string {
  return memoryScopeLabels[scope];
}

export function memoryAuthorityLabel(authority: MemoryAuthority): string {
  return memoryAuthorityLabels[authority];
}

export function memoryEntryListQuery(
  status: MemoryEntryStatusFilter,
  category: MemoryCategory | 'all',
  query: string,
): string {
  const params = new URLSearchParams({ status });
  if (category !== 'all') params.set('category', category);
  if (query.trim()) params.set('query', query.trim());
  return params.toString();
}

export function memoryEntriesPath(workspaceId: string, query = ''): string {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/memory/entries`;
  return query ? `${base}?${query}` : base;
}

export function memoryEntryPath(workspaceId: string, entryId: string): string {
  return `${memoryEntriesPath(workspaceId)}/${encodeURIComponent(entryId)}`;
}

export function memoryEntryScoreToUnit(score: number): number {
  return score / 100;
}

export function memoryEntryUnitToScore(unit: number): number {
  if (!Number.isFinite(unit)) return 0;
  return Math.min(100, Math.max(0, unit * 100));
}

export function validateMemoryEntryForm(values: MemoryEntryFormValues): string | undefined {
  if (!values.title.trim()) return '请输入记忆标题';
  if (!values.content.trim()) return '请输入记忆正文';
  if (!MEMORY_CATEGORIES.includes(values.category)) return '请选择有效的记忆类别';
  if (!Number.isFinite(values.confidence) || values.confidence < 0 || values.confidence > 100) {
    return '置信度必须在 0 到 100 之间';
  }
  if (!Number.isFinite(values.importance) || values.importance < 0 || values.importance > 100) {
    return '重要性必须在 0 到 100 之间';
  }
  return undefined;
}

function editableFields(values: MemoryEntryFormValues) {
  return {
    category: values.category,
    title: values.title.trim(),
    summary: values.summary.trim(),
    content: values.content,
    tags: [...new Set(values.tags.map(tag => tag.trim()).filter(Boolean))],
    confidence: memoryEntryScoreToUnit(values.confidence),
    importance: memoryEntryScoreToUnit(values.importance),
    pinned: values.pinned,
  };
}

export function memoryEntryCreatePayload(values: MemoryEntryFormValues) {
  const { pinned: _pinned, ...fields } = editableFields(values);
  return {
    scope: 'workspace' as const,
    ...fields,
    sources: [] as const,
  };
}

export function memoryEntryUpdatePayload(entry: MemoryEntryDto, values: MemoryEntryFormValues) {
  return {
    expectedVersion: entry.version,
    ...editableFields(values),
  };
}

export function legacyMemoryFilename(id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 96);
  return `${safeId || 'legacy-memory'}.md`;
}

export function legacyMemoryMarkdown(title: string, summary: string, content: string): string {
  const heading = title.replace(/[\r\n]+/g, ' ').trim() || '旧版记忆';
  return [`# ${heading}`, summary.trim(), content.trim()].filter(Boolean).join('\n\n');
}

export const memoryEntryCategories = MEMORY_CATEGORIES;
