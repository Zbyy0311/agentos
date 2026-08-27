import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
    close(): void;
  };
};

import type { WorkflowDefinitionPayloadV2 } from '@agentos/shared';
import { canonicalizeJson, hashCanonicalJson } from '../../snapshots/canonicalJson.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { MigrationRegistry } from '../registry.js';
import {
  M25_LEGACY_WORKFLOW_ID,
  M25_UNBOUND_WORKFLOW_ID,
  migration007Checksum,
} from '../migrations/007-workflow-definitions.js';
import {
  M3_013_LEGACY_DEFINITION_HASH,
  M3_013_LEGACY_DEFINITION_JSON,
  M3_013_LEGACY_WORKFLOW_KEY,
  M3_013_LEGACY_WORKFLOW_NAME,
  M3_013_LEGACY_WORKFLOW_V2_ID,
  M3_013_SEED_TIMESTAMP,
  M3_013_UNBOUND_DEFINITION_HASH,
  M3_013_UNBOUND_DEFINITION_JSON,
  M3_013_UNBOUND_WORKFLOW_KEY,
  M3_013_UNBOUND_WORKFLOW_NAME,
  M3_013_UNBOUND_WORKFLOW_V2_ID,
  migration013,
  migration013Checksum,
} from '../migrations/013-workflow-creation-metadata-v2.js';
import { migration012Checksum } from '../migrations/012-m3-runtime-schema.js';
import {
  WorkflowDefinitionIntegrityError,
  WorkflowDefinitionRepository,
} from '../../store/WorkflowDefinitionRepository.js';

type Db = InstanceType<typeof DatabaseSync>;

const EXPECTED_IDS = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015'];
const NOW = '2026-08-03T00:00:00.000Z';

function migratedDb(registry = DEFAULT_REGISTRY_MIGRATIONS): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...registry])).run();
  return db;
}

function legacyV2Payload(definitionKey = 'invalid-v2', version = 20): WorkflowDefinitionPayloadV2 {
  return {
    schemaVersion: 2,
    definitionKey,
    version,
    name: definitionKey,
    executionMode: 'legacy_pipeline',
    retryPolicy: null,
    worktreeMode: 'preferred',
    stages: [
      { key: 'first', sequence: 1, agentRole: 'codex', dependsOn: [] },
      { key: 'second', sequence: 2, agentRole: 'kimi', dependsOn: ['first'] },
    ],
  };
}

function insertDefinition(db: Db, payload: unknown, id: string): void {
  const value = payload as Record<string, unknown>;
  const definitionJson = canonicalizeJson(payload);
  db.prepare(`
    INSERT INTO workflow_definitions (
      id, definition_key, version, name, definition_json, definition_hash,
      enabled, archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
  `).run(
    id,
    value.definitionKey,
    value.version,
    value.name,
    definitionJson,
    hashCanonicalJson(payload),
    NOW,
    NOW,
  );
}

function assertIntegrity(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => (
    error instanceof WorkflowDefinitionIntegrityError
    && error.code === 'WORKFLOW_DEFINITION_INTEGRITY_FAILED'
  ));
}

test('Migration 013 is non-destructive, canonical, and preserves the frozen 007/012 checksums', () => {
  assert.deepEqual(DEFAULT_REGISTRY_MIGRATIONS.map(migration => migration.id), EXPECTED_IDS);
  assert.equal(migration013.id, '013');
  assert.equal(migration013.destructive, false);
  assert.equal(migration007Checksum, '2bf9edb75204d05e');
  assert.equal(migration012Checksum, '7b87c3538e4b9e83');
  assert.equal(hashCanonicalJson(JSON.parse(M3_013_LEGACY_DEFINITION_JSON)), M3_013_LEGACY_DEFINITION_HASH);
  assert.equal(hashCanonicalJson(JSON.parse(M3_013_UNBOUND_DEFINITION_JSON)), M3_013_UNBOUND_DEFINITION_HASH);
  assert.match(migration013Checksum, /^[0-9a-f]{16}$/);
});

