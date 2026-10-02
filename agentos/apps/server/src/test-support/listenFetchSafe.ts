import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomInt } from 'node:crypto';

/** Windows may assign a low ephemeral port that Fetch refuses before sending HTTP. */
export async function listenFetchSafe(server: Server): Promise<AddressInfo> {
  for (let attempt = 0; attempt < 32; attempt++) {
    try { await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.removeListener('listening', listening); reject(error); };
      const listening = () => { server.removeListener('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', listening);
      server.listen(randomInt(20000, 60000), '127.0.0.1');
    }); } catch (error) {
      if (['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    const address = server.address() as AddressInfo;
    // All Fetch-restricted service ports are below this bounded test range.
    if (address.port >= 16384) return address;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  throw new Error('Unable to allocate a Fetch-compatible local test port');
}
