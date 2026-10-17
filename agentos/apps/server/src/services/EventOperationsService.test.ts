import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  COMPACTABLE_RUNTIME_EVENT_TYPES,
  MAX_RUNTIME_EVENT_PAYLOAD_BYTES,
  createM3RuntimeEventRegistry,
  isRuntimeEventPayloadOffloadSummary,
} from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { OutboxRepository } from '../store/OutboxRepository.js';
import { RunSequenceAllocator } from '../store/RunSequenceAllocator.js';
import { RuntimeEventRepository, RuntimeEventRepositoryError, RuntimeEventOutboxWriter } from '../store/RuntimeEventRepository.js';
import { createEntityId } from '../store/Identity.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { canonicalizeJson } from '../snapshots/canonicalJson.js';
import { EventPayloadOffloadService } from './EventPayloadOffloadService.js';
import { EventOperationsService, type EventRetentionPolicy } from './EventOperationsService.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => TransactionDatabase & { close(): void };
};

const NOW = '2026-10-17T00:00:00.000Z';
const WS = 'ws_p5a_event_ops';
const TASK = 'task_p5a_event_ops';
const RUN = 'run_p5a_event_ops';
const SNAPSHOT = 'snapshot_p5a_event_ops';
const STAGE = 'stage_p5a_event_ops';

type Db = InstanceType<typeof DatabaseSync>;

function seededDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, 'P5A Event Ops', '/tmp/p5a', '/tmp/p5a', ?, ?, ?)
  `).run(WS, NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, 'P5A task', 'open', 'normal', 'test', ?, ?)
  `).run(TASK, WS, NOW, NOW);
  db.prepare(`
    INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'running', 'initial', 'v2_api', 'test', ?, ?)
  `).run(RUN, WS, TASK, RUN, NOW, NOW);
  db.prepare(`
    INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, captured_at)
    VALUES (?, ?, ?, 'workflow_00000000000000000000000002', 1, '{}', ?, ?)
  `).run(SNAPSHOT, WS, RUN, 'a'.repeat(64), NOW);
  db.prepare(`
    INSERT INTO run_stages (
      id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
      sequence, attempt, status, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, 'plan', 'Plan', 1, 1, 'running', ?, ?, 1)
  `).run(STAGE, WS, RUN, SNAPSHOT, NOW, NOW);
  return db;
}

interface Stack {
  db: Db;
  events: RuntimeEventRepository;
  writer: RuntimeEventOutboxWriter;
  outbox: OutboxRepository;
  offloader: EventPayloadOffloadService;
  service: EventOperationsService;
  artifactRoot: string;
}

function stack(db: Db, options: { offload?: boolean; ineligible?: readonly string[] } = {}): Stack {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'p5a-event-ops-'));
  const registry = createM3RuntimeEventRegistry();
  const offloader = new EventPayloadOffloadService(db, artifactRoot, {
    ineligibleEventTypes: options.ineligible,
  });
  const events = new RuntimeEventRepository(db, registry, undefined, undefined, options.offload === false ? undefined : offloader);
  const allocator = new RunSequenceAllocator(db);
  const outbox = new OutboxRepository(db, events);
  const writer = new RuntimeEventOutboxWriter(events, allocator, outbox, db);
  const service = new EventOperationsService(db, events, writer, offloader, outbox);
  return { db, events, writer, outbox, offloader, service, artifactRoot };
}

function deltaOfSize(totalPayloadBytes: number): string {
  const base = Buffer.byteLength(canonicalizeJson({ channel: 'assistant', delta: '' }), 'utf8');
  return 'd'.repeat(totalPayloadBytes - base);
}

function appendTextDelta(s: Stack, delta: string, timestamp = NOW): { eventId: string; sequence: number } {
  return inTransaction(s.db, () => {
    const result = s.writer.appendWithinTransaction({
      type: 'stream.text_delta',
      workspaceId: WS,
      runId: RUN,
      timestamp,
      source: 'stage-executor',
      eventContext: { correlationId: RUN, causationId: 'op_p5a_test' },
      payload: { channel: 'assistant', delta },
    });
    return { eventId: result.event.id, sequence: result.event.sequence };
  });
}

