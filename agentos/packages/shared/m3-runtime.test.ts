import assert from 'node:assert/strict';
import test from 'node:test';
import {
  M3_CORE_EVENT_DEFINITIONS,
  M3_MULTI_EVENT_ORDERING_CONTRACTS,
  M3_OPERATION_STATUSES,
  M3_RUN_STATUSES,
  M3_RUN_TRANSITION_EVENT_CONTRACTS,
  M3_STAGE_TRANSITION_EVENT_CONTRACTS,
  M3_STAGE_STATUSES,
  M3_RUNTIME_EVENT_TYPES,
  RUNTIME_EVENT_DOMAINS,
  RUNTIME_EVENT_SOURCES,
  RuntimeEventRegistryError,
  V2_RUN_REASONS,
  WORKTREE_MODES,
  createM3RuntimeEventRegistry,
  getM3RunTransitionEventContract,
  getM3StageTransitionEventContract,
  isCanonicalRuntimeTimestamp,
} from './src/index.ts';
import {
  createM3RuntimeEventFixtures,
} from './src/types/m3-runtime-fixtures.ts';
import type { RunFailedPayload } from './src/types/m3-runtime-registry.ts';
import type {
  CancelRunBody,
  CreateRunBody,
  OperationEventsQuery,
  OperationPathParams,
  ReplayArtifactIndexEntry,
  ReplayCompatibilityWarning,
  ResolvedSseCursor,
  RunReplayQuery,
  RuntimeEventDraft,
  RuntimeEventEnvelope,
  RuntimeEventFrame,
  RuntimeEventPage,
  RuntimeEventRecord,
  RuntimeKeepaliveFrame,
  RunEventsQuery,
  RunPathParams,
  RunRequestHeaders,
  RunStreamQuery,
  SseRequestHeaders,
  StartRunBody,
} from './src/types/m3-runtime.ts';
import type { RunReplayResponse } from './src/types/index.ts';

test('keeps the ProviderType compile-time contract in the Shared test source', () => {
  const validProviderType: RunFailedPayload['providerType'] = 'codex';
  assert.equal(validProviderType, 'codex');
  // @ts-expect-error non-canonical ProviderType must not be assignable to RunFailedPayload
  const invalidProviderType: RunFailedPayload['providerType'] = 'not-a-provider';
  void invalidProviderType;
});

function withPayloadField(
  event: RuntimeEventEnvelope,
  field: string,
  value: unknown,
): RuntimeEventDraft {
  return {
    ...event,
    id: `${event.id}-${field}`,
    payload: {
      ...(event.payload as Record<string, unknown>),
      [field]: value,
    },
  };
}

test('uses the canonical Stage status set and keeps Migration 009 pending compatibility', () => {
  assert.deepEqual(M3_STAGE_STATUSES, [
    'pending',
    'ready',
    'starting',
    'running',
    'waiting_approval',
    'paused',
    'completed',
    'failed',
    'cancelled',
    'skipped',
  ]);
  assert.equal(M3_STAGE_STATUSES.includes('created' as never), false);
  assert.equal(M3_STAGE_STATUSES.includes('blocked' as never), false);
});

test('uses the exact EventSource protocol and rejects underscore values', () => {
  assert.deepEqual(RUNTIME_EVENT_SOURCES, [
    'run-engine',
    'scheduler',
    'workflow-executor',
    'stage-executor',
    'provider-adapter',
    'process-manager',
    'worktree-manager',
    'git-runtime',
    'memory-engine',
    'policy-engine',
    'approval-service',
    'artifact-manager',
    'usage-aggregator',
    'recovery-manager',
    'conversation-service',
    'extension',
    'system',
  ]);

  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);
  const invalidSource = {
    ...fixtures.validRunCreatedEvent,
    source: ['run', 'engine'].join('_') as unknown as RuntimeEventDraft['source'],
  };
  assert.throws(
    () => registry.publish(invalidSource),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_ENVELOPE',
  );
});

test('registers the complete P2C-1 Event set with frozen domains and metadata', () => {
  assert.deepEqual(RUNTIME_EVENT_DOMAINS, ['run', 'stage', 'approval']);
  const expectedTypes = [
    'run.created',
    'run.queued',
    'run.dequeued',
    'run.started',
    'run.paused',
    'run.resumed',
    'run.cancelled',
    'run.completed',
    'run.failed',
    'stage.created',
    'stage.ready',
    'stage.starting',
    'stage.started',
    'stage.paused',
    'stage.resumed',
    'stage.completed',
    'stage.failed',
    'stage.cancelled',
    'stage.skipped',
    'approval.required',
    'approval.resolved',
  ];
  assert.deepEqual(M3_RUNTIME_EVENT_TYPES, expectedTypes);
  assert.deepEqual(M3_CORE_EVENT_DEFINITIONS.map(definition => definition.type), expectedTypes);
  assert.equal(M3_CORE_EVENT_DEFINITIONS.length, 21);

  const registry = createM3RuntimeEventRegistry();
  assert.deepEqual(
    [registry.get('run.dequeued')?.domain, registry.get('run.dequeued')?.source],
    ['run', 'scheduler'],
  );
  assert.equal(registry.get('run.dequeued')?.defaultVisibility, 'internal');
  assert.equal(registry.get('run.dequeued')?.forbidsStageId, true);
  assert.equal(registry.get('stage.starting')?.requiresStageId, true);
  assert.equal(registry.get('approval.required')?.requiresApprovalRequestId, true);
  assert.equal(registry.get('run.failed')?.defaultSeverity, 'error');
  assert.equal(registry.get('stage.cancelled')?.defaultSeverity, 'notice');
  assert.equal(registry.get('approval.required')?.defaultSeverity, 'notice');
});

