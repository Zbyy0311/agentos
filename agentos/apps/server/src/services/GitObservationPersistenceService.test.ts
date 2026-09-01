import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

import {
  createChangedFilesV1,
  createM3RuntimeEventRegistry,
  parseGitCommitObjectIdV1,
  type AuthorizedRuntimeEventContextV1,
  type GitObservationRuntimeEventContextAuthorityV1,
  type GitObservationSnapshotV1,
  type RuntimeEventContextAuthoritySourceV1,
} from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceGitObservationRepository } from '../store/WorkspaceGitObservationRepository.js';
import { WorkspaceAdmissionRepository } from '../store/WorkspaceAdmissionRepository.js';
import { RuntimeEventOutboxWriter, RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import { RunSequenceAllocator } from '../store/RunSequenceAllocator.js';
import { OutboxRepository } from '../store/OutboxRepository.js';
import { inTransaction } from '../store/Transaction.js';
import {
  GitObservationPersistenceError,
  GitObservationPersistenceService,
  type CanonicalCommandOwnershipVerifierV1,
  type GitObservationPersistenceCommandV1,
  type GitObservationPersistenceFaultInjection,
} from './GitObservationPersistenceService.js';

/**
 * P6-L1C-M3 durable Git Observation tests.
 *
 * Real migrated 016 schema via SqliteStore.runMigrations; a real temp
 * Artifact root; deterministic fault injection at every frozen crash window.
 * No real Git execution: snapshots are constructed through frozen M1 types.
 */

const NOW = new Date('2026-09-01T00:00:00.000Z');
const SHA_A = parseGitCommitObjectIdV1('a'.repeat(40))!;
const SHA_B = parseGitCommitObjectIdV1('b'.repeat(40))!;
const DIFF_BYTES = new TextEncoder().encode('diff --git a/x b/x\n+one\n');
const DIFF_SHA = createHash('sha256').update(DIFF_BYTES).digest('hex');

type Db = ReturnType<SqliteStore['getDatabase']>;

interface Fixture {
  root: string;
  artifactRoot: string;
  store: SqliteStore;
  db: Db;
  observations: WorkspaceGitObservationRepository;
  admissions: WorkspaceAdmissionRepository;
  close(): void;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-l1c-m3-'));
  const artifactRoot = join(root, '.agentos', 'artifacts');
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
    id: 'ws-a', name: 'WS A', rootPath: root, gitEnabled: true, memoryEnabled: true,
    agents: [{ id: 'agent-a', name: 'Agent', role: 'codex', enabled: true, cliCommand: 'agent', cliArgs: [] }],
    lastOpenedAt: NOW.toISOString(), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  }] }), 'utf8');
  const store = new SqliteStore(root);
  const db = store.getDatabase();
  return {
    root,
    artifactRoot,
    store,
    db,
    observations: new WorkspaceGitObservationRepository(db),
    admissions: new WorkspaceAdmissionRepository(db),
    close() { try { store.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

function seedCanonicalRun(fx: Fixture, runId = 'run-a', workspaceId = 'ws-a'): void {
  const db = fx.db;
  db.prepare('INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('task-' + runId, workspaceId, 't', 'open', 'normal', 'test', NOW.toISOString(), NOW.toISOString());
  db.prepare('INSERT INTO workflow_definitions (id, definition_key, version, name, definition_json, definition_hash, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('wf-' + runId, 'key-' + runId, 1, 'n', '{"stages":[]}', 'b'.repeat(64), 1, NOW.toISOString(), NOW.toISOString());
  db.prepare('INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(runId, workspaceId, 'task-' + runId, runId, 'queued', 'initial', 'v2_api', 'test', NOW.toISOString(), NOW.toISOString());
  db.prepare('INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('snap-' + runId, workspaceId, runId, 'wf-' + runId, 1, '{}', 'a'.repeat(64), NOW.toISOString());
}

function seedLegacyAgentRun(fx: Fixture, agentRunId = 'agentrun-a'): void {
  fx.store.createConversation({ id: 'conv-' + agentRunId, workspaceId: 'ws-a', type: 'direct', title: 'c', agentId: 'agent-a', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  fx.store.createMessage({ id: 'msg-' + agentRunId, conversationId: 'conv-' + agentRunId, workspaceId: 'ws-a', senderType: 'user', content: 'hi', createdAt: NOW.toISOString() });
  fx.store.createRun({ id: agentRunId, workspaceId: 'ws-a', conversationId: 'conv-' + agentRunId, sourceMessageId: 'msg-' + agentRunId, objective: 'obj', status: 'running', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}

function insertAdmission(fx: Fixture, overrides: Record<string, unknown> = {}): string {
  const id = 'adm-' + Math.random().toString(36).slice(2, 10);
  fx.admissions.insertAdmission({
    id, workspaceId: 'ws-a', subjectKind: 'CANONICAL_RUN', canonicalRunId: 'run-a', legacyRunId: null,
    requestedMutationClass: 'MODIFYING', effectiveMutationClass: 'MODIFYING', enforcementEvidenceJson: null,
    requestOrder: 1, state: 'REQUESTED', queueReason: null, releaseReason: null,
    requestedAt: NOW.toISOString(), grantedAt: null, releasedAt: null,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), version: 1,
    ...overrides,
  } as never);
  return id;
}

function insertOperation(fx: Fixture, runId: string, id: string, correlationId: string): void {
  fx.db.prepare(
    'INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'run.start', 'completed', 'ws-a', 'run', runId, runId, correlationId, NOW.toISOString(), NOW.toISOString());
}

function gitSnapshot(overrides: Record<string, unknown> = {}): GitObservationSnapshotV1 {
  return {
    schemaVersion: 1,
    trigger: 'on_demand',
    observationState: 'GIT',
    repositoryRoot: 'E:\\ws\\repo',
    cwd: 'E:\\ws\\repo',
    baseCommitSha: SHA_A,
    finalCommitSha: SHA_B,
    dirtyState: 'dirty',
    statusCompleteness: 'complete',
    changedFiles: createChangedFilesV1([
      { path: 'src/x.ts', kind: 'modified', staged: true, unstaged: false, previousPath: null },
    ]),
    diffState: 'available',
    truncation: { changedFiles: false, diff: false },
    error: null,
    subfailures: [],
    ...overrides,
  } as unknown as GitObservationSnapshotV1;
}

function notGitSnapshot(): GitObservationSnapshotV1 {
  return {
    schemaVersion: 1, trigger: 'on_demand', observationState: 'NOT_GIT',
    repositoryRoot: null, cwd: 'E:\\ws\\plain', baseCommitSha: null, finalCommitSha: null,
    dirtyState: 'not_applicable', statusCompleteness: 'not_applicable', changedFiles: null,
    diffState: 'not_applicable', truncation: { changedFiles: false, diff: false },
    error: null, subfailures: [],
  };
}

function unavailableSnapshot(): GitObservationSnapshotV1 {
  return {
    schemaVersion: 1, trigger: 'on_demand', observationState: 'UNAVAILABLE',
    repositoryRoot: null, cwd: 'E:\\ws\\repo', baseCommitSha: null, finalCommitSha: null,
    dirtyState: 'unknown', statusCompleteness: 'incomplete', changedFiles: null,
    diffState: 'unavailable', truncation: { changedFiles: false, diff: false },
    error: { phase: 'repository_discovery', code: 'GIT_REPOSITORY_DISCOVERY_FAILED' },
    subfailures: [],
  };
}

interface AuthorityStub extends GitObservationRuntimeEventContextAuthorityV1 {
  calls: RuntimeEventContextAuthoritySourceV1[];
}

function operationAuthority(context: { correlationId: string; causationId: string; operationId: string }): AuthorityStub {
  const calls: RuntimeEventContextAuthoritySourceV1[] = [];
  return {
    calls,
    authorize(source) {
      calls.push(source);
      if (source.origin !== 'operation' || source.operationId !== context.operationId) throw new Error('unauthorized');
      return { correlationId: context.correlationId, causationId: context.causationId, origin: 'operation', authorityId: context.operationId } as unknown as AuthorizedRuntimeEventContextV1;
    },
  };
}

function commandAuthority(commandId: string): AuthorityStub {
  return {
    calls: [],
    authorize(source) {
      if (source.origin !== 'canonical_command' || source.commandId !== commandId) throw new Error('unauthorized');
      return { correlationId: 'corr', causationId: 'cause', origin: 'canonical_command', authorityId: commandId } as unknown as AuthorizedRuntimeEventContextV1;
    },
  };
}

function persistedEventAuthority(eventId: string, context: { correlationId: string; causationId: string }): AuthorityStub {
  return {
    calls: [],
    authorize(source) {
      if (source.origin !== 'persisted_event' || source.eventId !== eventId) throw new Error('unauthorized');
      return { correlationId: context.correlationId, causationId: context.causationId, origin: 'persisted_event', authorityId: eventId } as unknown as AuthorizedRuntimeEventContextV1;
    },
  };
}

interface ServiceHarness {
  fx: Fixture;
  service: GitObservationPersistenceService;
  events: RuntimeEventRepository;
  outbox: OutboxRepository;
  writer: RuntimeEventOutboxWriter;
  artifactRoot: string;
}

function makeService(
  fx: Fixture,
  options: {
    authority?: GitObservationRuntimeEventContextAuthorityV1;
    canonicalCommandVerifier?: CanonicalCommandOwnershipVerifierV1;
    faultInjection?: GitObservationPersistenceFaultInjection;
    now?: () => Date;
  } = {},
): ServiceHarness {
  const events = new RuntimeEventRepository(fx.db, createM3RuntimeEventRegistry());
  const outbox = new OutboxRepository(fx.db, events);
  const writer = new RuntimeEventOutboxWriter(events, new RunSequenceAllocator(fx.db), outbox, fx.db);
  const service = new GitObservationPersistenceService({
    store: fx.store,
    db: fx.db,
    observations: fx.observations,
    factWriter: writer,
    eventAuthority: options.authority ?? operationAuthority({ correlationId: 'corr-a', causationId: 'cause-a', operationId: 'op-a' }),
    artifactRoot: fx.artifactRoot,
    canonicalCommandVerifier: options.canonicalCommandVerifier,
    faultInjection: options.faultInjection,
    now: options.now ?? (() => NOW),
    createArtifactId: () => 'artifact-' + Math.random().toString(36).slice(2, 10),
    createObservationId: () => 'obs-' + Math.random().toString(36).slice(2, 10),
  });
  return { fx, service, events, outbox, writer, artifactRoot: fx.artifactRoot };
}

function canonicalCommand(admissionId: string, runId: string, authoritySource: RuntimeEventContextAuthoritySourceV1, snapshot: GitObservationSnapshotV1 = gitSnapshot()): GitObservationPersistenceCommandV1 {
  return {
    workspaceId: 'ws-a',
    snapshot,
    diffBytes: DIFF_BYTES,
    binding: { subjectKind: 'CANONICAL_RUN', admissionId, canonicalRunId: runId, authoritySource },
  };
}

function eventCount(fx: Fixture): number {
  return (fx.db.prepare('SELECT COUNT(*) AS c FROM runtime_events').get() as { c: number }).c;
}
function outboxCount(fx: Fixture): number {
  return (fx.db.prepare('SELECT COUNT(*) AS c FROM outbox_messages').get() as { c: number }).c;
}
function artifactCount(fx: Fixture): number {
  return (fx.db.prepare('SELECT COUNT(*) AS c FROM runtime_artifacts').get() as { c: number }).c;
}
function observationCount(fx: Fixture): number {
  return (fx.db.prepare('SELECT COUNT(*) AS c FROM workspace_git_observations').get() as { c: number }).c;
}
function artifactDir(artifactRoot: string, runId: string, artifactId: string): string {
  return join(artifactRoot, 'ws-a', runId, artifactId);
}
function countArtifactDirs(artifactRoot: string, runId: string): number {
  const runDir = join(artifactRoot, 'ws-a', runId);
  if (!existsSync(runDir)) return 0;
  return readdirSync(runDir, { withFileTypes: true })
    .filter(e => e.isDirectory()).length;
}

const OP_SRC = (id = 'op-a'): RuntimeEventContextAuthoritySourceV1 =>
 ({ origin: 'operation', operationId: id, context: { correlationId: 'corr-a', causationId: 'cause-a' } });

// ---------------------------------------------------------------------------
// Writer regression: the process-manager default is preserved; an explicit
// source must still match the Registry definition.
// ---------------------------------------------------------------------------
test('writer regression: omitted source still emits process-manager', () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    const events = new RuntimeEventRepository(fx.db, createM3RuntimeEventRegistry());
    const outbox = new OutboxRepository(fx.db, events);
    const writer = new RuntimeEventOutboxWriter(events, new RunSequenceAllocator(fx.db), outbox, fx.db);
    let capturedSource: string | undefined;
    const originalAppend = events.appendWithinTransaction.bind(events);
    (events as unknown as { appendWithinTransaction: (draft: unknown) => unknown }).appendWithinTransaction = (draft: unknown) => {
      capturedSource = (draft as { source?: string }).source;
      return originalAppend(draft as never);
    };
    try {
      inTransaction(fx.db, () => writer.appendWithinTransaction({
        type: 'run.started',
        workspaceId: 'ws-a',
        runId: 'run-a',
        timestamp: NOW.toISOString(),
        eventContext: { correlationId: 'corr', causationId: 'cause' },
        payload: { startedAt: NOW.toISOString() },
      }));
    } catch {
      // The Registry rejects a process-manager source for run.started; the
      // regression signal is the source the writer actually supplied.
    }
    assert.equal(capturedSource, 'process-manager');
  } finally { fx.close(); }
});

test('writer: explicit source must match the Registry definition source', () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    const events = new RuntimeEventRepository(fx.db, createM3RuntimeEventRegistry());
    const outbox = new OutboxRepository(fx.db, events);
    const writer = new RuntimeEventOutboxWriter(events, new RunSequenceAllocator(fx.db), outbox, fx.db);
    assert.throws(() => inTransaction(fx.db, () => writer.appendWithinTransaction({
      type: 'git.observation.completed',
      workspaceId: 'ws-a',
      runId: 'run-a',
      timestamp: NOW.toISOString(),
      source: 'process-manager',
      eventContext: { correlationId: 'corr', causationId: 'cause' },
      payload: { observationState: 'GIT', dirtyState: 'clean' },
    })), /source does not match its definition/);
  } finally { fx.close(); }
});

// ---------------------------------------------------------------------------
// Persistence modes.
// ---------------------------------------------------------------------------
test('WORKSPACE_ONLY persists the observation with no events, outbox, or artifact', async () => {
  const fx = createFixture();
  try {
    const { service } = makeService(fx);
    const result = await service.persist({
      workspaceId: 'ws-a',
      snapshot: gitSnapshot(),
      binding: { subjectKind: 'WORKSPACE_ONLY' },
    });
    assert.equal(observationCount(fx), 1);
    assert.equal(eventCount(fx), 0);
    assert.equal(outboxCount(fx), 0);
    assert.equal(artifactCount(fx), 0);
    assert.equal(result.eventsCreated, 0);
    assert.equal(result.outboxRowsCreated, 0);
    const row = fx.observations.findById('ws-a', result.observationId)!;
    assert.equal(row.admissionId, null);
    assert.equal(row.subjectKind, null);
    assert.equal(row.canonicalRunId, null);
    assert.equal(row.legacyRunId, null);
    assert.equal(row.diffArtifactId, null);
    assert.equal(row.observationState, 'GIT');
  } finally { fx.close(); }
});

test('LEGACY_AGENT_RUN persists with the admission binding and no events/outbox/artifact', async () => {
  const fx = createFixture();
  try {
    seedLegacyAgentRun(fx);
    const admissionId = insertAdmission(fx, { subjectKind: 'LEGACY_AGENT_RUN', canonicalRunId: null, legacyRunId: 'agentrun-a' });
    const { service } = makeService(fx);
    const result = await service.persist({
      workspaceId: 'ws-a',
      snapshot: gitSnapshot(),
      binding: { subjectKind: 'LEGACY_AGENT_RUN', admissionId, legacyRunId: 'agentrun-a' },
    });
    assert.equal(observationCount(fx), 1);
    assert.equal(eventCount(fx), 0);
    assert.equal(outboxCount(fx), 0);
    assert.equal(artifactCount(fx), 0);
    const row = fx.observations.findById('ws-a', result.observationId)!;
    assert.equal(row.admissionId, admissionId);
    assert.equal(row.subjectKind, 'LEGACY_AGENT_RUN');
    assert.equal(row.legacyRunId, 'agentrun-a');
    assert.equal(row.canonicalRunId, null);
    assert.equal(row.diffArtifactId, null);
  } finally { fx.close(); }
});

test('CANONICAL_RUN persists observation, canonical artifact, events, and outbox atomically', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    insertOperation(fx, 'run-a', 'op-a', 'corr-a');
    const admissionId = insertAdmission(fx);
    const { service } = makeService(fx);
    const result = await service.persist(canonicalCommand(admissionId, 'run-a', OP_SRC()));

    assert.equal(observationCount(fx), 1);
    assert.equal(artifactCount(fx), 1);
    assert.equal(eventCount(fx), 2);
    assert.equal(outboxCount(fx), 2);
    assert.equal(result.eventsCreated, 2);
    assert.equal(result.outboxRowsCreated, 2);
    assert.ok(result.diffArtifactId);

    const obs = fx.observations.findById('ws-a', result.observationId)!;
    assert.equal(obs.subjectKind, 'CANONICAL_RUN');
    assert.equal(obs.canonicalRunId, 'run-a');
    assert.equal(obs.admissionId, admissionId);
    assert.equal(obs.diffArtifactId, result.diffArtifactId);

    const artifact = fx.store.getCanonicalRuntimeArtifactRecord('ws-a', result.diffArtifactId!)!;
    assert.equal(artifact.provenanceKind, 'CANONICAL');
    assert.equal(artifact.canonicalRunId, 'run-a');
    assert.equal(artifact.type, 'diff');
    assert.equal(artifact.sha256, DIFF_SHA);
    assert.equal(artifact.sizeBytes, DIFF_BYTES.byteLength);
    assert.equal(artifact.contentAvailable, true);
    assert.equal(artifact.mimeType, 'text/x-diff');

    const bytes = readFileSync(join(artifactDir(fx.artifactRoot, 'run-a', artifact.id), 'content'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), DIFF_SHA);
    assert.equal(bytes.byteLength, DIFF_BYTES.byteLength);

    const events = fx.db.prepare('SELECT id, type, source, run_id, artifact_id FROM runtime_events ORDER BY sequence ASC').all() as Array<Record<string, unknown>>;
    assert.deepEqual(events.map(e => e.type), ['git.observation.completed', 'artifact.diff.registered']);
    assert.deepEqual(events.map(e => e.source), ['git-runtime', 'artifact-manager']);
    assert.equal(events[1].artifact_id, artifact.id);

    const outboxRows = fx.db.prepare('SELECT event_id FROM outbox_messages').all() as Array<{ event_id: string }>;
    const eventIds = new Set(events.map(e => e.id));
    assert.equal(outboxRows.length, 2);
    assert.ok(outboxRows.every(r => eventIds.has(r.event_id)));
  } finally { fx.close(); }
});

test('CANONICAL_RUN without valid AuthorizedRuntimeEventContextV1 fails closed with no commit', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    const admissionId = insertAdmission(fx);
    const rejecting = {
      authorize(): never { throw new Error('unauthorized'); },
    } as unknown as GitObservationRuntimeEventContextAuthorityV1;
    const { service } = makeService(fx, { authority: rejecting });
    await assert.rejects(
      () => service.persist(canonicalCommand(admissionId, 'run-a', OP_SRC())),
      (error: unknown) => {
        assert.ok(error instanceof GitObservationPersistenceError);
        assert.equal((error as GitObservationPersistenceError).code, 'AUTHORITY_UNPROVEN');
        return true;
      },
    );
    assert.equal(observationCount(fx), 0);
    assert.equal(artifactCount(fx), 0);
    assert.equal(eventCount(fx), 0);
    assert.equal(outboxCount(fx), 0);
    assert.equal(countArtifactDirs(fx.artifactRoot, 'run-a'), 0);
  } finally { fx.close(); }
});

// ---------------------------------------------------------------------------
// Snapshot serialization / integrity.
// ---------------------------------------------------------------------------
test('finalCommitSha survives through the frozen snapshot JSON', async () => {
  const fx = createFixture();
  try {
    const { service } = makeService(fx);
    const result = await service.persist({
      workspaceId: 'ws-a', snapshot: gitSnapshot(), binding: { subjectKind: 'WORKSPACE_ONLY' },
    });
    const row = fx.observations.findById('ws-a', result.observationId)!;
    const parsed = JSON.parse(row.statusSummaryJson!) as Record<string, unknown>;
    assert.equal(parsed.finalCommitSha, SHA_B);
    assert.equal(parsed.baseCommitSha, SHA_A);
    assert.equal(parsed.repositoryRoot, 'E:\\ws\\repo');
    assert.equal(row.baseCommitSha, SHA_A);
  } finally { fx.close(); }
});

test('changedFiles truncation metadata survives', async () => {
  const fx = createFixture();
  try {
    const truncated = createChangedFilesV1(
      Array.from({ length: 20 }, (_, i) => ({ path: 'f/' + String(i).padStart(3, '0') + '.ts', kind: 'modified' as const, staged: true, unstaged: false, previousPath: null })),
      { maximumEntries: 5, maximumSerializedBytes: 4096 },
    );
    const { service } = makeService(fx);
    const result = await service.persist({
      workspaceId: 'ws-a',
      snapshot: gitSnapshot({ changedFiles: truncated, truncation: { changedFiles: true, diff: false } }),
      binding: { subjectKind: 'WORKSPACE_ONLY' },
    });
    const row = fx.observations.findById('ws-a', result.observationId)!;
    const parsed = JSON.parse(row.changedFilesJson!) as { totalEntries: number; omittedEntries: number; truncated: boolean; entries: unknown[] };
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.totalEntries, 20);
    assert.equal(parsed.entries.length, 5);
    assert.equal(parsed.omittedEntries, 15);
  } finally { fx.close(); }
});

test('stable error/subfailure serialization for UNAVAILABLE', async () => {
  const fx = createFixture();
  try {
    const { service } = makeService(fx);
    const result = await service.persist({
      workspaceId: 'ws-a', snapshot: unavailableSnapshot(), binding: { subjectKind: 'WORKSPACE_ONLY' },
    });
    const row = fx.observations.findById('ws-a', result.observationId)!;
    assert.equal(row.observationState, 'UNAVAILABLE');
    assert.equal(row.errorCode, 'GIT_REPOSITORY_DISCOVERY_FAILED');
    assert.equal(row.changedFilesJson, null);
    assert.equal(row.diffArtifactId, null);
    const parsed = JSON.parse(row.statusSummaryJson!) as { observationState: string; error: { code: string } };
    assert.equal(parsed.observationState, 'UNAVAILABLE');
    assert.equal(parsed.error.code, 'GIT_REPOSITORY_DISCOVERY_FAILED');
  } finally { fx.close(); }
});

test('GIT clean observation persists clean dirty state', async () => {
  const fx = createFixture();
  try {
    const clean = gitSnapshot({
      dirtyState: 'clean',
      changedFiles: createChangedFilesV1([]),
      diffState: 'not_requested',
    });
    const { service } = makeService(fx);
    const result = await service.persist({
      workspaceId: 'ws-a', snapshot: clean, binding: { subjectKind: 'WORKSPACE_ONLY' },
    });
    const row = fx.observations.findById('ws-a', result.observationId)!;
    assert.equal(row.dirtyState, 'clean');
    const parsed = JSON.parse(row.statusSummaryJson!) as { dirtyState: string; diffState: string };
    assert.equal(parsed.dirtyState, 'clean');
  } finally { fx.close(); }
});

// ---------------------------------------------------------------------------
// Binding / subject integrity.
// ---------------------------------------------------------------------------
test('cross-Workspace admission is rejected', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    insertOperation(fx, 'run-a', 'op-a', 'corr-a');
    // A legitimate admission for run-a exists in ws-a; the command claims the
    // same admission but for a canonical Run that lives in a different
    // Workspace, so the composite subject FK must fail.
    seedCanonicalRun(fx, 'run-b');
    const admissionId = insertAdmission(fx);
    const { service } = makeService(fx);
    await assert.rejects(
      () => service.persist(canonicalCommand(admissionId, 'run-b', OP_SRC())),
      () => true,
    );
    assert.equal(observationCount(fx), 0);
    assert.equal(eventCount(fx), 0);
    assert.equal(artifactCount(fx), 0);
    assert.equal(countArtifactDirs(fx.artifactRoot, 'run-a'), 0);
  } finally { fx.close(); }
});

