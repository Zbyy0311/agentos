export type ReviewerDecision = 'pass' | 'block' | 'unknown';
export type FinalDecision = 'approve' | 'reject' | 'modify' | 'unknown';

export interface WorkerEvidenceParseResult {
  hasChecksRun: boolean;
  hasFindings: boolean;
  hasEvidence: boolean;
  legacyPlanOnly: boolean;
}

function sectionHasContent(stdout: string, title: string): boolean {
  const normalizedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `(?:^|\\n)#{1,6}\\s*(?:\\d+\\.\\s*)?${normalizedTitle}\\s*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s|$)`,
    'i',
  );
  const match = stdout.match(regex);
  return Boolean(match?.[1]?.trim());
}

function extractLabeledDecision(stdout: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\s*:\\s*(approve|reject|modify|pass|block)`, 'i');
  const match = stdout.match(regex);
  return match?.[1]?.toLowerCase() ?? null;
}

export function parseWorkerEvidence(stdout: string): WorkerEvidenceParseResult {
  const hasChecksRun = sectionHasContent(stdout, 'Checks Run');
  const hasFindings = sectionHasContent(stdout, 'Findings by Severity');
  const hasEvidence = sectionHasContent(stdout, 'Evidence');
  const legacyPlanOnly =
    !hasChecksRun &&
    !hasFindings &&
    !hasEvidence &&
    (sectionHasContent(stdout, 'Implementation Plan') || sectionHasContent(stdout, 'Proposed Code Changes'));

  return { hasChecksRun, hasFindings, hasEvidence, legacyPlanOnly };
}

export function parseReviewerDecision(stdout: string): ReviewerDecision {
  const decision = extractLabeledDecision(stdout, 'Decision');
  if (decision === 'pass' || decision === 'block') return decision;
  return 'unknown';
}

export function parseFinalDecision(stdout: string): FinalDecision {
  const sectionDecision = extractLabeledDecision(stdout, 'Final Decision');
  if (sectionDecision === 'approve' || sectionDecision === 'reject' || sectionDecision === 'modify') {
    return sectionDecision;
  }

  const fallback = extractLabeledDecision(stdout, 'Decision');
  if (fallback === 'approve' || fallback === 'reject' || fallback === 'modify') {
    return fallback;
  }

  return 'unknown';
}
