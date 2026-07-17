type ExecutionRef = { id: string; runId: string };
type RunRef = { id: string };

export function selectActiveRunExecutions<T extends ExecutionRef>(executions: T[], runs: RunRef[]): { runId?: string; executions: T[] } {
  const runId = runs[0]?.id ?? executions[0]?.runId;
  if (!runId) return { executions: [] };
  return { runId, executions: executions.filter(execution => execution.runId === runId) };
}