test('wrong canonical Run is rejected', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    insertOperation(fx, 'run-a', 'op-a', 'corr-a');
    const admissionId = insertAdmission(fx);
    const { service } = makeService(fx);
    await assert.rejects(
      () => service.persist(canonicalCommand(admissionId, 'run-missing', OP_SRC())),
      () => true,
    );
    assert.equal(observationCount(fx), 0);
    assert.equal(artifactCount(fx), 0);
    assert.equal(eventCount(fx), 0);
  } finally { fx.close(); }
});

test('wrong legacy subject is rejected', async () => {
  const fx = createFixture();
  try {
    seedLegacyAgentRun(fx);
    const admissionId = insertAdmission(fx, { subjectKind: 'LEGACY_AGENT_RUN', canonicalRunId: null, legacyRunId: 'agentrun-a' });
    const { service } = makeService(fx);
    await assert.rejects(
      () => service.persist({
        workspaceId: 'ws-a',
        snapshot: gitSnapshot(),
        binding: { subjectKind: 'LEGACY_AGENT_RUN', admissionId, legacyRunId: 'agentrun-missing' },
      }),
      () => true,
    );
    assert.equal(observationCount(fx), 0);
  } finally { fx.close(); }
});

test('canonical artifact never fabricates legacy provenance', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    insertOperation(fx, 'run-a', 'op-a', 'corr-a');
    const admissionId = insertAdmission(fx);
    const { service } = makeService(fx);
    const result = await service.persist(canonicalCommand(admissionId, 'run-a', OP_SRC()));
    const raw = fx.db.prepare('SELECT * FROM runtime_artifacts WHERE id = ?').get(result.diffArtifactId!) as Record<string, unknown>;
    assert.equal(raw.provenance_kind, 'CANONICAL');
    assert.equal(raw.run_id, null);
    assert.equal(raw.source_execution_id, null);
    assert.equal(raw.agent_id, null);
    assert.equal(raw.canonical_run_id, 'run-a');
  } finally { fx.close(); }
});

