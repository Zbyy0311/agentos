import type { AgentExecution } from '@agentos/shared';

type ExecutionEvidence = Pick<AgentExecution, 'runId' | 'status'>;

export function getDoneExecution<T extends ExecutionEvidence>(payload: {
  execution?: T;
  executions?: T[];
}): T | undefined {
  return payload.execution ?? payload.executions?.at(-1);
}
