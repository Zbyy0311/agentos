import type { MemoryCandidateOperation, MemoryType, RunFileChange } from '@agentos/shared';

export interface MemoryExtractionInput {
  objective: string;
  resultSummary: string;
  fileChanges: RunFileChange[];
  visibleReplies: string[];
}

export interface MemoryCandidateDraft {
  type: MemoryType;
  title: string;
  summary: string;
  content: string;
  confidence: number;
  operation: MemoryCandidateOperation;
}

export type MemoryExtractionReason = 'explicit_marker' | 'public_evidence' | 'no_valuable_public_evidence';

export interface MemoryExtractionResult {
  drafts: MemoryCandidateDraft[];
  reason: MemoryExtractionReason;
}

const MEMORY_TYPES = new Set<MemoryType>(['overview', 'convention', 'decision', 'experience']);
const OPERATIONS = new Set<MemoryCandidateOperation>(['create', 'update', 'merge', 'ignore']);

export class MemoryExtractor {
  extract(input: MemoryExtractionInput): MemoryExtractionResult {
    const publicText = [input.resultSummary, ...input.visibleReplies].filter(Boolean).join('\n\n');
    const drafts: MemoryCandidateDraft[] = [];
    const payloads = findCandidatePayloads(publicText);
    for (const rawJson of payloads) {
      try {
        const value: unknown = JSON.parse(rawJson);
        const draft = validateDraft(value);
        if (draft) drafts.push(draft);
      } catch {
        // A malformed marker means no candidate for that marker; the Run stays completed.
      }
      if (drafts.length >= 3) break;
    }
    if (payloads.length > 0) return { drafts, reason: 'explicit_marker' };

    const publicEvidence = [input.objective, input.resultSummary, ...input.visibleReplies]
      .map(value => value.trim())
      .filter(Boolean)
      .join('\n');
    if (!hasValuablePublicEvidence(publicEvidence, input.fileChanges.length > 0)) {
      return { drafts: [], reason: 'no_valuable_public_evidence' };
    }

    if (input.fileChanges.length > 0) {
      drafts.push(createEvidenceDraft(input, 'experience', '执行经验'));
    }
    if (containsAny(publicEvidence, ['决定', '决策', '方案', '采用', '选用', 'decision', 'solution'])) {
      drafts.push(createEvidenceDraft(input, 'decision', '执行决策'));
    }
    if (containsAny(publicEvidence, ['规范', '约定', '必须', '统一', '禁止', 'convention', 'standard'])) {
      drafts.push(createEvidenceDraft(input, 'convention', '执行规范'));
    }
    if (drafts.length === 0) drafts.push(createEvidenceDraft(input, 'experience', '执行经验'));
    return { drafts: drafts.slice(0, 3), reason: 'public_evidence' };
  }
}

function hasValuablePublicEvidence(text: string, hasFileChanges: boolean): boolean {
  if (hasFileChanges) return true;
  if (text.length < 12) return false;
  return containsAny(text, [
    '决定', '决策', '方案', '规范', '约定', '修复', '验证', '测试', '迁移', '配置',
    '完成', '通过', '采用', '必须', 'fix', 'test', 'migrat', 'config', 'verified',
  ]) && !/^(已完成|完成|好的|好|已处理|处理好了)[。.!！\s]*$/i.test(text);
}

function containsAny(text: string, terms: string[]): boolean {
  const normalized = text.toLocaleLowerCase();
  return terms.some(term => normalized.includes(term.toLocaleLowerCase()));
}

function createEvidenceDraft(input: MemoryExtractionInput, type: MemoryType, label: string): MemoryCandidateDraft {
  const objective = truncate(input.objective.trim() || '公开执行任务', 120);
  const summary = truncate(input.resultSummary.trim() || input.visibleReplies.find(Boolean)?.trim() || '任务产生了可复用的公开执行证据。', 500);
  const files = input.fileChanges.map(change => `${change.changeType}: ${change.path}`).join('\n');
  const content = [
    `任务：${input.objective.trim() || '公开执行任务'}`,
    `结果：${input.resultSummary.trim() || input.visibleReplies.filter(Boolean).join('\n') || '未提供额外摘要。'}`,
    files ? `文件变更：\n${files}` : '',
  ].filter(Boolean).join('\n\n');
  return {
    type,
    title: `${label}：${objective}`,
    summary,
    content: truncate(content, 12000),
    confidence: input.fileChanges.length > 0 ? 85 : 75,
    operation: 'create',
  };
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function findCandidatePayloads(text: string): string[] {
  const payloads: string[] = [];
  const fenced = /```agentos-memory\s*\n([\s\S]*?)\n```/gi;
  for (const match of text.matchAll(fenced)) payloads.push(match[1]);
  const inline = /<!--\s*agentos-memory-candidate\s*:\s*(\{[\s\S]*?\})\s*-->/gi;
  for (const match of text.matchAll(inline)) payloads.push(match[1]);
  return payloads;
}

function validateDraft(value: unknown): MemoryCandidateDraft | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  const type = data.type;
  const operation = data.operation ?? 'create';
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
  const content = typeof data.content === 'string' ? data.content.trim() : '';
  const confidence = typeof data.confidence === 'number' ? data.confidence : Number(data.confidence);
  if (!MEMORY_TYPES.has(type as MemoryType) || !OPERATIONS.has(operation as MemoryCandidateOperation)) return undefined;
  if (!title || !summary || !content || !Number.isInteger(confidence) || confidence < 0 || confidence > 100) return undefined;
  if (title.length > 200 || summary.length > 1000 || content.length > 12000) return undefined;
  return { type: type as MemoryType, title, summary, content, confidence, operation: operation as MemoryCandidateOperation };
}