test('validates canonical UTC timestamp and source/Envelope reference rules', () => {
  assert.equal(isCanonicalRuntimeTimestamp('2026-08-02T00:00:00.000Z'), true);
  assert.equal(isCanonicalRuntimeTimestamp('2026-08-02T08:00:00.000+08:00'), false);
  assert.equal(isCanonicalRuntimeTimestamp('2026-08-02T00:00:00Z'), false);
  assert.equal(isCanonicalRuntimeTimestamp('2026-02-29T00:00:00.000Z'), false);

  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);
  assert.throws(
    () => registry.publish(fixtures.invalidNonCanonicalTimestamp),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_TIMESTAMP',
  );
  assert.throws(
    () => registry.publish(fixtures.invalidUnexpectedStageId),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'UNEXPECTED_STAGE_ID',
  );
  assert.throws(
    () => registry.publish(fixtures.invalidMissingApprovalRequestId),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'MISSING_APPROVAL_REQUEST_ID',
  );
  assert.throws(
    () => registry.publish(fixtures.invalidSource),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_ENVELOPE',
  );

  assert.equal(fixtures.validRunOnlyApprovalRequiredEvent.stageId, undefined);
  assert.equal(fixtures.validRunOnlyApprovalRequiredEvent.approvalRequestId, 'approval_fixture_run_only');
  assert.doesNotThrow(() => registry.publish(fixtures.validRunOnlyApprovalRequiredEvent));
});

test('rejects whitespace-only payload strings, invalid string-array members, unsafe numbers and providers', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);
  const whitespaceCases: readonly [RuntimeEventEnvelope, string, unknown][] = [
    [fixtures.validRunPausedEvent, 'requestedBy', ' \t '],
    [fixtures.validStageCancelledEvent, 'reason', '\t\n'],
    [fixtures.validRunFailedEvent, 'errorCode', '   '],
    [fixtures.validRunFailedEvent, 'message', '   '],
    [fixtures.validRunFailedEvent, 'phase', '   '],
    [fixtures.validStageCreatedEvent, 'workflowStageKey', '   '],
    [fixtures.validStageCreatedEvent, 'name', '   '],
    [fixtures.validStageResumedEvent, 'resumeMode', '   '],
    [fixtures.validStageSkippedEvent, 'condition', '   '],
    [fixtures.validRunQueuedEvent, 'queueName', '   '],
    [fixtures.validRunCompletedEvent, 'worktreeStatus', '   '],
    [fixtures.validRunCreatedEvent, 'parentRunId', '   '],
    [fixtures.validRunStartedEvent, 'baseCommit', '   '],
    [fixtures.validRunFailedEvent, 'debugArtifactId', '   '],
    [fixtures.validApprovalRequiredEvent, 'title', '   '],
    [fixtures.validApprovalRequiredEvent, 'description', '   '],
    [fixtures.validApprovalResolvedEvent, 'decidedBy', '   '],
  ];
  for (const [event, field, value] of whitespaceCases) {
    assert.throws(
      () => registry.publish(withPayloadField(event, field, value)),
      (error: unknown) => error instanceof RuntimeEventRegistryError
        && error.code === 'INVALID_EVENT_PAYLOAD',
      `${event.type}.${field} should reject whitespace-only values`,
    );
  }

  const stringArrayCases: readonly [RuntimeEventEnvelope, string][] = [
    [fixtures.validRunCompletedEvent, 'completedStageIds'],
    [fixtures.validRunCompletedEvent, 'artifactIds'],
    [fixtures.validStageCreatedEvent, 'dependsOn'],
    [fixtures.validStageReadyEvent, 'dependenciesCompleted'],
    [fixtures.validRunCancelledEvent, 'terminatedProcessIds'],
  ];
  for (const [event, field] of stringArrayCases) {
    assert.throws(
      () => registry.publish(withPayloadField(event, field, ['   '])),
      (error: unknown) => error instanceof RuntimeEventRegistryError
        && error.code === 'INVALID_EVENT_PAYLOAD',
      `${event.type}.${field} should reject whitespace-only array members`,
    );
  }

  const numericCases: readonly [RuntimeEventEnvelope, string, number][] = [
    [fixtures.validRunQueuedEvent, 'position', Number.NaN],
    [fixtures.validRunQueuedEvent, 'position', Number.POSITIVE_INFINITY],
    [fixtures.validRunQueuedEvent, 'position', Number.MAX_SAFE_INTEGER + 1],
    [fixtures.validRunCompletedEvent, 'durationMs', Number.NaN],
    [fixtures.validRunCompletedEvent, 'durationMs', Number.MAX_SAFE_INTEGER + 1],
    [fixtures.validStageCreatedEvent, 'sequence', Number.MAX_SAFE_INTEGER + 1],
    [fixtures.validStageCompletedEvent, 'durationMs', Number.POSITIVE_INFINITY],
    [fixtures.validRunStartedEvent, 'workflowSnapshotVersion', Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [event, field, value] of numericCases) {
    assert.throws(
      () => registry.publish(withPayloadField(event, field, value)),
      (error: unknown) => error instanceof RuntimeEventRegistryError
        && error.code === 'INVALID_EVENT_PAYLOAD',
      `${event.type}.${field} should reject invalid numeric values`,
    );
  }

  assert.throws(
    () => registry.publish(withPayloadField(fixtures.validRunFailedEvent, 'providerType', 'not-a-provider')),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_PAYLOAD',
  );

  const preserved = withPayloadField(fixtures.validRunPausedEvent, 'requestedBy', '  fixture  ');
  const published = registry.publish(preserved);
  assert.equal((published.payload as Record<string, unknown>).requestedBy, '  fixture  ');
  assert.equal((preserved.payload as Record<string, unknown>).requestedBy, '  fixture  ');
});

