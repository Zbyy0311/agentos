import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { NATIVE_STDIN_MAX_CHUNK_BYTES } from './driver.js';
import { BoundedNativeProcessStdin } from './stdin.js';

describe('BoundedNativeProcessStdin', () => {
  it('caps a write before it can enter the underlying Writable', async () => {
    let writes = 0;
    const writable = new Writable({ write(_chunk, _encoding, callback) { writes += 1; callback(); } });
    const stdin = new BoundedNativeProcessStdin(writable);

    await expect(stdin.write(new Uint8Array(NATIVE_STDIN_MAX_CHUNK_BYTES + 1)))
      .rejects.toThrow('PROCESS_STDIN_CHUNK_TOO_LARGE');
    expect(writes).toBe(0);
    await stdin.close();
  });

  it('allows one in-flight write and close waits for that write before ending', async () => {
    let releaseWrite: (() => void) | undefined;
    const writable = new Writable({
      write(_chunk, _encoding, callback) { releaseWrite = callback; },
    });
    const stdin = new BoundedNativeProcessStdin(writable);

    const first = stdin.write(Buffer.from('first'));
    await expect(stdin.write(Buffer.from('second')))
      .rejects.toThrow('PROCESS_STDIN_WRITE_IN_PROGRESS');
    const closing = stdin.close();
    await expect(stdin.write(Buffer.from('late')))
      .rejects.toThrow('PROCESS_STDIN_CLOSING');
    releaseWrite?.();
    await first;
    await closing;
    await expect(stdin.close()).resolves.toBeUndefined();
  });

  it('rejects an outstanding write when the child input closes unexpectedly', async () => {
    const writable = new Writable({ write() { /* intentionally never completes */ } });
    const stdin = new BoundedNativeProcessStdin(writable);
    const pending = stdin.write(Buffer.from('pending'));
    writable.destroy();
    await expect(pending).rejects.toThrow('PROCESS_STDIN_CLOSED');
    await expect(stdin.write(Buffer.from('after-close'))).rejects.toThrow();
  });
});
