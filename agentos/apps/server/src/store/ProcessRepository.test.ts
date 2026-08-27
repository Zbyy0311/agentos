import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createM3RuntimeEventRegistry } from '@agentos/shared';

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
import { ProviderSessionRepository } from './ProviderSessionRepository.js';
import { ProcessOutputReferenceRepository } from './ProcessOutputReferenceRepository.js';
import { OutboxRepository } from './OutboxRepository.js';
import { RuntimeEventOutboxWriter, RuntimeEventRepository } from './RuntimeEventRepository.js';
import { RunSequenceAllocator } from './RunSequenceAllocator.js';
import {
  ProcessRepository,
  RuntimeProcessIntegrityError,
  RuntimeProcessValidationError,
} from './ProcessRepository.js';

const require = createRequire(import.meta.url);
const durableCoordinatorModulePath = fileURLToPath(
  new URL('../../../../packages/process-runtime/src/durable-coordinator.ts', import.meta.url),
);
const artifactSinkModulePath = fileURLToPath(
  new URL('../../../../packages/process-runtime/src/artifact-sink.ts', import.meta.url),
);

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
}

function rootInput(
  overrides: Partial<Parameters<ProcessRepository['createProcess']>[0]> = {},
): Parameters<ProcessRepository['createProcess']>[0] {
  return {
    workspaceId: WS,
    taskId: TASK,
    runId: RUN,
    stageId: STAGE,
    stageAttempt: 1,
    providerSessionId: SESSION_ID,
    authorityRole: 'primary-provider' as const,
    claimEpoch: 1,
    processType: 'provider' as const,
    platform: 'win32',
    executableResolved: 'C:\\bin\\agent.exe',
    argsRedacted: ['[REDACTED]', '[REDACTED]'],
    cwdResolved: 'E:\\ws',
    shell: 0,
    detached: 0,
    stdinMode: 'closed' as const,
    stdoutMode: 'capture' as const,
    stderrMode: 'capture' as const,
    timeoutPolicy: { graceMs: 5000 },
    securityProfileRef: 'secprofile_default',
    createdAt: NOW,
    ...overrides,
  };
}

function assertValidation(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => (
    error instanceof RuntimeProcessValidationError
    && error.code === 'RUNTIME_PROCESS_VALIDATION_FAILED'
  ));
}

function assertIntegrity(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => (
    error instanceof RuntimeProcessIntegrityError
    && error.code === 'RUNTIME_PROCESS_INTEGRITY_FAILED'
  ));
}

