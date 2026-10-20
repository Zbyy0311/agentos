import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from './Transaction.js';
import { AuditRecordRepository } from './AuditRecordRepository.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => TransactionDatabase & { close(): void };
};

const T0 = '2026-10-20T00:00:00.000Z';
const T1 = '2026-10-20T00:01:00.000Z';
const T2 = '2026-10-20T00:02:00.000Z';

function fixture(): { db: TransactionDatabase & { close(): void }; repo: AuditRecordRepository; close: () => void } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  return { db, repo: new AuditRecordRepository(db), close: () => db.close() };
}

test('append persists an audit record and findById round-trips it', () => {
  const { repo, close } = fixture();
  try {
    const record = repo.append({
      id: 'audit_1', workspaceId: 'ws_1', actorType: 'user', actorId: 'user-a',
      actionType: 'approval.resolve', resourceType: 'approval_request', resourceId: 'approval_9',
      result: 'allow_once', summary: 'resolved', detail: { extra: true }, createdAt: T0,
    });
    assert.equal(record.detail?.extra, true);
    const read = repo.findById('audit_1')!;
    assert.equal(read.actorType, 'user');
    assert.equal(read.resourceId, 'approval_9');
    assert.equal(read.workspaceId, 'ws_1');
  } finally {
    close();
  }
});

test('query filters by workspace, resource, action and order', () => {
  const { repo, close } = fixture();
  try {
    repo.append({ id: 'audit_a', workspaceId: 'ws_1', actorType: 'system', actorId: 'policy-engine', actionType: 'policy.evaluate', resourceType: 'policy_decision', resourceId: 'pdec_1', result: 'deny', summary: 's', createdAt: T0 });
    repo.append({ id: 'audit_b', workspaceId: 'ws_1', actorType: 'user', actorId: 'user-a', actionType: 'approval.resolve', resourceType: 'approval_request', resourceId: 'approval_9', result: 'allow_once', summary: 's', createdAt: T1 });
    repo.append({ id: 'audit_c', workspaceId: 'ws_2', actorType: 'user', actorId: 'user-a', actionType: 'approval.resolve', resourceType: 'approval_request', resourceId: 'approval_10', result: 'deny', summary: 's', createdAt: T2 });

    assert.deepEqual(repo.query({ workspaceId: 'ws_1' }).map(r => r.id), ['audit_a', 'audit_b']);
    assert.deepEqual(repo.query({ workspaceId: 'ws_1', order: 'desc' }).map(r => r.id), ['audit_b', 'audit_a']);
    assert.deepEqual(repo.query({ resourceType: 'approval_request', resourceId: 'approval_9' }).map(r => r.id), ['audit_b']);
    assert.deepEqual(repo.query({ actionType: 'policy.evaluate' }).map(r => r.id), ['audit_a']);
    assert.deepEqual(repo.query({ actorId: 'user-a', limit: 1 }).map(r => r.id), ['audit_b']);
    assert.equal(repo.query({}).length, 3);
  } finally {
    close();
  }
});

test('append-only is enforced by the database triggers and the API surface', () => {
  const { repo, db, close } = fixture();
  try {
    repo.append({ id: 'audit_x', actorType: 'system', actorId: 's', actionType: 'a', resourceType: 'r', result: 'ok', summary: 's', createdAt: T0 });
    assert.throws(() => db.prepare(`UPDATE audit_records SET summary = 'changed' WHERE id = 'audit_x'`).run(), /AUDIT_RECORD_IMMUTABLE/);
    assert.throws(() => db.prepare(`DELETE FROM audit_records WHERE id = 'audit_x'`).run(), /AUDIT_RECORD_IMMUTABLE/);
    // The repository exposes no mutation methods.
    const api = Object.getOwnPropertyNames(AuditRecordRepository.prototype);
    for (const method of api) {
      assert.ok(!/update|delete|remove|mutate/i.test(method), `no mutation method named ${method}`);
    }
  } finally {
    close();
  }
});

test('validation rejects blank fields and unknown actor types', () => {
  const { repo, close } = fixture();
  try {
    assert.throws(() => repo.append({ id: 'a', actorType: 'system' as never, actorId: '', actionType: 'x', resourceType: 'y', result: 'ok', summary: 's', createdAt: T0 }), /INPUT_INVALID/);
    assert.throws(() => repo.append({ id: 'a', actorType: 'bot' as never, actorId: 'b', actionType: 'x', resourceType: 'y', result: 'ok', summary: 's', createdAt: T0 }), /INPUT_INVALID/);
  } finally {
    close();
  }
});