test('validates Approval stage references without misclassifying blank values as Run-only', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);

  assert.doesNotThrow(() => registry.publish(fixtures.validRunOnlyApprovalRequiredEvent));
  assert.doesNotThrow(() => registry.publish(fixtures.validApprovalRequiredEvent));

  for (const blank of ['', '   ']) {
    assert.throws(
      () => registry.publish({ ...fixtures.validApprovalRequiredEvent, stageId: blank }),
      (error: unknown) => error instanceof RuntimeEventRegistryError
        && error.code === 'INVALID_EVENT_ENVELOPE',
    );
    assert.throws(
      () => registry.publish({ ...fixtures.validApprovalRequiredEvent, approvalRequestId: blank }),
      (error: unknown) => error instanceof RuntimeEventRegistryError
        && error.code === 'INVALID_EVENT_ENVELOPE',
    );
  }

  assert.throws(
    () => registry.publish({ ...fixtures.validStageStartedEvent, stageId: '' }),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_ENVELOPE',
  );
  assert.throws(
    () => registry.publish({ ...fixtures.validRunCreatedEvent, stageId: '' }),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_ENVELOPE',
  );
  assert.throws(
    () => registry.publish({ ...fixtures.validApprovalRequiredEvent, approvalRequestId: undefined }),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'MISSING_APPROVAL_REQUEST_ID',
  );
});

test('preserves b838 StageStarted Snapshot compatibility while keeping lifecycle fields strict', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);
  const stageEvent = fixtures.validStageStartedEvent;
  const stagePayload = stageEvent.payload as unknown as Record<string, unknown>;
  const providerSnapshot = stagePayload.providerSnapshot as Record<string, unknown>;
  const providerTimeoutPolicy = providerSnapshot.timeoutPolicy as Record<string, unknown>;

  const withProviderPatch = (patch: Record<string, unknown>): RuntimeEventDraft => ({
    ...stageEvent,
    id: `${stageEvent.id}-provider-patch`,
    payload: {
      ...stagePayload,
      providerSnapshot: {
        ...providerSnapshot,
        ...patch,
      },
    },
  });

  assert.doesNotThrow(() => registry.publish(withProviderPatch({ argsTemplate: ['--flag', ''] })));
  assert.doesNotThrow(() => registry.publish(withProviderPatch({ argsTemplate: [] })));
  assert.doesNotThrow(() => registry.publish(withProviderPatch({
    timeoutPolicy: {
      ...providerTimeoutPolicy,
      discoveryTimeoutMs: 0,
      validationTimeoutMs: 0,
      startupTimeoutMs: 0,
      idleTimeoutMs: null,
      totalTimeoutMs: null,
      cancelGracePeriodMs: 0,
      approvalTimeoutMs: null,
    },
  })));

  const nullableSnapshotFields = [
    'executable',
    'model',
    'environmentProfileId',
    'secretProfileId',
    'workspaceRelativeWorkingDirectory',
  ];
  for (const field of nullableSnapshotFields) {
    for (const value of [null, 'fixture', '  fixture  ']) {
      const published = registry.publish(withProviderPatch({ [field]: value }));
      const publishedProviderSnapshot = (published.payload as Record<string, unknown>).providerSnapshot as Record<string, unknown>;
      assert.equal(publishedProviderSnapshot[field], value, `${field} must preserve its original value`);
    }
    for (const value of ['', '   ', '\t\n', 42]) {
      assert.throws(
        () => registry.publish(withProviderPatch({ [field]: value })),
        (error: unknown) => error instanceof RuntimeEventRegistryError
          && error.code === 'INVALID_EVENT_PAYLOAD',
        `${field}=${String(value)} must be rejected`,
      );
    }
  }

  assert.throws(
    () => registry.publish(withProviderPatch({ argsTemplate: ['--flag', 42] })),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_PAYLOAD',
  );
  assert.throws(
    () => registry.publish({
      ...stageEvent,
      payload: { ...stagePayload, providerSnapshot: undefined },
    } as RuntimeEventDraft),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_PAYLOAD',
  );
  assert.throws(
    () => registry.publish({
      ...stageEvent,
      payload: { ...stagePayload, agentSnapshot: undefined },
    } as RuntimeEventDraft),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_PAYLOAD',
  );
  assert.throws(
    () => registry.publish(withPayloadField(stageEvent, 'workflowStageKey', '   ')),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_PAYLOAD',
  );
  assert.throws(
    () => registry.publish(withPayloadField(stageEvent, 'name', '   ')),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_PAYLOAD',
  );
});

