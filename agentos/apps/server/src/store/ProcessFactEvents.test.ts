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
const DEFAULT_EVENT_CONTEXT = Object.freeze({
  correlationId: RUN,
  causationId: 'op_m4_p2b_context',
});
const GRACE_DEADLINE = '2026-08-14T01:00:05.000Z';
const FORCE_DEADLINE = '2026-08-14T01:00:10.000Z';

function eventContext(causationId: string, parentEventId?: string) {
  return {
    correlationId: RUN,
    causationId,
    ...(parentEventId === undefined ? {} : { parentEventId }),
  };
}

function acceptedEventId(value: { readonly eventId?: string }): string {
  assert.equal(typeof value.eventId, 'string');
  return value.eventId!;
}

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
    eventContext: DEFAULT_EVENT_CONTEXT,
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
    eventContext: DEFAULT_EVENT_CONTEXT,
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
    const createdSession = sessions.createSession(sessionInput({
      eventContext: eventContext('op_m4_session_claim'),
    }));
    assert.equal(createdSession.kind, 'created');
    const session = createdSession.session;
    const sessionEventId = acceptedEventId(createdSession);
    const createdProcess = processes.createProcess(processInput(session.id, {
      eventContext: eventContext(sessionEventId, sessionEventId),
    }));
    assert.equal(createdProcess.kind, 'created');
    const process = createdProcess.process;
    const processEventId = acceptedEventId(createdProcess);
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
      eventContext: eventContext(processEventId, processEventId),
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
      eventContext: eventContext(acceptedEventId(starting), acceptedEventId(starting)),
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
      eventContext: eventContext(acceptedEventId(bound), acceptedEventId(bound)),
    });
    assert.equal(refCreated.kind, 'created');
    const ref = refCreated.reference;
    assert.equal(counts(db).events, 4);
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
      eventContext: eventContext(acceptedEventId(bound), acceptedEventId(bound)),
    });
    assert.equal(checkpoint.kind, 'applied');
    assert.equal(counts(db).events, 5);
    const finalized = outputs.finalizeReference({
      workspaceId: WS,
      processId: process.id,
      stream: 'stdout',
      expectedVersion: checkpoint.reference.version,
      sha256: 'a'.repeat(64),
      finalizedAt: LATER,
      eventContext: eventContext(acceptedEventId(checkpoint), acceptedEventId(checkpoint)),
    });
    assert.equal(finalized.kind, 'applied');
    assert.equal(counts(db).events, 6);

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
      gracefulRequested: true,
      graceDeadline: GRACE_DEADLINE,
      forceDeadline: FORCE_DEADLINE,
      idempotencyKeyHash: 'b'.repeat(64),
      eventContext: eventContext('op_m4_cancel'),
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
      durationMs: 3600000,
      graceful: true,
      force: false,
      eventContext: eventContext(acceptedEventId(stopping), acceptedEventId(stopping)),
    });
    assert.equal(exited.kind, 'applied');
    assert.equal(counts(db).events, 8);

    const records = events.listByRunAfterSequence(RUN, 0);
    assert.deepEqual(records.map(record => record.event.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(records.map(record => record.event.type), [
      'process.session_claimed',
      'process.launch_requested',
      'process.starting',
      'process.started',
      'process.output_reference_advanced',
      'process.output_reference_advanced',
      'process.stopping',
      'process.exited',
    ]);
    assert.deepEqual(records.map(record => record.event.correlationId), Array(8).fill(RUN));
    assert.deepEqual(records.map(record => record.event.causationId), [
      'op_m4_session_claim',
      sessionEventId,
      acceptedEventId(createdProcess),
      acceptedEventId(starting),
      acceptedEventId(bound),
      acceptedEventId(checkpoint),
      'op_m4_cancel',
      acceptedEventId(stopping),
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
      executableResolved: 'C:\\secrets\\SUPER_EXE_SECRET\\agent.exe',
      argsRedacted: ['--token=SUPER_SECRET'],
      cwdResolved: 'E:\\workspace\\SUPER_CWD_SECRET',
    })).process;
    const row = events.findByRunAndSequence(RUN, 2);
    assert.equal(row?.kind, 'known');
    const serialized = JSON.stringify(row?.event.payload);
    assert.equal(serialized.includes('SUPER_SECRET'), false);
    assert.equal(serialized.includes('token='), false);
    assert.equal(serialized.includes('SUPER_EXE_SECRET'), false);
    assert.equal(serialized.includes('SUPER_CWD_SECRET'), false);
    assert.equal(serialized.includes('C:\\secrets'), false);
    assert.equal(serialized.includes('E:\\workspace\\SUPER_CWD_SECRET'), false);
    const failed = processes.casStartProcess({
      workspaceId: WS,
      processId: process.id,
      expectedVersion: process.version,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      timestamp: NOW,
      eventContext: DEFAULT_EVENT_CONTEXT,
    });
    assert.equal(failed.kind, 'applied');
  } finally {
    close(db);
  }
});