describe('ProcessRepository', () => {
  it('creates a created reservation before spawn with no native identity', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      const { kind, process } = repository.createProcess(rootInput());
      assert.equal(kind, 'created');
      assert.match(process.id, /^proc_[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.equal(process.status, 'created');
      assert.equal(process.claimEpoch, 1);
      assert.equal(process.nativePid, null);
      assert.equal(process.nativeStartedAt, null);
      assert.equal(process.version, 1);
      assert.equal(process.argsRedactedJson, '["[REDACTED]","[REDACTED]"]');
      assert.equal(process.timeoutPolicyJson, '{"graceMs":5000}');
    } finally {
      db.close();
    }
  });

  it('exactly-one root claim per Stage attempt; losers join', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      const first = repository.createProcess(rootInput());
      const second = repository.createProcess(rootInput());
      assert.equal(first.kind, 'created');
      assert.equal(second.kind, 'joined');
      assert.equal(second.process.id, first.process.id);
      const count = (db.prepare('SELECT COUNT(*) AS c FROM runtime_processes').get() as { c: number }).c;
      assert.equal(count, 1);
    } finally {
      db.close();
    }
  });

  it('child reservations follow a valid parent chain; missing parents fail closed', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      const root = repository.createProcess(rootInput()).process;
      const child = repository.createProcess(rootInput({
        parentProcessId: root.id,
        authorityRole: null,
        providerSessionId: null,
        stageId: null,
        stageAttempt: null,
      })).process;
      assert.equal(child.status, 'created');
      assert.equal(child.parentProcessId, root.id);
      const grandchild = repository.createProcess(rootInput({
        parentProcessId: child.id,
        authorityRole: null,
        providerSessionId: null,
        stageId: null,
        stageAttempt: null,
      })).process;
      assert.equal(grandchild.parentProcessId, child.id);
      assertValidation(() => repository.createProcess(rootInput({
        parentProcessId: 'proc_' + 'z'.repeat(26),
        authorityRole: null,
        providerSessionId: null,
        stageId: null,
        stageAttempt: null,
      })));
      // Self-parent is unreachable via UPDATE: identity immutability fires
      // first; the DDL self-parent CHECK stays as defense in depth.
      assert.throws(() => db.prepare(`
        UPDATE runtime_processes SET parent_process_id = id WHERE id = ?
      `).run(root.id), /RUNTIME_PROCESS_IDENTITY_IMMUTABLE/);
    } finally {
      db.close();
    }
  });

  it('root shape and session binding constraints fail closed', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      assertValidation(() => repository.createProcess(rootInput({
        authorityRole: 'primary-provider' as const,
        providerSessionId: null,
      })));
      assertValidation(() => repository.createProcess(rootInput({
        authorityRole: null,
        parentProcessId: null,
        providerSessionId: SESSION_ID,
        stageId: null,
        stageAttempt: null,
      })));
      assertValidation(() => repository.createProcess(rootInput({
        authorityRole: null,
        parentProcessId: null,
        providerSessionId: null,
        stageId: STAGE,
        stageAttempt: null,
      })));
      assertValidation(() => repository.createProcess(rootInput({
        authorityRole: 'primary-provider' as const,
        parentProcessId: 'proc_' + 'b'.repeat(26),
      })));
    } finally {
      db.close();
    }
  });

  it('winning created->starting CAS consumes the spawn right; losers never respawn', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      const process = repository.createProcess(rootInput()).process;
      const winner = repository.casStartProcess({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      assert.equal(winner.kind, 'applied');
      assert.equal(winner.process.status, 'starting');
      assert.equal(winner.process.nativePid, null);
      assert.equal(winner.process.version, 2);
      const loser = repository.casStartProcess({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      assert.equal(loser.kind, 'state-mismatch');
      const again = repository.casStartProcess({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 2,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      assert.equal(again.kind, 'state-mismatch');
      assert.equal(repository.findById(WS, process.id)!.version, 2);
    } finally {
      db.close();
    }
  });

  it('native PID binds only to the same Process; starting->running sets started_at', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      const process = repository.createProcess(rootInput()).process;
      repository.casStartProcess({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      const fenced = repository.casBindNativeIdentity({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 2,
        expectedClaimEpoch: 9,
        expectedClaimOwner: null,
        timestamp: LATER,
        nativePid: 9999,
        nativeStartedAt: LATER,
      });
      assert.equal(fenced.kind, 'fence-conflict');
      assert.equal(repository.findById(WS, process.id)!.nativePid, null);
      const bound = repository.casBindNativeIdentity({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 2,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
        nativePid: 4242,
        nativeParentPid: 4000,
        nativeStartedAt: LATER,
      });
      assert.equal(bound.kind, 'applied');
      assert.equal(bound.process.status, 'running');
      assert.equal(bound.process.nativePid, 4242);
      assert.equal(bound.process.startedAt, LATER);
      assert.equal(bound.process.version, 3);
      assert.equal(repository.findById(WS, process.id)!.nativePid, 4242);
    } finally {
      db.close();
    }
  });

  it('P6-M2a spawn persists recovery metadata (hash only, never plaintext token)', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      const process = repository.createProcess(rootInput()).process;
      repository.casStartProcess({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      const rawToken = 'p6m2a-one-time-recovery-token-0123456789abcdef';
      const bound = repository.casBindNativeIdentity({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 2,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
        nativePid: 4242,
        nativeStartedAt: LATER,
        recoveryToken: rawToken,
      });
      assert.equal(bound.kind, 'applied');

      const persisted = repository.findById(WS, process.id)!;
      // Recovery fields are now written by production code.
      assert.equal(typeof persisted.recoveryTokenHash, 'string');
      assert.match(persisted.recoveryTokenHash!, /^[0-9a-f]{64}$/);
      assert.equal(persisted.recoveryCheckedAt, LATER);
      assert.equal(typeof persisted.recoveryEvidenceJson, 'string');

      // The hash verifies the token (matches SHA-256 of the raw token).
      const expectedHash = createHash('sha256').update(rawToken, 'utf8').digest('hex');
      assert.equal(persisted.recoveryTokenHash, expectedHash);

      // The plaintext token never reaches the database.
      assert.notEqual(persisted.recoveryTokenHash, rawToken);
      const evidence = JSON.parse(persisted.recoveryEvidenceJson!) as Record<string, unknown>;
      // P6-M3b: the writer emits the current version (v2) with the birth identity.
      assert.equal(evidence.schemaVersion, 2);
      assert.equal(evidence.nativePid, 4242);
      assert.equal(evidence.nativeStartedAt, LATER);
      assert.equal(evidence.nativeBirthIdentity, null, 'no birth identity was supplied in this bind');
      assert.equal(evidence.recoveryTokenHash, expectedHash);
      assert.equal(evidence.platform, 'win32');
      const serializedEvidence = persisted.recoveryEvidenceJson!;
      assert.ok(!serializedEvidence.includes(rawToken), 'evidence must not embed the raw token');

      // Raw SQL read-back: no column may contain the plaintext token.
      const row = db.prepare('SELECT * FROM runtime_processes WHERE id = ?').get(process.id) as Record<string, unknown>;
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'string') {
          assert.ok(!value.includes(rawToken), `column ${key} must not contain the raw token`);
        }
      }
    } finally {
      db.close();
    }
  });

+  it('P6-M3b bind persists the lossless birth identity in the canonical column and v2 mirror', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      const process = repository.createProcess(rootInput()).process;
      repository.casStartProcess({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      const rawToken = 'p6m3b-birth-token';
      const birth = '134176000000000000'; // > 2^53, exercises the lossless text path
      const bound = repository.casBindNativeIdentity({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 2,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
        nativePid: 5150,
        nativeStartedAt: LATER,
        nativeBirthIdentity: birth,
        recoveryToken: rawToken,
      });
      assert.equal(bound.kind, 'applied');
      const persisted = repository.findById(WS, process.id)!;
      // Dedicated column is canonical and preserved exactly (no Number coercion).
      assert.equal(persisted.nativeBirthIdentity, birth);
      // The v2 evidence mirror carries the exact same canonical value.
      const evidence = JSON.parse(persisted.recoveryEvidenceJson!) as Record<string, unknown>;
      assert.equal(evidence.schemaVersion, 2);
      assert.equal(evidence.nativeBirthIdentity, birth);
      // Raw SQL read-back proves the column holds the exact decimal digits.
      const row = db.prepare('SELECT native_birth_identity FROM runtime_processes WHERE id = ?').get(process.id) as { native_birth_identity: string };
      assert.equal(row.native_birth_identity, birth);
    } finally {
      db.close();
    }
  });

  it('P6-M2a bind without a recovery token leaves recovery columns null', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      const process = repository.createProcess(rootInput()).process;
      repository.casStartProcess({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      const bound = repository.casBindNativeIdentity({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 2,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
        nativePid: 4242,
        nativeStartedAt: LATER,
      });
      assert.equal(bound.kind, 'applied');
      const persisted = repository.findById(WS, process.id)!;
      assert.equal(persisted.recoveryTokenHash, null);
      assert.equal(persisted.recoveryEvidenceJson, null);
      assert.equal(persisted.recoveryCheckedAt, null);
    } finally {
      db.close();
    }
  });

  it('late spawn success during stopping binds identity but never running', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      const process = repository.createProcess(rootInput()).process;
      repository.casStartProcess({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      const stopping = repository.transitionStatus({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 2,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        expectedFrom: 'starting',
        to: 'stopping',
        timestamp: LATER,
      });
      assert.equal(stopping.kind, 'applied');
      const bound = repository.casBindNativeIdentity({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 3,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
        nativePid: 777,
        nativeStartedAt: LATER,
      });
      assert.equal(bound.kind, 'applied');
      assert.equal(bound.process.status, 'stopping');
      assert.equal(bound.process.nativePid, 777);
      assert.equal(bound.process.startedAt, null);
    } finally {
      db.close();
    }
  });

  it('terminal processes are immutable; duplicate terminal observation returns stored fact', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      const process = repository.createProcess(rootInput()).process;
      repository.casStartProcess({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      repository.casBindNativeIdentity({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 2,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
        nativePid: 123,
        nativeStartedAt: LATER,
      });
      const terminal = repository.transitionStatus({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 3,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        expectedFrom: 'running',
        to: 'exited',
        timestamp: LATER,
        exitCode: 0,
        exitSignal: null,
      });
      assert.equal(terminal.kind, 'applied');
      assert.equal(terminal.process.status, 'exited');
      assert.equal(terminal.process.exitCode, 0);
      assert.equal(terminal.process.exitedAt, LATER);
      const duplicate = repository.transitionStatus({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 4,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        expectedFrom: 'running',
        to: 'exited',
        timestamp: LATER,
        exitCode: 0,
      });
      assert.equal(duplicate.kind, 'terminal');
      assert.equal(duplicate.process.version, 4);
      assert.throws(() => db.prepare(`
        UPDATE runtime_processes SET status = 'orphaned' WHERE id = ?
      `).run(process.id), /RUNTIME_PROCESS_TERMINAL_IMMUTABLE/);
    } finally {
      db.close();
    }
  });

  it('spawn failure compensation terminalizes with stable evidence and never respawns', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      const process = repository.createProcess(rootInput()).process;
      repository.casStartProcess({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      const failed = repository.transitionStatus({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 2,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        expectedFrom: 'starting',
        to: 'failed',
        timestamp: LATER,
        errorCode: 'PROCESS_SPAWN_FAILED',
        errorDetailRedacted: 'native spawn failed',
      });
      assert.equal(failed.kind, 'applied');
      assert.equal(failed.process.status, 'failed');
      assert.equal(failed.process.errorCode, 'PROCESS_SPAWN_FAILED');
      const retry = repository.casStartProcess({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 3,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      assert.equal(retry.kind, 'terminal');
    } finally {
      db.close();
    }
  });

  it('canonical JSON is enforced at the repository layer and json_valid at the DDL floor', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      assertValidation(() => repository.createProcess(rootInput({
        argsRedacted: { bad: undefined },
      })));
      assertValidation(() => repository.createProcess(rootInput({
        argsRedacted: ['x'.repeat(70 * 1024)],
      })));
      assertValidation(() => repository.createProcess(rootInput({
        timeoutPolicy: new Date(),
      })));
      const process = repository.createProcess(rootInput()).process;
      assert.throws(() => db.prepare(`
        UPDATE runtime_processes SET args_redacted_json = 'not-json' WHERE id = ?
      `).run(process.id), /CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('claim transfer requires created, no native identity and an expired lease', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      const process = repository.createProcess(rootInput({
        claimOwnerId: 'svc-1',
        claimLeaseExpiresAt: '2026-08-12T00:00:00.000Z',
      })).process;
      const transferred = repository.casTransferClaim({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: 'svc-1',
        timestamp: NOW,
        newClaimOwner: 'svc-2',
        newClaimLeaseExpiresAt: '2026-08-13T02:00:00.000Z',
      });
      assert.equal(transferred.kind, 'applied');
      assert.equal(transferred.process.claimEpoch, 2);
      assert.equal(transferred.process.claimOwnerId, 'svc-2');
      const stale = repository.casTransferClaim({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 2,
        expectedClaimEpoch: 2,
        expectedClaimOwner: 'svc-1',
        timestamp: NOW,
        newClaimOwner: 'svc-3',
        newClaimLeaseExpiresAt: '2026-08-13T03:00:00.000Z',
      });
      assert.equal(stale.kind, 'fence-conflict');
    } finally {
      db.close();
    }
  });

  it('running requires native identity; created forbids it; tampered rows fail integrity', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      const process = repository.createProcess(rootInput()).process;
      assert.throws(() => db.prepare(`
        UPDATE runtime_processes SET native_pid = 5 WHERE id = ?
      `).run(process.id), /CHECK constraint failed/);
      db.prepare(`
        UPDATE runtime_processes SET status = 'running', native_pid = 1, native_started_at = ?, started_at = ? WHERE id = ?
      `).run(NOW, NOW, process.id);
      db.prepare("UPDATE runtime_processes SET version = 1.5 WHERE id = ?").run(process.id);
      assertIntegrity(() => repository.findById(WS, process.id));
      assert.throws(() => db.prepare('DELETE FROM runtime_processes WHERE id = ?').run(process.id),
        /RUNTIME_PROCESS_REJECT_DELETE/);
    } finally {
      db.close();
    }
  });

  it('participates in an external transaction and rolls back with it', () => {
    const db = migratedDb();
    try {
      const repository = new ProcessRepository(db);
      assert.throws(() => inTransaction(db, () => {
        repository.createProcess(rootInput());
        throw new Error('outer rollback');
      }), /outer rollback/);
      assert.equal((db.prepare('SELECT COUNT(*) AS c FROM runtime_processes').get() as { c: number }).c, 0);
    } finally {
      db.close();
    }
  });
});

