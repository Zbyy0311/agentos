import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  M2_ACCEPTANCE_INVENTORY,
  createM2AcceptanceInventory,
  type AcceptanceDomainId,
} from './M2AcceptanceInventory.js';
import {
  M2ReadOnlyParityService,
  type M2ParityInput,
  type M2ParityRecord,
} from './M2ReadOnlyParityService.js';

const TASK_DOMAIN: AcceptanceDomainId = 'task_domain_task_run';
const CONVERSATION_DOMAIN: AcceptanceDomainId = 'conversation_runtime';
const SOURCE_BYTES = new Uint8Array([0x7b, 0x22, 0x73, 0x72, 0x63, 0x22, 0x3a, 0x31, 0x7d]);

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function taskRecord(
  recordKey: string,
  fields: Record<string, unknown>,
  aggregate: M2ParityRecord['aggregate'] = 'task-domain',
): M2ParityRecord {
  return { recordKey, fields, aggregate };
}

function baseInput(overrides: Partial<M2ParityInput> = {}): M2ParityInput {
  const legacyRecord = taskRecord('task-1', {
    status: 'open',
    content: 'private task content',
    providerToken: 'private-provider-token',
    commandArgs: ['--secret', 'private-command-arg'],
  });
  const canonicalRecord = taskRecord('task-1', {
    commandArgs: ['--secret', 'private-command-arg'],
    providerToken: 'private-provider-token',
    content: 'private task content',
    status: 'open',
  });
  return {
    domainId: TASK_DOMAIN,
    aggregate: 'task-domain',
    source: {
      sourceKey: 'workspace/ws-1/tasks.json',
      sourceKind: 'tasks-json',
      scope: 'workspace:ws-1',
      sourceBytes: SOURCE_BYTES,
      canonicalDatabaseOpaqueId: 'db-fixture-1',
    },
    legacyRecords: [legacyRecord],
    canonicalRecords: [canonicalRecord],
    behavior: {
      legacyContractDigest: 'behavior-v1',
      canonicalContractDigest: 'behavior-v1',
    },
    ...overrides,
  };
}

test('Acceptance Inventory contains eight stable, ordered domains', () => {
  const inventory = createM2AcceptanceInventory();
  assert.deepEqual(
    inventory.domains.map(domain => domain.domainId),
    [
      'workspace_aggregate',
      'agent_profile',
      'provider_configuration',
      'legacy_task_item',
      'task_domain_task_run',
      'conversation_runtime',
      'legacy_migration_evidence',
      'operational_json_exclusions',
    ],
  );
  assert.equal(inventory.domains.length, 8);
  assert.deepEqual(inventory, M2_ACCEPTANCE_INVENTORY);
});

test('Acceptance Inventory is deeply immutable and has unique, non-conflicting authority declarations', () => {
  const inventory = createM2AcceptanceInventory();
  assert.equal(Object.isFrozen(inventory), true);
  assert.equal(Object.isFrozen(inventory.domains), true);
  const ids = inventory.domains.map(domain => domain.domainId);
  assert.equal(new Set(ids).size, ids.length);
  for (const domain of inventory.domains) {
    assert.equal(Object.isFrozen(domain), true);
    assert.equal(Object.isFrozen(domain.currentStorage), true);
    assert.equal(Object.isFrozen(domain.productionReaders), true);
    assert.equal(Object.isFrozen(domain.productionWriters), true);
    assert.ok(domain.authoritativeReadSource.length > 0);
    assert.ok(domain.authoritativeWriteSource.length > 0);
    assert.ok(domain.repositoryServiceRouteSymbols.length > 0);
    assert.ok(domain.p1ComparisonResponsibility.length > 0);
    assert.ok(domain.p2P3P4OwningGate.length > 0);
    assert.equal(
      domain.authoritativeWriteSource.some(source => domain.legacyFallbackSource.includes(source)),
      false,
      'authority overlap for ' + domain.domainId,
    );
  }
});

test('Inventory keeps Task-domain runs and Conversation agent_runs in separate aggregates', () => {
  const inventory = createM2AcceptanceInventory();
  const task = inventory.domains.find(domain => domain.domainId === TASK_DOMAIN);
  const conversation = inventory.domains.find(domain => domain.domainId === CONVERSATION_DOMAIN);
  assert.ok(task);
  assert.ok(conversation);
  assert.match(task.aggregateBoundary, /runs/);
  assert.doesNotMatch(task.aggregateBoundary, /run_steps|agent_events/);
  assert.match(conversation.aggregateBoundary, /agent_runs/);
  assert.doesNotMatch(conversation.aggregateBoundary, /Task-domain Run history/);
});