test('covers every registered payload with a valid and an unknown-field invalid fixture', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);

  assert.equal(fixtures.validEvents.length, 21);
  assert.equal(fixtures.invalidPayloads.length, 21);
  for (const event of fixtures.validEvents) {
    assert.ok(registry.get(event.type), `missing definition for ${event.type}`);
  }
  for (const invalidPayload of fixtures.invalidPayloads) {
    assert.throws(
      () => registry.publish(invalidPayload),
      (error: unknown) => error instanceof RuntimeEventRegistryError
        && error.code === 'INVALID_EVENT_PAYLOAD',
    );
  }
});

test('rejects omission of every required payload field for all 21 registered Events', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);
  const validEvents = new Map(fixtures.validEvents.map(event => [event.type, event]));
  let omissionCount = 0;

  for (const definition of M3_CORE_EVENT_DEFINITIONS) {
    const event = validEvents.get(definition.type);
    if (!event) throw new Error(`Missing valid fixture for ${definition.type}`);
    const required = new Set(definition.payloadSchema.required);
    const optional = new Set(definition.payloadSchema.optional);
    const allowed = new Set([...required, ...optional]);
    assert.equal(required.size + optional.size, allowed.size, `${definition.type} schema fields overlap`);
    assert.equal(
      Object.keys(event.payload as Record<string, unknown>).every(field => allowed.has(field)),
      true,
      `${definition.type} fixture contains an undeclared payload field`,
    );

    for (const field of definition.payloadSchema.required) {
      omissionCount += 1;
      const omittedPayload: Record<string, unknown> = {
        ...(event.payload as Record<string, unknown>),
      };
      assert.equal(field in omittedPayload, true, `${definition.type}.${field} missing from valid fixture`);
      delete omittedPayload[field];
      assert.throws(
        () => registry.publish({
          ...event,
          id: `${event.id}-missing-${field}`,
          payload: omittedPayload,
        } as RuntimeEventDraft),
        (error: unknown) => error instanceof RuntimeEventRegistryError
          && error.code === 'INVALID_EVENT_PAYLOAD',
        `${definition.type}.${field} required-field omission must fail`,
      );
    }
  }

  assert.equal(omissionCount, 58);
});

