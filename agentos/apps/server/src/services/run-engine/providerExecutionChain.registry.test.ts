import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../store/SqliteStore.js';
import { createProviderExecutionChain } from './providerExecutionChain.js';

test('LITE-04-101: production chain registers the three canonical Provider adapters', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-provider-chain-registry-'));
  const store = new SqliteStore(root);
  try {
    const chain = createProviderExecutionChain({
      store,
      artifactRoot: join(root, 'artifacts'),
      workspaceRootFor: () => root,
    });
    for (const [adapterId, version, providerType] of [
      ['builtin.kimicode', '1.0.0', 'kimicode'],
      ['builtin.codex', '1.0.0', 'codex'],
      ['builtin.opencode', '1.0.0', 'opencode'],
    ] as const) {
      const adapter = chain.providerRegistry.resolve({ adapterId, adapterVersion: version });
      assert.equal(adapter.manifest.id, adapterId);
      assert.equal(adapter.manifest.version, version);
      assert.ok(adapter.manifest.providerTypes.includes(providerType));
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