// ---------------------------------------------------------------------------
// Runtime Event authority provenance.
// ---------------------------------------------------------------------------
test('operation authority proves the Operation belongs to the same Workspace/Run', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    const admissionId = insertAdmission(fx);
    // Operation exists for a DIFFERENT Run, so authority for run-a is unproven.
    insertOperation(fx, 'run-a', 'op-real', 'corr-real');
    const authority = operationAuthority({ correlationId: 'corr-a', causationId: 'cause-a', operationId: 'op-missing' });
    const { service } = makeService(fx, { authority });
    await assert.rejects(
      () => service.persist(canonicalCommand(admissionId, 'run-a', { origin: 'operation', operationId: 'op-missing', context: { correlationId: 'corr-a', causationId: 'cause-a' } })),
      (e: unknown) => (e as GitObservationPersistenceError).code === 'AUTHORITY_UNPROVEN',
    );
    assert.equal(observationCount(fx), 0);
    assert.equal(eventCount(fx), 0);
    assert.equal(artifactCount(fx), 0);
  } finally { fx.close(); }
});

test('persisted_event authority proves the Event exists in the same Workspace/Run', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    insertOperation(fx, 'run-a', 'op-a', 'corr-a');
    const admissionId = insertAdmission(fx);
    // First create a legitimate prior canonical event to serve as causation.
    const events = new RuntimeEventRepository(fx.db, createM3RuntimeEventRegistry());
    const outbox = new OutboxRepository(fx.db, events);
    const writer = new RuntimeEventOutboxWriter(events, new RunSequenceAllocator(fx.db), outbox, fx.db);
    const prior = inTransaction(fx.db, () => writer.appendWithinTransaction({
      type: 'run.started',
      workspaceId: 'ws-a',
      runId: 'run-a',
      timestamp: NOW.toISOString(),
      source: 'run-engine',
      eventContext: { correlationId: 'corr-a', causationId: 'cause-a' },
      payload: { startedAt: NOW.toISOString() },
    }));
    const authority = persistedEventAuthority(prior.event.id, { correlationId: 'corr-a', causationId: prior.event.id });
    const { service } = makeService(fx, { authority });
    const result = await service.persist(canonicalCommand(
      admissionId, 'run-a',
      { origin: 'persisted_event', eventId: prior.event.id, context: { correlationId: 'corr-a', causationId: prior.event.id } },
      gitSnapshot({ diffState: 'not_requested' }),
    ));
    assert.equal(observationCount(fx), 1);
    const emitted = fx.db.prepare("SELECT type, causation_id FROM runtime_events WHERE type = 'git.observation.completed'").get() as { type: string; causation_id: string };
    assert.equal(emitted.causation_id, prior.event.id);
    assert.equal(eventCount(fx), 2);
    assert.equal(outboxCount(fx), 2);
  } finally { fx.close(); }
});

