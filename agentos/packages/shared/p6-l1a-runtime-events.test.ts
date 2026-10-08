import assert from 'node:assert/strict';
import test from 'node:test';
import {
  M3_CORE_EVENT_DEFINITIONS,
  M4_PROCESS_EVENT_DEFINITIONS,
  P6_L1_EVENT_DEFINITIONS,
  P6_L1_RUNTIME_EVENT_TYPES,
  RUNTIME_EVENT_DOMAINS,
  RUNTIME_EVENT_SOURCES,
  RuntimeEventRegistryError,
  createM3RuntimeEventRegistry,
  isWorkspaceAdmissionGrantedPayload,
  type RuntimeEventDraft,
} from './src/index.ts';

// L1A-13 — new Runtime Event domains are accepted additively.
test('L1A-13 new Runtime Event domains accepted additively', () => {
  for (const domain of ['workspace', 'git', 'artifact']) {
    assert.ok((RUNTIME_EVENT_DOMAINS as readonly string[]).includes(domain));
  }
  // Historical domains are preserved.
  for (const domain of ['run', 'stage', 'approval', 'stream', 'process']) {
    assert.ok((RUNTIME_EVENT_DOMAINS as readonly string[]).includes(domain));
  }
  // New source registered additively; historical sources preserved.
  assert.ok((RUNTIME_EVENT_SOURCES as readonly string[]).includes('workspace-admission'));
  assert.ok((RUNTIME_EVENT_SOURCES as readonly string[]).includes('process-manager'));
});

// L1A-14 — every new canonical event is registered.
test('L1A-14 every new canonical event registered with correct domain', () => {
  const registry = createM3RuntimeEventRegistry();
  const expectedDomain: Record<string, string> = {
    'workspace.admission.requested': 'workspace',
    'workspace.admission.granted': 'workspace',
    'workspace.admission.queued': 'workspace',
    'workspace.admission.released': 'workspace',
    'run.mutation_class.resolved': 'run',
    'run.read_only_enforcement.unavailable': 'run',
    'git.observation.completed': 'git',
    'git.observation.unavailable': 'git',
    'artifact.diff.registered': 'artifact',
  };
  assert.deepEqual(
    P6_L1_EVENT_DEFINITIONS.map(d => d.type),
    [...P6_L1_RUNTIME_EVENT_TYPES],
  );
  for (const [type, domain] of Object.entries(expectedDomain)) {
    const def = registry.get(type);
    assert.ok(def, type + ' must be registered');
    assert.equal(def.domain, domain, type + ' domain');
    assert.equal(def.schemaVersion, 1);
  }
});

// Historical registries remain intact.
test('L1A-17 historical M3/M4 event registry fixtures unchanged', () => {
  assert.equal(M3_CORE_EVENT_DEFINITIONS.length, 26);
  assert.equal(M4_PROCESS_EVENT_DEFINITIONS.length, 13);
});

function draft(type: string, payload: unknown): RuntimeEventDraft {
  return {
    id: 'evt_p6l1a_01',
    schemaVersion: 1,
    type,
    workspaceId: 'ws-1',
    taskId: 'task-1',
    runId: 'run-1',
    sequence: 1,
    correlationId: 'corr-1',
    causationId: 'corr-1',
    timestamp: '2026-08-29T00:00:00.000Z',
    payload,
  } as unknown as RuntimeEventDraft;
}

// L1A-15 — malformed new event payload is rejected.
test('L1A-15 malformed new event payload rejected', () => {
  assert.equal(
    isWorkspaceAdmissionGrantedPayload({
      subjectKind: 'CANONICAL_RUN',
      effectiveMutationClass: 'SIDEWAYS',
      requestOrder: 1,
    }),
    false,
  );
  assert.equal(
    isWorkspaceAdmissionGrantedPayload({
      subjectKind: 'CANONICAL_RUN',
      effectiveMutationClass: 'READ_ONLY',
    }),
    false,
  );
  const registry = createM3RuntimeEventRegistry();
  assert.throws(
    () => registry.publish(draft('workspace.admission.granted', { subjectKind: 'CANONICAL_RUN' })),
    (e: unknown) => e instanceof RuntimeEventRegistryError,
  );
});

// A well-formed new event publishes.
test('well-formed workspace.admission.granted publishes', () => {
  const registry = createM3RuntimeEventRegistry();
  const event = registry.publish(
    draft('workspace.admission.granted', {
      subjectKind: 'CANONICAL_RUN',
      effectiveMutationClass: 'MODIFYING',
      requestOrder: 1,
    }),
  );
  assert.equal(event.type, 'workspace.admission.granted');
});

