import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { inTransaction } from './Transaction.js';
import {
  OutputReferenceIntegrityError,
  OutputReferenceValidationError,
  ProcessOutputReferenceRepository,
} from './ProcessOutputReferenceRepository.js';

type Db = InstanceType<typeof DatabaseSync>;

const NOW = '2026-08-13T00:00:00.000Z';
const LATER = '2026-08-13T01:00:00.000Z';
const WS = 'ws_m4';
const TASK = 'task_m4';
const RUN = 'run_m4';
const SNAPSHOT = 'snapshot_m4';
const STAGE = 'stage_m4';
const PCFG = 'pcfg_m4';
const AGENT = 'agent_m4';
const SESSION_ID = 'psess_' + 'A'.repeat(26);
const ROOT_ID = 'proc_' + 'B'.repeat(26);
const SHA256 = 'd'.repeat(64);

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  seedParents(db);
  return db;
}

function seedParents(db: Db): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, ?, '/tmp/m4', '/tmp/m4', ?, ?, ?)
  `).run(WS, 'M4', NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, 'M4 task', 'open', 'normal', 'test', ?, ?)
  `).run(TASK, WS, NOW, NOW);
  db.prepare(`
    INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', 'initial', 'v2_api', 'test', ?, ?)
  `).run(RUN, WS, TASK, RUN, NOW, NOW);
  db.prepare(`
    INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, captured_at)
    VALUES (?, ?, ?, 'workflow_00000000000000000000000002', 1, '{}', ?, ?)
  `).run(SNAPSHOT, WS, RUN, 'a'.repeat(64), NOW);
  db.prepare(`
    INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, 'plan', 'Plan', 1, 1, 'pending', ?, ?, 1)
  `).run(STAGE, WS, RUN, SNAPSHOT, NOW, NOW);
  db.prepare(`
    INSERT INTO provider_configurations (id, workspace_id, name, provider_type, adapter_id, runtime_mode, capabilities_json, timeout_policy_json, created_at, updated_at)
    VALUES (?, ?, 'M4 provider', 'kimicode', 'adapter.cli', 'cli', '{}', '{}', ?, ?)
  `).run(PCFG, WS, NOW, NOW);
  db.prepare(`
    INSERT INTO agent_profiles (workspace_id, id, name, agent_role, role_title, system_prompt, permissions_json, enabled, cli_command, cli_args_json, created_at, updated_at)
    VALUES (?, ?, 'Agent', 'worker', 'Worker', '', '[]', 1, 'agent', '[]', ?, ?)
  `).run(WS, AGENT, NOW, NOW);
  db.prepare(`
    INSERT INTO provider_sessions (
      id, workspace_id, task_id, run_id, stage_id, stage_attempt,
      authority_role, agent_id, provider_config_id, provider_config_version,
      provider_type, adapter_id, adapter_version, config_schema_version,
      runtime_mode, status, claim_epoch, capabilities_json, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'primary-provider', ?, ?, 1, 'kimicode', 'adapter.cli', '1.0.0', 1, 'cli', 'starting', 1, '{}', 1, ?, ?)
  `).run(
    SESSION_ID,
    WS,
    TASK,
    RUN,
    STAGE,
    AGENT,
    PCFG,
    NOW,
    NOW,
  );
  db.prepare(`
    INSERT INTO runtime_processes (
      id, workspace_id, task_id, run_id, stage_id, stage_attempt,
      provider_session_id, authority_role, claim_epoch, process_type, platform,
      status, executable_resolved, args_redacted_json, cwd_resolved, shell,
      detached, stdin_mode, stdout_mode, stderr_mode, timeout_policy_json,
      security_profile_ref, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, 'primary-provider', 1, 'provider', 'win32', 'created',
      'C:\\bin\\agent.exe', '[]', 'E:\\ws', 0, 0, 'closed', 'capture', 'capture',
      '{}', 'secprofile_default', 1, ?, ?)
  `).run(
    ROOT_ID,
    WS,
    TASK,
    RUN,
    STAGE,
    SESSION_ID,
    NOW,
    NOW,
  );
}

function referenceInput(overrides: Partial<Parameters<ProcessOutputReferenceRepository['createReference']>[0]> = {}) {
  return {
    workspaceId: WS,
    runId: RUN,
    processId: ROOT_ID,
    stream: 'stdout' as const,
    storageKey: 'sink/ws_m4/artifact_placeholder',
    contentType: 'text/plain',
    encoding: 'utf-8',
    redactionMode: 'scan' as const,
    createdAt: NOW,
    ...overrides,
  };
}

function assertValidation(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => (
    error instanceof OutputReferenceValidationError
    && error.code === 'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED'
  ));
}

function assertIntegrity(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => (
    error instanceof OutputReferenceIntegrityError
    && error.code === 'PROCESS_OUTPUT_REFERENCE_INTEGRITY_FAILED'
  ));
}

