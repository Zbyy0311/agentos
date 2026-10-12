import type { Writable } from 'node:stream';
import type { NativeProcessStdin } from './driver.js';
import { NATIVE_STDIN_MAX_CHUNK_BYTES } from './driver.js';

/**
 * Bounded adapter over a Node Writable. One write may be outstanding at a
 * time, each accepted write is capped, and its promise settles only after the
 * underlying Writable completes that write. This prevents callers from
 * turning a pipe into an unbounded in-memory queue.
 */
export class BoundedNativeProcessStdin implements NativeProcessStdin {
  private pendingWrite: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private failure: Error | undefined;
  private finished = false;

  constructor(private readonly writable: Writable) {
    writable.on('error', error => {
      this.failure = error instanceof Error ? error : new Error(String(error));
    });
    writable.on('finish', () => { this.finished = true; });
    writable.on('close', () => {
      if (!this.finished) this.failure ??= new Error('PROCESS_STDIN_CLOSED');
    });
  }

  write(chunk: Uint8Array): Promise<void> {
    if (!(chunk instanceof Uint8Array)) return Promise.reject(new Error('PROCESS_STDIN_INVALID_CHUNK'));
    if (chunk.byteLength > NATIVE_STDIN_MAX_CHUNK_BYTES) {
      return Promise.reject(new Error('PROCESS_STDIN_CHUNK_TOO_LARGE'));
    }
    if (chunk.byteLength === 0) return Promise.resolve();
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.finished || this.writable.destroyed || this.writable.writableEnded) {
      return Promise.reject(new Error('PROCESS_STDIN_CLOSED'));
    }
    if (this.closePromise !== undefined) return Promise.reject(new Error('PROCESS_STDIN_CLOSING'));
    if (this.pendingWrite !== undefined) return Promise.reject(new Error('PROCESS_STDIN_WRITE_IN_PROGRESS'));

    let operation!: Promise<void>;
    operation = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        this.writable.removeListener('error', onError);
        this.writable.removeListener('close', onClose);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error): void => finish(error);
      const onClose = (): void => finish(new Error('PROCESS_STDIN_CLOSED'));
      this.writable.once('error', onError);
      this.writable.once('close', onClose);
      try {
        // Copy the caller's buffer so mutation after write() cannot change the
        // bytes still waiting in the native or Windows helper transport.
        this.writable.write(Buffer.from(chunk), error => finish(error));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.pendingWrite = operation;
    return operation.finally(() => {
      if (this.pendingWrite === operation) this.pendingWrite = undefined;
    });
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    if (this.finished) return Promise.resolve();
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.writable.destroyed || this.writable.writableEnded) {
      return Promise.reject(new Error('PROCESS_STDIN_CLOSED'));
    }

    this.closePromise = (async () => {
      if (this.pendingWrite !== undefined) await this.pendingWrite;
      if (this.failure !== undefined) throw this.failure;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          this.writable.removeListener('finish', onFinish);
          this.writable.removeListener('error', onError);
          this.writable.removeListener('close', onClose);
          if (error) reject(error);
          else resolve();
        };
        const onFinish = (): void => finish();
        const onError = (error: Error): void => finish(error);
        const onClose = (): void => finish(new Error('PROCESS_STDIN_CLOSED'));
        this.writable.once('finish', onFinish);
        this.writable.once('error', onError);
        this.writable.once('close', onClose);
        this.writable.end();
      });
    })();
    return this.closePromise;
  }
}
