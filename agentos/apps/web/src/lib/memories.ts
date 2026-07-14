import type { MemoryRecord, MemoryType } from '@agentos/shared';

export interface MemoryFormValues {
  type: MemoryType;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  relatedFiles: string[];
  importance: number;
  confidence: number;
}

export const memoryTypeLabels: Record<MemoryType, string> = { overview: '项目概览', convention: '开发规范', decision: '架构决策', experience: '问题经验' };

export function validateMemoryForm(input: MemoryFormValues): string | undefined {
  if (!input.title.trim()) return '请输入记忆标题';
  if (!input.summary.trim()) return '请输入摘要';
  if (!Number.isInteger(input.importance) || input.importance < 0 || input.importance > 100) return '重要性必须是 0 到 100';
  if (!Number.isInteger(input.confidence) || input.confidence < 0 || input.confidence > 100) return '置信度必须是 0 到 100';
  return undefined;
}

export function memoryQuery(status: 'active' | 'archived' | 'all', type: MemoryType | 'all', query: string): string {
  const params = new URLSearchParams();
  if (status !== 'active') params.set('status', status);
  if (type !== 'all') params.set('type', type);
  if (query.trim()) params.set('query', query.trim());
  return params.toString();
}

export function memoryPreview(memory: MemoryRecord): string {
  return memory.summary.trim() || memory.title;
}