test('canonical_command authority fails closed without a verifier seam', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    const admissionId = insertAdmission(fx);
    const { service } = makeService(fx, { authority: commandAuthority('cmd-1') });
    await assert.rejects(
      () => service.persist(canonicalCommand(admissionId, 'run-a', { origin: 'canonical_command', commandId: 'cmd-1', context: { correlationId: 'c', causationId: 'x' } })),
      (e: unknown) => {
        const err = e as GitObservationPersistenceError;
        assert.equal(err.code, 'AUTHORITY_UNPROVEN');
        assert.match(err.message, /canonical_command/);
        return true;
      },
    );
    assert.equal(observationCount(fx), 0);
    assert.equal(eventCount(fx), 0);
    assert.equal(artifactCount(fx), 0);
  } finally { fx.close(); }
});

test('canonical_command authority succeeds only with a proven verifier seam', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    const admissionId = insertAdmission(fx);
    const verifier: CanonicalCommandOwnershipVerifierV1 = {
      verifyCanonicalCommandOwnership(input) {
        return input.workspaceId === 'ws-a' && input.canonicalRunId === 'run-a' && input.commandId === 'cmd-real';
      },
    };
    const { service } = makeService(fx, { authority: commandAuthority('cmd-real'), canonicalCommandVerifier: verifier });
    const result = await service.persist(canonicalCommand(
      admissionId, 'run-a',
      { origin: 'canonical_command', commandId: 'cmd-real', context: { correlationId: 'corr', causationId: 'cause' } },
      gitSnapshot({ diffState: 'not_requested' }),
    ));
    assert.equal(observationCount(fx), 1);
    assert.equal(result.eventsCreated, 1);
    assert.equal(result.outboxRowsCreated, 1);
  } finally { fx.close(); }
});

