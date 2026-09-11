import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKSPACE_EVENT_FORBIDDEN_ENVELOPE_KEYS,
  WORKSPACE_EVENT_STREAM_TYPES,
  createM3RuntimeEventRegistry,
  isWorkspaceEventStreamType,
} from './src/index.ts';

const TIMESTAMP = '2026-09-11T00:00:00.000Z';
const ENTRY_PAYLOAD = {
  memoryEntryId: 'mem_1',
  version: 3,
  scope: 'task',
  category: 'decision',
  authority: 'system-verified',
};
const CANDIDATE_REVIEW_PAYLOAD = {
  candidateId: 'mcand_1',
  candidateVersion: 2,
  outcome: 'accept',
  memoryEntryId: 'mem_1',
};
const CONFLICT_PAYLOAD = {
  conflictId: 'conf_1',
  conflictType: 'contradiction',
  entryAId: 'mem_1',
  entryBId: 'mem_2',
};
const CONFLICT_RESOLUTION_PAYLOAD = {
  ...CONFLICT_PAYLOAD,
  disposition: 'supersede-earlier',
};

const WORKSPACE_DRAFT = {
  id: 'evt_01J0000000000000000000000A',
  schemaVersion: 1,
  type: 'memory.entry_created',
  workspaceId: 'ws_1',
  sequence: 1,
  timestamp: TIMESTAMP,
  source: 'memory-engine',
  correlationId: 'memory-candidate:mcand_1:v2',
  causationId: 'mcand_1',
  payload: ENTRY_PAYLOAD,
};

function workspaceDraft(overrides = {}) {
  return { ...WORKSPACE_DRAFT, ...overrides };
}

function registryError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the Registry to throw');
}

test('MF5W-01 the frozen allowlist is exactly the eight Workspace Memory facts', () => {
  assert.deepEqual(WORKSPACE_EVENT_STREAM_TYPES, [
    'memory.candidate_reviewed',
    'memory.conflict_opened',
    'memory.conflict_resolved',
    'memory.entry_created',
    'memory.entry_updated',
    'memory.entry_rejected',
    'memory.entry_superseded',
    'memory.entry_deduplicated',
  ]);
  assert.equal(isWorkspaceEventStreamType('memory.entry_created'), true);
  assert.equal(isWorkspaceEventStreamType('memory.entry_conflicted'), false);
  assert.equal(isWorkspaceEventStreamType('run.started'), false);
});

test('MF5W-02 every allowlisted type publishes on the Workspace stream with canonical defaults', () => {
  const registry = createM3RuntimeEventRegistry();
  const payloads = {
    'memory.candidate_reviewed': CANDIDATE_REVIEW_PAYLOAD,
    'memory.conflict_opened': CONFLICT_PAYLOAD,
    'memory.conflict_resolved': CONFLICT_RESOLUTION_PAYLOAD,
    'memory.entry_created': ENTRY_PAYLOAD,
    'memory.entry_updated': ENTRY_PAYLOAD,
    'memory.entry_rejected': ENTRY_PAYLOAD,
    'memory.entry_superseded': ENTRY_PAYLOAD,
    'memory.entry_deduplicated': ENTRY_PAYLOAD,
  };
  for (const type of WORKSPACE_EVENT_STREAM_TYPES) {
    const event = registry.publishWorkspace(workspaceDraft({ type, payload: payloads[type] }));
    assert.equal(event.type, type);
    assert.equal(event.workspaceId, 'ws_1');
    assert.equal(event.source, 'memory-engine');
    assert.equal(event.severity, 'info');
    assert.equal(event.visibility, 'internal');
    assert.equal(event.durability, 'durable');
    assert.equal(event.causationId, 'mcand_1');
    assert.equal(event.schemaVersion, 1);
    assert.equal(Object.isFrozen(event), true);
    assert.equal(Object.isFrozen(event.payload), true);
    assert.equal('runId' in event, false);
  }
});

test('MF5W-03 a registered type outside the allowlist is refused', () => {
  const registry = createM3RuntimeEventRegistry();
  const created = registryError(() => registry.publishWorkspace(workspaceDraft({
    type: 'memory.candidate_created',
    payload: { candidateId: 'mcand_1', scope: 'task', category: 'decision', authority: 'system-verified', decision: 'auto-accept' },
  })));
  assert.equal(created.code, 'WORKSPACE_EVENT_TYPE_NOT_ALLOWED');
  const runType = registryError(() => registry.publishWorkspace(workspaceDraft({ type: 'run.started', payload: {} })));
  assert.equal(runType.code, 'WORKSPACE_EVENT_TYPE_NOT_ALLOWED');
});