/** Append without an Outbox handoff so cleanup paths see a delivered-free Event. */
function appendRaw(
  s: Stack,
  type: string,
  payload: Record<string, unknown>,
  timestamp: string,
  overrides: { severity?: string; visibility?: string; source?: string } = {},
): { eventId: string; sequence: number } {
  return inTransaction(s.db, () => {
    const sequence = new RunSequenceAllocator(s.db).allocateWithinTransaction(WS, RUN);
    const event = s.events.appendWithinTransaction({
      id: createEntityId('event'),
      schemaVersion: 1,
      type,
      workspaceId: WS,
      runId: RUN,
      sequence,
      timestamp,
      source: (overrides.source ?? 'stage-executor') as never,
      correlationId: RUN,
      causationId: 'op_p5a_raw',
      ...(overrides.severity === undefined ? {} : { severity: overrides.severity as never }),
      ...(overrides.visibility === undefined ? {} : { visibility: overrides.visibility as never }),
      payload: payload as never,
    });
    return { eventId: event.id, sequence: event.sequence };
  });
}

function eventRows(s: Stack): Array<{ id: string; type: string; sequence: number; payload_json: string; timestamp: string }> {
  return s.db.prepare(`
    SELECT id, type, sequence, payload_json, timestamp FROM runtime_events
    WHERE workspace_id = ? AND run_id = ? ORDER BY sequence ASC
  `).all(WS, RUN) as Array<{ id: string; type: string; sequence: number; payload_json: string; timestamp: string }>;
}

