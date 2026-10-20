import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { ProviderValidationCacheRepository } from './ProviderValidationCacheRepository.js';
import { computeProviderValidationCacheKey } from '@agentos/agent-core/providers';

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-pv-cache-repo-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  return root;
}

function keyFor(providerConfigId: string, version = 1): string {
  return computeProviderValidationCacheKey({
    providerConfigId,
    configurationVersion: version,
    executableMtimeMs: null,
    environmentProfileVersion: null,
    adapterVersion: 'builtin.custom-cli@1',
  });
}

test('migration 066 creates provider_validation_cache on a fresh store', () => {
  const root = createRoot();
  const store = new SqliteStore(root);
  try {
    const table = store.getDatabase().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_validation_cache'",
    ).get() as { name: string } | undefined;
    assert.equal(table?.name, 'provider_validation_cache');
    const index = store.getDatabase().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_provider_validation_cache_expires'",
    ).get() as { name: string } | undefined;
    assert.equal(index?.name, 'idx_provider_validation_cache_expires');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('validation cache get/set round-trips and upserts on the same key', async () => {
  const root = createRoot();
  const store = new SqliteStore(root);
  try {
    const workspaceId = (await new WorkspaceManager(store).create('WS', join(root, 'a'), { git: false, memory: false, readme: false, docs: false })).id;
    const repo = new ProviderValidationCacheRepository(store.getDatabase() as any);
    const key = keyFor('provider-1');
    assert.equal(repo.get(key, new Date().toISOString()), null);

    repo.set({
      workspaceId, providerConfigId: 'provider-1', cacheKey: key,
      configurationVersion: 1, resultJson: '{"valid":true}', now: '2026-10-20T00:00:00.000Z', ttlMs: 60_000,
    });
    assert.equal(repo.get(key, '2026-10-20T00:00:30.000Z'), '{"valid":true}');

    repo.set({
      workspaceId, providerConfigId: 'provider-1', cacheKey: key,
      configurationVersion: 1, resultJson: '{"valid":false}', now: '2026-10-20T00:01:00.000Z', ttlMs: 60_000,
    });
    assert.equal(repo.get(key, '2026-10-20T00:01:10.000Z'), '{"valid":false}');
    assert.equal(repo.findByKey(key)?.configuration_version, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('validation cache expires after TTL and prunes lazily', async () => {
  const root = createRoot();
  const store = new SqliteStore(root);
  try {
    const workspaceId = (await new WorkspaceManager(store).create('WS', join(root, 'a'), { git: false, memory: false, readme: false, docs: false })).id;
    const db = store.getDatabase() as any;
    const repo = new ProviderValidationCacheRepository(db);
    const key = keyFor('provider-1');
    repo.set({
      workspaceId, providerConfigId: 'provider-1', cacheKey: key,
      configurationVersion: 1, resultJson: '{"valid":true}', now: '2026-10-20T00:00:00.000Z', ttlMs: 60_000,
    });

    // Inside TTL: hit.
    assert.equal(repo.get(key, '2026-10-20T00:00:59.999Z'), '{"valid":true}');
    // Past TTL: miss, and the expired row was pruned.
    assert.equal(repo.get(key, '2026-10-20T00:01:00.000Z'), null);
    assert.equal(repo.findByKey(key), undefined);

    // A different configuration version produces a different key (no stale reuse).
    const otherKey = keyFor('provider-1', 2);
    assert.notEqual(otherKey, key);
    assert.equal(repo.get(otherKey, '2026-10-20T00:00:10.000Z'), null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