test('MF5W-04 a draft carrying a Run-bound reference is refused, never dropped', () => {
  const registry = createM3RuntimeEventRegistry();
  for (const key of WORKSPACE_EVENT_FORBIDDEN_ENVELOPE_KEYS) {
    const error = registryError(() => registry.publishWorkspace(workspaceDraft({ [key]: 'stowaway_1' })));
    assert.equal(error.code, 'INVALID_EVENT_ENVELOPE', key);
  }
  const runId = registryError(() => registry.publishWorkspace(workspaceDraft({ runId: 'run_1' })));
  assert.equal(runId.code, 'INVALID_EVENT_ENVELOPE');
});

test('MF5W-05 incomplete or malformed Workspace envelopes fail closed', () => {
  const registry = createM3RuntimeEventRegistry();
  assert.equal(registryError(() => registry.publishWorkspace(workspaceDraft({ workspaceId: '  ' }))).code, 'INVALID_EVENT_ENVELOPE');
  assert.equal(registryError(() => registry.publishWorkspace(workspaceDraft({ causationId: undefined }))).code, 'INVALID_EVENT_ENVELOPE');
  assert.equal(registryError(() => registry.publishWorkspace(workspaceDraft({ correlationId: undefined }))).code, 'INVALID_EVENT_ENVELOPE');
  assert.equal(registryError(() => registry.publishWorkspace(workspaceDraft({ sequence: 0 }))).code, 'INVALID_EVENT_ENVELOPE');
  assert.equal(registryError(() => registry.publishWorkspace(workspaceDraft({ timestamp: '2026-09-11T00:00:00Z' }))).code, 'INVALID_EVENT_TIMESTAMP');
  assert.equal(registryError(() => registry.publishWorkspace(workspaceDraft({ schemaVersion: 2 }))).code, 'UNKNOWN_FUTURE_EVENT_NOT_PUBLISHABLE');
  assert.equal(registryError(() => registry.publishWorkspace(workspaceDraft({ schemaVersion: 0 }))).code, 'INVALID_EVENT_SCHEMA_VERSION');
  assert.equal(registryError(() => registry.publishWorkspace(workspaceDraft({ source: 'process-manager' }))).code, 'INVALID_EVENT_ENVELOPE');
});

test('MF5W-06 payload validation is reused unchanged for Workspace drafts', () => {
  const registry = createM3RuntimeEventRegistry();
  const wrongVersion = registryError(() => registry.publishWorkspace(workspaceDraft({
    payload: { ...ENTRY_PAYLOAD, version: 0 },
  })));
  assert.equal(wrongVersion.code, 'INVALID_EVENT_PAYLOAD');
  const unknownField = registryError(() => registry.publishWorkspace(workspaceDraft({
    payload: { ...ENTRY_PAYLOAD, content: 'secret' },
  })));
  assert.equal(unknownField.code, 'INVALID_EVENT_PAYLOAD');
});

test('MF5W-07 the Run publish path is unchanged', () => {
  const registry = createM3RuntimeEventRegistry();
  const runDraft = {
    id: 'evt_01J0000000000000000000000B',
    schemaVersion: 1,
    type: 'memory.entry_created',
    workspaceId: 'ws_1',
    runId: 'run_1',
    sequence: 1,
    timestamp: TIMESTAMP,
    correlationId: 'op_1',
    payload: ENTRY_PAYLOAD,
  };
  assert.equal(registry.publish(runDraft).runId, 'run_1');
  // The Run path still requires its own binding and rejects the Workspace shape.
  assert.equal(registryError(() => registry.publish({ ...runDraft, runId: undefined })).code, 'INVALID_EVENT_ENVELOPE');
});

test('MF5W-08 published Workspace Events do not mutate the caller draft', () => {
  const registry = createM3RuntimeEventRegistry();
  const draft = { ...WORKSPACE_DRAFT, payload: { ...ENTRY_PAYLOAD } };
  const event = registry.publishWorkspace(draft);
  draft.payload.version = 99;
  assert.equal(event.payload.version, 3);
  assert.equal(JSON.stringify(event).includes('runId'), false);
});