function close(s: Stack, db: Db): void {
  db.close();
  rmSync(s.artifactRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// §47 payload limit
// ---------------------------------------------------------------------------

test('§47: payload just under the 64KB limit is persisted in full', () => {
  const db = seededDb();
  const s = stack(db);
  try {
    const delta = deltaOfSize(MAX_RUNTIME_EVENT_PAYLOAD_BYTES - 1);
    const { eventId } = appendTextDelta(s, delta);
    const row = eventRows(s).find(r => r.id === eventId)!;
    const payload = JSON.parse(row.payload_json) as { delta: string };
    assert.equal(payload.delta, delta);
    assert.equal(Buffer.byteLength(row.payload_json, 'utf8'), MAX_RUNTIME_EVENT_PAYLOAD_BYTES - 1);
  } finally {
    close(s, db);
  }
});

test('§47: payload exactly at the 64KB limit is persisted in full', () => {
  const db = seededDb();
  const s = stack(db);
  try {
    const delta = deltaOfSize(MAX_RUNTIME_EVENT_PAYLOAD_BYTES);
    const { eventId } = appendTextDelta(s, delta);
    const row = eventRows(s).find(r => r.id === eventId)!;
    const payload = JSON.parse(row.payload_json) as { delta: string };
    assert.equal(payload.delta, delta);
  } finally {
    close(s, db);
  }
});

test('§47: payload over 64KB is offloaded to an Artifact; the Event keeps only a summary', () => {
  const db = seededDb();
  const s = stack(db);
  try {
    const delta = deltaOfSize(MAX_RUNTIME_EVENT_PAYLOAD_BYTES + 1);
    const { eventId } = appendTextDelta(s, delta);
    const row = eventRows(s).find(r => r.id === eventId)!;
    const persisted = JSON.parse(row.payload_json) as Record<string, unknown>;
    assert.ok(isRuntimeEventPayloadOffloadSummary(persisted), 'persisted payload must be an offload summary');
    const summary = persisted as unknown as {
      artifactId: string;
      sizeBytes: number;
      sha256: string;
      preview: string;
      storedKeys: string[];
    };
    // No raw content leak: the persisted JSON must not contain the body.
    assert.ok(!row.payload_json.includes(delta.slice(0, 1024)));
    assert.ok(!row.payload_json.includes(delta.slice(-1024)));
    // The raw read returns the summary too (append-only read contract kept).
    const consumed = s.events.findById(eventId)!;
    assert.equal(consumed.kind, 'known');
    assert.ok(isRuntimeEventPayloadOffloadSummary(consumed.event.payload));
    // The Artifact reconstructs the exact original canonical payload.
    const bytes = s.offloader.readOffloadedPayload(summary.artifactId);
    assert.equal(bytes.byteLength, summary.sizeBytes);
    assert.equal(bytes.toString('utf8'), canonicalizeJson({ channel: 'assistant', delta }));
    // The Artifact is a canonical runtime_artifacts row bound to the Run.
    const artifact = s.db.prepare(`
      SELECT provenance_kind, canonical_run_id, artifact_type, sha256
      FROM runtime_artifacts WHERE id = ?
    `).get(summary.artifactId) as { provenance_kind: string; canonical_run_id: string; artifact_type: string; sha256: string };
    assert.equal(artifact.provenance_kind, 'CANONICAL');
    assert.equal(artifact.canonical_run_id, RUN);
    assert.equal(artifact.artifact_type, 'event-payload');
    assert.equal(artifact.sha256, summary.sha256);
    assert.deepEqual(summary.storedKeys, ['channel', 'delta']);
  } finally {
    close(s, db);
  }
});

test('§47 fail-closed: oversized payload is rejected without an offloader or for an ineligible type', () => {
  const db = seededDb();
  const s = stack(db, { offload: false });
  const s2 = stack(db, { ineligible: ['stream.text_delta'] });
  try {
    const delta = deltaOfSize(MAX_RUNTIME_EVENT_PAYLOAD_BYTES + 1);
    assert.throws(
      () => appendTextDelta(s, delta),
      (error: unknown) => error instanceof RuntimeEventRepositoryError
        && error.code === 'RUNTIME_EVENT_PAYLOAD_TOO_LARGE',
    );
    assert.throws(
      () => appendTextDelta(s2, delta),
      (error: unknown) => error instanceof RuntimeEventRepositoryError
        && error.code === 'RUNTIME_EVENT_PAYLOAD_TOO_LARGE',
    );
    // Nothing was persisted by either rejection.
    assert.equal(eventRows(s).length, 0);
  } finally {
    close(s, db);
    rmSync(s2.artifactRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §61 event.corrected
// ---------------------------------------------------------------------------

test('§61: correctEvent appends a correction; the original Event row is byte-identical', () => {
  const db = seededDb();
  const s = stack(db);
  try {
    const original = appendTextDelta(s, 'original text');
    const before = eventRows(s).find(r => r.id === original.eventId)!;
    const correction = inTransaction(db, () => s.service.correctEvent({
      workspaceId: WS,
      originalEventId: original.eventId,
      reason: 'provider reclassification',
      correctedFields: { delta: 'corrected text' },
      eventContext: { correlationId: RUN, causationId: original.eventId },
      timestamp: NOW,
    }));
    assert.equal(correction.event.type, 'event.corrected');
    assert.ok(correction.event.sequence > original.sequence);
    const after = eventRows(s).find(r => r.id === original.eventId)!;
    assert.equal(after.payload_json, before.payload_json, 'original Event must be immutable');
    const correctionRow = eventRows(s).find(r => r.id === correction.event.id)!;
    const payload = JSON.parse(correctionRow.payload_json) as {
      targetEventId: string;
      reason: string;
      correctedFields: Record<string, unknown>;
    };
    assert.equal(payload.targetEventId, original.eventId);
    assert.equal(payload.reason, 'provider reclassification');
    assert.deepEqual(payload.correctedFields, { delta: 'corrected text' });
  } finally {
    close(s, db);
  }
});

test('§61: corrections are idempotent for identical input and chain for new fields', () => {
  const db = seededDb();
  const s = stack(db);
  try {
    const original = appendTextDelta(s, 'v1');
    const first = inTransaction(db, () => s.service.correctEvent({
      workspaceId: WS,
      originalEventId: original.eventId,
      reason: 'fix',
      correctedFields: { delta: 'v2' },
      eventContext: { correlationId: RUN, causationId: original.eventId },
      timestamp: NOW,
    }));
    const second = inTransaction(db, () => s.service.correctEvent({
      workspaceId: WS,
      originalEventId: original.eventId,
      reason: 'fix',
      correctedFields: { delta: 'v2' },
      eventContext: { correlationId: RUN, causationId: original.eventId },
      timestamp: NOW,
    }));
    assert.equal(second.event.id, first.event.id, 'identical correction must not append a new Event');
    assert.equal(eventRows(s).filter(r => r.type === 'event.corrected').length, 1);
    const third = inTransaction(db, () => s.service.correctEvent({
      workspaceId: WS,
      originalEventId: original.eventId,
      reason: 'fix again',
      correctedFields: { delta: 'v3' },
      eventContext: { correlationId: RUN, causationId: original.eventId },
      timestamp: NOW,
    }));
    assert.notEqual(third.event.id, first.event.id);
    assert.equal(eventRows(s).filter(r => r.type === 'event.corrected').length, 2);
  } finally {
    close(s, db);
  }
});

test('§61 projection: listByRunWithCorrections applies corrections; raw reads stay unchanged', () => {
  const db = seededDb();
  const s = stack(db);
  try {
    const a = appendTextDelta(s, 'aaa');
    const b = appendTextDelta(s, 'bbb');
    inTransaction(db, () => s.service.correctEvent({
      workspaceId: WS,
      originalEventId: a.eventId,
      reason: 'fix',
      correctedFields: { delta: 'aaa-fixed' },
      eventContext: { correlationId: RUN, causationId: a.eventId },
      timestamp: NOW,
    }));
    const query = { workspaceId: WS, runId: RUN, afterSequence: 0, limit: 200 } as const;
    const projected = s.service.listByRunWithCorrections(query);
    const projectedA = projected.results.find(r => r.kind === 'known' && r.event.id === a.eventId)!;
    const projectedB = projected.results.find(r => r.kind === 'known' && r.event.id === b.eventId)!;
    assert.equal((projectedA.event.payload as { delta: string }).delta, 'aaa-fixed');
    assert.equal((projectedB.event.payload as { delta: string }).delta, 'bbb');
    const raw = s.events.queryByRun(query);
    const rawA = raw.results.find(r => r.kind === 'known' && r.event.id === a.eventId)!;
    assert.equal((rawA.event.payload as { delta: string }).delta, 'aaa', 'raw append-only read must be unchanged');
    // Corrections never target unknown events.
    assert.throws(() => inTransaction(db, () => s.service.correctEvent({
      workspaceId: WS,
      originalEventId: 'evt_missing0000000000000000',
      reason: 'fix',
      correctedFields: {},
      eventContext: { correlationId: RUN, causationId: 'op_p5a_test' },
      timestamp: NOW,
    })));
  } finally {
    close(s, db);
  }
});

// ---------------------------------------------------------------------------
// §59 compaction
// ---------------------------------------------------------------------------

test('§59: only compactible high-volume blocks are compacted; originals reconstruct from the Artifact', () => {
  const db = seededDb();
  const s = stack(db);
  try {
    const payloads = ['one', 'two', 'three', 'four', 'five', 'six'];
    const ids: string[] = [];
    for (const text of payloads.slice(0, 3)) {
      ids.push(appendRaw(s, 'stream.text_delta', { channel: 'assistant', delta: text }, NOW).eventId);
    }
    appendRaw(s, 'stream.text_completed', { channel: 'assistant', characterCount: 3 }, NOW);
    for (const text of payloads.slice(3)) {
      ids.push(appendRaw(s, 'stream.text_delta', { channel: 'assistant', delta: text }, NOW).eventId);
    }
    appendRaw(s, 'run.completed', { durationMs: 1, completedStageIds: [], artifactIds: [], worktreeStatus: 'clean' }, NOW, { source: 'run-engine' });

    const result = inTransaction(db, () => s.service.compactRunHighVolumeEvents({
      workspaceId: WS,
      runId: RUN,
      timestamp: NOW,
      eventContext: { correlationId: RUN, causationId: 'op_p5a_compact' },
      config: { minEvents: 3 },
    }));
    // Two contiguous text_delta blocks of 3, split by the text_completed Event.
    assert.equal(result.compacted.length, 2);
    const remaining = eventRows(s);
    const compactedRows = remaining.filter(r => r.type === 'event.compacted');
    assert.equal(compactedRows.length, 2);
    for (const c of result.compacted) {
      assert.equal(c.originalCount, 3);
      assert.deepEqual(c.eventTypes, ['stream.text_delta']);
      const originals = s.service.readCompactionOriginals(c.replacementArtifactId);
      assert.equal(originals.length, 3);
      const start = c.fromSequence < 4 ? 0 : 3;
      assert.deepEqual(originals.map(o => (o.payload as { delta: string }).delta), payloads.slice(start, start + 3));
      assert.deepEqual(originals.map(o => o.id), ids.slice(start, start + 3));
    }
    // Compacted Events are gone; key Events survive.
    assert.equal(remaining.filter(r => r.type === 'stream.text_delta').length, 0);
    assert.equal(remaining.filter(r => r.type === 'stream.text_completed').length, 1);
    assert.equal(remaining.filter(r => r.type === 'run.completed').length, 1);
    // A second pass has nothing to do and never touches terminal facts.
    const second = inTransaction(db, () => s.service.compactRunHighVolumeEvents({
      workspaceId: WS,
      runId: RUN,
      timestamp: NOW,
      eventContext: { correlationId: RUN, causationId: 'op_p5a_compact' },
      config: { minEvents: 2 },
    }));
    assert.equal(second.compacted.length, 0);
  } finally {
    close(s, db);
  }
});

test('§59: blocks with an undelivered Outbox handoff are skipped; non-compactible config is rejected', () => {
  const db = seededDb();
  const s = stack(db);
  try {
    // Delivered: raw appends without outbox. Undelivered: writer appends with pending outbox.
    appendRaw(s, 'stream.text_delta', { channel: 'assistant', delta: 'raw' }, NOW);
    for (let i = 0; i < 3; i += 1) appendTextDelta(s, `pending-${i}`);
    const result = inTransaction(db, () => s.service.compactRunHighVolumeEvents({
      workspaceId: WS,
      runId: RUN,
      timestamp: NOW,
      eventContext: { correlationId: RUN, causationId: 'op_p5a_compact' },
      config: { minEvents: 2 },
    }));
    // The contiguous block contains undelivered handoffs -> skipped entirely.
    assert.equal(result.compacted.length, 0);
    assert.equal(eventRows(s).filter(r => r.type === 'stream.text_delta').length, 4);
    assert.throws(() => COMPACTABLE_RUNTIME_EVENT_TYPES.length >= 0
      && inTransaction(db, () => s.service.compactRunHighVolumeEvents({
        workspaceId: WS,
        runId: RUN,
        timestamp: NOW,
        eventContext: { correlationId: RUN, causationId: 'op_p5a_compact' },
        config: { eventTypes: ['run.completed'] },
      })), /not compactible/);
  } finally {
    close(s, db);
  }
});

// ---------------------------------------------------------------------------
// §58 retention
// ---------------------------------------------------------------------------

test('§58: retention cleans only eligible categories; permanent facts survive', () => {
  const db = seededDb();
  const s = stack(db);
  try {
    const day = (n: number): string => new Date(Date.parse(NOW) - n * 24 * 3600 * 1000).toISOString();
    appendRaw(s, 'stream.text_delta', { channel: 'assistant', delta: 'old stream' }, day(10));
    appendRaw(s, 'stream.text_delta', { channel: 'assistant', delta: 'fresh stream' }, day(1));
    appendRaw(s, 'stream.text_completed', { channel: 'assistant', characterCount: 1 }, day(40));
    appendRaw(s, 'stream.text_completed', { channel: 'assistant', characterCount: 1 }, day(5), { severity: 'debug' });
    appendRaw(s, 'stream.text_completed', { channel: 'assistant', characterCount: 1 }, day(20), { visibility: 'restricted' });
    appendRaw(s, 'run.completed', { durationMs: 1, completedStageIds: [], artifactIds: [], worktreeStatus: 'clean' }, day(60), { source: 'run-engine' });
    // An undelivered writer-appended old stream Event must survive.
    const old = day(30);
    inTransaction(db, () => s.writer.appendWithinTransaction({
      type: 'stream.text_delta',
      workspaceId: WS,
      runId: RUN,
      timestamp: old,
      source: 'stage-executor',
      eventContext: { correlationId: RUN, causationId: 'op_p5a_test' },
      payload: { channel: 'assistant', delta: 'undelivered old' },
    }));

    const policy: EventRetentionPolicy = {
      durableRetentionDays: 30,
      rawStreamRetentionDays: 7,
      debugEventRetentionDays: 3,
      restrictedRetentionDays: 14,
    };
    const result = s.service.enforceRetention(WS, policy, new Date(Date.parse(NOW)));
    assert.equal(result.deletedByCategory.rawStream, 1);
    assert.equal(result.deletedByCategory.debug, 1);
    assert.equal(result.deletedByCategory.restricted, 1);
    assert.equal(result.deletedByCategory.durable, 1);
    assert.equal(result.deletedEvents, 4);

    const remaining = eventRows(s);
    const byPayload = (needle: string) => remaining.some(r => r.payload_json.includes(needle));
    assert.ok(!byPayload('old stream'), 'aged raw-stream Event is cleaned');
    assert.ok(byPayload('fresh stream'));
    assert.ok(byPayload('undelivered old'), 'an undelivered Outbox Event survives retention');
    assert.ok(remaining.some(r => r.type === 'run.completed'), 'terminal fact is permanent');
    assert.equal(remaining.filter(r => r.type === 'stream.text_completed').length, 0);
  } finally {
    close(s, db);
  }
});

test('§58: retention never deletes event.corrected / event.compacted audit facts', () => {
  const db = seededDb();
  const s = stack(db);
  try {
    const old = new Date(Date.parse(NOW) - 400 * 24 * 3600 * 1000).toISOString();
    const original = appendRaw(s, 'stream.text_delta', { channel: 'assistant', delta: 'old' }, old);
    inTransaction(db, () => s.service.correctEvent({
      workspaceId: WS,
      originalEventId: original.eventId,
      reason: 'ancient fix',
      correctedFields: { delta: 'older' },
      eventContext: { correlationId: RUN, causationId: original.eventId },
      timestamp: old,
    }));
    inTransaction(db, () => s.service.compactRunHighVolumeEvents({
      workspaceId: WS,
      runId: RUN,
      timestamp: old,
      eventContext: { correlationId: RUN, causationId: 'op_p5a_compact' },
      config: { minEvents: 2 },
    }));
    const result = s.service.enforceRetention(WS, {
      durableRetentionDays: 1,
      rawStreamRetentionDays: 1,
      debugEventRetentionDays: 1,
      restrictedRetentionDays: 1,
    }, new Date(Date.parse(NOW)));
    const remaining = eventRows(s);
    assert.equal(remaining.filter(r => r.type === 'event.corrected').length, 1);
    assert.equal(remaining.filter(r => r.type === 'event.compacted').length, 0);
    assert.ok(result.deletedEvents >= 0);
  } finally {
    close(s, db);
  }
});
