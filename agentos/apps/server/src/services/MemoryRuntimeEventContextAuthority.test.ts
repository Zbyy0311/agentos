/**
 * Evidence tests for the production L1C causal-context authority
 * (`DurableMemoryRuntimeEventContextAuthority`).
 *
 * Contract under test: the caller's `context` is only a CLAIM. It is honored
 * exactly when a durable row proves it — the referenced row exists, it owns the
 * claimed correlation, and it IS the claimed cause — and the returned context is
 * re-derived from that row. A forged correlation, a redirected cause, an unknown
 * authority id, or an origin this repository cannot prove durably
 * (`canonical_command`) must all fail closed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimeEventContextAuthoritySourceV1 } from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import {
  DurableMemoryRuntimeEventContextAuthority,
  MemoryRuntimeEventContextAuthorityError,
} from './MemoryRuntimeEventContextAuthority.js';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};

const NOW = '2026-09-11T00:00:00.000Z';
const WS = 'ws_certauth';
const TASK = 'task_certauth';
const RUN = 'run_certauth';

// Two durable Operations of the same Run. The second one exists so a claim can
// point at a REAL persisted correlation that still belongs to another record.
const OP = 'op_' + 'a'.repeat(26);
const OP_CORRELATION = 'corr-certauth-op';
const OP2 = 'op_' + 'b'.repeat(26);
const OP2_CORRELATION = 'corr-certauth-op2';
// A durable Runtime Event of the same Run, deliberately with a DIFFERENT
// correlation and a causation that is not itself, so "reuse the Operation row"
// or "read causation_id instead of id" cannot satisfy its assertions.
const EVENT = 'evt_' + 'c'.repeat(26);
const EVENT_CORRELATION = 'corr-certauth-event';
const EVENT_CAUSATION = 'cause-certauth-event';
// Ids that exist nowhere in the fixture.
const ABSENT_OPERATION = 'op_' + 'd'.repeat(26);
const ABSENT_EVENT = 'evt_' + 'e'.repeat(26);
const COMMAND = 'cmd_' + 'f'.repeat(26);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-mem-ctx-authority-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_certauth', 'C:/tmp/ws_certauth', NOW, NOW, NOW);
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(TASK, WS, 'task', 'open', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(RUN, WS, TASK, RUN, 'queued', 'initial', 'test', NOW, NOW);
  const insertOperation = db.prepare(
    'INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, created_at, started_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  );
  insertOperation.run(OP, 'run.start', 'running', WS, 'run', RUN, RUN, OP_CORRELATION, NOW, NOW, NOW);
  insertOperation.run(OP2, 'run.start', 'running', WS, 'run', RUN, RUN, OP2_CORRELATION, NOW, NOW, NOW);
  return {
    db,
    authority: new DurableMemoryRuntimeEventContextAuthority(db as unknown as TransactionDatabase),
    close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

function insertRuntimeEvent(
  db: SqliteDb,
  input: { readonly id: string; readonly correlationId: string; readonly causationId?: string | null },
): void {
  db.prepare(`INSERT INTO runtime_events (
    id, schema_version, type, workspace_id, task_id, run_id, sequence, timestamp,
    source, correlation_id, causation_id, severity, visibility, durability,
    payload_json, created_at
  ) VALUES (?, 1, 'run.progress', ?, ?, ?, 1, ?, 'run-engine', ?, ?, 'info', 'public', 'durable', '{}', ?)`)
    .run(input.id, WS, TASK, RUN, NOW, input.correlationId, input.causationId ?? null, NOW);
}

function count(db: SqliteDb, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

// 1 — a proven Operation claim yields exactly the persisted causal context.
test('operation origin returns the persisted correlation_id and the operation id', () => {
  const fx = fixture();
  try {
    const context = fx.authority.authorize({
      origin: 'operation',
      operationId: OP,
      context: { correlationId: OP_CORRELATION, causationId: OP },
    });
    assert.deepEqual({ ...context }, {
      correlationId: OP_CORRELATION,
      causationId: OP,
      origin: 'operation',
      authorityId: OP,
    });
  } finally { fx.close(); }
});

// 2 — an authority row that does not exist cannot be proven.
test('an unknown operation id fails with ORIGIN_UNPROVEN', () => {
  const fx = fixture();
  try {
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM operations WHERE id = ?', ABSENT_OPERATION), 0);
    assert.throws(
      () => fx.authority.authorize({
        origin: 'operation',
        operationId: ABSENT_OPERATION,
        context: { correlationId: OP_CORRELATION, causationId: ABSENT_OPERATION },
      }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryRuntimeEventContextAuthorityError);
        assert.equal(error.code, 'ORIGIN_UNPROVEN');
        return true;
      },
    );
  } finally { fx.close(); }
});

// 3 — a fabricated correlation must be rejected even when it is a real value
// persisted on some OTHER record.
test('a claimed correlation that is not the persisted one fails with ORIGIN_UNPROVEN', () => {
  const fx = fixture();
  try {
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM operations WHERE correlation_id = ?', OP2_CORRELATION), 1);
    assert.throws(
      () => fx.authority.authorize({
        origin: 'operation',
        operationId: OP,
        context: { correlationId: OP2_CORRELATION, causationId: OP },
      }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryRuntimeEventContextAuthorityError);
        assert.equal(error.code, 'ORIGIN_UNPROVEN');
        return true;
      },
    );
    assert.throws(
      () => fx.authority.authorize({
        origin: 'operation',
        operationId: OP,
        context: { correlationId: 'corr-forged', causationId: OP },
      }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryRuntimeEventContextAuthorityError);
        assert.equal(error.code, 'ORIGIN_UNPROVEN');
        return true;
      },
    );
  } finally { fx.close(); }
});

// 4 — a redirected cause is rejected even when the claimed id is a real record.
test('a claimed causation that is not the operation record fails with ORIGIN_UNPROVEN', () => {
  const fx = fixture();
  try {
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM operations WHERE id = ?', OP2), 1);
    assert.throws(
      () => fx.authority.authorize({
        origin: 'operation',
        operationId: OP,
        context: { correlationId: OP_CORRELATION, causationId: OP2 },
      }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryRuntimeEventContextAuthorityError);
        assert.equal(error.code, 'ORIGIN_UNPROVEN');
        return true;
      },
    );
  } finally { fx.close(); }
});

// 5 — a proven persisted Event derives its own correlation and its own id.
test('persisted_event origin returns the persisted event correlation and its id', () => {
  const fx = fixture();
  try {
    insertRuntimeEvent(fx.db, { id: EVENT, correlationId: EVENT_CORRELATION, causationId: EVENT_CAUSATION });
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM runtime_events WHERE id = ?', EVENT), 1);
    const context = fx.authority.authorize({
      origin: 'persisted_event',
      eventId: EVENT,
      context: { correlationId: EVENT_CORRELATION, causationId: EVENT },
    });
    assert.deepEqual({ ...context }, {
      correlationId: EVENT_CORRELATION,
      causationId: EVENT,
      origin: 'persisted_event',
      authorityId: EVENT,
    });
  } finally { fx.close(); }
});

// 6 — an Event row that does not exist cannot be proven.
test('an unknown persisted event id fails with ORIGIN_UNPROVEN', () => {
  const fx = fixture();
  try {
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM runtime_events WHERE id = ?', ABSENT_EVENT), 0);
    assert.throws(
      () => fx.authority.authorize({
        origin: 'persisted_event',
        eventId: ABSENT_EVENT,
        context: { correlationId: EVENT_CORRELATION, causationId: ABSENT_EVENT },
      }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryRuntimeEventContextAuthorityError);
        assert.equal(error.code, 'ORIGIN_UNPROVEN');
        return true;
      },
    );
  } finally { fx.close(); }
});

// 7 — there is no durable canonical-command registry, so this origin can never
// be proven: failing closed is the only honest answer.
test('canonical_command always fails with ORIGIN_UNPROVEN', () => {
  const fx = fixture();
  try {
    // Even a claim that would be provable as an Operation origin is refused.
    assert.throws(
      () => fx.authority.authorize({
        origin: 'canonical_command',
        commandId: COMMAND,
        context: { correlationId: OP_CORRELATION, causationId: OP },
      }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryRuntimeEventContextAuthorityError);
        assert.equal(error.code, 'ORIGIN_UNPROVEN');
        return true;
      },
    );
    assert.throws(
      () => fx.authority.authorize({
        origin: 'canonical_command',
        commandId: COMMAND,
        context: { correlationId: 'corr-anything', causationId: COMMAND },
      }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryRuntimeEventContextAuthorityError);
        assert.equal(error.code, 'ORIGIN_UNPROVEN');
        return true;
      },
    );
  } finally { fx.close(); }
});

// 8 — an unusable claim is refused before any resolution is attempted.
test('a missing, non-object, or blank context fails with INPUT_INVALID', () => {
  const fx = fixture();
  try {
    const withContext = (context: unknown): RuntimeEventContextAuthoritySourceV1 =>
      ({ origin: 'operation', operationId: OP, context } as unknown as RuntimeEventContextAuthoritySourceV1);
    const cases: ReadonlyArray<readonly [string, RuntimeEventContextAuthoritySourceV1]> = [
      ['missing context field', { origin: 'operation', operationId: OP } as unknown as RuntimeEventContextAuthoritySourceV1],
      ['empty-string context', withContext('')],
      ['empty context object', withContext({})],
      ['empty correlationId', withContext({ correlationId: '', causationId: OP })],
      ['blank causationId', withContext({ correlationId: OP_CORRELATION, causationId: '   ' })],
      ['null source', null as unknown as RuntimeEventContextAuthoritySourceV1],
    ];
    for (const [label, source] of cases) {
      assert.throws(
        () => fx.authority.authorize(source),
        (error: unknown) => {
          assert.ok(error instanceof MemoryRuntimeEventContextAuthorityError, label);
          assert.equal(error.code, 'INPUT_INVALID', label);
          return true;
        },
        label,
      );
    }
  } finally { fx.close(); }
});

// 9 — a blank authority id is invalid input, not an unprovable origin.
test('blank origin identifiers fail with INPUT_INVALID', () => {
  const fx = fixture();
  try {
    const operationId = '';
    const eventId = '   ';
    assert.throws(
      () => fx.authority.authorize({ origin: 'operation', operationId, context: { correlationId: OP_CORRELATION, causationId: OP } }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryRuntimeEventContextAuthorityError);
        assert.equal(error.code, 'INPUT_INVALID');
        return true;
      },
    );
    assert.throws(
      () => fx.authority.authorize({ origin: 'persisted_event', eventId, context: { correlationId: EVENT_CORRELATION, causationId: EVENT } }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryRuntimeEventContextAuthorityError);
        assert.equal(error.code, 'INPUT_INVALID');
        return true;
      },
    );
  } finally { fx.close(); }
});