test('maps all 17 Run and 19 Stage transitions without terminal outgoing edges', () => {
  const expectedRunMatrix = [
    { aggregate: 'run', from: null, to: 'queued', primaryEvent: 'run.created', terminal: false },
    { aggregate: 'run', from: 'queued', to: 'starting', primaryEvent: 'run.dequeued', terminal: false },
    { aggregate: 'run', from: 'queued', to: 'cancelled', primaryEvent: 'run.cancelled', terminal: true },
    { aggregate: 'run', from: 'starting', to: 'running', primaryEvent: 'run.started', terminal: false },
    { aggregate: 'run', from: 'starting', to: 'failed', primaryEvent: 'run.failed', terminal: true },
    { aggregate: 'run', from: 'starting', to: 'cancelled', primaryEvent: 'run.cancelled', terminal: true },
    { aggregate: 'run', from: 'running', to: 'waiting_approval', primaryEvent: 'approval.required', terminal: false },
    { aggregate: 'run', from: 'running', to: 'paused', primaryEvent: 'run.paused', terminal: false },
    { aggregate: 'run', from: 'running', to: 'completed', primaryEvent: 'run.completed', terminal: true },
    { aggregate: 'run', from: 'running', to: 'failed', primaryEvent: 'run.failed', terminal: true },
    { aggregate: 'run', from: 'running', to: 'cancelled', primaryEvent: 'run.cancelled', terminal: true },
    { aggregate: 'run', from: 'waiting_approval', to: 'running', primaryEvent: 'approval.resolved', terminal: false },
    { aggregate: 'run', from: 'waiting_approval', to: 'failed', primaryEvent: 'run.failed', terminal: true },
    { aggregate: 'run', from: 'waiting_approval', to: 'cancelled', primaryEvent: 'run.cancelled', terminal: true },
    { aggregate: 'run', from: 'paused', to: 'running', primaryEvent: 'run.resumed', terminal: false },
    { aggregate: 'run', from: 'paused', to: 'failed', primaryEvent: 'run.failed', terminal: true },
    { aggregate: 'run', from: 'paused', to: 'cancelled', primaryEvent: 'run.cancelled', terminal: true },
  ];
  const expectedStageMatrix = [
    { aggregate: 'stage', from: null, to: 'pending', primaryEvent: 'stage.created', terminal: false },
    { aggregate: 'stage', from: 'pending', to: 'ready', primaryEvent: 'stage.ready', terminal: false },
    { aggregate: 'stage', from: 'pending', to: 'skipped', primaryEvent: 'stage.skipped', terminal: true },
    { aggregate: 'stage', from: 'pending', to: 'cancelled', primaryEvent: 'stage.cancelled', terminal: true },
    { aggregate: 'stage', from: 'ready', to: 'starting', primaryEvent: 'stage.starting', terminal: false },
    { aggregate: 'stage', from: 'ready', to: 'cancelled', primaryEvent: 'stage.cancelled', terminal: true },
    { aggregate: 'stage', from: 'starting', to: 'running', primaryEvent: 'stage.started', terminal: false },
    { aggregate: 'stage', from: 'starting', to: 'failed', primaryEvent: 'stage.failed', terminal: true },
    { aggregate: 'stage', from: 'starting', to: 'cancelled', primaryEvent: 'stage.cancelled', terminal: true },
    { aggregate: 'stage', from: 'running', to: 'waiting_approval', primaryEvent: 'approval.required', terminal: false },
    { aggregate: 'stage', from: 'running', to: 'paused', primaryEvent: 'stage.paused', terminal: false },
    { aggregate: 'stage', from: 'running', to: 'completed', primaryEvent: 'stage.completed', terminal: true },
    { aggregate: 'stage', from: 'running', to: 'failed', primaryEvent: 'stage.failed', terminal: true },
    { aggregate: 'stage', from: 'running', to: 'cancelled', primaryEvent: 'stage.cancelled', terminal: true },
    { aggregate: 'stage', from: 'waiting_approval', to: 'running', primaryEvent: 'approval.resolved', terminal: false },
    { aggregate: 'stage', from: 'waiting_approval', to: 'failed', primaryEvent: 'stage.failed', terminal: true },
    { aggregate: 'stage', from: 'waiting_approval', to: 'cancelled', primaryEvent: 'stage.cancelled', terminal: true },
    { aggregate: 'stage', from: 'paused', to: 'running', primaryEvent: 'stage.resumed', terminal: false },
    { aggregate: 'stage', from: 'paused', to: 'cancelled', primaryEvent: 'stage.cancelled', terminal: true },
  ];

  assert.deepEqual(M3_RUN_TRANSITION_EVENT_CONTRACTS, expectedRunMatrix);
  assert.deepEqual(M3_STAGE_TRANSITION_EVENT_CONTRACTS, expectedStageMatrix);
  assert.equal(new Set(M3_RUN_TRANSITION_EVENT_CONTRACTS.map(contract => `${contract.from}->${contract.to}`)).size, 17);
  assert.equal(new Set(M3_STAGE_TRANSITION_EVENT_CONTRACTS.map(contract => `${contract.from}->${contract.to}`)).size, 19);

  for (const from of [null, ...M3_RUN_STATUSES]) {
    for (const to of M3_RUN_STATUSES) {
      assert.deepEqual(
        getM3RunTransitionEventContract(from, to),
        expectedRunMatrix.find(contract => contract.from === from && contract.to === to),
      );
    }
  }
  for (const from of [null, ...M3_STAGE_STATUSES]) {
    for (const to of M3_STAGE_STATUSES) {
      assert.deepEqual(
        getM3StageTransitionEventContract(from, to),
        expectedStageMatrix.find(contract => contract.from === from && contract.to === to),
      );
    }
  }

  assert.equal(getM3RunTransitionEventContract('completed', 'running'), undefined);
  assert.equal(getM3RunTransitionEventContract('failed', 'queued'), undefined);
  assert.equal(getM3RunTransitionEventContract('cancelled', 'running'), undefined);
  assert.equal(getM3StageTransitionEventContract('completed', 'running'), undefined);
  assert.equal(getM3StageTransitionEventContract('failed', 'running'), undefined);
  assert.equal(getM3StageTransitionEventContract('cancelled', 'running'), undefined);
  assert.equal(getM3StageTransitionEventContract('skipped', 'running'), undefined);

  const registered = new Set(M3_CORE_EVENT_DEFINITIONS.map(definition => definition.type));
  for (const contract of [...M3_RUN_TRANSITION_EVENT_CONTRACTS, ...M3_STAGE_TRANSITION_EVENT_CONTRACTS]) {
    assert.equal(registered.has(contract.primaryEvent), true, contract.primaryEvent);
  }
  assert.equal(registered.has('run.queued'), true);
  assert.equal(M3_RUN_TRANSITION_EVENT_CONTRACTS.some(contract => contract.primaryEvent === 'run.queued'), false);
  assert.equal(M3_RUNTIME_EVENT_TYPES.includes('run.status_changed' as never), false);
  assert.equal(M3_RUNTIME_EVENT_TYPES.includes('stage.status_changed' as never), false);
});

