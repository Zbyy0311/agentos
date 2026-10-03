import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const routeHarness = fileURLToPath(new URL('../../e2e/p2-group-recovery-route-harness.mjs', import.meta.url));
const serverRoot = fileURLToPath(new URL('../../../server/', import.meta.url));

test('real group recovery and concurrent respond calls converge on one durable owner and one mock walk', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', routeHarness], {
    cwd: serverRoot,
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, AGENTOS_FORCE_MOCK: 'true' },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const receipt = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? '{}') as {
    readonly recoveryStatuses: readonly number[];
    readonly recoveredInteractionIds: readonly string[];
    readonly recoveredSourceMessageIds: readonly string[];
    readonly clientMessageIds: readonly string[];
    readonly respondStatuses: readonly number[];
    readonly ownerClaims: number;
    readonly turnStartEvents: number;
    readonly providerStartEvents: number;
    readonly providerMode: string;
  };
  assert.deepEqual(receipt.recoveryStatuses, [200, 201]);
  assert.equal(new Set(receipt.recoveredInteractionIds).size, 1);
  assert.equal(new Set(receipt.recoveredSourceMessageIds).size, 1);
  assert.equal(new Set(receipt.clientMessageIds).size, 1);
  assert.deepEqual(receipt.respondStatuses, [200, 409]);
  assert.equal(receipt.ownerClaims, 1);
  assert.equal(receipt.turnStartEvents, 1);
  assert.equal(receipt.providerMode, 'forced-mock');
});