test('Inventory excludes worktree leases, memory Markdown, artifacts, and test fixtures from Legacy Product JSON retirement', () => {
  const inventory = createM2AcceptanceInventory();
  const exclusions = inventory.domains.find(domain => domain.domainId === 'operational_json_exclusions');
  assert.ok(exclusions);
  assert.match(exclusions.currentRetirementStatus, /excluded/i);
  assert.match(exclusions.currentStorage.join('|'), /leases\.json/);
  assert.match(exclusions.currentStorage.join('|'), /memory/);
  assert.match(exclusions.currentStorage.join('|'), /artifacts/);
  assert.doesNotMatch(exclusions.productionReaders.join('|'), /\.test\.ts/);
  assert.doesNotMatch(exclusions.productionWriters.join('|'), /fixture/i);
});

test('exact-byte SHA-256 is reported without exposing source bytes', () => {
  const result = new M2ReadOnlyParityService().compare(baseInput());
  assert.equal(result.source.sourceHash, sha256(SOURCE_BYTES));
  assert.equal(JSON.stringify(result).includes(Buffer.from(SOURCE_BYTES).toString('utf8')), false);
  assert.equal('sourceBytes' in result, false);
});

test('same logical input produces stable result and comparison hash', () => {
  const service = new M2ReadOnlyParityService();
  const first = service.compare(baseInput());
  const second = service.compare(baseInput());
  assert.deepEqual(second, first);
  assert.match(first.comparisonHash, /^[0-9a-f]{64}$/);
});

test('record and field input order does not change the result', () => {
  const first = baseInput({
    legacyRecords: [
      taskRecord('task-2', { status: 'done', priority: 2 }),
      taskRecord('task-1', { status: 'open', priority: 1 }),
    ],
    canonicalRecords: [
      taskRecord('task-2', { priority: 2, status: 'done' }),
      taskRecord('task-1', { priority: 1, status: 'open' }),
    ],
  });
  const second = baseInput({
    legacyRecords: [
      taskRecord('task-1', { priority: 1, status: 'open' }),
      taskRecord('task-2', { priority: 2, status: 'done' }),
    ],
    canonicalRecords: [
      taskRecord('task-1', { status: 'open', priority: 1 }),
      taskRecord('task-2', { status: 'done', priority: 2 }),
    ],
  });
  const service = new M2ReadOnlyParityService();
  assert.deepEqual(service.compare(second), service.compare(first));
});

test('equal classification requires fields and behavior to match', () => {
  const result = new M2ReadOnlyParityService().compare(baseInput());
  assert.equal(result.classification, 'equal');
  assert.equal(result.behavior.fieldConsistent, true);
  assert.equal(result.behavior.contractConsistent, true);
  assert.equal(result.counts.equal, 1);
});

test('missing_legacy and missing_canonical are distinct classifications', () => {
  const service = new M2ReadOnlyParityService();
  const missingLegacy = service.compare(baseInput({
    legacyRecords: [],
    canonicalRecords: [taskRecord('task-1', { status: 'open' })],
  }));
  const missingCanonical = service.compare(baseInput({
    legacyRecords: [taskRecord('task-1', { status: 'open' })],
    canonicalRecords: [],
  }));
  assert.equal(missingLegacy.classification, 'missing_legacy');
  assert.equal(missingCanonical.classification, 'missing_canonical');
});

test('mismatch includes only field names and value digests', () => {
  const result = new M2ReadOnlyParityService().compare(baseInput({
    canonicalRecords: [taskRecord('task-1', {
      status: 'in_progress',
      content: 'different private content',
      providerToken: 'different-private-token',
      commandArgs: ['--different-secret'],
    })],
  }));
  assert.equal(result.classification, 'mismatch');
  assert.equal(result.behavior.fieldConsistent, false);
  assert.ok(result.evidence.some(item => item.fieldName === 'status'));
  const serialized = JSON.stringify(result);
  for (const secret of ['private-provider-token', 'different-private-token', 'private task content', 'different private content', '--secret', '--different-secret']) {
    assert.equal(serialized.includes(secret), false, 'raw secret leaked: ' + secret);
  }
  for (const item of result.evidence) {
    assert.match(item.expectedValueDigest, /^[0-9a-f]{64}$/);
    assert.match(item.actualValueDigest, /^[0-9a-f]{64}$/);
  }
});

test('behavior mismatch is non-equal even when fields match', () => {
  const result = new M2ReadOnlyParityService().compare(baseInput({
    behavior: {
      legacyContractDigest: 'behavior-v1',
      canonicalContractDigest: 'behavior-v2',
    },
  }));
  assert.equal(result.classification, 'mismatch');
  assert.equal(result.behavior.fieldConsistent, true);
  assert.equal(result.behavior.contractConsistent, false);
  assert.ok(result.evidence.some(item => item.fieldName === 'behavior_contract'));
});