test('freezes the shared multi-Event ordering contracts', () => {
  // Branch A: stage.failed → run.failed. Branch B: run.failed only.
  assert.deepEqual(M3_MULTI_EVENT_ORDERING_CONTRACTS, [
    {
      name: 'startup-completion',
      events: ['stage.started', 'run.started'],
      stageMultiplicity: 'single',
      stageOrdering: 'none',
      contiguousRunSequence: true,
      independentOutboxPerEvent: true,
      atomicCurrentStateEventOutbox: true,
    },
    {
      name: 'startup-failure',
      events: ['stage.failed', 'run.failed'],
      stageMultiplicity: 'single',
      stageOrdering: 'none',
      contiguousRunSequence: true,
      independentOutboxPerEvent: true,
      atomicCurrentStateEventOutbox: true,
    },
    {
      name: 'approval-failure',
      events: ['approval.resolved', 'stage.failed', 'run.failed'],
      stageMultiplicity: 'single',
      stageOrdering: 'none',
      contiguousRunSequence: true,
      independentOutboxPerEvent: true,
      atomicCurrentStateEventOutbox: true,
    },
    {
      name: 'approval-cancellation',
      events: ['approval.resolved', 'stage.cancelled', 'run.cancelled'],
      stageMultiplicity: 'all-affected-non-terminal',
      stageOrdering: 'sequence-asc-then-id-asc',
      contiguousRunSequence: true,
      independentOutboxPerEvent: true,
      atomicCurrentStateEventOutbox: true,
    },
    {
      name: 'run-cancellation',
      events: ['stage.cancelled', 'run.cancelled'],
      stageMultiplicity: 'all-affected-non-terminal',
      stageOrdering: 'sequence-asc-then-id-asc',
      contiguousRunSequence: true,
      independentOutboxPerEvent: true,
      atomicCurrentStateEventOutbox: true,
    },
    {
      name: 'run-completion',
      events: ['stage.completed', 'run.completed'],
      stageMultiplicity: 'single',
      stageOrdering: 'none',
      contiguousRunSequence: true,
      independentOutboxPerEvent: true,
      atomicCurrentStateEventOutbox: true,
    },
    {
      name: 'run-graph-creation',
      events: ['run.created', 'stage.created'],
      stageMultiplicity: 'all-created',
      stageOrdering: 'sequence-asc-then-id-asc',
      contiguousRunSequence: true,
      independentOutboxPerEvent: true,
      atomicCurrentStateEventOutbox: true,
    },
  ]);
  assert.equal(M3_MULTI_EVENT_ORDERING_CONTRACTS.length, 7);
  assert.deepEqual(
    M3_MULTI_EVENT_ORDERING_CONTRACTS.map(contract => contract.name),
    [
      'startup-completion',
      'startup-failure',
      'approval-failure',
      'approval-cancellation',
      'run-cancellation',
      'run-completion',
      'run-graph-creation',
    ],
  );
  assert.equal(
    new Set(M3_MULTI_EVENT_ORDERING_CONTRACTS.map(contract => contract.name)).size,
    7,
  );
  const startupFailure = M3_MULTI_EVENT_ORDERING_CONTRACTS.find(
    contract => contract.name === 'startup-failure',
  );
  assert.ok(startupFailure);
  assert.deepEqual(startupFailure, {
    name: 'startup-failure',
    events: ['stage.failed', 'run.failed'],
    stageMultiplicity: 'single',
    stageOrdering: 'none',
    contiguousRunSequence: true,
    independentOutboxPerEvent: true,
    atomicCurrentStateEventOutbox: true,
  });
  assert.equal(Object.isFrozen(M3_RUN_TRANSITION_EVENT_CONTRACTS), true);
  assert.equal(Object.isFrozen(M3_RUN_TRANSITION_EVENT_CONTRACTS[0]), true);
  assert.equal(Object.isFrozen(M3_STAGE_TRANSITION_EVENT_CONTRACTS[0]), true);
  assert.equal(Object.isFrozen(M3_MULTI_EVENT_ORDERING_CONTRACTS), true);
  assert.equal(Object.isFrozen(M3_MULTI_EVENT_ORDERING_CONTRACTS[0]), true);
  for (const contract of M3_MULTI_EVENT_ORDERING_CONTRACTS) {
    assert.equal(Object.isFrozen(contract), true);
    assert.equal(Object.isFrozen(contract.events), true);
    assert.equal(contract.contiguousRunSequence, true);
    assert.equal(contract.independentOutboxPerEvent, true);
    assert.equal(contract.atomicCurrentStateEventOutbox, true);
  }
});

test('freezes the Run Graph Creation composite order and cardinality rules', () => {
  const creation = M3_MULTI_EVENT_ORDERING_CONTRACTS.find(
    contract => contract.name === 'run-graph-creation',
  );
  assert.ok(creation);
  assert.deepEqual(creation.events, ['run.created', 'stage.created']);
  assert.equal(creation.stageMultiplicity, 'all-created');
  assert.equal(creation.stageOrdering, 'sequence-asc-then-id-asc');
  assert.equal(creation.contiguousRunSequence, true);
  assert.equal(creation.independentOutboxPerEvent, true);
  assert.equal(creation.atomicCurrentStateEventOutbox, true);

  const stages = [
    { sequence: 2, id: 'stage_b' },
    { sequence: 1, id: 'stage_z' },
    { sequence: 1, id: 'stage_a' },
  ].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  assert.deepEqual(stages.map(stage => stage.id), ['stage_a', 'stage_z', 'stage_b']);
  const eventTypes = [creation.events[0], ...stages.map(() => creation.events[1])];
  assert.deepEqual(eventTypes, ['run.created', 'stage.created', 'stage.created', 'stage.created']);
  assert.equal(eventTypes[0], 'run.created');
  assert.deepEqual(eventTypes.slice(1), ['stage.created', 'stage.created', 'stage.created']);
  assert.deepEqual(eventTypes.map((_, index) => index + 1), [1, 2, 3, 4]);
  assert.equal(eventTypes.length, stages.length + 1);
  assert.equal(eventTypes.length + 1, stages.length + 2);
  const emptyEventTypes = [creation.events[0]];
  assert.deepEqual(emptyEventTypes, ['run.created']);
  assert.deepEqual(emptyEventTypes.map((_, index) => index + 1), [1]);
  assert.equal(emptyEventTypes.length + 1, 2);
});

