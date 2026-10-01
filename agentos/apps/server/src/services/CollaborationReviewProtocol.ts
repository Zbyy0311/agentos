import type { CollaborationReviewConclusion } from '@agentos/shared';

export interface ParsedCollaborationReview {
  readonly candidateId: string;
  readonly candidateHash: string;
  readonly runId: string;
  readonly stageAttempt: number;
  readonly reviewerAgentId: string;
  readonly conclusion: CollaborationReviewConclusion;
  readonly summary: string;
}

export interface CollaborationReviewBinding {
  readonly candidateId: string;
  readonly candidateHash: string;
  readonly runId: string;
  readonly stageAttempt: number;
  readonly reviewerAgentId: string;
}

export type CollaborationReviewValidation =
  | { readonly valid: true; readonly review: ParsedCollaborationReview }
  | { readonly valid: false; readonly reason: string };

const MAX_REVIEW_BYTES = 16_384;
const MAX_SUMMARY_BYTES = 8_192;
const REVIEW_WRAPPERS = new Set(['agentosCollaborationReview', 'agentosArtifact']);

interface ReviewParseFailure {
  readonly reason: string;
}

type ReviewParseResult =
  | { readonly review: ParsedCollaborationReview }
  | ReviewParseFailure;

/** Extract complete top-level JSON objects without interpreting braces in strings. */
function extractJsonObjects(value: string): string[] {
  const results: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && depth > 0) {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return results;
}

function parseReview(value: string | undefined): ReviewParseResult {
  if (!value || !value.trim()) return { reason: '评审阶段未返回结构化结论' };
  if (Buffer.byteLength(value, 'utf8') > MAX_REVIEW_BYTES) return { reason: '评审结论超过长度上限' };

  const envelopes: Array<{ wrapperKey: string; value: Record<string, unknown> }> = [];
  for (const json of extractJsonObjects(value)) {
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const top = parsed as Record<string, unknown>;
    for (const wrapperKey of REVIEW_WRAPPERS) {
      const wrapped = top[wrapperKey];
      if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
        envelopes.push({ wrapperKey, value: wrapped as Record<string, unknown> });
      }
    }
  }
  if (envelopes.length === 0) return { reason: '评审结论中没有可识别的 AgentOS 评审 JSON 对象' };
  if (envelopes.length !== 1) return { reason: '评审结论包含多个结构化评审对象，无法唯一判定' };

  const { wrapperKey, value: row } = envelopes[0]!;
  const required = ['candidateHash', 'candidateId', 'conclusion', 'reviewerAgentId', 'runId', 'stageAttempt', 'summary', 'version'];
  if (wrapperKey === 'agentosArtifact') required.push('type');
  const missing = required.filter(key => !(key in row));
  if (missing.length > 0) return { reason: `评审结论缺少必需字段：${missing.join('、')}` };
  const invalid: string[] = [];
  if (row.version !== 1) invalid.push('version');
  if (wrapperKey === 'agentosArtifact' && row.type !== 'review') invalid.push('type');
  for (const key of ['candidateId', 'candidateHash', 'runId', 'reviewerAgentId']) {
    if (typeof row[key] !== 'string' || !row[key]) invalid.push(key);
  }
  if (!Number.isSafeInteger(row.stageAttempt) || (row.stageAttempt as number) < 1) invalid.push('stageAttempt');
  if (row.conclusion !== 'approved' && row.conclusion !== 'changes_requested') invalid.push('conclusion');
  if (typeof row.summary !== 'string' || !row.summary.trim()) invalid.push('summary');
  else if (Buffer.byteLength(row.summary, 'utf8') > MAX_SUMMARY_BYTES) invalid.push('summary(length)');
  if (invalid.length > 0) return { reason: `评审结论字段格式无效：${invalid.join('、')}` };

  return {
    review: {
      candidateId: row.candidateId as string,
      candidateHash: row.candidateHash as string,
      runId: row.runId as string,
      stageAttempt: row.stageAttempt as number,
      reviewerAgentId: row.reviewerAgentId as string,
      conclusion: row.conclusion as CollaborationReviewConclusion,
      summary: (row.summary as string).trim(),
    },
  };
}