test('P2B-2 output reference creation/replay/CAS losers emit zero facts for zero progress', () => {
  const db = migratedDb();
  try {
    const { sessions, processes, outputs } = bundle(db);
    const session = sessions.createSession(sessionInput()).session;
    const process = processes.createProcess(processInput(session.id)).process;
    const before = counts(db);
    const created = outputs.createReference({
      workspaceId: WS,
      runId: RUN,
      processId: process.id,
      stream: 'stderr',
      storageKey: 'managed/zero-byte',
      contentType: 'text/plain',
      encoding: 'utf-8',
      redactionMode: 'strict',
      eventContext: DEFAULT_EVENT_CONTEXT,
    });
    assert.equal(created.kind, 'created');
    const afterCreate = counts(db);
    assert.equal(afterCreate.refs, before.refs + 1);
    assert.equal(afterCreate.events, before.events);
    assert.equal(afterCreate.outbox, before.outbox);
    assert.equal(afterCreate.next, before.next);

    const joined = outputs.createReference({
      workspaceId: WS,
      runId: RUN,
      processId: process.id,
      stream: 'stderr',
      storageKey: 'managed/zero-byte',
      contentType: 'text/plain',
      encoding: 'utf-8',
      redactionMode: 'strict',
      eventContext: DEFAULT_EVENT_CONTEXT,
    });
    assert.equal(joined.kind, 'joined');
    assert.deepEqual(counts(db), afterCreate);

    const loser = outputs.checkpoint({
      workspaceId: WS,
      processId: process.id,
      stream: 'stderr',
      expectedVersion: created.reference.version + 1,
      sourceBytesSeen: 1,
      retainedBytes: 1,
      nextSourceOffset: 1,
      segmentCount: 1,
      truncated: false,
      updatedAt: LATER,
      eventContext: DEFAULT_EVENT_CONTEXT,
    });
    assert.equal(loser.kind, 'version-conflict');
    assert.deepEqual(counts(db), afterCreate);
  } finally {
    close(db);
  }
});

test('P2B-2 durable facts reject synthetic correlation and return frozen payloads', () => {
  const db = migratedDb();
  try {
    const { events, writer, sessions, processes } = bundle(db);
    const session = sessions.createSession(sessionInput()).session;
    processes.createProcess(processInput(session.id));
    const launch = events.findByRunAndSequence(RUN, 2);
    assert.equal(launch?.kind, 'known');
    assert.equal(Object.isFrozen(launch.event), true);
    assert.equal(Object.isFrozen(launch.event.payload), true);
    assert.throws(
      () => {
        const args = (launch.event.payload as { argsRedacted: string[] }).argsRedacted;
        args.push('mutation');
      },
      TypeError,
    );
    assert.throws(
      () => inTransaction(db, () => writer.appendWithinTransaction({
        type: 'process.session_state_changed',
        workspaceId: WS,
        taskId: TASK,
        runId: RUN,
        stageId: STAGE,
        providerSessionId: session.id,
        timestamp: LATER,
        eventContext: { correlationId: 'm4-p2b:synthetic', causationId: 'op_fake' },
        payload: {
          from: 'starting',
          to: 'starting',
          adapterStartRequested: true,
          terminal: false,
        },
      })),
      /Synthetic m4-p2b correlationId is forbidden/,
    );
  } finally {
    close(db);
  }
});