test('malformed, duplicate, tombstone, and conflict classifications are explicit', () => {
  const service = new M2ReadOnlyParityService();
  assert.equal(service.compare(baseInput({ sourceStatus: 'malformed' })).classification, 'malformed');
  assert.equal(service.compare(baseInput({ duplicateRecordKeys: ['task-1'] })).classification, 'duplicate');
  assert.equal(service.compare(baseInput({ tombstoneRecordKeys: ['task-1'] })).classification, 'tombstone');
  assert.equal(service.compare(baseInput({ conflictRecordKeys: ['task-1'] })).classification, 'conflict');
  for (const result of [
    service.compare(baseInput({ sourceStatus: 'malformed' })),
    service.compare(baseInput({ duplicateRecordKeys: ['task-1'] })),
    service.compare(baseInput({ tombstoneRecordKeys: ['task-1'] })),
    service.compare(baseInput({ conflictRecordKeys: ['task-1'] })),
  ]) {
    assert.equal(result.counts.equal ?? 0, 0);
  }
});

test('changed source hash invalidates the old result', () => {
  const input = baseInput();
  const result = new M2ReadOnlyParityService().compare({
    ...input,
    source: {
      ...input.source,
      previousSourceHash: 'old-source-hash',
    },
  });
  assert.equal(result.classification, 'changed_source');
  assert.equal(result.source.previousSourceHash, 'old-source-hash');
});

test('source identity redacts full local paths and database paths', () => {
  const input = baseInput();
  const result = new M2ReadOnlyParityService().compare({
    ...input,
    source: {
      ...input.source,
      sourceKey: 'C:\\Users\\Administrator\\workspace\\workspaces.json',
      scope: 'E:\\workspace\\Multi-Agent\\agentos',
      canonicalDatabaseOpaqueId: 'C:\\Users\\Administrator\\agentos.sqlite',
    },
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('C:\\Users\\Administrator'), false);
  assert.equal(serialized.includes('E:\\workspace\\Multi-Agent'), false);
  assert.match(result.source.sourceKey, /^[0-9a-f]{64}$/);
  assert.match(result.source.scope, /^[0-9a-f]{64}$/);
  assert.match(result.source.canonicalDatabaseOpaqueId, /^[0-9a-f]{64}$/);
});

test('Task content, Conversation content, provider credentials, and command args never appear in evidence', () => {
  const input = baseInput();
  const result = new M2ReadOnlyParityService().compare({
    ...input,
    canonicalRecords: [taskRecord('task-1', {
      message: 'private conversation message',
      providerCredential: 'credential-value',
      commandArgs: ['--api-key', 'api-key-value'],
      content: 'private task body',
    })],
  });
  const serialized = JSON.stringify(result);
  for (const secret of ['private conversation message', 'credential-value', '--api-key', 'api-key-value', 'private task body']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('comparison does not mutate input objects, arrays, field maps, or source bytes', () => {
  const input = baseInput();
  const beforeInput = structuredClone(input);
  const beforeBytes = Array.from(input.source.sourceBytes);
  new M2ReadOnlyParityService().compare(input);
  assert.deepEqual(input, beforeInput);
  assert.deepEqual(Array.from(input.source.sourceBytes), beforeBytes);
});

test('Comparator exposes no write/save/update/delete/apply interface', () => {
  const methodNames = Object.getOwnPropertyNames(M2ReadOnlyParityService.prototype);
  assert.deepEqual(methodNames, ['constructor', 'compare']);
  assert.equal(methodNames.some(name => /write|save|update|delete|apply/i.test(name)), false);
});

test('Task-domain comparison rejects Conversation aggregate records', () => {
  const result = new M2ReadOnlyParityService().compare({
    ...baseInput(),
    legacyRecords: [taskRecord('conversation-run-1', { event: 'agent' }, 'conversation')],
    canonicalRecords: [taskRecord('conversation-run-1', { event: 'agent' }, 'conversation')],
  });
  assert.equal(result.classification, 'conflict');
  assert.ok(result.evidence.some(item => item.redactedReason === 'aggregate_boundary_mismatch'));
  assert.equal(JSON.stringify(result).includes('agent'), false);
});

test('Conversation comparison rejects Task-domain runs', () => {
  const input = baseInput();
  const result = new M2ReadOnlyParityService().compare({
    ...input,
    domainId: CONVERSATION_DOMAIN,
    aggregate: 'conversation',
    legacyRecords: [taskRecord('task-run-1', { status: 'running' }, 'task-domain')],
    canonicalRecords: [taskRecord('task-run-1', { status: 'running' }, 'task-domain')],
  });
  assert.equal(result.classification, 'conflict');
  assert.ok(result.evidence.some(item => item.redactedReason === 'aggregate_boundary_mismatch'));
});

test('Comparator produces no file or database side effects', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m2-p1-parity-'));
  const sentinel = join(root, 'sentinel.txt');
  writeFileSync(sentinel, 'unchanged', 'utf8');
  const beforeFiles = readdirSync(root);
  const beforeBytes = readFileSync(sentinel);
  try {
    new M2ReadOnlyParityService().compare(baseInput());
    assert.deepEqual(readdirSync(root), beforeFiles);
    assert.deepEqual(readFileSync(sentinel), beforeBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
