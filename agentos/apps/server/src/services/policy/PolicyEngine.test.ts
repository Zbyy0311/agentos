import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../../migrations/registry.js';
import { MigrationRunner } from '../../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../../migrations/default-registry.js';
import { createFileBackupProvider } from '../../migrations/backup.js';
import type { MinimalDatabaseSync } from '../../migrations/types.js';
import type { TransactionDatabase } from '../../store/Transaction.js';
import { PolicyRepository } from '../../store/PolicyRepository.js';
import { PolicyEngine, DEFAULT_POLICY_PROFILE_NAME } from './PolicyEngine.js';

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
const WS = 'ws_pengine';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-pengine-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_pengine', 'C:/tmp/ws_pengine', NOW, NOW, NOW);
  const repo = new PolicyRepository(db as unknown as TransactionDatabase);
  const engine = new PolicyEngine(repo, { now: () => NOW });
  return { db, repo, engine, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function evaluate(engine: PolicyEngine, overrides: Record<string, unknown> = {}) {
  return engine.evaluate({
    workspaceId: WS,
    action: 'provider.launch',
    agentPermissions: ['read'],
    ...overrides,
  });
}

test('first evaluation seeds the default profile and falls back to allow', () => {
  const fx = fixture();
  try {
    const result = evaluate(fx.engine);
    assert.equal(result.decision, 'allow');
    assert.equal(result.profileId, fx.repo.findDefaultProfile(WS)?.id);
    assert.equal(result.evaluatedAt, NOW);
    assert.equal(fx.repo.listProfiles(WS).length, 1);

    const rules = fx.repo.findRulesByProfile(result.profileId);
    assert.equal(rules.length, 2);
    const writeRule = rules.find(rule => rule.decision === 'require_approval');
    assert.deepEqual(writeRule?.selector, { permission: 'write' });
    const fallback = rules.find(rule => rule.decision === 'allow');
    assert.deepEqual(fallback?.selector, {});
    assert.equal(result.matchedRuleIds.length, 1);
    assert.equal(result.matchedRuleIds[0], fallback?.id);
  } finally {
    fx.close();
  }
});

test('an agent with the write permission requires approval, mirroring RuntimeApprovalGate', () => {
  const fx = fixture();
  try {
    const result = evaluate(fx.engine, { agentPermissions: ['read', 'write'] });
    assert.equal(result.decision, 'require_approval');
    assert.equal(result.matchedRuleIds.length, 2);
  } finally {
    fx.close();
  }
});

test('deny beats require_approval regardless of priority and specificity', () => {
  const fx = fixture();
  try {
    const profileId = evaluate(fx.engine).profileId;
    fx.repo.createRule({
      id: 'prule_' + 'h'.repeat(26), profileId, action: 'provider.launch',
      selector: {}, decision: 'deny', priority: -100, specificity: 0, createdAt: NOW,
    });
    const result = evaluate(fx.engine, { agentPermissions: ['write'] });
    assert.equal(result.decision, 'deny');
    assert.equal(result.matchedRuleIds.length, 3);
  } finally {
    fx.close();
  }
});

test('precedence across decision classes beats specificity: deny wins over a more specific require_approval', () => {
  const fx = fixture();
  try {
    const profileId = evaluate(fx.engine).profileId;
    fx.repo.createRule({
      id: 'prule_' + 'i'.repeat(26), profileId, action: 'provider.launch',
      selector: { providerType: 'codex' }, decision: 'require_approval', priority: 0, specificity: 5, createdAt: NOW,
    });
    fx.repo.createRule({
      id: 'prule_' + 'j'.repeat(26), profileId, action: 'provider.launch',
      selector: {}, decision: 'deny', priority: 0, specificity: 0, createdAt: NOW,
    });
    assert.equal(evaluate(fx.engine, { providerType: 'codex' }).decision, 'deny');
  } finally {
    fx.close();
  }
});

test('specificity then priority break ties within the same decision class', () => {
  const fx = fixture();
  try {
    const profileId = evaluate(fx.engine).profileId;
    const generic = fx.repo.createRule({
      id: 'prule_' + 'k'.repeat(26), profileId, action: 'provider.launch',
      selector: {}, decision: 'allow', priority: 100, specificity: 0, createdAt: NOW,
    });
    const specific = fx.repo.createRule({
      id: 'prule_' + 'l'.repeat(26), profileId, action: 'provider.launch',
      selector: { providerType: 'codex' }, decision: 'allow', priority: 0, specificity: 3, createdAt: NOW,
    });

    const first = evaluate(fx.engine, { providerType: 'codex' });
    assert.equal(first.decision, 'allow');
    assert.equal(first.matchedRuleIds[0], specific.id);

    fx.repo.setRuleEnabled(specific.id, false);
    assert.equal(evaluate(fx.engine, { providerType: 'codex' }).matchedRuleIds[0], generic.id);
    fx.repo.setRuleEnabled(specific.id, true);
    fx.repo.setRuleEnabled(generic.id, false);

    const lowPriority = fx.repo.createRule({
      id: 'prule_' + 'o'.repeat(26), profileId, action: 'provider.launch',
      selector: { providerType: 'codex' }, decision: 'allow', priority: 1, specificity: 3, createdAt: NOW,
    });
    const highPriority = fx.repo.createRule({
      id: 'prule_' + 'p'.repeat(26), profileId, action: 'provider.launch',
      selector: { providerType: 'codex' }, decision: 'allow', priority: 50, specificity: 3, createdAt: NOW,
    });
    assert.equal(evaluate(fx.engine, { providerType: 'codex' }).matchedRuleIds[0], highPriority.id);
    fx.repo.setRuleEnabled(highPriority.id, false);
    assert.equal(evaluate(fx.engine, { providerType: 'codex' }).matchedRuleIds[0], lowPriority.id);
  } finally {
    fx.close();
  }
});

test('disabled rules do not participate in evaluation', () => {
  const fx = fixture();
  try {
    const profileId = evaluate(fx.engine).profileId;
    const deny = fx.repo.createRule({
      id: 'prule_' + 'm'.repeat(26), profileId, action: 'provider.launch',
      selector: {}, decision: 'deny', priority: 500, specificity: 9, createdAt: NOW,
    });
    assert.equal(evaluate(fx.engine).decision, 'deny');
    fx.repo.setRuleEnabled(deny.id, false);
    assert.equal(evaluate(fx.engine).decision, 'allow');
  } finally {
    fx.close();
  }
});

test('seeding is idempotent: repeated evaluations create one profile', () => {
  const fx = fixture();
  try {
    evaluate(fx.engine, { agentPermissions: ['write'] });
    evaluate(fx.engine);
    evaluate(fx.engine, { agentPermissions: ['write'] });
    assert.equal(fx.repo.listProfiles(WS).length, 1);
    const profile = fx.repo.findDefaultProfile(WS)!;
    assert.equal(profile.name, DEFAULT_POLICY_PROFILE_NAME);
    assert.equal(fx.repo.findRulesByProfile(profile.id).length, 2);
  } finally {
    fx.close();
  }
});

test('evaluation returns complete decision fields for audit persistence', () => {
  const fx = fixture();
  try {
    const result = evaluate(fx.engine, {
      agentPermissions: ['write'], providerType: 'codex', runId: 'run_1', stageId: 'stage_1', fingerprint: 'fp_1',
    });
    assert.deepEqual(Object.keys(result).sort(), ['decision', 'evaluatedAt', 'matchedRuleIds', 'profileId']);
    assert.equal(result.decision, 'require_approval');
    assert.equal(result.profileId, fx.repo.findDefaultProfile(WS)!.id);
    assert.equal(result.evaluatedAt, NOW);
    assert.ok(result.matchedRuleIds.every(id => typeof id === 'string' && id.startsWith('prule_')));
    assert.equal(result.matchedRuleIds.length, 2);

    const persisted = fx.repo.insertDecision({
      id: 'pdec_' + 'n'.repeat(26), workspaceId: WS, runId: 'run_1', stageId: 'stage_1',
      action: 'provider.launch', fingerprint: 'fp_1', decision: result.decision,
      matchedRuleIds: result.matchedRuleIds, profileId: result.profileId, evaluatedAt: result.evaluatedAt,
    });
    assert.equal(persisted.decision, result.decision);
    assert.deepEqual(persisted.matchedRuleIds, result.matchedRuleIds);
  } finally {
    fx.close();
  }
});