function fileDbPair(): { root: string; path: string; a: Db; b: Db; close(): void } {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m4-p2b-race-'));
  const path = join(root, 'agentos.sqlite');
  const a = new DatabaseSync(path);
  const b = new DatabaseSync(path);
  a.exec('PRAGMA foreign_keys = ON');
  a.exec('PRAGMA busy_timeout = 5000');
  b.exec('PRAGMA foreign_keys = ON');
  b.exec('PRAGMA busy_timeout = 5000');
  return {
    root,
    path,
    a,
    b,
    close() {
      try { a.close(); } catch { /* ignore */ }
      try { b.close(); } catch { /* ignore */ }
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold the file briefly; OS temp cleanup removes it. */ }
    },
  };
}

interface WorkerHandle {
  started: Promise<void>;
  attempted: Promise<void>;
  result: Promise<unknown>;
  terminate(): Promise<void>;
}

function runRepoCallInWorker(
  repoFile: string,
  repoClass: string,
  dbPath: string,
  method: string,
  args: unknown[],
): WorkerHandle {
  const moduleUrl = new URL(`./${repoFile}.ts`, import.meta.url).href;
  const code = [
    "const { parentPort } = require('node:worker_threads');",
    "(async () => {",
    "  try {",
    "    const { register } = require('tsx/esm/api');",
    "    register();",
    "    const { DatabaseSync } = require('node:sqlite');",
    `    const module = await import(${JSON.stringify(moduleUrl)});`,
    `    const db = new DatabaseSync(${JSON.stringify(dbPath)});`,
    "    db.exec('PRAGMA foreign_keys = ON');",
    "    db.exec('PRAGMA busy_timeout = 5000');",
    `    const repo = new module.${repoClass}(db);`,
    "    parentPort.postMessage({ type: 'started' });",
    "    parentPort.postMessage({ type: 'attempting' });",
    `    const result = await Promise.resolve(repo[${JSON.stringify(method)}](...${JSON.stringify(args)}));`,
    "    db.close();",
    "    parentPort.postMessage({ type: 'result', value: result });",
    "  } catch (error) {",
    "    parentPort.postMessage({ type: 'error', error: String((error && error.message) || error) });",
    "  }",
    "})();",
  ].join('\n');
  const worker = new Worker(code, { eval: true });
  let resolveStarted: () => void = () => undefined;
  let rejectStarted: (error: Error) => void = () => undefined;
  let resolveAttempted: () => void = () => undefined;
  let rejectAttempted: (error: Error) => void = () => undefined;
  let resolveResult: (value: unknown) => void = () => undefined;
  let rejectResult: (error: Error) => void = () => undefined;
  const started = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const attempted = new Promise<void>((resolve, reject) => {
    resolveAttempted = resolve;
    rejectAttempted = reject;
  });
  const result = new Promise<unknown>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on('message', (message) => {
    if (message.type === 'started') resolveStarted();
    else if (message.type === 'attempting') resolveAttempted();
    else if (message.type === 'result') resolveResult(message.value);
    else if (message.type === 'error') {
      const error = new Error(message.error);
      rejectStarted(error);
      rejectAttempted(error);
      rejectResult(error);
    }
  });
  worker.once('error', (error) => {
    rejectStarted(error);
    rejectAttempted(error);
    rejectResult(error);
  });
  return {
    started,
    attempted,
    result,
    terminate: () => worker.terminate().then(() => undefined),
  };
}