test('fresh DB keeps Workflow V1 and adds both Workflow V2 definitions through Migration 013', () => {
  const db = migratedDb();
  try {
    const rows = db.prepare(`
      SELECT id, definition_key, version, name, definition_json, definition_hash, created_at, updated_at
      FROM workflow_definitions ORDER BY definition_key, version
    `).all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map(row => [row.id, row.definition_key, row.version, row.name]), [
      [M25_LEGACY_WORKFLOW_ID, 'legacy-pipeline', 1, 'legacy-pipeline-v1'],
      [M3_013_LEGACY_WORKFLOW_V2_ID, M3_013_LEGACY_WORKFLOW_KEY, 2, M3_013_LEGACY_WORKFLOW_NAME],
      [M25_UNBOUND_WORKFLOW_ID, 'unbound-task-run', 1, 'unbound-task-run-v1'],
      [M3_013_UNBOUND_WORKFLOW_V2_ID, M3_013_UNBOUND_WORKFLOW_KEY, 2, M3_013_UNBOUND_WORKFLOW_NAME],
    ]);
    assert.deepEqual(rows.filter(row => row.version === 2).map(row => [row.definition_json, row.definition_hash, row.created_at, row.updated_at]), [
      [M3_013_LEGACY_DEFINITION_JSON, M3_013_LEGACY_DEFINITION_HASH, M3_013_SEED_TIMESTAMP, M3_013_SEED_TIMESTAMP],
      [M3_013_UNBOUND_DEFINITION_JSON, M3_013_UNBOUND_DEFINITION_HASH, M3_013_SEED_TIMESTAMP, M3_013_SEED_TIMESTAMP],
    ]);
    assert.deepEqual(
      (db.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>).map(row => row.migration_id),
      EXPECTED_IDS,
    );
  } finally {
    db.close();
  }
});

test('001–012 DB upgrade adds only the two V2 rows and leaves both V1 rows byte-for-byte unchanged', () => {
  const through012 = DEFAULT_REGISTRY_MIGRATIONS.filter(
    migration => migration.id !== '013' && migration.id !== '014' && migration.id !== '015',
  );
  const db = migratedDb(through012);
  try {
    const before = db.prepare(`
      SELECT id, definition_key, version, name, definition_json, definition_hash, created_at, updated_at
      FROM workflow_definitions WHERE version = 1 ORDER BY id
    `).all();
    // This test proves Migration 013 upgrade semantics only; Migration 014 is
    // destructive and requires the backup gate, which an in-memory upgrade DB
    // cannot satisfy. Its behavior is covered by m4-p2-migration-014.test.ts.
    new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(migration => migration.id !== '014'))).run();
    const after = db.prepare(`
      SELECT id, definition_key, version, name, definition_json, definition_hash, created_at, updated_at
      FROM workflow_definitions WHERE version = 1 ORDER BY id
    `).all();
    assert.deepEqual(after, before);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM workflow_definitions WHERE version = 2').get() as { count: number }).count, 2);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '013'").get() as { count: number }).count, 1);
  } finally {
    db.close();
  }
});

test('WorkflowDefinitionRepository selects and exposes exact V2 metadata', () => {
  const db = migratedDb();
  try {
    const repository = new WorkflowDefinitionRepository(db);
    const legacy = repository.findLatestAvailableByKey(M3_013_LEGACY_WORKFLOW_KEY);
    const unbound = repository.findLatestAvailableByKey(M3_013_UNBOUND_WORKFLOW_KEY);
    assert.equal(legacy?.payload.schemaVersion, 2);
    assert.equal(legacy?.payload.worktreeMode, 'preferred');
    assert.deepEqual(legacy?.payload.stages.map(stage => stage.dependsOn), [
      [], ['codex_manager'], ['kimi_worker'], ['opencode_reviewer'],
    ]);
    assert.equal(unbound?.payload.schemaVersion, 2);
    assert.equal(unbound?.payload.worktreeMode, 'disabled');
    assert.deepEqual(unbound?.payload.stages, []);
  } finally {
    db.close();
  }
});

test('WorkflowDefinitionRepository rejects invalid V2 worktree and dependency contracts', () => {
  const cases: Array<[string, (payload: Record<string, unknown>) => void]> = [
    ['invalid-worktree', payload => { payload.worktreeMode = 'workspace'; }],
    ['missing-worktree', payload => { delete payload.worktreeMode; }],
    ['unknown-root', payload => { payload.extra = true; }],
    ['missing-depends', payload => { delete (payload.stages as Array<Record<string, unknown>>)[0]!.dependsOn; }],
    ['unknown-stage', payload => { (payload.stages as Array<Record<string, unknown>>)[0]!.extra = true; }],
    ['duplicate-depends', payload => { (payload.stages as Array<Record<string, unknown>>)[1]!.dependsOn = ['first', 'first']; }],
    ['self-depends', payload => { (payload.stages as Array<Record<string, unknown>>)[0]!.dependsOn = ['first']; }],
    ['missing-depends-target', payload => { (payload.stages as Array<Record<string, unknown>>)[1]!.dependsOn = ['missing']; }],
    ['forward-depends', payload => { (payload.stages as Array<Record<string, unknown>>)[0]!.dependsOn = ['second']; }],
  ];
  for (const [id, mutate] of cases) {
    const db = migratedDb();
    try {
      const payload = JSON.parse(JSON.stringify(legacyV2Payload(`invalid-${id}`, 20))) as Record<string, unknown>;
      mutate(payload);
      insertDefinition(db, payload, `workflow_invalid_${id}`);
      assertIntegrity(() => new WorkflowDefinitionRepository(db).findById(`workflow_invalid_${id}`));
    } finally {
      db.close();
    }
  }
});