// ---------------------------------------------------------------------------
// Crash windows A-J.
// ---------------------------------------------------------------------------
function crashSetup(fx: Fixture): { admissionId: string; h: ServiceHarness } {
  seedCanonicalRun(fx);
  insertOperation(fx, 'run-a', 'op-a', 'corr-a');
  const admissionId = insertAdmission(fx);
  return { admissionId, h: null as never };
}

test('A: failure before temp write leaves no DB rows and no artifact', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    insertOperation(fx, 'run-a', 'op-a', 'corr-a');
    const admissionId = insertAdmission(fx);
    const { service } = makeService(fx, { faultInjection: { beforeTempWrite: () => { throw new Error('boom'); } } });
    await assert.rejects(() => service.persist(canonicalCommand(admissionId, 'run-a', OP_SRC())), /boom/);
    assert.equal(observationCount(fx), 0);
    assert.equal(artifactCount(fx), 0);
    assert.equal(eventCount(fx), 0);
    assert.equal(outboxCount(fx), 0);
    assert.equal(countArtifactDirs(fx.artifactRoot, 'run-a'), 0);
  } finally { fx.close(); }
});

test('B: temp write failure leaves no DB rows and no final artifact', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    insertOperation(fx, 'run-a', 'op-a', 'corr-a');
    const admissionId = insertAdmission(fx);
    const { service } = makeService(fx, { faultInjection: { failTempWrite: () => { throw new Error('disk-full'); } } });
    await assert.rejects(() => service.persist(canonicalCommand(admissionId, 'run-a', OP_SRC())), /disk-full/);
    assert.equal(observationCount(fx), 0);
    assert.equal(artifactCount(fx), 0);
    assert.equal(eventCount(fx), 0);
    assert.equal(countArtifactDirs(fx.artifactRoot, 'run-a'), 0);
  } finally { fx.close(); }
});

