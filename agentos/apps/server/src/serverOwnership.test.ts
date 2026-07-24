import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import {
  acquireServerOwnership,
  serverOwnershipEndpoint,
  ServerAlreadyRunningError,
  ServerOwnershipUnavailableError,
  type ServerOwnership,
} from './serverOwnership.js';

function makeRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `agentos-ownership-${label}-`));
}

test('R29 same-process acquire conflicts, then release permits re-acquire; different roots coexist', async () => {
  const rootA = makeRoot('a');
  const rootB = makeRoot('b');
  let first: ServerOwnership | undefined;
  let other: ServerOwnership | undefined;
  let third: ServerOwnership | undefined;
  try {
    first = await acquireServerOwnership(rootA);
    assert.ok(first.endpoint.length > 0);

    await assert.rejects(
      () => acquireServerOwnership(rootA),
      (error: unknown) => {
        assert.ok(error instanceof ServerAlreadyRunningError);
        assert.equal((error as ServerAlreadyRunningError).code, 'SERVER_ALREADY_RUNNING');
        return true;
      },
    );

    other = await acquireServerOwnership(rootB);
    assert.notEqual(other.endpoint, first.endpoint);

    await first.release();
    first = undefined;

    third = await acquireServerOwnership(rootA);
    await third.release();
    // release is idempotent
    await third.release();
    third = undefined;

    await other.release();
    other = undefined;
  } finally {
    await first?.release().catch(() => {});
    await third?.release().catch(() => {});
    await other?.release().catch(() => {});
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test(
  'R30 unix stale socket is probed and cleaned; non-socket conflicts fail closed',
  { skip: process.platform === 'win32' ? 'unix domain socket scenario only' : false },
  async () => {
    const root = makeRoot('unix');
    const endpoint = serverOwnershipEndpoint(root);
    let ownership: ServerOwnership | undefined;
    try {
      // Build a stale socket: bind a real listener, then close it without cleanup.
      const stale = net.createServer();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        stale.once('error', rejectPromise);
        stale.listen(endpoint, () => resolvePromise());
      });
      await new Promise<void>(resolvePromise => stale.close(() => resolvePromise()));
      assert.ok(existsSync(endpoint), 'stale socket file should remain after the listener closes');

      // The stale socket has no live owner, so acquisition probes, cleans, and binds.
      ownership = await acquireServerOwnership(root);
      await ownership.release();
      ownership = undefined;

      // A regular file at the endpoint must never be deleted; the conflict is reported stably.
      writeFileSync(endpoint, 'not a socket');
      await assert.rejects(
        () => acquireServerOwnership(root),
        (error: unknown) => {
          assert.ok(error instanceof ServerOwnershipUnavailableError);
          assert.equal((error as ServerOwnershipUnavailableError).code, 'SERVER_OWNERSHIP_UNAVAILABLE');
          return true;
        },
      );
      assert.ok(existsSync(endpoint), 'regular file must not be removed by stale cleanup');
    } finally {
      await ownership?.release().catch(() => {});
      try { unlinkSync(endpoint); } catch { /* best effort */ }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
