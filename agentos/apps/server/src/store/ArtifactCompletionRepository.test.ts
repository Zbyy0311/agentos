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
import { ArtifactCompletionRepository, ArtifactCompletionRepositoryError } from './ArtifactCompletionRepository.js';

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
const WS = 'ws_arcomp';
const ART = 'art_1';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-arcomp-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_arcomp', 'C:/tmp/ws_arcomp', NOW, NOW, NOW);
  // A review Artifact: provenance_kind CANONICAL references the canonical Run
  // directly (migration 016), so no legacy agent_runs/executions chain is needed.
  db.prepare("INSERT INTO tasks (id, workspace_id, title, created_by, created_at, updated_at) VALUES ('task_1', ?, 'T', 'agent_a', ?, ?)")
    .run(WS, NOW, NOW);
  db.prepare("INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at) VALUES ('run_1', ?, 'task_1', 'run_1', 'completed', 'initial', 'v2_api', 'agent_a', ?, ?)")
    .run(WS, NOW, NOW);
  db.prepare("INSERT INTO runtime_artifacts (id, workspace_id, provenance_kind, canonical_run_id, agent_id, artifact_type, title, summary, size_bytes, content_available, created_at) VALUES (?, ?, 'CANONICAL', 'run_1', 'agent_a', 'review', 'Review', 's', 12, 0, ?)")
    .run(ART, WS, NOW);
  const repo = new ArtifactCompletionRepository(db as unknown as TransactionDatabase);
  return { db, repo, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function completionInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'comp_' + 'a'.repeat(26),
    workspaceId: WS,
    artifactId: ART,
    artifactType: 'review' as const,
    runId: 'run_1',
    conclusion: 'approved' as const,
    decidedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}
test('AR-04: a recorded completion is durable and immutable', () => {
  const fx = fixture();
  try {
    const record = fx.repo.recordCompletion(completionInput());
    assert.equal(record.conclusion, 'approved');
    assert.equal(record.artifactType, 'review');
    assert.equal(record.runId, 'run_1');
    assert.equal(fx.repo.findById(WS, record.id)?.artifactId, ART);
    assert.throws(
      () => fx.db.prepare("UPDATE artifact_completions SET conclusion = 'fail' WHERE id = ?").run(record.id),
      /ARTIFACT_COMPLETION_IMMUTABLE/,
    );
    assert.equal(fx.repo.findById(WS, record.id)!.conclusion, 'approved');
  } finally {
    fx.close();
  }
});

test('AR-03/AR-06: input validation fails closed; a completion for a missing Artifact cannot persist', () => {
  const fx = fixture();
  try {
    assert.throws(() => fx.repo.recordCompletion(completionInput({ conclusion: 'maybe' })), ArtifactCompletionRepositoryError);
    assert.throws(() => fx.repo.recordCompletion(completionInput({ artifactType: 'file' })), ArtifactCompletionRepositoryError);
    assert.throws(() => fx.repo.recordCompletion(completionInput({ artifactId: '' })), ArtifactCompletionRepositoryError);
    // A completion for a non-existent Artifact violates the FK and persists nothing.
    assert.throws(
      () => fx.repo.recordCompletion(completionInput({ artifactId: 'art_missing' })),
      ArtifactCompletionRepositoryError,
    );
    assert.deepEqual(fx.repo.listForWorkspace(WS), []);
  } finally {
    fx.close();
  }
});
