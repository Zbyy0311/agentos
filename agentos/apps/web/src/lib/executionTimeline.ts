import type { ExecutionStatus } from '@agentos/shared';

export interface TimelineExecutionEvent {
  id: string;
  executionId: string;
  status: ExecutionStatus;
  activity: string;
  createdAt: string;
  agentId?: string;
}

export function collapseStreamingExecutionEvents<T extends TimelineExecutionEvent>(events: T[]): T[] {
  const collapsed: T[] = [];
  for (const event of events) {
    const previous = collapsed.at(-1);
    const isRepeatedStream = previous
      && previous.status === 'streaming_response'
      && event.status === 'streaming_response'
      && previous.executionId === event.executionId
      && previous.agentId === event.agentId
      && previous.activity === event.activity;
    if (isRepeatedStream) collapsed[collapsed.length - 1] = event;
    else collapsed.push(event);
  }
  return collapsed;
}
