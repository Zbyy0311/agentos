export class TypewriterQueue {
  private pending = '';

  enqueue(text: string): void {
    if (text) this.pending += text;
  }

  drainOne(): string | undefined {
    if (!this.pending) return undefined;
    const next = this.pending[0];
    this.pending = this.pending.slice(1);
    return next;
  }

  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return rest;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }
}
