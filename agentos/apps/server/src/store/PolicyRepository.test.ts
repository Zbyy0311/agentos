import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from './Transaction.js';
import { PolicyRepository, PolicyRepositoryError } from './PolicyRepository.js';

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};
const NOW = '2026-10-11T00:00:00.000Z';
const WS = 'ws_policy';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-policy-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_policy', 'C:/tmp/ws_policy', NOW, NOW, NOW);
  const repo = new PolicyRepository(db as unknown as TransactionDatabase);
  return { db, repo, root, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function profileInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pprof_' + 'a'.repeat(26),
    workspaceId: WS,
    name: 'default',
    isDefault: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function ruleInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prule_' + 'b'.repeat(26),
    profileId: 'pprof_' + 'a'.repeat(26),
    action: 'provider.launch' as const,
    selector: {},
    decision: 'allow' as const,
    priority: 0,
    createdAt: NOW,
    ...overrides,
  };
}

test('profiles: CRUD, default lookup, and UNIQUE(workspace_id, name)', () => {
  const fx = fixture();
  try {
    const created = fx.repo.createProfile(profileInput());
    assert.equal(created.isDefault, true);
    assert.equal(created.rulesVersion, 1);
    assert.equal(fx.repo.findDefaultProfile(WS)?.id, created.id);
    assert.equal(fx.repo.findProfileById(WS, created.id)?.name, 'default');
    assert.deepEqual(fx.repo.listProfiles(WS).map(profile => profile.id), [created.id]);

    assert.throws(
      () => fx.repo.createProfile(profileInput({ id: 'pprof_' + 'c'.repeat(26) })),
      (error: unknown) => error instanceof PolicyRepositoryError && error.code === 'PERSISTENCE_FAILED',
    );
    assert.throws(
      () => fx.repo.createProfile(profileInput({ id: '', name: 'other' })),
      (error: unknown) => error instanceof PolicyRepositoryError && error.code === 'INPUT_INVALID',
    );

    const touched = fx.repo.touchProfile(WS, created.id, NOW);
    assert.equal(touched.rulesVersion, 2);
    assert.throws(
      () => fx.repo.touchProfile(WS, 'pprof_missing', NOW),
      (error: unknown) => error instanceof PolicyRepositoryError && error.code === 'NOT_FOUND',
    );
  } finally {
    fx.close();
  }
});

test('rules: CRUD, enabled-only lookup, cascade delete with the profile', () => {
  const fx = fixture();
  try {
    const profile = fx.repo.createProfile(profileInput());
    const enabled = fx.repo.createRule(ruleInput({ id: 'prule_' + 'd'.repeat(26), decision: 'require_approval', priority: 5, specificity: 2 }));
    const disabled = fx.repo.createRule(ruleInput({ id: 'prule_' + 'e'.repeat(26), enabled: false, priority: 9 }));
    assert.equal(enabled.enabled, true);
    assert.equal(disabled.enabled, false);

    assert.deepEqual(fx.repo.findRulesByProfile(profile.id).map(rule => rule.id), [enabled.id]);
    assert.equal(fx.repo.findRuleById(disabled.id)?.enabled, false);

    const reenabled = fx.repo.setRuleEnabled(disabled.id, true);
    assert.equal(reenabled.enabled, true);
    assert.equal(fx.repo.findRulesByProfile(profile.id).length, 2);

    assert.throws(
      () => fx.repo.createRule(ruleInput({ id: 'prule_' + 'f'.repeat(26), action: 'provider.delete' as never })),
      (error: unknown) => error instanceof PolicyRepositoryError && error.code === 'INPUT_INVALID',
    );
    assert.throws(
      () => fx.repo.createRule(ruleInput({ id: 'prule_' + 'g'.repeat(26), decision: 'maybe' as never })),
      (error: unknown) => error instanceof PolicyRepositoryError && error.code === 'INPUT_INVALID',
    );

    fx.db.prepare('DELETE FROM policy_profiles WHERE id = ?').run(profile.id);
    assert.equal(fx.repo.findRulesByProfile(profile.id).length, 0);
  } finally {
    fx.close();
  }
});

test('decisions: insert, lookup, run filter, and pagination', () => {
  const fx = fixture();
  try {
    const profile = fx.repo.createProfile(profileInput());
    const ids = ['pdec_' + '1'.repeat(26), 'pdec_' + '2'.repeat(26), 'pdec_' + '3'.repeat(26)];
    for (const [index, id] of ids.entries()) {
      fx.repo.insertDecision({
        id, workspaceId: WS, runId: index < 2 ? 'run_1' : 'run_2', stageId: 'stage_1',
        action: 'provider.launch', fingerprint: 'fp_' + index, decision: index === 0 ? 'require_approval' : 'allow',
        matchedRuleIds: ['prule_x'], profileId: profile.id, evaluatedAt: `2026-10-11T00:00:0${index}.000Z`,
      });
    }

    const found = fx.repo.findDecisionById(WS, ids[0]!);
    assert.equal(found?.decision, 'require_approval');
    assert.equal(found?.fingerprint, 'fp_0');
    assert.deepEqual(found?.matchedRuleIds, ['prule_x']);

    assert.deepEqual(fx.repo.listDecisions(WS).map(decision => decision.id), ids);
    assert.deepEqual(fx.repo.listDecisions(WS, { runId: 'run_1' }).map(decision => decision.id), ids.slice(0, 2));
    assert.deepEqual(fx.repo.listDecisions(WS, { limit: 2 }).map(decision => decision.id), ids.slice(0, 2));
    assert.deepEqual(fx.repo.listDecisions(WS, { limit: 2, offset: 2 }).map(decision => decision.id), ids.slice(2));
    assert.throws(
      () => fx.repo.listDecisions(WS, { limit: 0 }),
      (error: unknown) => error instanceof PolicyRepositoryError && error.code === 'INPUT_INVALID',
    );
  } finally {
    fx.close();
  }
});