// L1A-16 — an unknown core event still fails closed.
test('L1A-16 unknown core event still UNREGISTERED_CORE_EVENT', () => {
  const registry = createM3RuntimeEventRegistry();
  assert.throws(
    () => registry.publish(draft('workspace.admission.nonexistent', {})),
    (e: unknown) =>
      e instanceof RuntimeEventRegistryError && e.code === 'UNREGISTERED_CORE_EVENT',
  );
});

// ---------------------------------------------------------------------------
// L1A-R13..L1A-R17 — canonical admission events reject the LEGACY subject.
//
// The frozen observability contract: a CANONICAL_RUN may publish canonical
// Runtime/Outbox events; a LEGACY_AGENT_RUN MUST NOT publish canonical
// Runtime Events under an agent_runs.id and MUST NOT require a fake
// canonical Run (compatibility telemetry only; workspace_admissions remains
// the authority). The shared WorkspaceAdmissionSubject union stays
// dual-subject; only the canonical Runtime Event vocabulary is restricted.
// ---------------------------------------------------------------------------

function expectInvalidPayload(type: string, payload: unknown): void {
  const registry = createM3RuntimeEventRegistry();
  assert.throws(
    () => registry.publish(draft(type, payload)),
    (e: unknown) =>
      e instanceof RuntimeEventRegistryError && e.code === 'INVALID_EVENT_PAYLOAD',
  );
}

// L1A-R13 — workspace.admission.requested + LEGACY_AGENT_RUN -> INVALID_EVENT_PAYLOAD.
test('L1A-R13 workspace.admission.requested LEGACY_AGENT_RUN -> INVALID_EVENT_PAYLOAD', () => {
  expectInvalidPayload('workspace.admission.requested', {
    subjectKind: 'LEGACY_AGENT_RUN',
    requestedMutationClass: 'MODIFYING',
  });
});

// L1A-R14 — workspace.admission.granted + LEGACY_AGENT_RUN -> INVALID_EVENT_PAYLOAD.
test('L1A-R14 workspace.admission.granted LEGACY_AGENT_RUN -> INVALID_EVENT_PAYLOAD', () => {
  expectInvalidPayload('workspace.admission.granted', {
    subjectKind: 'LEGACY_AGENT_RUN',
    effectiveMutationClass: 'MODIFYING',
    requestOrder: 1,
  });
});

// L1A-R15 — workspace.admission.queued + LEGACY_AGENT_RUN -> INVALID_EVENT_PAYLOAD.
test('L1A-R15 workspace.admission.queued LEGACY_AGENT_RUN -> INVALID_EVENT_PAYLOAD', () => {
  expectInvalidPayload('workspace.admission.queued', {
    subjectKind: 'LEGACY_AGENT_RUN',
    effectiveMutationClass: 'MODIFYING',
    requestOrder: 1,
    queueReason: 'workspace busy',
  });
});

// L1A-R16 — workspace.admission.released + LEGACY_AGENT_RUN -> INVALID_EVENT_PAYLOAD.
test('L1A-R16 workspace.admission.released LEGACY_AGENT_RUN -> INVALID_EVENT_PAYLOAD', () => {
  expectInvalidPayload('workspace.admission.released', {
    subjectKind: 'LEGACY_AGENT_RUN',
    releaseReason: 'completed',
  });
});

// L1A-R17 — equivalent CANONICAL_RUN payloads are valid.
test('L1A-R17 equivalent CANONICAL_RUN payloads valid', () => {
  const registry = createM3RuntimeEventRegistry();
  const requested = registry.publish(
    draft('workspace.admission.requested', {
      subjectKind: 'CANONICAL_RUN',
      requestedMutationClass: 'MODIFYING',
    }),
  );
  assert.equal(requested.type, 'workspace.admission.requested');
  const granted = registry.publish(
    draft('workspace.admission.granted', {
      subjectKind: 'CANONICAL_RUN',
      effectiveMutationClass: 'MODIFYING',
      requestOrder: 1,
    }),
  );
  assert.equal(granted.type, 'workspace.admission.granted');
  const queued = registry.publish(
    draft('workspace.admission.queued', {
      subjectKind: 'CANONICAL_RUN',
      effectiveMutationClass: 'READ_ONLY',
      requestOrder: 2,
      queueReason: 'workspace busy',
    }),
  );
  assert.equal(queued.type, 'workspace.admission.queued');
  const released = registry.publish(
    draft('workspace.admission.released', {
      subjectKind: 'CANONICAL_RUN',
      releaseReason: 'completed',
    }),
  );
  assert.equal(released.type, 'workspace.admission.released');
});