describe('ProcessRepository two-connection races', () => {
  it('root Process claim race: exactly one root row; loser joins with a stable result', async () => {
    const pair = fileDbPair();
    try {
      const seed = (db: Db) => {
        new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
        seedParents(db);
      };
      seed(pair.a);
      const repositoryA = new ProcessRepository(pair.a);
      const repositoryB = new ProcessRepository(pair.b);

      pair.a.exec('BEGIN IMMEDIATE');
      const worker = runRepoCallInWorker(
        'ProcessRepository',
        'ProcessRepository',
        pair.path,
        'createProcess',
        [rootInput()],
      );
     await worker.started;
      await worker.attempted;
      // A wins the root claim while holding the write lock. createProcess
      // wraps itself in a transaction, so the winner is inserted with the
      // exact same CAS SQL the repository uses (no nested BEGIN).
      const winnerId = 'proc_' + 'C'.repeat(26);
      pair.a.prepare(`
        INSERT INTO runtime_processes (
          id, workspace_id, task_id, run_id, stage_id, stage_attempt,
          provider_session_id, authority_role, claim_epoch, process_type, platform,
          status, executable_resolved, args_redacted_json, cwd_resolved, shell,
          detached, stdin_mode, stdout_mode, stderr_mode, timeout_policy_json,
          security_profile_ref, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, 'primary-provider', 1, 'provider', 'win32',
          'created', 'C:\\bin\\agent.exe', '["[REDACTED]"]', 'E:\\ws', 0, 0, 'closed',
          'capture', 'capture', '{"graceMs":5000}', 'secprofile_default', 1, ?, ?)
      `).run(winnerId, WS, TASK, RUN, STAGE, SESSION_ID, NOW, NOW);
      const winner = { kind: 'created', process: { id: winnerId } };
     pair.a.exec('COMMIT');
     const loser = await worker.result as { kind: string; process: { id: string } };
     assert.equal(loser.kind, 'joined');
     assert.equal(loser.process.id, winner.process.id);
      const count = (pair.b.prepare('SELECT COUNT(*) AS c FROM runtime_processes').get() as { c: number }).c;
      assert.equal(count, 1);
      await worker.terminate();
    } finally {
      pair.close();
    }
  });

  it('created->starting CAS race: exactly one winner consumes the spawn right', async () => {
    const pair = fileDbPair();
    try {
      const seed = (db: Db) => {
        new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
        seedParents(db);
      };
      seed(pair.a);
      const repositoryA = new ProcessRepository(pair.a);
      const repositoryB = new ProcessRepository(pair.b);
      const process = repositoryA.createProcess(rootInput()).process;

      pair.a.exec('BEGIN IMMEDIATE');
      const worker = runRepoCallInWorker(
        'ProcessRepository',
        'ProcessRepository',
        pair.path,
        'casStartProcess',
        [{
          workspaceId: WS,
          processId: process.id,
          expectedVersion: 1,
          expectedClaimEpoch: 1,
          expectedClaimOwner: null,
          timestamp: LATER,
        }],
      );
      await worker.started;
      await worker.attempted;
      const winner = repositoryA.casStartProcess({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      assert.equal(winner.kind, 'applied');
      pair.a.exec('COMMIT');
      const loser = await worker.result as { kind: string };
      assert.equal(loser.kind, 'state-mismatch');
      const final = repositoryB.findById(WS, process.id)!;
      assert.equal(final.status, 'starting');
      assert.equal(final.version, 2);
      // No second spawn can ever be consumed: a further CAS is a mismatch.
      const again = repositoryB.casStartProcess({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: 2,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      assert.equal(again.kind, 'state-mismatch');
      await worker.terminate();
    } finally {
      pair.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Real Migration 014 SQLite integration for the process-runtime durable
// coordinator. The coordinator is loaded at runtime via createRequire so the
// server tsc rootDir boundary stays intact; the port adapters below map the
// three real repositories to the coordinator's structural seam.
// ---------------------------------------------------------------------------

interface IntegrationSessionView {
  sessionId: string;
  workspaceId: string;
  runId: string;
  stageId: string;
  stageAttempt: number;
  status: string;
  claimEpoch: number;
  claimOwnerId: string | null;
  adapterStartRequestedAt: string | null;
  version: number;
}

interface IntegrationProcessView {
  processId: string;
  workspaceId: string;
  runId: string;
  status: string;
  claimEpoch: number;
  claimOwnerId: string | null;
  nativePid: number | null;
  version: number;
}

interface IntegrationOutputView {
  processId: string;
  stream: string;
  workspaceId: string;
  runId: string;
  artifactId: string;
  storageKey: string;
  sourceBytesSeen: number;
  retainedBytes: number;
  nextSourceOffset: number;
  segmentCount: number;
  truncated: boolean;
  truncationReason: string | null;
  finalized: boolean;
  sha256: string | null;
  version: number;
}

interface IntegrationSessionCreate {
  workspaceId: string;
  taskId: string;
  runId: string;
  stageId: string;
  stageAttempt: number;
  authorityRole: string;
  agentId: string;
  providerConfigId: string;
  providerConfigVersion: number;
  providerType: string;
  adapterId: string;
  adapterVersion: string;
  configSchemaVersion: number;
  runtimeMode: string;
  claimEpoch: number;
  claimOwnerId?: string | null;
  claimLeaseExpiresAt?: string | null;
  capabilities: unknown;
}

interface IntegrationProcessCreate {
  workspaceId: string;
  taskId: string;
  runId: string;
  stageId?: string | null;
  stageAttempt?: number | null;
  providerSessionId?: string | null;
  parentProcessId?: string | null;
  authorityRole?: string | null;
  claimEpoch: number;
  claimOwnerId?: string | null;
  claimLeaseExpiresAt?: string | null;
  processType: string;
  platform: string;
  executableResolved: string;
  executableFingerprint?: string | null;
  argsRedacted: unknown;
  cwdResolved: string;
  shell: number;
  detached: number;
  stdinMode: string;
  stdoutMode: string;
  stderrMode: string;
  timeoutPolicy: unknown;
  securityProfileRef: string;
}

interface IntegrationFenceInput {
  workspaceId: string;
  expectedClaimEpoch: number;
  expectedClaimOwner: string | null;
}

interface IntegrationClaimInput extends IntegrationFenceInput {
  sessionId: string;
  expectedVersion: number;
  timestamp: string;
}

interface IntegrationProcessClaimInput extends IntegrationFenceInput {
  processId: string;
  expectedVersion: number;
  timestamp: string;
}

interface IntegrationTransitionInput extends IntegrationFenceInput {
  sessionId: string;
  processId: string;
  expectedVersion: number;
  timestamp: string;
  expectedFrom: string;
  to: string;
  errorCode?: string;
  errorDetailRedacted?: string;
  exitCode?: number | null;
  cleanupResult?: string | null;
  failureCode?: string;
  failureDetailRedacted?: string;
}

interface IntegrationOutputCreate {
  workspaceId: string;
  runId: string;
  processId: string;
  stream: string;
  storageKey: string;
  contentType: string;
  encoding: string;
  redactionMode: string;
}

interface IntegrationOutputCheckpoint {
  workspaceId: string;
  processId: string;
  stream: string;
  expectedVersion: number;
  sourceBytesSeen: number;
  retainedBytes: number;
  nextSourceOffset: number;
  segmentCount: number;
  truncated: boolean;
  truncationReason?: string | null;
}

interface IntegrationOutputFinalize {
  workspaceId: string;
  processId: string;
  stream: string;
  expectedVersion: number;
  sha256: string;
}

interface IntegrationTransferPairInput {
  session: IntegrationClaimInput & { newClaimOwner: string; newClaimLeaseExpiresAt: string };
  process: IntegrationProcessClaimInput & { newClaimOwner: string; newClaimLeaseExpiresAt: string };
}

function toSessionView(session: { id: string; workspaceId: string; runId: string; stageId: string; stageAttempt: number; status: string; claimEpoch: number; claimOwnerId: string | null; adapterStartRequestedAt: string | null; version: number }): IntegrationSessionView {
  return {
    sessionId: session.id,
    workspaceId: session.workspaceId,
    runId: session.runId,
    stageId: session.stageId,
    stageAttempt: session.stageAttempt,
    status: session.status,
    claimEpoch: session.claimEpoch,
    claimOwnerId: session.claimOwnerId,
    adapterStartRequestedAt: session.adapterStartRequestedAt,
    version: session.version,
  };
}

function toProcessView(process: { id: string; workspaceId: string; runId: string; status: string; claimEpoch: number; claimOwnerId: string | null; nativePid: number | null; version: number }): IntegrationProcessView {
  return {
    processId: process.id,
    workspaceId: process.workspaceId,
    runId: process.runId,
    status: process.status,
    claimEpoch: process.claimEpoch,
    claimOwnerId: process.claimOwnerId,
    nativePid: process.nativePid,
    version: process.version,
  };
}

function mapSessionOutcome(outcome: { kind: string; session?: unknown; eventId?: string }): { kind: string; value?: unknown; eventId?: string } {
  if (outcome.session === undefined) return { kind: outcome.kind };
  return {
    kind: outcome.kind,
    value: toSessionView(outcome.session as never),
    ...(outcome.eventId === undefined ? {} : { eventId: outcome.eventId }),
  };
}

function mapProcessOutcome(outcome: { kind: string; process?: unknown; eventId?: string }): { kind: string; value?: unknown; eventId?: string } {
  if (outcome.process === undefined) return { kind: outcome.kind };
  return {
    kind: outcome.kind,
    value: toProcessView(outcome.process as never),
    ...(outcome.eventId === undefined ? {} : { eventId: outcome.eventId }),
  };
}

describe('M4-P2B real SQLite coordinator integration', () => {
  it('establish + spawn flow + output persist real rows through the coordinator', async () => {
    const db = migratedDb();
    const root = mkdtempSync(join(tmpdir(), 'agentos-m4-p2b-int-'));
    try {
      db.prepare(`
        INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, 'plan', 'Plan', 2, 2, 'pending', ?, ?, 1)
      `).run(STAGE + '_b', WS, RUN, SNAPSHOT, NOW, NOW);
      const events = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
      const outbox = new OutboxRepository(db, events);
      const factWriter = new RuntimeEventOutboxWriter(events, new RunSequenceAllocator(db), outbox, db);
      const sessionRepo = new ProviderSessionRepository(db, factWriter);
      const processRepo = new ProcessRepository(db, factWriter);
      const outputRepo = new ProcessOutputReferenceRepository(db, factWriter);
      const eventContext = { correlationId: RUN, causationId: 'op_m4_coordinator' };
      const { DurableProcessCoordinator } = require(durableCoordinatorModulePath);
      const { FileArtifactSink } = require(artifactSinkModulePath);

      const sessionPort = {
        createSessionClaim: async (input: any) => {
          const result = sessionRepo.createSession({
            workspaceId: input.workspaceId,
            taskId: input.taskId,
            runId: input.runId,
            stageId: input.stageId,
            stageAttempt: input.stageAttempt,
            authorityRole: input.authorityRole,
            agentId: input.agentId,
            providerConfigId: input.providerConfigId,
            providerConfigVersion: input.providerConfigVersion,
            providerType: input.providerType,
            adapterId: input.adapterId,
            adapterVersion: input.adapterVersion,
            configSchemaVersion: input.configSchemaVersion,
            runtimeMode: input.runtimeMode,
            claimEpoch: input.claimEpoch,
            claimOwnerId: input.claimOwnerId ?? null,
            claimLeaseExpiresAt: input.claimLeaseExpiresAt ?? null,
            capabilities: input.capabilities,
            eventContext: input.eventContext,
          });
          return {
            kind: result.kind,
            session: toSessionView(result.session),
            ...(result.eventId === undefined ? {} : { eventId: result.eventId }),
          };
        },
        casSetAdapterStartRequested: async (input: any) => mapSessionOutcome(sessionRepo.casSetAdapterStartRequested({
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          expectedVersion: input.expectedVersion,
          expectedClaimEpoch: input.expectedClaimEpoch,
          expectedClaimOwner: input.expectedClaimOwner,
          timestamp: input.timestamp,
          eventContext: input.eventContext,
        })),
        casSessionTransition: async (input: any) => mapSessionOutcome(sessionRepo.transitionStatus({
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          expectedVersion: input.expectedVersion,
          expectedClaimEpoch: input.expectedClaimEpoch,
          expectedClaimOwner: input.expectedClaimOwner,
          expectedFrom: input.expectedFrom,
          to: input.to,
          timestamp: input.timestamp,
          failureCode: input.failureCode,
          failureDetailRedacted: input.failureDetailRedacted,
          eventContext: input.eventContext,
        })),
        getSession: async (workspaceId: string, sessionId: string) => {
          const session = sessionRepo.findById(workspaceId, sessionId);
          return session === undefined ? null : toSessionView(session);
        },
      };

      const processPort = {
        createProcessReservation: async (input: any) => {
          const result = processRepo.createProcess({
            workspaceId: input.workspaceId,
            taskId: input.taskId,
            runId: input.runId,
            stageId: input.stageId ?? null,
            stageAttempt: input.stageAttempt ?? null,
            providerSessionId: input.providerSessionId ?? null,
            parentProcessId: input.parentProcessId ?? null,
            authorityRole: input.authorityRole ?? null,
            claimEpoch: input.claimEpoch,
            claimOwnerId: input.claimOwnerId ?? null,
            claimLeaseExpiresAt: input.claimLeaseExpiresAt ?? null,
            processType: input.processType,
            platform: input.platform,
            executableResolved: input.executableResolved,
            executableFingerprint: input.executableFingerprint ?? null,
            argsRedacted: input.argsRedacted,
            cwdResolved: input.cwdResolved,
            shell: input.shell,
            detached: input.detached,
            stdinMode: input.stdinMode,
            stdoutMode: input.stdoutMode,
            stderrMode: input.stderrMode,
            timeoutPolicy: input.timeoutPolicy,
            securityProfileRef: input.securityProfileRef,
            eventContext: input.eventContext,
          });
          return {
            kind: result.kind,
            process: toProcessView(result.process),
            ...(result.eventId === undefined ? {} : { eventId: result.eventId }),
          };
        },
        casConsumeSpawnRight: async (input: any) => mapProcessOutcome(processRepo.casStartProcess({
          workspaceId: input.workspaceId,
          processId: input.processId,
          expectedVersion: input.expectedVersion,
          expectedClaimEpoch: input.expectedClaimEpoch,
          expectedClaimOwner: input.expectedClaimOwner,
          timestamp: input.timestamp,
          eventContext: input.eventContext,
        })),
        casBindNativeIdentity: async (input: any) => mapProcessOutcome(processRepo.casBindNativeIdentity({
          workspaceId: input.workspaceId,
          processId: input.processId,
          expectedVersion: input.expectedVersion,
          expectedClaimEpoch: input.expectedClaimEpoch,
          expectedClaimOwner: input.expectedClaimOwner,
          timestamp: input.timestamp,
          nativePid: input.identity.nativePid,
          nativeParentPid: input.identity.nativeParentPid ?? null,
          nativeStartedAt: input.identity.nativeStartedAt,
          eventContext: input.eventContext,
        })),
        casProcessTransition: async (input: any) => mapProcessOutcome(processRepo.transitionStatus({
          workspaceId: input.workspaceId,
          processId: input.processId,
          expectedVersion: input.expectedVersion,
          expectedClaimEpoch: input.expectedClaimEpoch,
          expectedClaimOwner: input.expectedClaimOwner,
          expectedFrom: input.expectedFrom,
          to: input.to,
          timestamp: input.timestamp,
          errorCode: input.errorCode,
          errorDetailRedacted: input.errorDetailRedacted,
          exitCode: input.exitCode ?? null,
          exitSignal: input.exitSignal ?? null,
          terminationReason: input.terminationReason ?? null,
          cleanupResult: input.cleanupResult ?? null,
          gracefulRequested: input.gracefulRequested,
          graceDeadline: input.graceDeadline,
          forceDeadline: input.forceDeadline,
          idempotencyKeyHash: input.idempotencyKeyHash,
          durationMs: input.durationMs,
          graceful: input.graceful,
          force: input.force,
          failureOutcome: input.failureOutcome,
          cancelReason: input.cancelReason,
          cancelCausationId: input.cancelCausationId,
          spawnFailureEvidence: input.spawnFailureEvidence,
          eventContext: input.eventContext,
        })),
        getProcess: async (workspaceId: string, processId: string) => {
          const process = processRepo.findById(workspaceId, processId);
          return process === undefined ? null : toProcessView(process);
        },
      };

      const outputPort = {
        createReference: async (input: any) => {
          const result = outputRepo.createReference({
            workspaceId: input.workspaceId,
            runId: input.runId,
            processId: input.processId,
            stream: input.stream,
            storageKey: input.storageKey,
            contentType: input.contentType,
            encoding: input.encoding,
            redactionMode: input.redactionMode,
            eventContext: input.eventContext,
          });
          return {
            kind: result.kind,
            reference: result.reference,
            ...(result.eventId === undefined ? {} : { eventId: result.eventId }),
          };
        },
        checkpoint: async (input: any) => {
          const outcome = outputRepo.checkpoint(input);
          return {
            kind: outcome.kind,
            value: 'reference' in outcome ? outcome.reference : undefined,
            ...(outcome.eventId === undefined ? {} : { eventId: outcome.eventId }),
          };
        },
        finalizeReference: async (input: any) => {
          const outcome = outputRepo.finalizeReference(input);
          return {
            kind: outcome.kind,
            value: 'reference' in outcome ? outcome.reference : undefined,
            ...(outcome.eventId === undefined ? {} : { eventId: outcome.eventId }),
          };
        },
        getReference: async (workspaceId: string, processId: string, stream: string) => {
          const reference = outputRepo.findReference(workspaceId, processId, stream as 'stdout' | 'stderr');
          return reference === undefined ? null : reference;
        },
      };

      const atomicSeam = {
       createSessionAndRootProcess: async (input: any) => {
          let sessionResult!: { kind: string; session: { id: string }; eventId?: string };
          let processResult!: { kind: string; process: unknown; eventId?: string };
          inTransaction(db, () => {
            sessionResult = sessionRepo.createSession({
              workspaceId: input.session.workspaceId,
              taskId: input.session.taskId,
              runId: input.session.runId,
              stageId: input.session.stageId,
              stageAttempt: input.session.stageAttempt,
              authorityRole: input.session.authorityRole,
              agentId: input.session.agentId,
              providerConfigId: input.session.providerConfigId,
              providerConfigVersion: input.session.providerConfigVersion,
              providerType: input.session.providerType,
              adapterId: input.session.adapterId,
              adapterVersion: input.session.adapterVersion,
              configSchemaVersion: input.session.configSchemaVersion,
              runtimeMode: input.session.runtimeMode,
              claimEpoch: input.session.claimEpoch,
              claimOwnerId: input.session.claimOwnerId ?? null,
              claimLeaseExpiresAt: input.session.claimLeaseExpiresAt ?? null,
              capabilities: input.session.capabilities,
              eventContext: input.session.eventContext,
            });
            processResult = processRepo.createProcess({
              workspaceId: input.process.workspaceId,
              taskId: input.process.taskId,
              runId: input.process.runId,
              stageId: input.process.stageId ?? null,
              stageAttempt: input.process.stageAttempt ?? null,
              providerSessionId: input.process.providerSessionId
                ?? (input.process.authorityRole ? sessionResult.session.id : null),
              parentProcessId: input.process.parentProcessId ?? null,
              authorityRole: input.process.authorityRole ?? null,
              claimEpoch: input.process.claimEpoch,
              claimOwnerId: input.process.claimOwnerId ?? null,
              claimLeaseExpiresAt: input.process.claimLeaseExpiresAt ?? null,
              processType: input.process.processType,
              platform: input.process.platform,
              executableResolved: input.process.executableResolved,
              executableFingerprint: input.process.executableFingerprint ?? null,
              argsRedacted: input.process.argsRedacted,
              cwdResolved: input.process.cwdResolved,
              shell: input.process.shell,
              detached: input.process.detached,
              stdinMode: input.process.stdinMode,
              stdoutMode: input.process.stdoutMode,
              stderrMode: input.process.stderrMode,
              timeoutPolicy: input.process.timeoutPolicy,
              securityProfileRef: input.process.securityProfileRef,
              eventContext: sessionResult.eventId === undefined
                ? input.process.eventContext
                : { ...input.process.eventContext, causationId: sessionResult.eventId },
            });
          });
          return {
            session: toSessionView(sessionResult.session as never),
            process: toProcessView(processResult.process as never),
            joinedExisting: processResult.kind === 'joined',
            sessionEventId: sessionResult.eventId,
            processEventId: processResult.eventId,
          };
        },
        casTransferClaimPair: async (input: any) => {
          let sOutcome: { kind: string; eventId?: string } = { kind: 'not-found' };
          let pOutcome: { kind: string; eventId?: string } = { kind: 'not-found' };
          let aborted = false;
          try {
            inTransaction(db, () => {
              sOutcome = sessionRepo.casTransferClaim({
                workspaceId: input.session.workspaceId,
                sessionId: input.session.sessionId,
                expectedVersion: input.session.expectedVersion,
                expectedClaimEpoch: input.session.expectedClaimEpoch,
                expectedClaimOwner: input.session.expectedClaimOwner,
                timestamp: input.session.timestamp,
                newClaimOwner: input.session.newClaimOwner,
                newClaimLeaseExpiresAt: input.session.newClaimLeaseExpiresAt,
                eventContext: input.session.eventContext,
              });
              if (sOutcome.kind !== 'applied') throw new Error('PAIR_ABORT');
              pOutcome = processRepo.casTransferClaim({
                workspaceId: input.process.workspaceId,
                processId: input.process.processId,
                expectedVersion: input.process.expectedVersion,
                expectedClaimEpoch: input.process.expectedClaimEpoch,
                expectedClaimOwner: input.process.expectedClaimOwner,
                timestamp: input.process.timestamp,
                newClaimOwner: input.process.newClaimOwner,
                newClaimLeaseExpiresAt: input.process.newClaimLeaseExpiresAt,
                eventContext: sOutcome.eventId === undefined
                  ? input.process.eventContext
                  : { ...input.process.eventContext, causationId: sOutcome.eventId },
              });
              if (pOutcome.kind !== 'applied') throw new Error('PAIR_ABORT');
            });
          } catch (error) {
            if ((error as Error).message !== 'PAIR_ABORT') throw error;
            aborted = true;
          }
          const session = sessionRepo.findById(input.session.workspaceId, input.session.sessionId)!;
          const process = processRepo.findById(input.process.workspaceId, input.process.processId)!;
          if (!aborted) {
            return {
              kind: 'applied',
              session: toSessionView(session),
              process: toProcessView(process),
              sessionEventId: sOutcome.eventId,
              processEventId: pOutcome.eventId,
            };
          }
          return {
            kind: 'conflict',
            reason: (sOutcome!.kind === 'applied' ? pOutcome!.kind : sOutcome!.kind),
            session: toSessionView(session),
            process: toProcessView(process),
          };
        },
      };

      const driver = {
        spawn: async () => { throw new Error('unused'); },
        gracefulStop: async () => ({ delivered: true, detail: 'ok' }),
        terminateTree: async () => ({ classification: 'complete', attemptedMembers: [], errors: [] }),
        verifySurvivors: async () => ({ classification: 'complete', knownPids: [] }),
        inspectIdentity: async () => ({ kind: 'match', identity: { pid: 1, startedAtMs: 0, executablePath: 'x' } }),
      };

      const coordinator = new DurableProcessCoordinator({
        sessionRepository: sessionPort,
        processRepository: processPort,
        outputReferenceRepository: outputPort,
        artifactSink: new FileArtifactSink(join(root, 'sink')),
        atomicSeam,
        driver,
      });

      const established = await coordinator.establishClaimAndReservation({
        session: {
          workspaceId: WS,
          taskId: TASK,
          runId: RUN,
          stageId: STAGE + '_b',
          stageAttempt: 2,
          authorityRole: 'primary-provider',
          agentId: AGENT,
          providerConfigId: PCFG,
          providerConfigVersion: 1,
          providerType: 'kimicode',
          adapterId: 'adapter.cli',
          adapterVersion: '1.0.0',
          configSchemaVersion: 1,
          runtimeMode: 'cli',
          claimEpoch: 1,
          claimOwnerId: 'svc-1',
          claimLeaseExpiresAt: '2026-08-12T00:00:00.000Z',
          capabilities: { streaming: true },
          eventContext,
        },
        process: {
          workspaceId: WS,
          taskId: TASK,
          runId: RUN,
          stageId: STAGE + '_b',
          stageAttempt: 2,
          providerSessionId: null,
          authorityRole: 'primary-provider',
          claimEpoch: 1,
          claimOwnerId: 'svc-1',
          claimLeaseExpiresAt: '2026-08-12T00:00:00.000Z',
          processType: 'provider',
          platform: 'win32',
          executableResolved: 'C:\\bin\\agent.exe',
          argsRedacted: ['[REDACTED]'],
          cwdResolved: 'E:\\ws',
          shell: 0,
          detached: 0,
          stdinMode: 'closed',
          stdoutMode: 'capture',
          stderrMode: 'capture',
          timeoutPolicy: { graceMs: 5000 },
          securityProfileRef: 'secprofile_default',
          eventContext,
        },
      });
      assert.equal(established.session.status, 'starting');
      assert.equal(established.process.status, 'created');
      assert.equal((db.prepare('SELECT COUNT(*) AS c FROM provider_sessions').get() as { c: number }).c, 2);
      assert.equal((db.prepare('SELECT COUNT(*) AS c FROM runtime_processes').get() as { c: number }).c, 1);

      // Duplicate establish joins the same pair.
      const duplicate = await coordinator.establishClaimAndReservation({
        session: {
          workspaceId: WS,
          taskId: TASK,
          runId: RUN,
          stageId: STAGE + '_b',
          stageAttempt: 2,
          authorityRole: 'primary-provider',
          agentId: AGENT,
          providerConfigId: PCFG,
          providerConfigVersion: 1,
          providerType: 'kimicode',
          adapterId: 'adapter.cli',
          adapterVersion: '1.0.0',
          configSchemaVersion: 1,
          runtimeMode: 'cli',
          claimEpoch: 1,
          claimOwnerId: 'svc-1',
          claimLeaseExpiresAt: '2026-08-12T00:00:00.000Z',
          capabilities: { streaming: true },
          eventContext,
        },
        process: {
          workspaceId: WS,
          taskId: TASK,
          runId: RUN,
          stageId: STAGE + '_b',
          stageAttempt: 2,
          providerSessionId: established.session.sessionId,
          authorityRole: 'primary-provider',
          claimEpoch: 1,
          claimOwnerId: 'svc-1',
          claimLeaseExpiresAt: '2026-08-12T00:00:00.000Z',
          processType: 'provider',
          platform: 'win32',
          executableResolved: 'C:\\bin\\agent.exe',
          argsRedacted: ['[REDACTED]'],
          cwdResolved: 'E:\\ws',
          shell: 0,
          detached: 0,
          stdinMode: 'closed',
          stdoutMode: 'capture',
          stderrMode: 'capture',
          timeoutPolicy: { graceMs: 5000 },
          securityProfileRef: 'secprofile_default',
          eventContext,
        },
      });
      assert.equal(duplicate.joinedExisting, true);

      // Paired takeover against the real repos.
      const pair = await coordinator.transferClaimPair({
        session: {
          workspaceId: established.session.workspaceId,
          sessionId: established.session.sessionId,
          expectedVersion: established.session.version,
          expectedClaimEpoch: established.session.claimEpoch,
          expectedClaimOwner: established.session.claimOwnerId,
          timestamp: LATER,
          newClaimOwner: 'svc-2',
          newClaimLeaseExpiresAt: '2026-08-13T02:00:00.000Z',
          eventContext,
        },
        process: {
          workspaceId: established.process.workspaceId,
          processId: established.process.processId,
          expectedVersion: established.process.version,
          expectedClaimEpoch: established.process.claimEpoch,
          expectedClaimOwner: established.process.claimOwnerId,
          timestamp: LATER,
          newClaimOwner: 'svc-2',
          newClaimLeaseExpiresAt: '2026-08-13T02:00:00.000Z',
          eventContext,
        },
      });
      assert.equal(pair.kind, 'applied');
      assert.equal(pair.session.claimEpoch, 2);
      assert.equal(pair.process.claimEpoch, 2);

      // Spawn flow against the real repos (fake native handle only).
      const spawned = await coordinator.consumeSpawnRightAndSpawn({
        workspaceId: pair.process.workspaceId,
        processId: pair.process.processId,
        expectedVersion: pair.process.version,
        expectedClaimEpoch: pair.process.claimEpoch,
        expectedClaimOwner: pair.process.claimOwnerId,
        timestamp: NOW,
        eventContext,
        spawn: async () => ({
          pid: 4242,
          identity: { pid: 4242, startedAtMs: Date.parse(NOW), executablePath: 'C:\\bin\\agent.exe', parentPid: 4000 },
          streams: { stdout: (async function* () {})(), stderr: (async function* () {})() },
          waitExit: async () => ({ exitCode: 0, signal: null, exitedAt: Date.parse(NOW) }),
        }),
      });
      assert.equal(spawned.kind, 'spawned');
      assert.equal(spawned.outcome.value.status, 'running');
      const storedProcess = processRepo.findById(pair.process.workspaceId, pair.process.processId)!;
      assert.equal(storedProcess.status, 'running');
      assert.equal(storedProcess.nativePid, 4242);

      // Output flow against the real repos + real file sink.
      const writer = await coordinator.beginOutput({
        workspaceId: storedProcess.workspaceId,
        runId: storedProcess.runId,
        processId: storedProcess.id,
        stream: 'stdout',
        storageKey: 'sink/ws_m4/int-' + storedProcess.id,
        contentType: 'text/plain',
        encoding: 'utf-8',
        redactionMode: 'scan',
        eventContext,
      });
      const bytes = new TextEncoder().encode('hello real sqlite');
      const appended = await writer.append({
        stream: 'stdout',
        sequence: 1,
        sourceOffset: 0,
        sourceBytes: bytes.length,
        bytes,
        text: 'hello real sqlite',
        binary: false,
      });
      assert.equal(appended.kind, 'applied');
      assert.equal(appended.value.sourceBytesSeen, bytes.length);
      const finalized = await writer.finalize();
      assert.equal(finalized.outcome.kind, 'applied');
      const reference = outputRepo.findReference(storedProcess.workspaceId, storedProcess.id, 'stdout')!;
      assert.equal(reference.finalized, true);
      assert.equal(reference.sha256, finalized.sha256);

      const processFacts = events.listByRunAfterSequence(RUN, 0)
        .filter(record => record.kind === 'known' && record.event.processId === storedProcess.id)
        .map(record => record.event);
      const launch = processFacts.find(event => event.type === 'process.launch_requested');
      const transfer = processFacts.find(event => event.type === 'process.claim_transferred');
      const starting = processFacts.find(event => event.type === 'process.starting');
      const started = processFacts.find(event => event.type === 'process.started');
      const outputFacts = processFacts.filter(event => event.type === 'process.output_reference_advanced');
      assert.ok(launch);
      assert.ok(transfer);
      assert.ok(starting);
      assert.ok(started);
      assert.equal(starting.causationId, transfer.id);
      assert.equal(started.causationId, starting.id);
      assert.equal(outputFacts.length, 2);
      assert.equal(outputFacts[0].causationId, started.id);
      assert.equal(outputFacts[1].causationId, outputFacts[0].id);
      assert.equal(new Set(processFacts.map(event => event.correlationId)).size, 1);
      assert.equal(processFacts[0].correlationId, eventContext.correlationId);
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS c FROM outbox_messages WHERE aggregate_id = ?').get(RUN) as { c: number }).c,
        (db.prepare('SELECT COUNT(*) AS c FROM runtime_events WHERE run_id = ?').get(RUN) as { c: number }).c,
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('atomic rollback: invalid Process reservation leaves Session=0 and Process=0', async () => {
    const db = migratedDb();
    try {
      db.prepare(`
        INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, 'plan', 'Plan', 2, 2, 'pending', ?, ?, 1)
      `).run(STAGE + '_b', WS, RUN, SNAPSHOT, NOW, NOW);
      const sessionRepo = new ProviderSessionRepository(db);
      const processRepo = new ProcessRepository(db);
      const outputRepo = new ProcessOutputReferenceRepository(db);
      const { DurableProcessCoordinator } = require(durableCoordinatorModulePath);
      const { FileArtifactSink } = require(artifactSinkModulePath);
      const root = mkdtempSync(join(tmpdir(), 'agentos-m4-p2b-rollback-'));

      const sessionPort = { createSessionClaim: async () => { throw new Error('unused'); }, casSetAdapterStartRequested: async () => ({ kind: 'state-mismatch' }), casSessionTransition: async () => ({ kind: 'state-mismatch' }), getSession: async () => null };
      const processPort = { createProcessReservation: async () => { throw new Error('unused'); }, casConsumeSpawnRight: async () => ({ kind: 'state-mismatch' }), casBindNativeIdentity: async () => ({ kind: 'state-mismatch' }), casProcessTransition: async () => ({ kind: 'state-mismatch' }), getProcess: async () => null };
      const outputPort = { createReference: async () => ({ kind: 'created', reference: null }), checkpoint: async () => ({ kind: 'state-mismatch' }), finalizeReference: async () => ({ kind: 'state-mismatch' }), getReference: async () => null };
      const atomicSeam = {
        createSessionAndRootProcess: async (input: any) => {
          try {
            inTransaction(db, () => {
              sessionRepo.createSession({
                workspaceId: input.session.workspaceId,
                taskId: input.session.taskId,
                runId: input.session.runId,
                stageId: input.session.stageId,
                stageAttempt: input.session.stageAttempt,
                authorityRole: input.session.authorityRole,
                agentId: input.session.agentId,
                providerConfigId: input.session.providerConfigId,
                providerConfigVersion: input.session.providerConfigVersion,
                providerType: input.session.providerType,
                adapterId: input.session.adapterId,
                adapterVersion: input.session.adapterVersion,
                configSchemaVersion: input.session.configSchemaVersion,
                runtimeMode: input.session.runtimeMode,
                claimEpoch: input.session.claimEpoch,
                claimOwnerId: input.session.claimOwnerId ?? null,
                claimLeaseExpiresAt: input.session.claimLeaseExpiresAt ?? null,
                capabilities: input.session.capabilities,
              });
              processRepo.createProcess({
                workspaceId: input.process.workspaceId,
                taskId: input.process.taskId,
                runId: input.process.runId,
                stageId: input.process.stageId ?? null,
                stageAttempt: input.process.stageAttempt ?? null,
                providerSessionId: input.process.providerSessionId ?? null,
                parentProcessId: input.process.parentProcessId ?? null,
                authorityRole: input.process.authorityRole ?? null,
                claimEpoch: input.process.claimEpoch,
                claimOwnerId: input.process.claimOwnerId ?? null,
                claimLeaseExpiresAt: input.process.claimLeaseExpiresAt ?? null,
                processType: input.process.processType,
                platform: input.process.platform,
                executableResolved: input.process.executableResolved,
                executableFingerprint: input.process.executableFingerprint ?? null,
                argsRedacted: input.process.argsRedacted,
                cwdResolved: input.process.cwdResolved,
                shell: input.process.shell,
                detached: input.process.detached,
                stdinMode: input.process.stdinMode,
                stdoutMode: input.process.stdoutMode,
                stderrMode: input.process.stderrMode,
                timeoutPolicy: input.process.timeoutPolicy,
                securityProfileRef: input.process.securityProfileRef,
              });
            });
            throw new Error('unreachable');
          } catch (error) {
            throw error;
          }
        },
        casTransferClaimPair: async () => ({ kind: 'conflict', reason: 'fence-conflict', session: null, process: null }),
      };

      const coordinator = new DurableProcessCoordinator({
        sessionRepository: sessionPort,
        processRepository: processPort,
        outputReferenceRepository: outputPort,
        artifactSink: new FileArtifactSink(join(root, 'sink')),
        atomicSeam,
        driver: {
          spawn: async () => { throw new Error('unused'); },
          gracefulStop: async () => ({ delivered: true, detail: 'ok' }),
          terminateTree: async () => ({ classification: 'complete', attemptedMembers: [], errors: [] }),
          verifySurvivors: async () => ({ classification: 'complete', knownPids: [] }),
          inspectIdentity: async () => ({ kind: 'match', identity: { pid: 1, startedAtMs: 0, executablePath: 'x' } }),
        },
      });

      await assert.rejects(
        coordinator.establishClaimAndReservation({
          session: {
            workspaceId: WS,
            taskId: TASK,
            runId: RUN,
            stageId: STAGE + '_b',
            stageAttempt: 2,
            authorityRole: 'primary-provider',
            agentId: AGENT,
            providerConfigId: PCFG,
            providerConfigVersion: 1,
            providerType: 'kimicode',
            adapterId: 'adapter.cli',
            adapterVersion: '1.0.0',
            configSchemaVersion: 1,
            runtimeMode: 'cli',
            claimEpoch: 1,
            claimOwnerId: 'svc-1',
            claimLeaseExpiresAt: '2026-08-12T00:00:00.000Z',
            capabilities: { streaming: true },
          },
          process: {
            workspaceId: WS,
            taskId: TASK,
            runId: RUN,
            stageId: STAGE + '_b',
            stageAttempt: 2,
            providerSessionId: null,
            authorityRole: 'primary-provider',
            claimEpoch: 1,
            claimOwnerId: 'svc-1',
            claimLeaseExpiresAt: '2026-08-12T00:00:00.000Z',
            processType: 'provider',
            platform: 'win32',
            executableResolved: 'C:\\bin\\agent.exe',
            argsRedacted: ['[REDACTED]'],
            cwdResolved: 'E:\\ws',
            shell: 0,
            detached: 0,
            stdinMode: 'closed',
            stdoutMode: 'capture',
            stderrMode: 'capture',
            timeoutPolicy: { graceMs: 5000 },
            securityProfileRef: 'secprofile_default',
            parentProcessId: 'proc_' + 'Z'.repeat(26),
          },
        }),
        /RUNTIME_PROCESS_VALIDATION_FAILED/,
      );
      // The whole transaction rolled back: no failed Session substitute.
      const sessionCount = (db.prepare('SELECT COUNT(*) AS c FROM provider_sessions').get() as { c: number }).c;
      const processCount = (db.prepare('SELECT COUNT(*) AS c FROM runtime_processes').get() as { c: number }).c;
      assert.equal(sessionCount, 1);
      assert.equal(processCount, 0);
    } finally {
      db.close();
    }
  });
});
