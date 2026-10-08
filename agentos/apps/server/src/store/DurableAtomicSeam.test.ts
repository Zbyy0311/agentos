import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { ProviderSessionRepository } from './ProviderSessionRepository.js';
import { ProcessRepository } from './ProcessRepository.js';
import { DurableAtomicSeamImpl } from './DurableAtomicSeam.js';

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
}

function sessionCreate() {
  return {
    workspaceId: WS, taskId: TASK, runId: RUN, stageId: STAGE, stageAttempt: 1,
    authorityRole: 'primary-provider' as const, agentId: AGENT, providerConfigId: PCFG,
    providerConfigVersion: 1, providerType: 'kimicode', adapterId: 'builtin.kimicode',
    adapterVersion: '1.0.0', configSchemaVersion: 1, runtimeMode: 'cli' as const,
    claimEpoch: 1, claimOwnerId: 'owner-1', claimLeaseExpiresAt: LATER,
    capabilities: { structuredEvents: true },
    eventContext: { correlationId: 'op-1', causationId: 'op-1' },
  };
}

function processCreate() {
  return {
    workspaceId: WS, taskId: TASK, runId: RUN, stageId: STAGE, stageAttempt: 1,
    authorityRole: 'primary-provider' as const, claimEpoch: 1, claimOwnerId: 'owner-1',
    claimLeaseExpiresAt: LATER, processType: 'provider' as const, platform: 'win32',
    executableResolved: 'C:\\bin\\agent.exe', argsRedacted: ['[REDACTED]'],
    cwdResolved: 'E:\\ws', shell: 0 as const, detached: 0 as const, stdinMode: 'closed' as const,
    stdoutMode: 'capture' as const, stderrMode: 'capture' as const,
    timeoutPolicy: { graceMs: 5000 }, securityProfileRef: 'secprofile_default',
    eventContext: { correlationId: 'op-1', causationId: 'op-1' },
  };
}

describe('DurableAtomicSeamImpl', () => {
  it('establishes Session + root Process atomically and joins duplicates', async () => {
    const db = migratedDb();
    try {
      const seam = new DurableAtomicSeamImpl(db, new ProviderSessionRepository(db), new ProcessRepository(db));
      const first = await seam.createSessionAndRootProcess({ session: sessionCreate(), process: processCreate() });
      assert.equal(first.joinedExisting, false);
      assert.match(first.session.sessionId, /^psess_/);
      assert.match(first.process.processId, /^proc_/);
      assert.equal(first.process.providerSessionId, first.session.sessionId);
      assert.equal(first.process.status, 'created');
      const second = await seam.createSessionAndRootProcess({ session: sessionCreate(), process: processCreate() });
      assert.equal(second.joinedExisting, true);
      assert.equal(second.session.sessionId, first.session.sessionId);
      assert.equal(second.process.processId, first.process.processId);
      assert.equal((db.prepare('SELECT COUNT(*) AS c FROM provider_sessions').get() as { c: number }).c, 1);
      assert.equal((db.prepare('SELECT COUNT(*) AS c FROM runtime_processes').get() as { c: number }).c, 1);
    } finally {
      db.close();
    }
  });

  it('rolls back the pair when the Process reservation fails', async () => {
    const db = migratedDb();
    try {
      const seam = new DurableAtomicSeamImpl(db, new ProviderSessionRepository(db), new ProcessRepository(db));
      await assert.rejects(
        seam.createSessionAndRootProcess({
          session: sessionCreate(),
          process: Object.assign(processCreate(), { executableResolved: '' }),
        }),
        /invalid/,
      );
      assert.equal((db.prepare('SELECT COUNT(*) AS c FROM provider_sessions').get() as { c: number }).c, 0);
      assert.equal((db.prepare('SELECT COUNT(*) AS c FROM runtime_processes').get() as { c: number }).c, 0);
    } finally {
      db.close();
    }
  });

  it('commits the paired claim transfer atomically', async () => {
    const db = migratedDb();
    try {
      const sessions = new ProviderSessionRepository(db);
      const processes = new ProcessRepository(db);
      const seam = new DurableAtomicSeamImpl(db, sessions, processes);
      const established = await seam.createSessionAndRootProcess({ session: sessionCreate(), process: processCreate() });
      const transferred = await seam.casTransferClaimPair({
        session: {
          workspaceId: WS, sessionId: established.session.sessionId, expectedVersion: 1,
          expectedClaimEpoch: 1, expectedClaimOwner: 'owner-1', timestamp: LATER,
          newClaimOwner: 'owner-2', newClaimLeaseExpiresAt: '2026-08-13T02:00:00.000Z',
          eventContext: { correlationId: 'op-2', causationId: 'op-2' },
        },
        process: {
          workspaceId: WS, processId: established.process.processId, expectedVersion: 1,
          expectedClaimEpoch: 1, expectedClaimOwner: 'owner-1', timestamp: LATER,
          newClaimOwner: 'owner-2', newClaimLeaseExpiresAt: '2026-08-13T02:00:00.000Z',
          eventContext: { correlationId: 'op-2', causationId: 'op-2' },
        },
      });
      assert.equal(transferred.kind, 'applied');
      if (transferred.kind !== 'applied') return;
      assert.equal(transferred.session.claimEpoch, 2);
      assert.equal(transferred.session.claimOwnerId, 'owner-2');
      assert.equal(transferred.process.claimEpoch, 2);
      assert.equal(transferred.process.claimOwnerId, 'owner-2');
    } finally {
      db.close();
    }
  });

  it('rolls back the session CAS when the Process transfer conflicts', async () => {
    const db = migratedDb();
    try {
      const sessions = new ProviderSessionRepository(db);
      const processes = new ProcessRepository(db);
      const seam = new DurableAtomicSeamImpl(db, sessions, processes);
      const established = await seam.createSessionAndRootProcess({ session: sessionCreate(), process: processCreate() });
      processes.casStartProcess({
        workspaceId: WS, processId: established.process.processId, expectedVersion: 1,
        expectedClaimEpoch: 1, expectedClaimOwner: 'owner-1', timestamp: LATER,
      });
      const transferred = await seam.casTransferClaimPair({
        session: {
          workspaceId: WS, sessionId: established.session.sessionId, expectedVersion: 1,
          expectedClaimEpoch: 1, expectedClaimOwner: 'owner-1', timestamp: LATER,
          newClaimOwner: 'owner-2', newClaimLeaseExpiresAt: '2026-08-13T02:00:00.000Z',
          eventContext: { correlationId: 'op-3', causationId: 'op-3' },
        },
        process: {
          workspaceId: WS, processId: established.process.processId, expectedVersion: 2,
          expectedClaimEpoch: 1, expectedClaimOwner: 'owner-1', timestamp: LATER,
          newClaimOwner: 'owner-2', newClaimLeaseExpiresAt: '2026-08-13T02:00:00.000Z',
          eventContext: { correlationId: 'op-3', causationId: 'op-3' },
        },
      });
      assert.equal(transferred.kind, 'conflict');
      if (transferred.kind !== 'conflict') return;
      const sessionAfter = sessions.findById(WS, established.session.sessionId)!;
      assert.equal(sessionAfter.claimEpoch, 1);
      assert.equal(sessionAfter.claimOwnerId, 'owner-1');
    } finally {
      db.close();
    }
  });
});