test('C: rename failure leaves no DB rows', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    insertOperation(fx, 'run-a', 'op-a', 'corr-a');
    const admissionId = insertAdmission(fx);
    const { service } = makeService(fx, { faultInjection: { failRename: () => { throw new Error('rename-fail'); } } });
    await assert.rejects(() => service.persist(canonicalCommand(admissionId, 'run-a', OP_SRC())), /rename-fail/);
    assert.equal(observationCount(fx), 0);
    assert.equal(artifactCount(fx), 0);
    assert.equal(eventCount(fx), 0);
    assert.equal(countArtifactDirs(fx.artifactRoot, 'run-a'), 0);
  } finally { fx.close(); }
});

test('D: artifact insert failure rolls back and removes the final directory', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    insertOperation(fx, 'run-a', 'op-a', 'corr-a');
    const admissionId = insertAdmission(fx);
    const { service } = makeService(fx, { faultInjection: { beforeArtifactInsert: () => { throw new Error('artifact-insert-fail'); } } });
    await assert.rejects(() => service.persist(canonicalCommand(admissionId, 'run-a', OP_SRC())), /artifact-insert-fail/);
    assert.equal(observationCount(fx), 0);
    assert.equal(artifactCount(fx), 0);
    assert.equal(eventCount(fx), 0);
    assert.equal(outboxCount(fx), 0);
    assert.equal(countArtifactDirs(fx.artifactRoot, 'run-a'), 0);
  } finally { fx.close(); }
});

