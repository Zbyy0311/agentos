/**
 * External store for the typewriter-streamed assistant text.
 *
 * The workspace page owns the SSE/typewriter pipeline, but the streamed text
 * must not live in page-level React state: every 12 ms character would
 * re-render the whole workspace tree. ChatPanel subscribes to this store and
 * keeps the text as its own local state, so only ChatPanel re-renders while
 * streaming. The page only updates the persisted message list once a message
 * completes.
 */
export type StreamingTextListener = (text: string) => void;

export class StreamingTextStore {
  private text: string;
  private readonly listeners = new Set<StreamingTextListener>();

  constructor(initialText = '') {
    this.text = initialText;
  }

  getSnapshot(): string {
    return this.text;
  }

  append(fragment: string): void {
    if (!fragment) return;
    this.text += fragment;
    this.emit();
  }

  clear(): void {
    if (!this.text) return;
    this.text = '';
    this.emit();
  }

  subscribe(listener: StreamingTextListener): () => void {
    this.listeners.add(listener);
    listener(this.text);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.text);
  }
}
