import type { AgentEvent, AgentEventDraft, EventBusContract, PersistEventResult } from '@agentos/shared';

export type PersistAgentEvent = (draft: AgentEventDraft) => PersistEventResult;
export type SubscriberErrorReporter = (error: unknown, event: AgentEvent) => void;
type EventSubscriber = (event: AgentEvent) => unknown | Promise<unknown>;

/**
 * Persists an event before delivering it to observers.  Subscribers are
 * notifications only: a broken observer must never turn a committed Run into
 * a failed Run or cause a second database write.
 */
export class EventBus implements EventBusContract {
  private readonly subscribers = new Set<EventSubscriber>();

  constructor(
    private readonly persist: PersistAgentEvent = draft => ({
      event: { ...draft, sequence: 0 },
      inserted: true,
    }),
    private readonly onSubscriberError: SubscriberErrorReporter = () => undefined,
  ) {}

  async publish(draft: AgentEventDraft): Promise<AgentEvent> {
    const result = this.persist(draft);
    if (result.inserted) await this.broadcastPersisted(result.event);
    return result.event;
  }

  async broadcastPersisted(event: AgentEvent): Promise<void> {
    const results = await Promise.allSettled(
      [...this.subscribers].map(subscriber => Promise.resolve().then(() => subscriber(event))),
    );
    for (const result of results) {
      if (result.status === 'rejected') this.onSubscriberError(result.reason, event);
    }
  }

  /** Kept for non-persistence observers and test doubles. */
  subscribe(handler: EventSubscriber): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }
}
