import type { TaskItem, TaskLog } from '@agentos/shared';
import { parseFinalDecision, parseReviewerDecision, parseWorkerEvidence } from '@agentos/agent-core';

export function getWorkerEvidenceFailure(log: TaskLog): string | null {
  const parsed = parseWorkerEvidence(log.stdout);
  if (parsed.hasChecksRun && parsed.hasFindings && parsed.hasEvidence) return null;
  return 'worker produced no execution evidence';
}

export function applyFinalReviewDecision(task: TaskItem, finalLog: TaskLog): void {
  const finalDecision = parseFinalDecision(finalLog.stdout);
  const reviewerDecision = task.outputs
    .filter(log => log.stage === 'opencode_reviewer')
    .map(log => parseReviewerDecision(log.stdout))
    .find(decision => decision !== 'unknown') ?? 'unknown';
  const workerLog = task.outputs.find(log => log.stage === 'kimi_worker');
  const workerEvidenceBlocked = workerLog ? getWorkerEvidenceFailure(workerLog) !== null : false;

  task.status = 'completed';
  task.currentAgent = null;
  task.reviewDecision = finalDecision;
  task.reviewBlocked = workerEvidenceBlocked
    || reviewerDecision === 'block'
    || finalDecision === 'reject'
    || finalDecision === 'modify';
  task.updatedAt = new Date().toISOString();
}