describe('ProcessOutputReferenceRepository', () => {
  it('creates a restricted zero-count reference with canonical artifact identity', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessOutputReferenceRepository(db);
      const { kind, reference } = repository.createReference(referenceInput());
      assert.equal(kind, 'created');
      assert.match(reference.artifactId, /^artifact_[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.equal(reference.accessClassification, 'restricted');
      assert.equal(reference.sourceBytesSeen, 0);
      assert.equal(reference.retainedBytes, 0);
      assert.equal(reference.nextSourceOffset, 0);
      assert.equal(reference.segmentCount, 0);
      assert.equal(reference.finalized, false);
      assert.equal(reference.sha256, null);
      assert.equal(reference.version, 1);
    } finally {
      db.close();
    }
  });

  it('duplicate (process_id, stream) joins the existing reference', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessOutputReferenceRepository(db);
      const first = repository.createReference(referenceInput());
      const second = repository.createReference(referenceInput());
      assert.equal(first.kind, 'created');
      assert.equal(second.kind, 'joined');
      assert.equal(second.reference.artifactId, first.reference.artifactId);
      const count = (db.prepare('SELECT COUNT(*) AS c FROM process_output_references').get() as { c: number }).c;
      assert.equal(count, 1);
    } finally {
      db.close();
    }
  });

  it('rejects invalid artifacts, modes, bounds and truncation shapes', () => {
    const cases: Array<[string, (repository: ProcessOutputReferenceRepository) => void]> = [
      ['bad artifact id', (repository) => {
        repository.createReference(referenceInput({ artifactId: 'artifact_bad' }));
      }],
      ['forbidden redaction mode', (repository) => {
        repository.createReference(referenceInput({ redactionMode: 'none' as never }));
      }],
      ['NUL storage key', (repository) => {
        repository.createReference(referenceInput({ storageKey: 'sink\u0000key' }));
      }],
      ['oversized retained bytes', (repository) => {
        repository.createReference(referenceInput({ sourceBytesSeen: 100, retainedBytes: 70 * 1024 * 1024 }));
      }],
      ['retained above source', (repository) => {
        repository.createReference(referenceInput({ sourceBytesSeen: 10, retainedBytes: 20 }));
      }],
      ['offset above source', (repository) => {
        repository.createReference(referenceInput({ sourceBytesSeen: 10, nextSourceOffset: 11 }));
      }],
      ['truncation reason without truncated', (repository) => {
        repository.createReference(referenceInput({ truncationReason: 'why' }));
      }],
      ['truncated without reason', (repository) => {
        repository.createReference(referenceInput({ truncated: true }));
      }],
    ];
    for (const [label, act] of cases) {
      const db = migratedDb();
      try {
        assertValidation(() => act(new ProcessOutputReferenceRepository(db)));
      } catch (error) {
        throw new Error(`case failed: ${label}`, { cause: error });
      } finally {
        db.close();
      }
    }
  });

  it('checkpoint CAS advances monotonically and duplicate checkpoints are idempotent', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessOutputReferenceRepository(db);
      const reference = repository.createReference(referenceInput()).reference;
      const first = repository.checkpoint({
        workspaceId: WS,
        processId: ROOT_ID,
        stream: 'stdout',
        expectedVersion: 1,
        sourceBytesSeen: 100,
        retainedBytes: 80,
        nextSourceOffset: 100,
        segmentCount: 1,
        truncated: false,
        updatedAt: LATER,
      });
      assert.equal(first.kind, 'applied');
      assert.equal(first.reference.sourceBytesSeen, 100);
      assert.equal(first.reference.version, 2);
      const duplicate = repository.checkpoint({
        workspaceId: WS,
        processId: ROOT_ID,
        stream: 'stdout',
        expectedVersion: 2,
        sourceBytesSeen: 100,
        retainedBytes: 80,
        nextSourceOffset: 100,
        segmentCount: 1,
        truncated: false,
        updatedAt: LATER,
      });
      assert.equal(duplicate.kind, 'duplicate');
      assert.equal(duplicate.reference.version, 2);
      const stale = repository.checkpoint({
        workspaceId: WS,
        processId: ROOT_ID,
        stream: 'stdout',
        expectedVersion: 1,
        sourceBytesSeen: 150,
        retainedBytes: 100,
        nextSourceOffset: 150,
        segmentCount: 2,
        truncated: false,
        updatedAt: LATER,
      });
      assert.equal(stale.kind, 'version-conflict');
      const regression = repository.checkpoint({
        workspaceId: WS,
        processId: ROOT_ID,
        stream: 'stdout',
        expectedVersion: 2,
        sourceBytesSeen: 50,
        retainedBytes: 40,
        nextSourceOffset: 50,
        segmentCount: 1,
        truncated: false,
        updatedAt: LATER,
      });
      assert.equal(regression.kind, 'non-monotonic');
    } finally {
      db.close();
    }
  });

  it('finalize stores sha256 once; duplicates return stored fact; append after finalize rejected', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessOutputReferenceRepository(db);
      const reference = repository.createReference(referenceInput()).reference;
      const finalized = repository.finalizeReference({
        workspaceId: WS,
        processId: ROOT_ID,
        stream: 'stdout',
        expectedVersion: 1,
        sha256: SHA256,
        finalizedAt: LATER,
      });
      assert.equal(finalized.kind, 'applied');
      assert.equal(finalized.reference.finalized, true);
      assert.equal(finalized.reference.sha256, SHA256);
      assert.equal(finalized.reference.finalizedAt, LATER);
      const duplicate = repository.finalizeReference({
        workspaceId: WS,
        processId: ROOT_ID,
        stream: 'stdout',
        expectedVersion: 2,
        sha256: SHA256,
        finalizedAt: LATER,
      });
      assert.equal(duplicate.kind, 'duplicate');
      const append = repository.checkpoint({
        workspaceId: WS,
        processId: ROOT_ID,
        stream: 'stdout',
        expectedVersion: 2,
        sourceBytesSeen: 200,
        retainedBytes: 200,
        nextSourceOffset: 200,
        segmentCount: 1,
        truncated: false,
        updatedAt: LATER,
      });
      assert.equal(append.kind, 'finalized');
      assert.throws(() => db.prepare(`
        UPDATE process_output_references SET source_bytes_seen = 300 WHERE process_id = ? AND stream = 'stdout'
      `).run(ROOT_ID), /PROCESS_OUTPUT_FINALIZED_IMMUTABLE/);
      assert.throws(() => db.prepare(`
        UPDATE process_output_references SET source_bytes_seen = 1 WHERE process_id = ? AND stream = 'stdout'
      `).run(ROOT_ID), /PROCESS_OUTPUT_FINALIZED_IMMUTABLE/);
    } finally {
      db.close();
    }
  });

  it('invalid sha256 is rejected; monotonic and delete triggers fail closed', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessOutputReferenceRepository(db);
      const reference = repository.createReference(referenceInput()).reference;
      assertValidation(() => repository.finalizeReference({
        workspaceId: WS,
        processId: ROOT_ID,
        stream: 'stdout',
        expectedVersion: 1,
        sha256: 'UPPER' + 'a'.repeat(59),
      }));
      assertValidation(() => repository.finalizeReference({
        workspaceId: WS,
        processId: ROOT_ID,
        stream: 'stdout',
        expectedVersion: 1,
        sha256: 'a'.repeat(63),
      }));
      repository.checkpoint({
        workspaceId: WS,
        processId: ROOT_ID,
        stream: 'stdout',
        expectedVersion: 1,
        sourceBytesSeen: 100,
        retainedBytes: 100,
        nextSourceOffset: 100,
        segmentCount: 1,
        truncated: false,
        updatedAt: LATER,
      });
      assert.throws(() => db.prepare(`
        UPDATE process_output_references SET source_bytes_seen = 99 WHERE process_id = ? AND stream = 'stdout'
      `).run(ROOT_ID), /PROCESS_OUTPUT_MONOTONIC/);
      assert.throws(() => db.prepare(`
        DELETE FROM process_output_references WHERE process_id = ? AND stream = 'stdout'
      `).run(ROOT_ID), /PROCESS_OUTPUT_REJECT_DELETE/);
      assert.equal(repository.listByProcess(WS, ROOT_ID).length, 1);
      db.prepare(`
        UPDATE process_output_references SET content_type = '' WHERE process_id = ? AND stream = 'stdout'
      `).run(ROOT_ID);
      assertIntegrity(() => repository.listByProcess(WS, ROOT_ID));
    } finally {
      db.close();
    }
  });

  it('workspace mismatch is classified distinctly from not-found', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessOutputReferenceRepository(db);
      repository.createReference(referenceInput());
      const mismatch = repository.checkpoint({
        workspaceId: 'ws_other',
        processId: ROOT_ID,
        stream: 'stdout',
        expectedVersion: 1,
        sourceBytesSeen: 10,
        retainedBytes: 10,
        nextSourceOffset: 10,
        segmentCount: 1,
        truncated: false,
      });
      assert.equal(mismatch.kind, 'workspace-mismatch');
      const missing = repository.checkpoint({
        workspaceId: WS,
        processId: 'proc_' + 'Z'.repeat(26),
        stream: 'stderr',
        expectedVersion: 1,
        sourceBytesSeen: 10,
        retainedBytes: 10,
        nextSourceOffset: 10,
        segmentCount: 1,
        truncated: false,
      });
      assert.equal(missing.kind, 'not-found');
    } finally {
      db.close();
    }
  });

  it('participates in an external transaction and rolls back with it', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessOutputReferenceRepository(db);
      assert.throws(() => inTransaction(db, () => {
        repository.createReference(referenceInput());
        throw new Error('outer rollback');
      }), /outer rollback/);
      assert.equal((db.prepare('SELECT COUNT(*) AS c FROM process_output_references').get() as { c: number }).c, 0);
    } finally {
      db.close();
    }
  });
});
