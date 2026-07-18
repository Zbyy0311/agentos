import { randomUUID } from 'node:crypto';
import type { AgentExecution, AgentRun, PendingRunDecision, PartialWriteDecision, RunFileChange } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';

export const PARTIAL_WRITE_DECISIONS: PartialWriteDecision[] = ['keep_and_continue', 'retry_current', 'abort'];

export class RunDecisionService {
  constructor(private readonly store: SqliteStore) {}

  recordPartialWriteFailure(input: { workspaceId: string; run: AgentRun; execution: AgentExecution; fileChanges: RunFileChange[]; writeCapable: boolean }): PendingRunDecision | undefined {
    if (!input.writeCapable || input.fileChanges.length === 0) return undefined;
    const decision = this.store.createPendingRunDecision({
      id: randomUUID(), workspaceId: input.workspaceId, runId: input.run.id, executionId: input.execution.id,
      kind: 'partial_write_failure', fileChanges: input.fileChanges, allowedDecisions: PARTIAL_WRITE_DECISIONS, createdAt: new Date().toISOString(),
    });
    this.store.updateRun(input.workspaceId, input.run.id, {
      status: 'waiting_user', waitingQuestion: this.buildQuestion(input.fileChanges), waitingExecutionId: input.execution.id,
      waitingAgentId: input.execution.agentId, completedAt: undefined,
    });
    return decision;
  }

  get(workspaceId: string, runId: string): PendingRunDecision | undefined {
    return this.store.getPendingRunDecision(workspaceId, runId);
  }

  resolve(workspaceId: string, decisionId: string, decision: PartialWriteDecision): PendingRunDecision {
    return this.store.resolvePendingRunDecision(workspaceId, decisionId, decision);
  }

  private buildQuestion(fileChanges: RunFileChange[]): string {
    const paths = fileChanges.map(change => change.path).slice(0, 20).join(', ');
    return `写入执行失败，但已检测到文件变化：${paths}。请选择：保留并继续、重试当前步骤，或终止 Run。`;
  }
}
