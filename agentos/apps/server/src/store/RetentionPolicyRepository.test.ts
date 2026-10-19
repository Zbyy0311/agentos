import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from './Transaction.js';
import { RetentionPolicyRepository } from './RetentionPolicyRepository.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => TransactionDatabase & { close(): void };
};

const T0 = '2026-10-20T00:00:00.000Z';
const T1 = '2026-10-20T00:01:00.000Z';

function fixture(): { repo: RetentionPolicyRepository; close: () => void } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  return { repo: new RetentionPolicyRepository(db), close: () => db.close() };
}

test('save creates a policy and re-save of the same scope bumps version', () => {
  const { repo, close } = fixture();
  try {
    const first = repo.save({
      id: 'rpol_1', workspaceId: 'ws_1', domain: 'runtime_events', name: 'default',
      policy: { durableRetentionDays: 10 }, now: T0,
    });
    assert.equal(first.version, 1);
    assert.equal(first.enabled, true);

    const second = repo.save({
      id: 'rpol_2', workspaceId: 'ws_1', domain: 'runtime_events', name: 'default',
      policy: { durableRetentionDays: 20 }, enabled: false, now: T1,
    });
    assert.equal(second.version, 2);
    assert.equal(second.id, 'rpol_1', 'upsert keeps the row id for the same scope');
    assert.equal(second.enabled, false);
    assert.equal(second.policy.durableRetentionDays, 20);
  } finally {
    close();
  }
});

test('getEffective prefers the workspace scope, then global, and skips disabled rows', () => {
  const { repo, close } = fixture();
  try {
    repo.save({ id: 'rpol_global', domain: 'runtime_events', name: 'default', policy: { durableRetentionDays: 30 }, now: T0 });
    assert.equal(repo.getEffective('ws_9', 'runtime_events')!.policy.durableRetentionDays, 30, 'global row applies to any workspace');

    repo.save({ id: 'rpol_ws', workspaceId: 'ws_9', domain: 'runtime_events', name: 'default', policy: { durableRetentionDays: 5 }, now: T0 });
    assert.equal(repo.getEffective('ws_9', 'runtime_events')!.policy.durableRetentionDays, 5, 'workspace row wins');
    assert.equal(repo.getEffective('ws_8', 'runtime_events')!.policy.durableRetentionDays, 30, 'other workspaces still use global');

    repo.save({ id: 'rpol_ws', workspaceId: 'ws_9', domain: 'runtime_events', name: 'default', policy: { durableRetentionDays: 5 }, enabled: false, now: T1 });
    assert.equal(repo.getEffective('ws_9', 'runtime_events')!.policy.durableRetentionDays, 30, 'disabled workspace row falls back to global');

    repo.save({ id: 'rpol_global', domain: 'runtime_events', name: 'default', policy: { durableRetentionDays: 30 }, enabled: false, now: T1 });
    assert.equal(repo.getEffective('ws_9', 'runtime_events'), undefined, 'all disabled means no policy');
  } finally {
    close();
  }
});

test('list filters by domain', () => {
  const { repo, close } = fixture();
  try {
    repo.save({ id: 'rpol_a', domain: 'runtime_events', name: 'default', policy: {}, now: T0 });
    repo.save({ id: 'rpol_b', domain: 'process_samples', name: 'default', policy: {}, now: T0 });
    assert.deepEqual(repo.list().map(p => p.id).sort(), ['rpol_a', 'rpol_b']);
    assert.deepEqual(repo.list('runtime_events').map(p => p.id), ['rpol_a']);
  } finally {
    close();
  }
});