test('P2B-2 failed/stopping/exited facts require frozen outcome evidence', () => {
  const db = migratedDb();
  try {
    const { events, sessions, processes } = bundle(db);
    const session = sessions.createSession(sessionInput()).session;
    const process = processes.createProcess(processInput(session.id)).process;
    const starting = processes.casStartProcess({
      workspaceId: WS,
      processId: process.id,
      expectedVersion: process.version,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      timestamp: NOW,
      eventContext: DEFAULT_EVENT_CONTEXT,
    });
    assert.equal(starting.kind, 'applied');

    assert.throws(
      () => processes.transitionStatus({
        workspaceId: WS,
        processId: process.id,
        expectedVersion: starting.process.version,
        expectedClaimEpoch: starting.process.claimEpoch,
        expectedClaimOwner: starting.process.claimOwnerId,
        expectedFrom: 'starting',
        to: 'failed',
        timestamp: LATER,
        errorCode: 'PROCESS_SPAWN_FAILED',
        eventContext: DEFAULT_EVENT_CONTEXT,
      }),
      /failureOutcome is required/,
    );
    assert.equal(counts(db).events, 3);

    const failed = processes.transitionStatus({
      workspaceId: WS,
      processId: process.id,
      expectedVersion: starting.process.version,
      expectedClaimEpoch: starting.process.claimEpoch,
      expectedClaimOwner: starting.process.claimOwnerId,
      expectedFrom: 'starting',
      to: 'failed',
      timestamp: LATER,
      errorCode: 'PROCESS_SPAWN_FAILED',
      failureOutcome: 'spawn-failure',
      spawnFailureEvidence: 'PROCESS_SPAWN_FAILED',
      eventContext: DEFAULT_EVENT_CONTEXT,
    });
    assert.equal(failed.kind, 'applied');
    const fact = events.findByRunAndSequence(RUN, 4);
    assert.equal(fact?.kind, 'known');
    assert.equal((fact.event.payload as { outcome: string }).outcome, 'spawn-failure');
    assert.equal(
      (fact.event.payload as { spawnFailureEvidence: string }).spawnFailureEvidence,
      'PROCESS_SPAWN_FAILED',
    );

    const child = processes.createProcess(processInput(session.id, {
      parentProcessId: process.id,
      stageId: null,
      stageAttempt: null,
      providerSessionId: null,
      authorityRole: null,
      eventContext: DEFAULT_EVENT_CONTEXT,
    })).process;
    const childStarting = processes.casStartProcess({
      workspaceId: WS,
      processId: child.id,
      expectedVersion: child.version,
      expectedClaimEpoch: child.claimEpoch,
      expectedClaimOwner: child.claimOwnerId,
      timestamp: LATER,
      eventContext: DEFAULT_EVENT_CONTEXT,
    });
    assert.equal(childStarting.kind, 'applied');
    const childStopping = processes.transitionStatus({
      workspaceId: WS,
      processId: child.id,
      expectedVersion: childStarting.process.version,
      expectedClaimEpoch: childStarting.process.claimEpoch,
      expectedClaimOwner: childStarting.process.claimOwnerId,
      expectedFrom: 'starting',
      to: 'stopping',
      timestamp: LATER,
      terminationReason: 'cancelled',
      gracefulRequested: true,
      graceDeadline: GRACE_DEADLINE,
      forceDeadline: FORCE_DEADLINE,
      idempotencyKeyHash: 'c'.repeat(64),
      eventContext: DEFAULT_EVENT_CONTEXT,
    });
    assert.equal(childStopping.kind, 'applied');
    const afterCancel = processes.transitionStatus({
      workspaceId: WS,
      processId: child.id,
      expectedVersion: childStopping.process.version,
      expectedClaimEpoch: childStopping.process.claimEpoch,
      expectedClaimOwner: childStopping.process.claimOwnerId,
      expectedFrom: 'stopping',
      to: 'failed',
      timestamp: LATER,
      errorCode: 'PROCESS_SPAWN_FAILED',
      terminationReason: 'cancelled',
      failureOutcome: 'spawn-failure-after-cancel',
      cancelReason: 'user-cancelled',
      cancelCausationId: 'op_m4_cancel_child',
      spawnFailureEvidence: 'PROCESS_SPAWN_FAILED',
      eventContext: DEFAULT_EVENT_CONTEXT,
    });
    assert.equal(afterCancel.kind, 'applied');
    const afterCancelFact = events.listByRunAfterSequence(RUN, 0).find(
      record => record.kind === 'known'
        && record.event.processId === child.id
        && record.event.type === 'process.failed',
    );
    assert.equal(afterCancelFact?.kind, 'known');
    assert.equal(
      (afterCancelFact.event.payload as { outcome: string }).outcome,
      'spawn-failure-after-cancel',
    );
    assert.equal(
      (afterCancelFact.event.payload as { cancelReason: string }).cancelReason,
      'user-cancelled',
    );
    assert.equal(
      (afterCancelFact.event.payload as { cancelCausationId: string }).cancelCausationId,
      'op_m4_cancel_child',
    );
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
        eventContext: DEFAULT_EVENT_CONTEXT,
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
        eventContext: DEFAULT_EVENT_CONTEXT,
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
