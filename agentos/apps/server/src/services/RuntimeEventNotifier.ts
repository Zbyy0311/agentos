export interface RuntimeEventCommitHint {
  readonly runId: string;
  readonly sequence: number;
  readonly eventId: string;
}

export type RuntimeEventCommitHandler = (hint: RuntimeEventCommitHint) => void;

export class RuntimeEventNotifier {
  private readonly subscribers = new Map<string, Set<RuntimeEventCommitHandler>>();

  subscribe(runId: string, handler: RuntimeEventCommitHandler): () => void {
    let handlers = this.subscribers.get(runId);
    if (!handlers) {
      handlers = new Set();
      this.subscribers.set(runId, handlers);
    }
    handlers.add(handler);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.subscribers.get(runId);
      current?.delete(handler);
      if (current?.size === 0) this.subscribers.delete(runId);
    };
  }

  publish(hint: RuntimeEventCommitHint): void {
    const handlers = this.subscribers.get(hint.runId);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(hint);
      } catch {
        // One process-local subscriber cannot break commit notification for
        // the remaining subscribers or alter the committed transaction.
      }
    }
  }
}
