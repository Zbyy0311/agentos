import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DurableProcessRepositoryAdapter, DurableSessionRepositoryAdapter } from './process-runtime-adapters.js';

describe('process-runtime claim lookup adapters', () => {
  it('delegates exact Session claim lookup without widening the key', async () => {
    const calls: unknown[][] = [];
    const repository = {
      findByClaimKey: (...args: unknown[]) => {
        calls.push(args);
        return undefined;
      },
    };
    const adapter = new DurableSessionRepositoryAdapter(repository as never);

    const result = await adapter.getSessionByClaimKey('ws_1', 'run_1', 'stage_1', 2, 'primary-provider');

    assert.equal(result, null);
    assert.deepEqual(calls, [['ws_1', 'run_1', 'stage_1', 2, 'primary-provider']]);
  });

  it('delegates exact root Process claim lookup without scanning PIDs or events', async () => {
    const calls: unknown[][] = [];
    const repository = {
      findByRootClaim: (...args: unknown[]) => {
        calls.push(args);
        return undefined;
      },
    };
    const adapter = new DurableProcessRepositoryAdapter(repository as never);

    const result = await adapter.getRootProcessByClaim('ws_1', 'run_1', 'stage_1', 2, 'primary-provider');

    assert.equal(result, null);
    assert.deepEqual(calls, [['ws_1', 'run_1', 'stage_1', 2, 'primary-provider']]);
  });
});
