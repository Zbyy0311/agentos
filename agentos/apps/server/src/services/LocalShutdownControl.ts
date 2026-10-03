import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:net';

export interface LocalShutdownControlOptions {
  readonly pipePath: string;
  readonly instanceId: string;
  readonly nonce: string;
  readonly onShutdown: () => void;
}

/** Private Windows named-pipe control channel used by the verified local launcher. */
export async function startLocalShutdownControl(options: LocalShutdownControlOptions): Promise<Server> {
  if (process.platform !== 'win32') throw new Error('Local shutdown named pipes are supported only on Windows.');
  if (!/^[a-f0-9]{32}$/u.test(options.instanceId) || !/^[a-f0-9]{64}$/u.test(options.nonce)
    || options.pipePath !== `\\\\.\\pipe\\agentos-local-${options.instanceId}-server`) {
    throw new Error('Local shutdown control identity is invalid.');
  }

  let shutdownAccepted = false;
  const server = createServer(socket => {
    socket.setTimeout(5_000, () => socket.destroy());
    let request = '';
    socket.on('data', chunk => {
      request += chunk.toString('utf8');
      if (request.length > 2_048) { socket.destroy(); return; }
      const newline = request.indexOf('\n');
      if (newline < 0) return;
      const raw = request.slice(0, newline);
      let parsed: unknown;
      try { parsed = JSON.parse(raw) as unknown; } catch {
        socket.end('{"ok":false,"code":"INVALID_REQUEST"}\n');
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        socket.end('{"ok":false,"code":"INVALID_REQUEST"}\n');
        return;
      }
      const message = parsed as { readonly operation?: unknown; readonly instanceId?: unknown; readonly nonce?: unknown };
      const nonce = typeof message.nonce === 'string' ? Buffer.from(message.nonce, 'utf8') : Buffer.alloc(0);
      const expected = Buffer.from(options.nonce, 'utf8');
      const authenticated = message.operation === 'shutdown'
        && message.instanceId === options.instanceId
        && nonce.length === expected.length
        && timingSafeEqual(nonce, expected);
      if (!authenticated) {
        socket.end('{"ok":false,"code":"CONTROL_IDENTITY_MISMATCH"}\n');
        return;
      }
      if (shutdownAccepted) {
        socket.end('{"ok":true,"state":"shutdown-already-requested"}\n');
        return;
      }
      shutdownAccepted = true;
      socket.end('{"ok":true,"state":"shutdown-accepted"}\n', () => setImmediate(options.onShutdown));
    });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (error: Error) => rejectPromise(error);
    server.once('error', onError);
    server.listen(options.pipePath, () => {
      server.removeListener('error', onError);
      resolvePromise();
    });
  });
  return server;
}

export async function closeLocalShutdownControl(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close(error => error ? rejectPromise(error) : resolvePromise());
  });
}
