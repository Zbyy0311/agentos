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
import { ApprovalDecisionRepository, ApprovalDecisionRepositoryError } from './ApprovalDecisionRepository.js';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};
const NOW = '2026-09-11T00:00:00.000Z';
const WS = 'ws_apdec';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-apdec-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_apdec', 'C:/tmp/ws_apdec', NOW, NOW, NOW);
  const repo = new ApprovalDecisionRepository(db as unknown as TransactionDatabase);
  return { db, repo, root, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function decisionInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ap_' + 'a'.repeat(26),
    workspaceId: WS,
    agentId: 'agent_a',
    provider: 'codex',
    toolName: 'shell',
    actionFingerprint: 'shell:ls',
    riskLevel: 'low' as const,
    decision: 'allow_once' as const,
    decidedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}
test('AP-03: a recorded decision is durable and readable, and the row is immutable', () => {
  const fx = fixture();
  try {
    const record = fx.repo.recordDecision(decisionInput());
    assert.equal(record.id, decisionInput().id);
    assert.equal(record.decision, 'allow_once');
    assert.equal(record.riskLevel, 'low');
    assert.equal(record.workspaceId, WS);

    const found = fx.repo.findById(WS, record.id);
    assert.ok(found);
    assert.equal(found!.toolName, 'shell');
    assert.equal(Number((fx.db.prepare('SELECT COUNT(*) AS n FROM approval_decisions WHERE workspace_id = ?').get(WS) as { n: number | bigint }).n), 1);

    assert.throws(
      () => fx.db.prepare("UPDATE approval_decisions SET decision = 'deny' WHERE id = ?").run(record.id),
      /APPROVAL_DECISION_IMMUTABLE/,
    );
    assert.equal(fx.repo.findById(WS, record.id)!.decision, 'allow_once');
    assert.deepEqual(fx.repo.listForWorkspace(WS).map(r => r.id), [record.id]);
    assert.equal(fx.repo.countForWorkspace(WS), 1);
  } finally {
    fx.close();
  }
});

test('AP-03: input validation fails closed and never writes a partial row', () => {
  const fx = fixture();
  try {
    assert.throws(() => fx.repo.recordDecision(decisionInput({ toolName: '' })), ApprovalDecisionRepositoryError);
    assert.throws(() => fx.repo.recordDecision(decisionInput({ decision: 'maybe' })), ApprovalDecisionRepositoryError);
    assert.throws(() => fx.repo.recordDecision(decisionInput({ riskLevel: 'extreme' })), ApprovalDecisionRepositoryError);
    assert.throws(() => fx.repo.recordDecision(decisionInput({ decidedAt: '' })), ApprovalDecisionRepositoryError);
    assert.equal(fx.repo.countForWorkspace(WS), 0);
  } finally {
    fx.close();
  }
});
