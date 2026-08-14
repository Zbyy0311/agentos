import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import {
  createM3RuntimeEventRegistry,
} from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { OutboxRepository } from './OutboxRepository.js';
import { ProcessOutputReferenceRepository } from './ProcessOutputReferenceRepository.js';
import { ProcessRepository, type CreateProcessInput } from './ProcessRepository.js';
import {
  ProviderSessionRepository,
  type CreateProviderSessionInput,
} from './ProviderSessionRepository.js';
import {
  RuntimeEventOutboxWriter,
  RuntimeEventRepository,
  RuntimeEventRepositoryError,
} from './RuntimeEventRepository.js';
import { RunSequenceAllocator } from './RunSequenceAllocator.js';
import { inTransaction } from './Transaction.js';

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

const NOW = '2026-08-14T00:00:00.000Z';
const LATER = '2026-08-14T01:00:00.000Z';
const WS = 'ws_m4_events';
const TASK = 'task_m4_events';
const RUN = 'run_m4_events';
const SNAPSHOT = 'snapshot_m4_events';
const STAGE = 'stage_m4_events';
const PCFG = 'pcfg_m4_events';
const AGENT = 'agent_m4_events';

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, 'M4 Events', '/tmp/m4-events', '/tmp/m4-events', ?, ?, ?)
  `).run(WS, NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, 'M4 event task', 'open', 'normal', 'test', ?, ?)
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
    INSERT INTO run_stages (
      id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
      sequence, attempt, status, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, 'plan', 'Plan', 1, 1, 'pending', ?, ?, 1)
  `).run(STAGE, WS, RUN, SNAPSHOT, NOW, NOW);
  db.prepare(`
    INSERT INTO provider_configurations (
      id, workspace_id, name, provider_type, adapter_id, runtime_mode,
      capabilities_json, timeout_policy_json, created_at, updated_at
    ) VALUES (?, ?, 'M4 provider', 'kimicode', 'adapter.cli', 'cli', '{}', '{}', ?, ?)
  `).run(PCFG, WS, NOW, NOW);
  db.prepare(`
    INSERT INTO agent_profiles (
      workspace_id, id, name, agent_role, role_title, system_prompt,
      permissions_json, enabled, cli_command, cli_args_json, created_at, updated_at
    ) VALUES (?, ?, 'Agent', 'worker', 'Worker', '', '[]', 1, 'agent', '[]', ?, ?)
  `).run(WS, AGENT, NOW, NOW);
  return db;
}

function sessionInput(overrides: Partial<CreateProviderSessionInput> = {}): CreateProviderSessionInput {
  return {
    workspaceId: WS,
    taskId: TASK,
    runId: RUN,
    stageId: STAGE,
    stageAttempt: 1,
    authorityRole: 'primary-provider',
    agentId: AGENT,
    providerConfigId: PCFG,
    providerConfigVersion: 1,
    providerType: 'kimicode',
    adapterId: 'adapter.cli',
    adapterVersion: '1.0.0',
    configSchemaVersion: 1,
    runtimeMode: 'cli',
    capabilities: { streaming: true },
    createdAt: NOW,
    ...overrides,
  };
}

function processInput(sessionId: string, overrides: Partial<CreateProcessInput> = {}): CreateProcessInput {
  return {
    workspaceId: WS,
    taskId: TASK,
    runId: RUN,
    stageId: STAGE,
    stageAttempt: 1,
    providerSessionId: sessionId,
    authorityRole: 'primary-provider',
    claimEpoch: 1,
    processType: 'provider',
    platform: 'win32',
    executableResolved: 'C:\\bin\\agent.exe',
    argsRedacted: ['[REDACTED]'],
    cwdResolved: 'E:\\workspace',
    shell: 0,
    detached: 0,
    stdinMode: 'closed',
    stdoutMode: 'capture',
    stderrMode: 'capture',
    timeoutPolicy: { graceMs: 5000 },
    securityProfileRef: 'secprofile_default',
    createdAt: NOW,
    ...overrides,
  };
}

function bundle(
  db: Db,
  options: ConstructorParameters<typeof RuntimeEventOutboxWriter>[4] = {},
): {
  writer: RuntimeEventOutboxWriter;
  events: RuntimeEventRepository;
  outbox: OutboxRepository;
  sessions: ProviderSessionRepository;
  processes: ProcessRepository;
  outputs: ProcessOutputReferenceRepository;
} {
  const events = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
  const allocator = new RunSequenceAllocator(db);
  const outbox = new OutboxRepository(db, events);
  const writer = new RuntimeEventOutboxWriter(events, allocator, outbox, db, options);
  return {
    writer,
    events,
    outbox,
    sessions: new ProviderSessionRepository(db, writer),
    processes: new ProcessRepository(db, writer),
    outputs: new ProcessOutputReferenceRepository(db, writer),
  };
}

