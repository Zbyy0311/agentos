import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net, { type AddressInfo } from 'node:net';
import {
  acquireLoopbackServerOwnership,
  acquireServerOwnership,
  deriveOwnershipCandidatePorts,
  serverOwnershipEndpoint,
  ServerAlreadyRunningError,
  ServerOwnershipUnavailableError,
  type ServerOwnership,
} from './serverOwnership.js';

const SERVER_SRC_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_CWD = dirname(SERVER_SRC_DIR);
const OWNERSHIP_MODULE_URL = pathToFileURL(join(SERVER_SRC_DIR, 'serverOwnership.ts')).href;

function makeRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `agentos-ownership-${label}-`));
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
  return port;
}

async function occupyPort(handler: (socket: net.Socket) => void): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer(handler);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  return { server, port: (server.address() as AddressInfo).port };
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise(resolvePromise => server.close(() => resolvePromise()));
}

function assertUnavailable(error: unknown): boolean {
  assert.ok(error instanceof ServerOwnershipUnavailableError);
  assert.equal((error as ServerOwnershipUnavailableError).code, 'SERVER_OWNERSHIP_UNAVAILABLE');
  return true;
}

function readDiagnosticField(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function snapshotDiagnosticValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value !== 'object' || depth >= 2 || seen.has(value)) return undefined;
  seen.add(value);
  const snapshot: Record<string, unknown> = {};
  for (const key of ['name', 'message', 'code', 'errno', 'syscall', 'address', 'port']) {
    const field = readDiagnosticField(value, key);
    if (field === null || ['string', 'number', 'boolean'].includes(typeof field)) snapshot[key] = field;
  }
  const cause = snapshotDiagnosticValue(readDiagnosticField(value, 'cause'), depth + 1, seen);
  if (cause !== undefined) snapshot.cause = cause;
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function snapshotListenTarget(args: readonly unknown[]): Record<string, unknown> | undefined {
  const target = args[0];
  if (typeof target === 'number') return { port: target };
  if (!target || typeof target !== 'object') return undefined;
  const snapshot: Record<string, unknown> = {};
  for (const key of ['host', 'port']) {
    const field = readDiagnosticField(target, key);
    if (field === null || ['string', 'number', 'boolean'].includes(typeof field)) snapshot[key] = field;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function assertAlreadyRunning(error: unknown): boolean {
  assert.ok(error instanceof ServerAlreadyRunningError);
  assert.equal((error as ServerAlreadyRunningError).code, 'SERVER_ALREADY_RUNNING');
  return true;
}

interface LoopbackChild {
  child: ChildProcess;
  lines(): string[];
}

function spawnLoopbackChild(root: string): LoopbackChild {
  let buffer = '';
  const script = [
    `import { acquireLoopbackServerOwnership } from ${JSON.stringify(OWNERSHIP_MODULE_URL)};`,
    'try {',
    '  const ownership = await acquireLoopbackServerOwnership(process.env.AGENTOS_OWN_ROOT);',
    "  console.log('ACQUIRED ' + ownership.endpoint);",
    '  setInterval(() => {}, 1000000);',
    '} catch (error) {',
    "  console.log('FAILED ' + ((error && error.code) || 'UNKNOWN'));",
    '}',
  ].join('\n');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    {
      cwd: SERVER_CWD,
      env: { ...process.env, AGENTOS_OWN_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', chunk => { buffer += String(chunk); });
  child.stderr?.on('data', chunk => { buffer += String(chunk); });
  return { child, lines: () => buffer.split('\n').map(line => line.trim()).filter(Boolean) };
}

async function waitForOutcomeLine(spawned: LoopbackChild, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outcome = spawned.lines().find(line => line.startsWith('ACQUIRED ') || line.startsWith('FAILED '));
    if (outcome) return outcome;
    if (spawned.child.exitCode !== null || spawned.child.signalCode !== null) {
      throw new Error(`child exited without an outcome line: ${spawned.lines().join(' | ')}`);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  throw new Error('child did not report an ownership outcome in time');
}

function waitForChildExit(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error('child did not exit in time'));
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
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

    await assert.rejects(() => acquireServerOwnership(rootA), assertAlreadyRunning);

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
  'R34 Node removes its own unix socket file on clean close (why the old R30 stale-socket construction was invalid)',
  { skip: process.platform === 'win32' ? 'documents unix OS behavior only' : false },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentos-ownership-r34-'));
    const socketPath = join(dir, 'probe.sock');
    const server = net.createServer();
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(socketPath, () => resolvePromise());
      });
      assert.ok(existsSync(socketPath), 'listening unix socket file should exist');
      await closeServer(server);
      const deadline = Date.now() + 2_000;
      while (existsSync(socketPath) && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      }
      assert.ok(
        !existsSync(socketPath),
        'a clean server.close removes the Node-created socket file, so stale sockets only survive process death',
      );
    } finally {
      await closeServer(server).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('R35 loopback same-root conflict, release and re-acquire; candidate ports are stable and unique', async () => {
  const root = makeRoot('r35');
  let first: ServerOwnership | undefined;
  let second: ServerOwnership | undefined;
  try {
    const derivedA = deriveOwnershipCandidatePorts(root);
    const derivedB = deriveOwnershipCandidatePorts(root);
    assert.deepEqual(derivedA, derivedB, 'candidate order must be stable for the same root');
    assert.ok(derivedA.length >= 16, 'at least 16 candidate ports');
    assert.equal(new Set(derivedA).size, derivedA.length, 'candidates must be unique');
    for (const port of derivedA) {
      assert.ok(port >= 49152 && port <= 65535, `candidate ${port} must be inside 49152-65535`);
    }

    const mutableNet = net as typeof net & { createServer: typeof net.createServer };
    const originalCreateServer = mutableNet.createServer;
    const bindAttempts: Array<{
      listenTarget?: Record<string, unknown>;
      rawError?: unknown;
    }> = [];
    const observedServers: Array<{
      server: net.Server;
      originalListen: net.Server['listen'];
      onError: (error: Error) => void;
    }> = [];
    mutableNet.createServer = ((...createArgs: unknown[]) => {
      const server = Reflect.apply(originalCreateServer, mutableNet, createArgs) as net.Server;
      const attempt: (typeof bindAttempts)[number] = {};
      bindAttempts.push(attempt);
      const originalListen = server.listen;
      const onError = (error: Error): void => {
        attempt.rawError = snapshotDiagnosticValue(error);
      };
      server.once('error', onError);
      server.listen = (function(this: net.Server, ...listenArgs: unknown[]): net.Server {
        attempt.listenTarget = snapshotListenTarget(listenArgs);
        return Reflect.apply(originalListen, this, listenArgs) as net.Server;
      }) as net.Server['listen'];
      observedServers.push({ server, originalListen, onError });
      return server;
    }) as typeof net.createServer;
    try {
      first = await acquireLoopbackServerOwnership(root);
    } catch (error) {
      console.error(JSON.stringify({
        diagnostic: 'R35_WINDOWS_BIND_FAILURE',
        candidatePorts: derivedA,
        bindAttempts,
        productionError: snapshotDiagnosticValue(error),
      }));
      throw error;
    } finally {
      mutableNet.createServer = originalCreateServer;
      for (const observed of observedServers) {
        observed.server.removeListener('error', observed.onError);
        observed.server.listen = observed.originalListen;
      }
    }
    assert.match(first.endpoint, /^tcp:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(!first.endpoint.includes(root), 'endpoint must not contain the project root');
    assert.ok(!first.endpoint.endsWith('.sock'), 'loopback ownership never uses filesystem sockets');

    await assert.rejects(() => acquireLoopbackServerOwnership(root), assertAlreadyRunning);

    await first.release();
    first = undefined;

    second = await acquireLoopbackServerOwnership(root);
    await second.release();
    second = undefined;
  } finally {
    await first?.release().catch(() => {});
    await second?.release().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('R36 different roots colliding on the first candidate move to the next candidate after a valid handshake', async () => {
  const rootA = makeRoot('r36a');
  const rootB = makeRoot('r36b');
  const port1 = await freePort();
  const port2 = await freePort();
  const candidatePorts = [port1, port2];
  let ownershipA: ServerOwnership | undefined;
  let ownershipB: ServerOwnership | undefined;
  try {
    ownershipA = await acquireLoopbackServerOwnership(rootA, { candidatePorts });
    assert.equal(ownershipA.endpoint, `tcp://127.0.0.1:${port1}`);

    ownershipB = await acquireLoopbackServerOwnership(rootB, { candidatePorts });
    assert.equal(ownershipB.endpoint, `tcp://127.0.0.1:${port2}`, 'B must take the next candidate after seeing a valid different-hash token');

    // Both roots hold ownership simultaneously.
    assert.ok(ownershipA.endpoint !== ownershipB.endpoint);
  } finally {
    await ownershipA?.release().catch(() => {});
    await ownershipB?.release().catch(() => {});
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('R37 unknown port occupants fail closed without jumping to the next candidate', async (t) => {
  const variants: Array<{
    name: string;
    handler: (socket: net.Socket) => void;
  }> = [
    { name: 'non-AgentOS text', handler: socket => { socket.end('hello world\n'); } },
    { name: 'silent peer (timeout)', handler: () => { /* never responds */ } },
    { name: 'malformed token', handler: socket => { socket.end('AGENTOS_OWNER_V1 not-a-hash\n'); } },
    { name: 'overlong token', handler: socket => { socket.end(`AGENTOS_OWNER_V1 ${'a'.repeat(200)}\n`); } },
    { name: 'connection reset', handler: socket => { socket.destroy(); } },
  ];

  for (const variant of variants) {
    await t.test(variant.name, async () => {
      const root = makeRoot('r37');
      const occupied = await occupyPort(variant.handler);
      const fallbackPort = await freePort();
      try {
        await assert.rejects(
          () => acquireLoopbackServerOwnership(root, {
            candidatePorts: [occupied.port, fallbackPort],
            probeTimeoutMs: 500,
          }),
          assertUnavailable,
          `${variant.name} must fail closed`,
        );
        // The next candidate must remain untouched: no owner was formed there.
        const probe = net.createServer();
        await new Promise<void>((resolvePromise, rejectPromise) => {
          probe.once('error', rejectPromise);
          probe.listen(fallbackPort, '127.0.0.1', () => resolvePromise());
        });
        await closeServer(probe);
      } finally {
        await closeServer(occupied.server).catch(() => {});
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('R38 loopback ownership is released automatically after a subprocess crash', { timeout: 120_000 }, async () => {
  const root = makeRoot('r38');
  const spawned = spawnLoopbackChild(root);
  let ownership: ServerOwnership | undefined;
  try {
    const outcome = await waitForOutcomeLine(spawned);
    assert.ok(outcome.startsWith('ACQUIRED tcp://127.0.0.1:'), `child should acquire loopback ownership: ${outcome}`);

    spawned.child.kill('SIGKILL');
    await waitForChildExit(spawned.child);

    // No file deletion and no stale cleanup: the OS released the port.
    ownership = await acquireLoopbackServerOwnership(root);
    assert.match(ownership.endpoint, /^tcp:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
      spawned.child.kill('SIGKILL');
    }
    await ownership?.release().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('R39 concurrent subprocesses never produce two owners and ownership remains available after contention clears', { timeout: 300_000 }, async () => {
  const ROUNDS = 5;
  const CHILDREN = 3;
  for (let round = 0; round < ROUNDS; round += 1) {
    const root = makeRoot(`r39-${round}`);
    const spawned = Array.from({ length: CHILDREN }, () => spawnLoopbackChild(root));
    let reacquired: ServerOwnership | undefined;
    try {
      try {
        const outcomes = await Promise.all(spawned.map(item => waitForOutcomeLine(item)));
        const acquired = outcomes.filter(outcome => outcome.startsWith('ACQUIRED '));
        const failed = outcomes.filter(outcome => outcome.startsWith('FAILED '));
        assert.ok(
          acquired.length <= 1,
          `round ${round}: at most one owner may win: ${outcomes.join(' | ')}`,
        );
        assert.equal(
          acquired.length + failed.length,
          CHILDREN,
          `round ${round}: every child must report exactly one recognized outcome: ${outcomes.join(' | ')}`,
        );
        assert.equal(
          failed.length,
          CHILDREN - acquired.length,
          `round ${round}: every non-owner must report a stable failure: ${outcomes.join(' | ')}`,
        );
        for (const outcome of outcomes) {
          assert.match(
            outcome,
            /^(ACQUIRED tcp:\/\/127\.0\.0\.1:\d+|FAILED (SERVER_ALREADY_RUNNING|SERVER_OWNERSHIP_UNAVAILABLE))$/,
            `round ${round}: every child outcome must be classified: ${outcome}`,
          );
        }
      } finally {
        for (const item of spawned) {
          if (item.child.exitCode === null && item.child.signalCode === null) {
            item.child.kill('SIGKILL');
          }
        }
        await Promise.all(spawned.map(item => waitForChildExit(item.child).catch(() => {})));
      }

      reacquired = await acquireLoopbackServerOwnership(root);
      assert.match(reacquired.endpoint, /^tcp:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await reacquired?.release().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('R40 platform ownership strategy selection keeps named pipe on Windows and loopback elsewhere', async () => {
  const root = makeRoot('r40');
  let ownership: ServerOwnership | undefined;
  try {
    const endpoint = serverOwnershipEndpoint(root);
    if (process.platform === 'win32') {
      assert.ok(endpoint.startsWith('\\\\.\\pipe\\agentos-server-'), 'Windows keeps the named pipe endpoint');
      ownership = await acquireServerOwnership(root);
      assert.ok(ownership.endpoint.startsWith('\\\\.\\pipe\\agentos-server-'));
      await assert.rejects(() => acquireServerOwnership(root), assertAlreadyRunning);
    } else {
      assert.match(endpoint, /^tcp:\/\/127\.0\.0\.1:\d+$/, 'non-Windows uses the loopback endpoint');
      assert.ok(!endpoint.endsWith('.sock'), 'no filesystem socket is used');
      ownership = await acquireServerOwnership(root);
      assert.match(ownership.endpoint, /^tcp:\/\/127\.0\.0\.1:\d+$/);
      await assert.rejects(() => acquireServerOwnership(root), assertAlreadyRunning);
    }
  } finally {
    await ownership?.release().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

async function assertPortFree(port: number): Promise<void> {
  const probe = net.createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    probe.once('error', rejectPromise);
    probe.listen(port, '127.0.0.1', () => resolvePromise());
  });
  await closeServer(probe);
}

test('R41 fallback churn cannot create a duplicate owner for the same root', async () => {
  const rootA = makeRoot('r41a');
  const rootB = makeRoot('r41b');
  const port1 = await freePort();
  const port2 = await freePort();
  const candidatePorts = [port1, port2];
  let ownershipA: ServerOwnership | undefined;
  let ownershipB: ServerOwnership | undefined;
  try {
    ownershipA = await acquireLoopbackServerOwnership(rootA, { candidatePorts });
    assert.equal(ownershipA.endpoint, `tcp://127.0.0.1:${port1}`);

    ownershipB = await acquireLoopbackServerOwnership(rootB, { candidatePorts });
    assert.equal(ownershipB.endpoint, `tcp://127.0.0.1:${port2}`);

    await ownershipA.release();
    ownershipA = undefined;

    // Root B already owns port2; a fresh acquire must not grab the freed port1.
    await assert.rejects(
      () => acquireLoopbackServerOwnership(rootB, { candidatePorts }),
      assertAlreadyRunning,
    );
    await assertPortFree(port1);
    assert.equal(ownershipB.endpoint, `tcp://127.0.0.1:${port2}`, 'original B ownership must stay valid');
  } finally {
    await ownershipA?.release().catch(() => {});
    await ownershipB?.release().catch(() => {});
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('R42 an existing same-root owner on a later candidate blocks a fresh acquire before any bind', async () => {
  const root = makeRoot('r42');
  const port1 = await freePort();
  const port2 = await freePort();
  let existing: ServerOwnership | undefined;
  try {
    existing = await acquireLoopbackServerOwnership(root, { candidatePorts: [port2] });
    assert.equal(existing.endpoint, `tcp://127.0.0.1:${port2}`);

    await assert.rejects(
      () => acquireLoopbackServerOwnership(root, { candidatePorts: [port1, port2] }),
      assertAlreadyRunning,
    );
    await assertPortFree(port1);
  } finally {
    await existing?.release().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('R43 different-root collision stays supported and fallback churn is still blocked after release', async () => {
  const rootA = makeRoot('r43a');
  const rootB = makeRoot('r43b');
  const port1 = await freePort();
  const port2 = await freePort();
  const candidatePorts = [port1, port2];
  let ownershipA: ServerOwnership | undefined;
  let ownershipB: ServerOwnership | undefined;
  try {
    ownershipA = await acquireLoopbackServerOwnership(rootA, { candidatePorts });
    ownershipB = await acquireLoopbackServerOwnership(rootB, { candidatePorts });
    assert.equal(ownershipA.endpoint, `tcp://127.0.0.1:${port1}`);
    assert.equal(ownershipB.endpoint, `tcp://127.0.0.1:${port2}`);

    await ownershipA.release();
    ownershipA = undefined;

    await assert.rejects(
      () => acquireLoopbackServerOwnership(rootB, { candidatePorts }),
      assertAlreadyRunning,
    );
    await assertPortFree(port1);
  } finally {
    await ownershipA?.release().catch(() => {});
    await ownershipB?.release().catch(() => {});
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('R44 an unknown later candidate blocks binding an earlier free candidate', async (t) => {
  const variants: Array<{
    name: string;
    handler: (socket: net.Socket) => void;
  }> = [
    { name: 'malformed token', handler: socket => { socket.end('AGENTOS_OWNER_V1 not-a-hash\n'); } },
    { name: 'silent peer (timeout)', handler: () => { /* never responds */ } },
    { name: 'connection reset', handler: socket => { socket.destroy(); } },
  ];

  for (const variant of variants) {
    await t.test(variant.name, async () => {
      const root = makeRoot('r44');
      const port1 = await freePort();
      const occupied = await occupyPort(variant.handler);
      try {
        await assert.rejects(
          () => acquireLoopbackServerOwnership(root, {
            candidatePorts: [port1, occupied.port],
            probeTimeoutMs: 500,
          }),
          assertUnavailable,
          `${variant.name} anywhere in the candidate set must fail closed`,
        );
        await assertPortFree(port1);
      } finally {
        await closeServer(occupied.server).catch(() => {});
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('R45 post-bind verification detects a concurrent same-root owner and releases its own bind', async () => {
  const root = makeRoot('r45');
  const port1 = await freePort();
  const port2 = await freePort();
  let concurrentOwner: ServerOwnership | undefined;
  try {
    await assert.rejects(
      () => acquireLoopbackServerOwnership(root, {
        candidatePorts: [port1, port2],
        afterPreSweep: async () => {
          // Explicit barrier: another same-root owner appears between the
          // pre-bind sweep and this process's bind, on a different candidate.
          concurrentOwner = await acquireLoopbackServerOwnership(root, { candidatePorts: [port2] });
        },
      }),
      assertAlreadyRunning,
    );
    assert.ok(concurrentOwner, 'the concurrent owner was established by the barrier hook');
    assert.equal(concurrentOwner!.endpoint, `tcp://127.0.0.1:${port2}`);
    // The failed acquire released its own bind: at most one owner remains.
    await assertPortFree(port1);
    await assert.rejects(
      () => acquireLoopbackServerOwnership(root, { candidatePorts: [port1, port2] }),
      assertAlreadyRunning,
    );
  } finally {
    await concurrentOwner?.release().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('R46 non-EADDRINUSE bind failures fail closed without falling through to the next candidate', async (t) => {
  for (const code of ['EACCES', 'EMFILE']) {
    await t.test(code, async () => {
      const root = makeRoot('r46');
      const port1 = await freePort();
      const port2 = await freePort();
      try {
        await assert.rejects(
          () => acquireLoopbackServerOwnership(root, {
            candidatePorts: [port1, port2],
            bindErrorForTesting: { port: port1, code },
          }),
          assertUnavailable,
        );
        await assertPortFree(port1);
        await assertPortFree(port2);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('R47 a held client connection cannot block release on loopback or named pipe ownership', { timeout: 60_000 }, async () => {
  const root = makeRoot('r47');
  let ownership: ServerOwnership | undefined;
  let heldClient: net.Socket | undefined;
  try {
    ownership = await acquireLoopbackServerOwnership(root);
    const port = Number(ownership.endpoint.replace('tcp://127.0.0.1:', ''));
    heldClient = net.connect({ host: '127.0.0.1', port });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      heldClient!.once('connect', () => resolvePromise());
      heldClient!.once('error', rejectPromise);
    });
    // Deliberately never close the client; release must still complete promptly.
    await Promise.race([
      ownership.release(),
      new Promise<never>((_resolvePromise, rejectPromise) => {
        setTimeout(() => rejectPromise(new Error('release blocked by held client')), 5_000);
      }),
    ]);
    ownership = undefined;

    const reacquired = await acquireLoopbackServerOwnership(root);
    await reacquired.release();

    if (process.platform === 'win32') {
      const pipeOwnership = await acquireServerOwnership(root);
      const pipeClient = net.connect(pipeOwnership.endpoint);
      await new Promise<void>((resolvePromise, rejectPromise) => {
        pipeClient.once('connect', () => resolvePromise());
        pipeClient.once('error', rejectPromise);
      });
      await Promise.race([
        pipeOwnership.release(),
        new Promise<never>((_resolvePromise, rejectPromise) => {
          setTimeout(() => rejectPromise(new Error('named pipe release blocked by held client')), 5_000);
        }),
      ]);
      pipeClient.destroy();
    }
  } finally {
    heldClient?.destroy();
    await ownership?.release().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
