export interface RunStreamEvent {
  event: string;
  data: Record<string, unknown>;
  cursor: number;
}

type RunStreamHandler = (event: RunStreamEvent) => void;

interface RunStreamSession {
  controller: AbortController;
  events: RunStreamEvent[];
  nextCursor: number;
  subscribers: Set<RunStreamHandler>;
  finished: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const SESSION_RETENTION_MS = 60_000;

export class RunStreamRegistry {
  private readonly sessions = new Map<string, RunStreamSession>();

  open(runId: string, controller: AbortController): void {
    const previous = this.sessions.get(runId);
    if (previous?.cleanupTimer) clearTimeout(previous.cleanupTimer);
    this.sessions.set(runId, {
      controller,
      events: [],
      nextCursor: 1,
      subscribers: new Set(),
      finished: false,
    });
  }

  emit(runId: string, event: string, data: object): RunStreamEvent | undefined {
    const session = this.sessions.get(runId);
    if (!session || session.finished) return undefined;
    const item: RunStreamEvent = {
      event,
      data: { ...(data as Record<string, unknown>), cursor: session.nextCursor },
      cursor: session.nextCursor,
    };
    session.nextCursor += 1;
    session.events.push(item);
    for (const subscriber of session.subscribers) {
      try {
        subscriber(item);
      } catch {
        // A disconnected subscriber must not interrupt the background Run.
      }
    }
    return item;
  }

  subscribe(runId: string, afterCursor: number, handler: RunStreamHandler): (() => void) | undefined {
    const session = this.sessions.get(runId);
    if (!session) return undefined;

    for (const item of session.events) {
      if (item.cursor > afterCursor) handler(item);
    }
    if (session.finished) return () => {};

    session.subscribers.add(handler);
    return () => session.subscribers.delete(handler);
  }

  finish(runId: string, event: string, data: object): void {
    const session = this.sessions.get(runId);
    if (!session || session.finished) return;
    this.emit(runId, event, data);
    session.finished = true;
    session.subscribers.clear();
    session.cleanupTimer = setTimeout(() => {
      this.sessions.delete(runId);
    }, SESSION_RETENTION_MS);
    session.cleanupTimer.unref?.();
  }

  cancel(runId: string): boolean {
    const session = this.sessions.get(runId);
    if (!session || session.finished) return false;
    session.controller.abort();
    return true;
  }

  has(runId: string): boolean {
    return this.sessions.has(runId);
  }

  isFinished(runId: string): boolean {
    return this.sessions.get(runId)?.finished ?? false;
  }
}