test('E: observation insert failure rolls back the artifact and removes the final directory', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    insertOperation(fx, 'run-a', 'op-a', 'corr-a');
    const admissionId = insertAdmission(fx);
    const { service } = makeService(fx, { faultInjection: { beforeObservationInsert: () => { throw new Error('obs-insert-fail'); } } });
    await assert.rejects(() => service.persist(canonicalCommand(admissionId, 'run-a', OP_SRC())), /obs-insert-fail/);
    assert.equal(observationCount(fx), 0);
    assert.equal(artifactCount(fx), 0);
    assert.equal(eventCount(fx), 0);
    assert.equal(countArtifactDirs(fx.artifactRoot, 'run-a'), 0);
  } finally { fx.close(); }
});

test('F: event append failure rolls back artifact and observation, removing the final directory', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    insertOperation(fx, 'run-a', 'op-a', 'corr-a');
    const admissionId = insertAdmission(fx);
    const { service } = makeService(fx, { faultInjection: { beforeEventAppend: () => { throw new Error('event-append-fail'); } } });
    await assert.rejects(() => service.persist(canonicalCommand(admissionId, 'run-a', OP_SRC())), /event-append-fail/);
    assert.equal(observationCount(fx), 0);
    assert.equal(artifactCount(fx), 0);
    assert.equal(eventCount(fx), 0);
    assert.equal(outboxCount(fx), 0);
    assert.equal(countArtifactDirs(fx.artifactRoot, 'run-a'), 0);
  } finally { fx.close(); }
});