test('enforces the single-source Run reason and canonical WorktreeMode values', () => {
  assert.deepEqual(V2_RUN_REASONS, [
    'initial',
    'retry',
    'resume-fallback',
    'review-fix',
    'provider-comparison',
    'manual',
  ]);
  assert.deepEqual(WORKTREE_MODES, ['required', 'preferred', 'disabled']);

  const fixtures = createM3RuntimeEventFixtures();
  assert.equal(fixtures.validRunCreatedEvent.payload.reason, 'initial');
  assert.equal(fixtures.validRunCreatedEvent.payload.worktreeMode, 'required');
  assert.throws(() => createM3RuntimeEventRegistry().publish(fixtures.invalidReason));
  assert.throws(() => createM3RuntimeEventRegistry().publish(fixtures.invalidWorktreeMode));
  assert.throws(() => createM3RuntimeEventRegistry().publish(fixtures.invalidUnknownWorktreeMode));
});

test('validates canonical run.created, run.started, and stage.started payloads', () => {
  const fixtures = createM3RuntimeEventFixtures();

  assert.deepEqual(Object.keys(fixtures.validRunCreatedEvent.payload).sort(), [
    'createdBy',
    'reason',
    'rootRunId',
    'worktreeMode',
  ]);
  assert.deepEqual(Object.keys(fixtures.validRunStartedEvent.payload), ['startedAt']);
  assert.deepEqual(Object.keys(fixtures.validStageStartedEvent.payload).sort(), [
    'agentSnapshot',
    'attempt',
    'name',
    'providerSnapshot',
    'workflowStageKey',
  ]);
  assert.equal(fixtures.validStageStartedEvent.payload.agentSnapshot.version, 1);
  assert.equal(fixtures.validStageStartedEvent.payload.providerSnapshot.version, 1);
  assert.ok(Array.isArray(fixtures.validStageStartedEvent.payload.agentSnapshot.permissions));
  assert.ok(Array.isArray(fixtures.validStageStartedEvent.payload.providerSnapshot.argsTemplate));
});

test('rejects illegal payloads and missing Stage envelope association', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);

  assert.throws(
    () => registry.publish(fixtures.invalidPayload),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_PAYLOAD',
  );
  assert.throws(
    () => registry.consume(fixtures.invalidPayload),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_PAYLOAD',
  );
  assert.throws(
    () => registry.publish(fixtures.invalidStageSnapshot),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_PAYLOAD',
  );
  assert.throws(
    () => registry.publish(fixtures.invalidStageEnvelope),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'MISSING_STAGE_ID',
  );
});

test('preserves Publish rejection for same-version unknown and future Events', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);

  assert.throws(
    () => registry.publish(fixtures.unknownSameVersionEvent),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'UNREGISTERED_CORE_EVENT',
  );
  assert.throws(
    () => registry.publish(fixtures.unknownFutureEvent),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'UNKNOWN_FUTURE_EVENT_NOT_PUBLISHABLE',
  );
});

test('consumes same-version unknown Events without rejecting them and preserves raw data', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);
  const result = registry.consume(fixtures.unknownSameVersionEvent);

  assert.equal(result.kind, 'unknown');
  if (result.kind === 'unknown') {
    assert.equal(result.event.warning, 'UNKNOWN_EVENT_TYPE');
    assert.deepEqual(result.event.raw, fixtures.unknownSameVersionEvent);
    assert.equal(result.event.causationId, 'evt_fixture_cause');
    assert.equal(result.event.parentEventId, 'evt_fixture_parent');
    assert.deepEqual(result.event.metadata, { unknownMetadata: true });
    assert.equal(result.event.unknownEnvelopeField, 'preserved');
  }
});

test('consumes future Events as lossless Unknown Runtime Events', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);
  const result = registry.consume(fixtures.unknownFutureEvent);

  assert.equal(result.kind, 'unknown');
  if (result.kind === 'unknown') {
    assert.equal(result.event.warning, 'UNKNOWN_FUTURE_EVENT_SCHEMA');
    assert.deepEqual(result.event.raw, fixtures.unknownFutureEvent);
    assert.equal(result.event.timestamp, fixtures.unknownFutureEvent.timestamp);
    assert.equal(result.event.source, 'future-source');
    assert.equal(result.event.severity, 'future-severity');
    assert.equal(result.event.visibility, 'future-visibility');
    assert.equal(result.event.durability, 'future-durability');
    assert.equal(result.event.causationId, 'evt_future_cause');
    assert.equal(result.event.parentEventId, 'evt_future_parent');
    assert.equal(result.event.taskId, 'task_fixture_01');
    assert.equal(result.event.agentId, 'agent_future');
    assert.equal(result.event.providerConfigId, 'provider_future');
    assert.equal(result.event.providerSessionId, 'session_future');
    assert.equal(result.event.processId, 'process_future');
    assert.equal(result.event.worktreeId, 'worktree_future');
    assert.equal(result.event.artifactId, 'artifact_future');
    assert.equal(result.event.approvalRequestId, 'approval_future');
    assert.equal(result.event.conversationId, 'conversation_future');
    assert.equal(result.event.messageId, 'message_future');
    assert.deepEqual(result.event.metadata, { futureMetadata: true });
    assert.equal(result.event.unknownFutureField, 'preserved');
  }
});

test('rejects unregistered Publish Events and invalid schema versions', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);

  assert.throws(
    () => registry.publish(fixtures.unregisteredCoreEvent),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'UNREGISTERED_CORE_EVENT',
  );
  assert.throws(
    () => registry.publish(fixtures.invalidSchemaVersion),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_SCHEMA_VERSION',
  );
});