function counts(db: Db): { sessions: number; processes: number; refs: number; events: number; outbox: number; next: number } {
  return {
    sessions: (db.prepare('SELECT COUNT(*) AS c FROM provider_sessions').get() as { c: number }).c,
    processes: (db.prepare('SELECT COUNT(*) AS c FROM runtime_processes').get() as { c: number }).c,
    refs: (db.prepare('SELECT COUNT(*) AS c FROM process_output_references').get() as { c: number }).c,
    events: (db.prepare('SELECT COUNT(*) AS c FROM runtime_events').get() as { c: number }).c,
    outbox: (db.prepare('SELECT COUNT(*) AS c FROM outbox_messages').get() as { c: number }).c,
    next: (db.prepare('SELECT next_event_sequence AS n FROM runs WHERE id = ?').get(RUN) as { n: number }).n,
  };
}

function close(db: Db): void {
  db.close();
}

test('P2B-2 A/B/C/G: accepted facts emit one ordered Event+Outbox; replay/CAS losers emit zero', () => {
  const db = migratedDb();
  try {
    const { events, outbox, sessions, processes, outputs } = bundle(db);
    const createdSession = sessions.createSession(sessionInput());
    assert.equal(createdSession.kind, 'created');
    const session = createdSession.session;
    const createdProcess = processes.createProcess(processInput(session.id));
    assert.equal(createdProcess.kind, 'created');
    const process = createdProcess.process;
    const afterCreate = counts(db);
    assert.equal(afterCreate.events, 2);
    assert.equal(afterCreate.outbox, 2);
    assert.equal(afterCreate.next, 3);

    const joinedSession = sessions.createSession(sessionInput());
    const joinedProcess = processes.createProcess(processInput(session.id));
    assert.equal(joinedSession.kind, 'joined');
    assert.equal(joinedProcess.kind, 'joined');
    assert.deepEqual(counts(db), afterCreate);

    const starting = processes.casStartProcess({
      workspaceId: WS,
      processId: process.id,
      expectedVersion: process.version,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      timestamp: NOW,
    });
    assert.equal(starting.kind, 'applied');
    assert.equal(counts(db).events, 3);
    const loser = processes.casStartProcess({
      workspaceId: WS,
      processId: process.id,
      expectedVersion: process.version,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      timestamp: NOW,
    });
    assert.equal(loser.kind, 'state-mismatch');
    assert.equal(counts(db).events, 3);

    const bound = processes.casBindNativeIdentity({
      workspaceId: WS,
      processId: process.id,
      expectedVersion: starting.process.version,
      expectedClaimEpoch: starting.process.claimEpoch,
      expectedClaimOwner: starting.process.claimOwnerId,
      nativePid: 1234,
      nativeStartedAt: LATER,
      timestamp: LATER,
    });
    assert.equal(bound.kind, 'applied');
    assert.equal(counts(db).events, 4);

    const refCreated = outputs.createReference({
      workspaceId: WS,
      runId: RUN,
      processId: process.id,
      stream: 'stdout',
      storageKey: 'managed/artifact',
      contentType: 'text/plain',
      encoding: 'utf-8',
      redactionMode: 'scan',
      createdAt: LATER,
    });
    assert.equal(refCreated.kind, 'created');
    const ref = refCreated.reference;
    assert.equal(counts(db).events, 5);
    const checkpoint = outputs.checkpoint({
      workspaceId: WS,
      processId: process.id,
      stream: 'stdout',
      expectedVersion: ref.version,
      sourceBytesSeen: 8,
      retainedBytes: 8,
      nextSourceOffset: 8,
      segmentCount: 1,
      truncated: false,
      updatedAt: LATER,
    });
    assert.equal(checkpoint.kind, 'applied');
    assert.equal(counts(db).events, 6);
    const finalized = outputs.finalizeReference({
      workspaceId: WS,
      processId: process.id,
      stream: 'stdout',
      expectedVersion: checkpoint.reference.version,
      sha256: 'a'.repeat(64),
      finalizedAt: LATER,
    });
    assert.equal(finalized.kind, 'applied');
    assert.equal(counts(db).events, 7);

    const stopping = processes.transitionStatus({
      workspaceId: WS,
      processId: process.id,
      expectedVersion: bound.process.version,
      expectedClaimEpoch: bound.process.claimEpoch,
      expectedClaimOwner: bound.process.claimOwnerId,
      expectedFrom: 'running',
      to: 'stopping',
      timestamp: LATER,
      terminationReason: 'cancelled',
      cleanupResult: 'TERMINATED',
    });
    assert.equal(stopping.kind, 'applied');
    const exited = processes.transitionStatus({
      workspaceId: WS,
      processId: process.id,
      expectedVersion: stopping.process.version,
      expectedClaimEpoch: stopping.process.claimEpoch,
      expectedClaimOwner: stopping.process.claimOwnerId,
      expectedFrom: 'stopping',
      to: 'exited',
      timestamp: LATER,
      exitCode: 0,
      terminationReason: 'cancelled',
      cleanupResult: 'TERMINATED',
    });
    assert.equal(exited.kind, 'applied');
    assert.equal(counts(db).events, 9);

    const records = events.listByRunAfterSequence(RUN, 0);
    assert.deepEqual(records.map(record => record.event.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(records.map(record => record.event.type), [
      'process.session_claimed',
      'process.launch_requested',
      'process.starting',
      'process.started',
      'process.output_reference_advanced',
      'process.output_reference_advanced',
      'process.output_reference_advanced',
      'process.stopping',
      'process.exited',
    ]);
    for (const record of records) {
      assert.equal(record.kind, 'known');
      assert.equal(outbox.findByEventId(record.event.id)?.event.id, record.event.id);
    }
  } finally {
    close(db);
  }
});

test('P2B-2 D: Event insert failure rolls back the durable mutation and sequence', () => {
  const db = migratedDb();
  try {
    const fixedEventId = 'evt_01J4P2B0000000000000000000';
    const first = bundle(db, { createEventId: () => fixedEventId });
    const session = first.sessions.createSession(sessionInput()).session;
    const failing = bundle(db, { createEventId: () => fixedEventId });
    assert.throws(
      () => failing.processes.createProcess(processInput(session.id)),
      (error: unknown) => error instanceof RuntimeEventRepositoryError
        && error.code === 'RUNTIME_EVENT_PERSISTENCE_FAILED',
    );
    const state = counts(db);
    assert.equal(state.sessions, 1);
    assert.equal(state.processes, 0);
    assert.equal(state.events, 1);
    assert.equal(state.outbox, 1);
    assert.equal(state.next, 2);
  } finally {
    close(db);
  }
});

test('P2B-2 E: Outbox insert failure rolls back Event, Process row and sequence', () => {
  const db = migratedDb();
  try {
    const session = bundle(db).sessions.createSession(sessionInput()).session;
    const first = bundle(db, { createOutboxId: () => 'outbox_fixed' });
    const root = first.processes.createProcess(processInput(session.id)).process;
    const before = counts(db);
    assert.equal(before.events, 2);

    assert.throws(
      () => first.processes.createProcess(processInput(session.id, {
        parentProcessId: root.id,
        stageId: null,
        stageAttempt: null,
        providerSessionId: null,
        authorityRole: null,
      })),
      /OUTBOX_PERSISTENCE_FAILED/,
    );
    assert.deepEqual(counts(db), before);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM runtime_processes WHERE parent_process_id = ?').get(root.id) as { c: number }).c,
      0,
    );
  } finally {
    close(db);
  }
});

test('P2B-2 F: Process Event payloads contain redacted facts, never sensitive args or raw detail', () => {
  const db = migratedDb();
  try {
    const { events, sessions, processes } = bundle(db);
    const session = sessions.createSession(sessionInput()).session;
    const process = processes.createProcess(processInput(session.id, {
      argsRedacted: ['--token=SUPER_SECRET'],
    })).process;
    const row = events.findByRunAndSequence(RUN, 2);
    assert.equal(row?.kind, 'known');
    const serialized = JSON.stringify(row?.event.payload);
    assert.equal(serialized.includes('SUPER_SECRET'), false);
    assert.equal(serialized.includes('token='), false);
    const failed = processes.casStartProcess({
      workspaceId: WS,
      processId: process.id,
      expectedVersion: process.version,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      timestamp: NOW,
    });
    assert.equal(failed.kind, 'applied');
  } finally {
    close(db);
  }
});

test('P2B-2 paired claim takeover remains one SQLite transaction with one Event+Outbox per winning CAS', () => {
  const db = migratedDb();
  try {
    const { sessions, processes, events, outbox } = bundle(db);
    const session = sessions.createSession(sessionInput({
      claimOwnerId: 'owner-1',
      claimLeaseExpiresAt: NOW,
    })).session;
    const process = processes.createProcess(processInput(session.id, {
      claimOwnerId: 'owner-1',
      claimLeaseExpiresAt: NOW,
    })).process;
    const before = counts(db);
    let sessionOutcome: unknown;
    let processOutcome: unknown;
    inTransaction(db, () => {
      sessionOutcome = sessions.casTransferClaim({
        workspaceId: WS,
        sessionId: session.id,
        expectedVersion: session.version,
        expectedClaimEpoch: session.claimEpoch,
        expectedClaimOwner: session.claimOwnerId,
        timestamp: LATER,
        newClaimOwner: 'owner-2',
        newClaimLeaseExpiresAt: '2026-08-14T02:00:00.000Z',
      });
      processOutcome = processes.casTransferClaim({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: process.version,
        expectedClaimEpoch: process.claimEpoch,
        expectedClaimOwner: process.claimOwnerId,
        timestamp: LATER,
        newClaimOwner: 'owner-2',
        newClaimLeaseExpiresAt: '2026-08-14T02:00:00.000Z',
      });
    });
    assert.equal((sessionOutcome as { kind: string }).kind, 'applied');
    assert.equal((processOutcome as { kind: string }).kind, 'applied');
    assert.equal(counts(db).events, before.events + 2);
    assert.equal(counts(db).outbox, before.outbox + 2);
    const tail = events.listByRunAfterSequence(RUN, before.next - 1);
    assert.equal(tail.length, 2);
    for (const record of tail) assert.equal(outbox.findByEventId(record.event.id)?.event.id, record.event.id);
  } finally {
    close(db);
  }
});
