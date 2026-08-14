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
  ProviderSessionIntegrityError,
  ProviderSessionRepository,
  ProviderSessionValidationError,
} from './ProviderSessionRepository.js';

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

function sessionInput(overrides: Partial<Parameters<ProviderSessionRepository['createSession']>[0]> = {}) {
  return {
    workspaceId: WS,
    taskId: TASK,
    runId: RUN,
    stageId: STAGE,
    stageAttempt: 1,
    authorityRole: 'primary-provider' as const,
    agentId: AGENT,
    providerConfigId: PCFG,
    providerConfigVersion: 1,
    providerType: 'kimicode',
    adapterId: 'adapter.cli',
    adapterVersion: '1.0.0',
    configSchemaVersion: 1,
    runtimeMode: 'cli' as const,
    capabilities: { streaming: true, models: ['kimi-k2'] },
    createdAt: NOW,
    ...overrides,
  };
}

function assertValidation(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => (
    error instanceof ProviderSessionValidationError
    && error.code === 'PROVIDER_SESSION_VALIDATION_FAILED'
  ));
}

function assertIntegrity(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => (
    error instanceof ProviderSessionIntegrityError
    && error.code === 'PROVIDER_SESSION_INTEGRITY_FAILED'
  ));
}

describe('ProviderSessionRepository', () => {
  it('first durable row is starting with claim epoch 1 and canonical bounded JSON', () => {
    const db = migratedDb();
    try {
      const repository = new ProviderSessionRepository(db);
      const { kind, session } = repository.createSession(sessionInput());
      assert.equal(kind, 'created');
      assert.match(session.id, /^psess_[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.equal(session.status, 'starting');
      assert.equal(session.claimEpoch, 1);
      assert.equal(session.claimOwnerId, null);
      assert.equal(session.adapterStartRequestedAt, null);
      assert.equal(session.version, 1);
      assert.equal(session.startedAt, null);
      assert.equal(session.completedAt, null);
      assert.equal(session.capabilitiesJson, '{"models":["kimi-k2"],"streaming":true}');
    } finally {
      db.close();
    }
  });

  it('duplicate five-column claim joins exactly one Session (single winner)', () => {
    const db = migratedDb();
    try {
      const repository = new ProviderSessionRepository(db);
      const first = repository.createSession(sessionInput());
      const second = repository.createSession(sessionInput());
      assert.equal(first.kind, 'created');
      assert.equal(second.kind, 'joined');
      assert.equal(second.session.id, first.session.id);
      const count = (db.prepare('SELECT COUNT(*) AS c FROM provider_sessions').get() as { c: number }).c;
      assert.equal(count, 1);
    } finally {
      db.close();
    }
  });

  it('rejects non-canonical, oversized and forbidden inputs before persistence', () => {
    const cases: Array<[string, (repository: ProviderSessionRepository) => void]> = [
      ['kimi provider type', (repository) => {
        repository.createSession(sessionInput({ providerType: 'kimi' }));
      }],
      ['non-canonical capabilities', (repository) => {
        repository.createSession(sessionInput({ capabilities: { bad: undefined } }));
      }],
      ['oversized capabilities', (repository) => {
        repository.createSession(sessionInput({ capabilities: { blob: 'x'.repeat(70 * 1024) } }));
      }],
      ['invalid runtime mode', (repository) => {
        repository.createSession(sessionInput({ runtimeMode: 'web' as never }));
      }],
      ['claim epoch below 1', (repository) => {
        repository.createSession(sessionInput({ claimEpoch: 0 }));
      }],
      ['unpaired claim owner', (repository) => {
        repository.createSession(sessionInput({ claimOwnerId: 'svc' }));
      }],
    ];
    for (const [label, act] of cases) {
      const db = migratedDb();
      try {
        assertValidation(() => act(new ProviderSessionRepository(db)));
      } catch (error) {
        throw new Error(`case failed: ${label}`, { cause: error });
      } finally {
        db.close();
      }
    }
  });

  it('casSetAdapterStartRequested is exactly once; duplicates return stored fact', () => {
    const db = migratedDb();
    try {
      const repository = new ProviderSessionRepository(db);
      const session = repository.createSession(sessionInput()).session;
      const first = repository.casSetAdapterStartRequested({
        workspaceId: WS,
        sessionId: session.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      assert.equal(first.kind, 'applied');
      assert.equal(first.session.adapterStartRequestedAt, LATER);
      assert.equal(first.session.version, 2);
      const duplicate = repository.casSetAdapterStartRequested({
        workspaceId: WS,
        sessionId: session.id,
        expectedVersion: 2,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      assert.equal(duplicate.kind, 'already-requested');
      assert.equal(duplicate.session.version, 2);
      const stale = repository.casSetAdapterStartRequested({
        workspaceId: WS,
        sessionId: session.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      // The stored marker dominates classification: duplicates return the
      // stored fact (already-requested) even with a stale expected version.
      assert.equal(stale.kind, 'already-requested');
    } finally {
      db.close();
    }
  });

  it('casSetAdapterStartRequested rejects a wrong claim fence before any marker write', () => {
    const db = migratedDb();
    try {
      const repository = new ProviderSessionRepository(db);
      const session = repository.createSession(sessionInput()).session;
      const fenced = repository.casSetAdapterStartRequested({
        workspaceId: WS,
        sessionId: session.id,
        expectedVersion: 1,
        expectedClaimEpoch: 9,
        expectedClaimOwner: null,
        timestamp: LATER,
      });
      assert.equal(fenced.kind, 'fence-conflict');
      assert.equal(repository.findById(WS, session.id)!.adapterStartRequestedAt, null);
    } finally {
      db.close();
    }
  });

  it('transitionStatus CAS applies and classifies losers without retry', () => {
    const db = migratedDb();
    try {
      const repository = new ProviderSessionRepository(db);
      const session = repository.createSession(sessionInput()).session;
      const active = repository.transitionStatus({
        workspaceId: WS,
        sessionId: session.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        expectedFrom: 'starting',
        to: 'active',
        timestamp: LATER,
      });
      assert.equal(active.kind, 'applied');
      assert.equal(active.session.status, 'active');
      assert.equal(active.session.startedAt, LATER);
      assert.equal(active.session.version, 2);
      const loser = repository.transitionStatus({
        workspaceId: WS,
        sessionId: session.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        expectedFrom: 'starting',
        to: 'active',
        timestamp: LATER,
      });
      assert.equal(loser.kind, 'state-mismatch');
      assert.equal(loser.session.status, 'active');
      const fenced = repository.transitionStatus({
        workspaceId: WS,
        sessionId: session.id,
        expectedVersion: 2,
        expectedClaimEpoch: 2,
        expectedClaimOwner: null,
        expectedFrom: 'active',
        to: 'completed',
        timestamp: LATER,
      });
      assert.equal(fenced.kind, 'fence-conflict');
      assertValidation(() => repository.transitionStatus({
        workspaceId: WS,
        sessionId: session.id,
        expectedVersion: 2,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        expectedFrom: 'active',
        to: 'starting',
        timestamp: LATER,
      }));
    } finally {
      db.close();
    }
  });

  it('failed transition requires a stable failure code and redacted detail', () => {
    const db = migratedDb();
    try {
      const repository = new ProviderSessionRepository(db);
      const session = repository.createSession(sessionInput()).session;
      assertValidation(() => repository.transitionStatus({
        workspaceId: WS,
        sessionId: session.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        expectedFrom: 'starting',
        to: 'failed',
        timestamp: LATER,
      }));
      const applied = repository.transitionStatus({
        workspaceId: WS,
        sessionId: session.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        expectedFrom: 'starting',
        to: 'failed',
        timestamp: LATER,
        failureCode: 'PROVIDER_PROTOCOL_ERROR',
        failureDetailRedacted: 'bounded safe detail',
      });
      assert.equal(applied.kind, 'applied');
      assert.equal(applied.session.status, 'failed');
      assert.equal(applied.session.errorCode, 'PROVIDER_PROTOCOL_ERROR');
      assert.equal(applied.session.completedAt, LATER);
    } finally {
      db.close();
    }
  });

  it('terminal sessions are immutable and duplicate terminal observation returns stored fact', () => {
    const db = migratedDb();
    try {
      const repository = new ProviderSessionRepository(db);
      const session = repository.createSession(sessionInput()).session;
      repository.transitionStatus({
        workspaceId: WS,
        sessionId: session.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        expectedFrom: 'starting',
        to: 'active',
        timestamp: LATER,
      });
      repository.transitionStatus({
        workspaceId: WS,
        sessionId: session.id,
        expectedVersion: 2,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        expectedFrom: 'active',
        to: 'completed',
        timestamp: LATER,
      });
      const duplicate = repository.transitionStatus({
        workspaceId: WS,
        sessionId: session.id,
        expectedVersion: 2,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        expectedFrom: 'active',
        to: 'failed',
        timestamp: LATER,
        failureCode: 'PROVIDER_UNKNOWN_ERROR',
        failureDetailRedacted: 'late observation',
      });
      assert.equal(duplicate.kind, 'terminal');
      assert.equal(duplicate.session.status, 'completed');
      assert.throws(() => db.prepare(`
        UPDATE provider_sessions SET status = 'active' WHERE id = ?
      `).run(session.id), /PROVIDER_SESSION_TERMINAL_IMMUTABLE/);
    } finally {
      db.close();
    }
  });

  it('claim transfer requires starting, absent start marker and an expired lease', () => {
    const db = migratedDb();
    try {
      const repository = new ProviderSessionRepository(db);
      db.prepare(`
        INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, 'plan', 'Plan', 2, 2, 'pending', ?, ?, 1)
      `).run(STAGE + '_b', WS, RUN, SNAPSHOT, NOW, NOW);
      const unleased = repository.createSession(sessionInput()).session;
      const noLease = repository.casTransferClaim({
        workspaceId: WS,
        sessionId: unleased.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: null,
        timestamp: LATER,
        newClaimOwner: 'svc-2',
        newClaimLeaseExpiresAt: '2026-08-13T02:00:00.000Z',
      });
      assert.equal(noLease.kind, 'fence-conflict');

      const leased = repository.createSession(sessionInput({
        stageId: STAGE + '_b',
        stageAttempt: 2,
        claimOwnerId: 'svc-1',
        claimLeaseExpiresAt: '2026-08-12T00:00:00.000Z',
      })).session;
      const transferred = repository.casTransferClaim({
        workspaceId: WS,
        sessionId: leased.id,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: 'svc-1',
        timestamp: NOW,
        newClaimOwner: 'svc-2',
        newClaimLeaseExpiresAt: '2026-08-13T02:00:00.000Z',
      });
      assert.equal(transferred.kind, 'applied');
      assert.equal(transferred.session.claimEpoch, 2);
      assert.equal(transferred.session.claimOwnerId, 'svc-2');
      assert.equal(transferred.session.version, 2);

      const staleOwner = repository.casTransferClaim({
        workspaceId: WS,
        sessionId: leased.id,
        expectedVersion: 2,
        expectedClaimEpoch: 2,
        expectedClaimOwner: 'svc-1',
        timestamp: NOW,
        newClaimOwner: 'svc-3',
        newClaimLeaseExpiresAt: '2026-08-13T03:00:00.000Z',
      });
      assert.equal(staleOwner.kind, 'fence-conflict');
    } finally {
      db.close();
    }
  });

  it('identity and delete triggers fail closed; tampered rows fail integrity', () => {
    const db = migratedDb();
    try {
      const repository = new ProviderSessionRepository(db);
      const session = repository.createSession(sessionInput()).session;
      assert.throws(() => db.prepare(`
        UPDATE provider_sessions SET provider_type = 'codex' WHERE id = ?
      `).run(session.id), /PROVIDER_SESSION_IDENTITY_IMMUTABLE/);
      assert.throws(() => db.prepare('DELETE FROM provider_sessions WHERE id = ?').run(session.id),
        /PROVIDER_SESSION_REJECT_DELETE/);
      db.prepare('UPDATE provider_sessions SET version = 1.5 WHERE id = ?').run(session.id);
      assertIntegrity(() => repository.findById(WS, session.id));
    } finally {
      db.close();
    }
  });

  it('participates in an external transaction and rolls back with it', () => {
    const db = migratedDb();
    try {
      const repository = new ProviderSessionRepository(db);
      assert.throws(() => inTransaction(db, () => {
        repository.createSession(sessionInput());
        throw new Error('outer rollback');
      }), /outer rollback/);
      assert.equal((db.prepare('SELECT COUNT(*) AS c FROM provider_sessions').get() as { c: number }).c, 0);
    } finally {
      db.close();
    }
  });
});
