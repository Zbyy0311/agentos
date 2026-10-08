import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { migration044, PREFERENCE_CONFIRMATIONS_044_DDL } from '../migrations/044-preference-confirmations.js';
import { SqliteStore } from '../../store/SqliteStore.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'agentos-preference-m2-'));
  mkdirSync(join(path, 'workspace'), { recursive: true });
  writeFileSync(join(path, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [
    ...['a', 'b'].map(id => ({ id: `workspace-${id}`, name: id, rootPath: path,
      gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-10-01T00:00:00.000Z',
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' })),
  ] }));
  return path;
}

test('044 requires its projection and Entry predecessors without partial DDL', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => migration044.apply({ db }), /PREREQUISITE_MISSING/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='preference_confirmations'").get(), undefined);
  } finally { db.close(); }
});

test('044 creates an idempotent sidecar and backfills provisional/stable projections with linked evidence', () => {
  const path = root();
  const store = new SqliteStore(path);
  try {
    const db = store.getDatabase();
    store.createConversation({ id: 'conv-a', workspaceId: 'workspace-a', type: 'direct', title: 'A', agentId: 'codex', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
    store.createMessage({ id: 'msg-a', conversationId: 'conv-a', workspaceId: 'workspace-a', senderType: 'user', content: 'source', createdAt: '2026-10-01T00:00:00.000Z' });
    store.createRun({ id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conv-a', sourceMessageId: 'msg-a', objective: 'preference', status: 'completed', resultSummary: 'ok', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
    store.createPreferenceEvidence({ id: 'evidence-a', profileId: 'default', workspaceId: 'workspace-a', conversationId: 'conv-a', runId: 'run-a', sourceEventId: 'source-a', dimension: 'response_detail', contextKind: 'coding', candidateValue: 'concise', signalType: 'repeated_instruction', polarity: 'positive', weight: 3, summary: 'observed', status: 'active', observedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z' });
    store.upsertPreferenceProjection({ id: 'projection-a', profileId: 'default', scope: 'workspace', workspaceId: 'workspace-a', dimension: 'response_detail', contextKind: 'coding', preferredValue: 'concise', confidence: 70, score: 7, evidenceCount: 1, independentRunCount: 1, status: 'provisional', lastSupportedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }, [{ evidenceId: 'evidence-a', contribution: 3 }]);
    store.upsertPreferenceProjection({ id: 'projection-stable', profileId: 'default', scope: 'global', dimension: 'execution_style', contextKind: 'general', preferredValue: 'direct_execution', confidence: 78, score: 8, evidenceCount: 3, independentRunCount: 3, status: 'stable', lastSupportedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
    store.upsertPreferenceProjection({ id: 'projection-observed', profileId: 'default', scope: 'global', dimension: 'response_detail', contextKind: 'general', preferredValue: 'balanced', confidence: 28, score: 2, evidenceCount: 1, independentRunCount: 1, status: 'observed', lastSupportedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
    migration044.apply({ db });
    migration044.apply({ db });
    const suggestion = db.prepare('SELECT status,version,evidence_json FROM preference_confirmations WHERE projection_id=?').get('projection-a') as { status: string; version: number; evidence_json: string };
    assert.equal(suggestion.status, 'pending');
    assert.equal(suggestion.version, 1);
    assert.equal(JSON.parse(suggestion.evidence_json).length, 1);
    assert.deepEqual((db.prepare("SELECT projection_id,status FROM preference_confirmations WHERE projection_id LIKE 'projection-%' ORDER BY projection_id").all() as Array<{ projection_id: string; status: string }>).map(row => ({ projection_id: row.projection_id, status: row.status })), [
      { projection_id: 'projection-a', status: 'pending' },
      { projection_id: 'projection-observed', status: 'pending' },
      { projection_id: 'projection-stable', status: 'pending' },
    ]);
    assert.equal((db.prepare("SELECT count(*) AS n FROM preference_confirmation_audit WHERE action='backfilled'").get() as { n: number }).n, 3);
    assert.equal((db.prepare('SELECT status FROM preference_projections WHERE id=?').get('projection-stable') as { status: string }).status, 'stable');
  } finally { store.close(); rmSync(path, { recursive: true, force: true }); }
});

test('044 failure rolls back its DDL and suggestion backfill under the migration transaction', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE preference_projections (
        id TEXT, profile_id TEXT, scope TEXT, workspace_id TEXT, preferred_value TEXT,
        dimension TEXT, context_kind TEXT, confidence INTEGER, evidence_count INTEGER,
        created_at TEXT, updated_at TEXT, status TEXT
      );
      CREATE TABLE preference_projection_evidence (projection_id TEXT, evidence_id TEXT);
      CREATE TABLE preference_evidence (
        id TEXT, profile_id TEXT, workspace_id TEXT, conversation_id TEXT, run_id TEXT,
        source_event_id TEXT, dimension TEXT, context_kind TEXT, candidate_value TEXT,
        signal_type TEXT, polarity TEXT, weight INTEGER, summary TEXT, status TEXT,
        observed_at TEXT, created_at TEXT
      );
      CREATE TABLE memory_entries (id TEXT);
      INSERT INTO preference_projections VALUES (
        'projection-fail','default','workspace','workspace-a','concise','response_detail',
        'coding',70,0,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','stable'
      );
      BEGIN IMMEDIATE;
    `);
    for (const statement of PREFERENCE_CONFIRMATIONS_044_DDL) db.prepare(statement).run();
    db.exec(`CREATE TRIGGER preference_backfill_failure BEFORE INSERT ON preference_confirmations
      BEGIN SELECT RAISE(ABORT,'injected preference backfill failure'); END`);
    assert.throws(() => migration044.apply({ db }), /injected preference backfill failure/);
    db.exec('ROLLBACK');
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='preference_confirmations'").get(), undefined);
  } finally { db.close(); }
});
