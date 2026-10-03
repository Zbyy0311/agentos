export interface MaintenanceActivitySnapshot {
  readonly counts: Readonly<Record<string, number>>;
  readonly unknown?: boolean;
}

export interface MaintenanceDrainSnapshot {
  readonly activeMutatingRequests: number;
  readonly activeDispatcherStarts: number;
  readonly activity: MaintenanceActivitySnapshot;
}

export class MaintenanceBarrier {
  private quiescing = false;
  private closed = false;
  private mutatingRequests = 0;
  private dispatcherStarts = 0;

  get snapshot(): { readonly quiescing: boolean; readonly activeMutatingRequests: number; readonly activeDispatcherStarts: number } {
    return Object.freeze({
      quiescing: this.quiescing,
      activeMutatingRequests: this.mutatingRequests,
      activeDispatcherStarts: this.dispatcherStarts,
    });
  }

  begin(): boolean {
    if (this.quiescing || this.closed) return false;
    this.quiescing = true;
    return true;
  }

  /** Permanently rejects new writes and dispatches for this server lifetime. */
  close(): void {
    this.closed = true;
    this.quiescing = true;
  }

  enterMutation(): (() => void) | undefined {
    if (this.quiescing) return undefined;
    this.mutatingRequests += 1;
    return this.once(() => { this.mutatingRequests -= 1; });
  }

  enterDispatcherStart(): (() => void) | undefined {
    if (this.quiescing) return undefined;
    this.dispatcherStarts += 1;
    return this.once(() => { this.dispatcherStarts -= 1; });
  }

  async waitForDrain(
    inspect: () => MaintenanceActivitySnapshot,
    timeoutMs = 30_000,
    pollMs = 50,
  ): Promise<MaintenanceDrainSnapshot> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let latest: MaintenanceDrainSnapshot = this.current(inspect());
    while (!this.isDrained(latest) && Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
      latest = this.current(inspect());
    }
    return latest;
  }

  end(): void {
    if (!this.closed) this.quiescing = false;
  }

  private current(activity: MaintenanceActivitySnapshot): MaintenanceDrainSnapshot {
    return Object.freeze({
      activeMutatingRequests: this.mutatingRequests,
      activeDispatcherStarts: this.dispatcherStarts,
      activity,
    });
  }

  private isDrained(snapshot: MaintenanceDrainSnapshot): boolean {
    return snapshot.activeMutatingRequests === 0
      && snapshot.activeDispatcherStarts === 0
      && snapshot.activity.unknown !== true
      && Object.values(snapshot.activity.counts).every(count => count === 0);
  }

  private once(release: () => void): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }
}