/**
 * Review output is deliberately strict: tolerate a single JSON Markdown fence
 * and the shared AgentOS artifact envelope, but never search prose for a
 * JSON-looking object that could be ambiguous. Both envelopes still require
 * every immutable collaboration binding before they can authorize a review.
 */
export function parseCollaborationReview(value: string | undefined): ParsedCollaborationReview | undefined {
  const result = parseReview(value);
  return 'review' in result ? result.review : undefined;
}

export function collaborationReviewMatchesBinding(
  review: ParsedCollaborationReview,
  expected: CollaborationReviewBinding,
): boolean {
  return review.candidateId === expected.candidateId
    && review.candidateHash === expected.candidateHash
    && review.runId === expected.runId
    && review.stageAttempt === expected.stageAttempt
    && review.reviewerAgentId === expected.reviewerAgentId;
}

/** Safe validation details for UI diagnostics; never returns untrusted values. */
export function validateCollaborationReview(
  value: string | undefined,
  expected: CollaborationReviewBinding,
): CollaborationReviewValidation {
  const parsed = parseReview(value);
  if (!('review' in parsed)) return { valid: false, reason: parsed.reason };
  const review = parsed.review;
  const mismatches: string[] = [];
  if (review.candidateId !== expected.candidateId) mismatches.push('候选 ID');
  if (review.candidateHash !== expected.candidateHash) mismatches.push('候选哈希');
  if (review.runId !== expected.runId) mismatches.push('Run');
  if (review.stageAttempt !== expected.stageAttempt) mismatches.push('阶段 attempt');
  if (review.reviewerAgentId !== expected.reviewerAgentId) mismatches.push('评审 Agent');
  return mismatches.length === 0
    ? { valid: true, review }
    : { valid: false, reason: `评审结论的${mismatches.join('、')}与冻结执行不匹配` };
}

export function buildCollaborationReviewPrompt(binding: CollaborationReviewBinding): string {
  return [
    'Review only this frozen candidate snapshot. It is isolated from the implementation workspace.',
    `Candidate ID (copy exactly): ${binding.candidateId}`,
    `Candidate SHA-256 (copy exactly): ${binding.candidateHash}`,
    'The Candidate SHA-256 printed immediately above is the authoritative frozen patch digest used for review binding. Copy it exactly. Do not substitute or recompute a per-file, manifest, or file-list aggregate hash mentioned in another report.',
    `Canonical Run ID (copy exactly): ${binding.runId}`,
    `Review stage attempt (copy exactly as a JSON number): ${binding.stageAttempt}`,
    `Reviewer Agent ID (copy exactly): ${binding.reviewerAgentId}`,
    'Inspect the changed files and the recorded test evidence before deciding. Report concrete release-blocking findings; approve only when the candidate is acceptable and the evidence supports it.',
    'Your final response is consumed by a strict validator. Include exactly one structured review JSON object. Plain JSON or one ```json code fence is preferred; a short surrounding explanation is tolerated, but do not include a second review object or conflicting verdict.',
    'Use the shared AgentOS envelope: one top-level key named agentosArtifact. Its value must include these fields: version (number 1), type (exactly "review"), candidateId, candidateHash, runId, stageAttempt, reviewerAgentId, conclusion, summary. Additional evidence metadata may be included, but do not add alternative binding values or verdicts.',
    'Set the five binding fields to the exact values above. Set conclusion to exactly "approved" or "changes_requested" based on your independent review. Give summary a concise but substantive evidence-based reason; do not copy placeholders or the examples from instructions.',
    'Do not modify any file. Any change in this review workspace invalidates the review.',
  ].join('\n');
}