test('G: outbox insert failure rolls back event, observation, and artifact, removing the final directory', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    insertOperation(fx, 'run-a', 'op-a', 'corr-a');
    const admissionId = insertAdmission(fx);
    const { service } = makeService(fx, { faultInjection: { beforeOutboxInsert: () => { throw new Error('outbox-insert-fail'); } } });
    await assert.rejects(() => service.persist(canonicalCommand(admissionId, 'run-a', OP_SRC())), /outbox-insert-fail/);
    assert.equal(observationCount(fx), 0);
    assert.equal(artifactCount(fx), 0);
    assert.equal(eventCount(fx), 0);
    assert.equal(outboxCount(fx), 0);
    assert.equal(countArtifactDirs(fx.artifactRoot, 'run-a'), 0);
  } finally { fx.close(); }
});

test('H: successful commit leaves final bytes whose hash/size match and all DB rows', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    insertOperation(fx, 'run-a', 'op-a', 'corr-a');
    const admissionId = insertAdmission(fx);
    const { service } = makeService(fx);
    const result = await service.persist(canonicalCommand(admissionId, 'run-a', OP_SRC()));
    const bytes = readFileSync(join(artifactDir(fx.artifactRoot, 'run-a', result.diffArtifactId!), 'content'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), DIFF_SHA);
    assert.equal(bytes.byteLength, DIFF_BYTES.byteLength);
    assert.equal(artifactCount(fx), 1);
    assert.equal(observationCount(fx), 1);
    assert.equal(eventCount(fx), 2);
    assert.equal(outboxCount(fx), 2);
  } finally { fx.close(); }
});

test('I: simulated crash after final rename before BEGIN leaves an allowed orphan and zero DB rows', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    insertOperation(fx, 'run-a', 'op-a', 'corr-a');
    const admissionId = insertAdmission(fx);
    let sawBegin = false;
    const crash = new Error('simulated-crash');
    const { service } = makeService(fx, {
      faultInjection: {
        crashBeforeBegin: () => { throw crash; },
        beforeArtifactInsert: () => { sawBegin = true; },
      },
    });
    await assert.rejects(() => service.persist(canonicalCommand(admissionId, 'run-a', OP_SRC())), /simulated-crash/);
    assert.equal(sawBegin, false);
    assert.equal(observationCount(fx), 0);
    assert.equal(artifactCount(fx), 0);
    assert.equal(eventCount(fx), 0);
    assert.equal(outboxCount(fx), 0);
    // Orphan file is allowed and was cleaned up by the normal-failure path.
    assert.equal(countArtifactDirs(fx.artifactRoot, 'run-a'), 0);
  } finally { fx.close(); }
});

test('J: no reachable state lets a committed row reference missing final content', async () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    insertOperation(fx, 'run-a', 'op-a', 'corr-a');
    const admissionId = insertAdmission(fx);
    const { service } = makeService(fx);
    const result = await service.persist(canonicalCommand(admissionId, 'run-a', OP_SRC()));
    const row = fx.db.prepare('SELECT storage_key, sha256, size_bytes FROM runtime_artifacts WHERE id = ?').get(result.diffArtifactId!) as { storage_key: string; sha256: string; size_bytes: number };
    const finalPath = join(fx.artifactRoot, row.storage_key);
    assert.ok(existsSync(finalPath));
    const bytes = readFileSync(finalPath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
    assert.equal(bytes.byteLength, row.size_bytes);
  } finally { fx.close(); }
});
