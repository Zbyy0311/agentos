import type { AgentEvent } from '@agentos/shared';

export interface EventBusContract {
  publish(event: AgentEvent): Promise<void>;
  subscribe(handler: (event: AgentEvent) => void | Promise<void>): () => void;
}

export class EventBus implements EventBusContract {
  private readonly subscribers = new Set<(event: AgentEvent) => void | Promise<void>>();

  async publish(event: AgentEvent): Promise<void> {
    for (const subscriber of this.subscribers) {
      await subscriber(event);
    }
  }

  subscribe(handler: (event: AgentEvent) => void | Promise<void>): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }
}