test('keeps Core Event definitions in the production Registry, not the fixture module', async () => {
  const publicExports = await import('./src/index.ts');
  assert.equal(M3_CORE_EVENT_DEFINITIONS.length, 21);
  assert.equal('createM3RuntimeEventFixtures' in publicExports, false);
});

test('uses the Runtime Event Page contract', () => {
  const page: RuntimeEventPage = {
    events: [],
    hasMore: false,
  };
  assert.deepEqual(Object.keys(page).sort(), ['events', 'hasMore']);
  const nextPage: RuntimeEventPage = {
    events: [],
    nextAfterSequence: 10,
    hasMore: true,
  };
  assert.equal(nextPage.nextAfterSequence, 10);
});

test('uses the P5A Runtime Event wire union and Replay DTO contract', () => {
  const fixtures = createM3RuntimeEventFixtures();
  const known: RuntimeEventRecord = fixtures.validRunStartedEvent;
  const query: RunReplayQuery = {
    fromSequence: 1,
    toSequence: 10,
    types: ['run.started'],
    stageId: 'stage_fixture_01',
    includeArtifacts: true,
  };
  const warning: ReplayCompatibilityWarning = {
    code: 'EVENT_SEQUENCE_GAP',
    message: 'Durable Runtime Event sequence 2 is unavailable.',
    fromSequence: 2,
    toSequence: 2,
  };
  const artifact: ReplayArtifactIndexEntry = {
    id: 'artifact_fixture_01',
    type: 'report',
    title: 'Replay report',
    sizeBytes: 0,
    contentAvailable: false,
    createdAt: fixtures.validRunStartedEvent.timestamp,
  };
  const response: RunReplayResponse = {
    runSnapshot: null,
    stageSnapshots: [],
    events: [known],
    artifactIndex: [artifact],
    compatibilityWarnings: [warning],
  };

  assert.equal(query.fromSequence, 1);
  assert.equal(response.events[0]?.id, fixtures.validRunStartedEvent.id);
  assert.equal(response.compatibilityWarnings[0]?.code, 'EVENT_SEQUENCE_GAP');
  assert.equal(response.artifactIndex[0]?.contentAvailable, false);
});

test('separates HTTP path, query, header, and body DTOs', () => {
  const operationPath: OperationPathParams = { operationId: 'op_fixture_01' };
  const operationQuery: OperationEventsQuery = { afterSequence: 1 };
  const runPath: RunPathParams = { runId: 'run_fixture_01' };
  const runEventsQuery: RunEventsQuery = { afterSequence: 1, limit: 50 };
  const streamQuery: RunStreamQuery = { afterSequence: 2 };
  const headers: RunRequestHeaders = { idempotencyKey: 'idem_fixture_01', ifMatch: '7' };
  const sseHeaders: SseRequestHeaders = { lastEventId: 'evt_fixture_01' };
  const resolvedCursor: ResolvedSseCursor = { afterSequence: 2, lastEventId: 'evt_fixture_01' };
  const createBody: CreateRunBody = { reason: 'initial', startImmediately: true };
  const cancelBody: CancelRunBody = { reason: 'fixture', mode: 'graceful', expectedVersion: 7 };
  const startBody: StartRunBody = {};

  assert.deepEqual(Object.keys(operationPath), ['operationId']);
  assert.deepEqual(Object.keys(operationQuery), ['afterSequence']);
  assert.deepEqual(Object.keys(runPath), ['runId']);
  assert.deepEqual(Object.keys(runEventsQuery), ['afterSequence', 'limit']);
  assert.deepEqual(Object.keys(streamQuery), ['afterSequence']);
  assert.deepEqual(Object.keys(headers), ['idempotencyKey', 'ifMatch']);
  assert.deepEqual(Object.keys(sseHeaders), ['lastEventId']);
  assert.equal(resolvedCursor.lastEventId, 'evt_fixture_01');
  assert.equal(createBody.startImmediately, true);
  assert.equal(cancelBody.mode, 'graceful');
  assert.deepEqual(Object.keys(startBody), []);
});

test('uses the discriminated SSE frame contract', () => {
  const fixtures = createM3RuntimeEventFixtures();
  const runtimeFrame: RuntimeEventFrame = {
    id: fixtures.validRunStartedEvent.id,
    event: 'runtime-event',
    data: fixtures.validRunStartedEvent,
  };
  const keepalive: RuntimeKeepaliveFrame = {
    event: 'keepalive',
    data: { time: fixtures.validRunStartedEvent.timestamp },
  };
  assert.equal(runtimeFrame.event, 'runtime-event');
  assert.equal(keepalive.event, 'keepalive');
});

test('associates Operation correlation through the Event envelope', () => {
  const fixtures = createM3RuntimeEventFixtures();
  assert.equal(fixtures.operationCorrelationEvent.type, 'run.started');
  assert.equal(fixtures.operationCorrelationEvent.runId, 'run_fixture_01');
  assert.equal(fixtures.operationCorrelationEvent.correlationId, 'corr_operation_fixture');
  assert.deepEqual(Object.keys(fixtures.operationCorrelationEvent.payload), ['startedAt']);
  assert.deepEqual(M3_OPERATION_STATUSES, fixtures.operationStatuses);
});
