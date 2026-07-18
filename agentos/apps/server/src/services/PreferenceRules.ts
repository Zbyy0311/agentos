import type { PreferenceContextKind, PreferenceDimension, PreferenceEvidence, PreferenceScope } from '@agentos/shared';

export const PREFERENCE_CONTEXTS: readonly PreferenceContextKind[] = ['coding', 'debugging', 'planning', 'review', 'explanation', 'general'];

export const PREFERENCE_DIMENSIONS: readonly PreferenceDimension[] = [
  'response_language', 'response_detail', 'execution_style', 'clarification_style', 'change_scope',
  'verification_depth', 'progress_update_style', 'delivery_format', 'tooling_habit',
];

export const PREFERENCE_VALUES: Readonly<Record<PreferenceDimension, readonly string[]>> = {
  response_language: ['chinese', 'english', 'follow_user'],
  response_detail: ['concise', 'balanced', 'detailed'],
  execution_style: ['direct_execution', 'plan_first', 'contextual'],
  clarification_style: ['ask_when_blocked', 'make_safe_assumptions'],
  change_scope: ['surgical', 'broad_refactor'],
  verification_depth: ['minimal', 'targeted', 'full_flow'],
  progress_update_style: ['concise_updates', 'frequent_updates', 'silent_until_done'],
  delivery_format: ['summary_commands_validation', 'summary_only', 'full_report'],
  tooling_habit: ['use_existing_tools', 'prefer_cli', 'prefer_browser'],
};

export const EVIDENCE_WEIGHTS = {
  direct_correction: 4,
  repeated_instruction: 3,
  workflow_choice: 2,
  successful_application: 1,
  rework: 3,
  conflict: 4,
} as const;

export const PROMOTION_THRESHOLDS = {
  provisionalScore: 6,
  provisionalRuns: 2,
  stableScore: 12,
  stableRuns: 4,
  dormantScore: 0,
  closeConfidenceDelta: 10,
  successScoreCap: 3,
} as const;

export const MAX_SUCCESS_EVIDENCE_PER_KEY = 4;

export function normalizePreferenceEvidence(input: PreferenceEvidence): PreferenceEvidence | undefined {
  if (!input.id || !input.profileId || !input.conversationId || !input.runId || !input.sourceEventId) return undefined;
  if (!PREFERENCE_DIMENSIONS.includes(input.dimension)) return undefined;
  if (!PREFERENCE_CONTEXTS.includes(input.contextKind)) return undefined;
  if (!PREFERENCE_VALUES[input.dimension].includes(input.candidateValue)) return undefined;
  if (!Number.isInteger(input.weight) || input.weight < 1 || input.weight > 4) return undefined;
  if (!input.summary.trim() || input.summary.length > 160) return undefined;
  if (!input.observedAt || !input.createdAt) return undefined;
  return { ...input, summary: input.summary.trim(), weight: Math.abs(input.weight) };
}

export function calculatePreferenceProjection(
  input: PreferenceEvidence[],
  scope: PreferenceScope,
  workspaceId?: string,
) {
  const evidence = input
    .map(normalizePreferenceEvidence)
    .filter((item): item is PreferenceEvidence => Boolean(item))
    .filter(item => item.status === 'active')
    .filter(item => scope === 'global' ? true : item.workspaceId === workspaceId);
  if (scope === 'workspace' && !workspaceId) return undefined;
  if (evidence.length === 0) return undefined;

  const globalWorkspaceIds = new Set(evidence.map(item => item.workspaceId).filter((id): id is string => Boolean(id)));
  const globalConversationIds = new Set(evidence.map(item => item.conversationId));
  const dates = evidence.map(item => Date.parse(item.observedAt)).filter(Number.isFinite);
  const span = dates.length > 1 ? Math.max(...dates) - Math.min(...dates) : 0;
  if (scope === 'global' && globalWorkspaceIds.size < 2 && !(globalConversationIds.size >= 3 && span >= 7 * 24 * 60 * 60 * 1000)) {
    return undefined;
  }

  const groups = new Map<string, PreferenceEvidence[]>();
  for (const item of evidence) {
    const key = `${item.dimension}:${item.contextKind}:${item.candidateValue}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const selected = [...groups.values()].sort((a, b) => scoreEvidence(b) - scoreEvidence(a))[0];
  if (!selected || selected.length === 0) return undefined;
  const first = selected[0];
  const score = scoreEvidence(selected);
  const allRelevant = evidence
    .filter(item => item.dimension === first.dimension && item.contextKind === first.contextKind)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const recentThree = allRelevant.slice(-3);
  const recentFour = allRelevant.slice(-4);
  const negativeRecent = recentThree.filter(item => item.polarity === 'negative' && item.weight >= 3).length;
  const hasRecentStrongConflict = recentFour.some(item => item.polarity === 'negative' && item.weight >= 4);
  const runCount = new Set(selected.map(item => item.runId)).size;
  const status = score < PROMOTION_THRESHOLDS.dormantScore || negativeRecent >= 2
    ? 'dormant'
    : runCount >= PROMOTION_THRESHOLDS.stableRuns && score >= PROMOTION_THRESHOLDS.stableScore && !hasRecentStrongConflict
      ? 'stable'
      : runCount >= PROMOTION_THRESHOLDS.provisionalRuns && score >= PROMOTION_THRESHOLDS.provisionalScore
        ? 'provisional'
        : 'observed';
  const latest = [...selected].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const lastSupported = [...selected].filter(item => item.polarity === 'positive').pop() ?? latest[latest.length - 1];
  const lastConflict = [...allRelevant].filter(item => item.polarity === 'negative').pop();
  const updatedAt = latest[latest.length - 1].observedAt;
  return {
    id: `preference:${first.profileId}:${scope}:${workspaceId ?? 'global'}:${first.dimension}:${first.contextKind}`,
    profileId: first.profileId,
    scope,
    ...(workspaceId ? { workspaceId } : {}),
    dimension: first.dimension,
    contextKind: first.contextKind,
    preferredValue: first.candidateValue,
    confidence: clampConfidence(score),
    score,
    evidenceCount: selected.length,
    independentRunCount: runCount,
    status,
    lastSupportedAt: lastSupported.observedAt,
    ...(lastConflict ? { lastConflictedAt: lastConflict.observedAt } : {}),
    createdAt: latest[0].createdAt,
    updatedAt,
  } as const;
}

function scoreEvidence(evidence: PreferenceEvidence[]): number {
  let successfulScore = 0;
  return evidence.reduce((score, item) => {
    const signed = item.polarity === 'negative' ? -item.weight : item.weight;
    if (item.signalType === 'successful_application' && item.polarity === 'positive') {
      const remaining = Math.max(0, PROMOTION_THRESHOLDS.successScoreCap - successfulScore);
      const contribution = Math.min(remaining, item.weight);
      successfulScore += contribution;
      return score + contribution;
    }
    return score + signed;
  }, 0);
}

function clampConfidence(score: number): number {
  return Math.max(0, Math.min(100, Math.round(50 + score * 3)));
}
