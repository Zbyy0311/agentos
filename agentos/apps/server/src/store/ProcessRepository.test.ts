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
  ProcessRepository,
  RuntimeProcessIntegrityError,
  RuntimeProcessValidationError,
} from './ProcessRepository.js';

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
const SESSION_ID = 'psess_' + 'a'.repeat(26);

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
