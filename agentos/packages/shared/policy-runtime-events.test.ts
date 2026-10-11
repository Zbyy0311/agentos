import assert from 'node:assert/strict';
import test from 'node:test';
import {
  POLICY_EVENT_DEFINITIONS,
  RUNTIME_EVENT_DOMAINS,
  RUNTIME_EVENT_SOURCES,
  RuntimeEventRegistryError,
  createM3RuntimeEventRegistry,
  isPolicyDeniedPayload,
  isPolicyEvaluatedPayload,
  isPolicyEvaluationFailedPayload,
  type RuntimeEventDraft,
} from './src/index.ts';

const TIMESTAMP = '2026-10-12T00:00:00.000Z';

function policyDraft(type: string, payload: unknown, overrides: Record<string, unknown> = {}): RuntimeEventDraft {
  return {
    id: 'evt_policy_fixture_01',
    schemaVersion: 1,
    type,
    workspaceId: 'ws_policy_fixture',
    taskId: 'task_policy_fixture',
    runId: 'run_policy_fixture',
    stageId: 'stage_policy_fixture',
    sequence: 1,
    timestamp: TIMESTAMP,
    correlationId: 'corr_policy_fixture',
    causationId: 'corr_policy_fixture',
    payload: payload as Record<string, unknown>,
    ...overrides,
  } as RuntimeEventDraft;
}

// Policy Runtime §91-95: the policy domain and the three policy Event types
// are additive; historical domains/sources stay frozen.
test('policy domain and policy-engine source accepted additively', () => {
  assert.ok((RUNTIME_EVENT_DOMAINS as readonly string[]).includes('policy'));
  for (const domain of ['run', 'stage', 'approval', 'process', 'memory']) {
    assert.ok((RUNTIME_EVENT_DOMAINS as readonly string[]).includes(domain));
  }
  assert.ok((RUNTIME_EVENT_SOURCES as readonly string[]).includes('policy-engine'));
});

test('every policy Event is registered with stage scope and non-public visibility', () => {
  const registry = createM3RuntimeEventRegistry();
  const expected = {
    'policy.evaluated': { severity: 'info', visibility: 'internal' },
    'policy.denied': { severity: 'notice', visibility: 'internal' },
    'policy.evaluation_failed': { severity: 'error', visibility: 'restricted' },
  } as const;
  assert.deepEqual(POLICY_EVENT_DEFINITIONS.map(definition => definition.type), Object.keys(expected));
  for (const [type, metadata] of Object.entries(expected)) {
    const definition = registry.get(type);
    assert.ok(definition, type + ' must be registered');
    assert.equal(definition.domain, 'policy');
    assert.equal(definition.source, 'policy-engine');
    assert.equal(definition.schemaVersion, 1);
    assert.equal(definition.defaultDurability, 'durable');
    assert.equal(definition.requiresStageId, true);
    assert.equal(definition.defaultSeverity, metadata.severity);
    assert.equal(definition.defaultVisibility, metadata.visibility);
  }
});

test('policy.evaluated publishes a valid payload and rejects bad shapes', () => {
  const registry = createM3RuntimeEventRegistry();
  const valid = policyDraft('policy.evaluated', {
    action: 'provider.launch',
    decision: 'require_approval',
    profileId: 'pprof_fixture',
    matchedRuleCount: 1,
    evaluatedAt: TIMESTAMP,
  });
  const envelope = registry.publish(valid);
  assert.equal(envelope.type, 'policy.evaluated');
  assert.ok(isPolicyEvaluatedPayload(envelope.payload));

  const rejects: Array<Record<string, unknown>> = [
    { action: 'provider.other', decision: 'allow', profileId: 'pprof', matchedRuleCount: 0, evaluatedAt: TIMESTAMP },
    { action: 'provider.launch', decision: 'escalate', profileId: 'pprof', matchedRuleCount: 0, evaluatedAt: TIMESTAMP },
    { action: 'provider.launch', decision: 'allow', profileId: '', matchedRuleCount: 0, evaluatedAt: TIMESTAMP },
    { action: 'provider.launch', decision: 'allow', profileId: 'pprof', matchedRuleCount: -1, evaluatedAt: TIMESTAMP },
    { action: 'provider.launch', decision: 'allow', profileId: 'pprof', matchedRuleCount: 0, evaluatedAt: '2026-10-12T00:00:00Z' },
    { action: 'provider.launch', decision: 'allow', profileId: 'pprof', matchedRuleCount: 0, evaluatedAt: TIMESTAMP, extra: true },
  ];
  for (const [index, payload] of rejects.entries()) {
    assert.throws(
      () => registry.publish(policyDraft('policy.evaluated', payload, { id: `evt_policy_bad_${index}` })),
      (error: unknown) => error instanceof RuntimeEventRegistryError && error.code === 'INVALID_EVENT_PAYLOAD',
      'rejects payload ' + index,
    );
  }
  // The stage scope is enforced by the envelope, not just the payload.
  assert.throws(
    () => registry.publish({ ...valid, id: 'evt_policy_no_stage', stageId: undefined }),
    (error: unknown) => error instanceof RuntimeEventRegistryError && error.code === 'MISSING_STAGE_ID',
  );
});

test('policy.denied publishes only a deny decision', () => {
  const registry = createM3RuntimeEventRegistry();
  const envelope = registry.publish(policyDraft('policy.denied', {
    action: 'provider.launch',
    decision: 'deny',
    profileId: 'pprof_fixture',
    evaluatedAt: TIMESTAMP,
  }));
  assert.ok(isPolicyDeniedPayload(envelope.payload));
  assert.throws(
    () => registry.publish(policyDraft('policy.denied', {
      action: 'provider.launch', decision: 'allow', profileId: 'pprof_fixture', evaluatedAt: TIMESTAMP,
    }, { id: 'evt_policy_deny_bad' })),
    (error: unknown) => error instanceof RuntimeEventRegistryError && error.code === 'INVALID_EVENT_PAYLOAD',
  );
});

test('policy.evaluation_failed requires an error code and accepts an optional timestamp', () => {
  const registry = createM3RuntimeEventRegistry();
  const minimal = registry.publish(policyDraft('policy.evaluation_failed', {
    action: 'provider.launch',
    errorCode: 'POLICY_ENGINE_ERROR',
  }));
  assert.ok(isPolicyEvaluationFailedPayload(minimal.payload));
  assert.equal((minimal.payload as { evaluatedAt?: string }).evaluatedAt, undefined);
  const withTimestamp = registry.publish(policyDraft('policy.evaluation_failed', {
    action: 'provider.launch',
    errorCode: 'POLICY_ENGINE_ERROR',
    evaluatedAt: TIMESTAMP,
  }, { id: 'evt_policy_failed_02', sequence: 2 }));
  assert.ok(isPolicyEvaluationFailedPayload(withTimestamp.payload));
  assert.throws(
    () => registry.publish(policyDraft('policy.evaluation_failed', {
      action: 'provider.launch',
    }, { id: 'evt_policy_failed_bad' })),
    (error: unknown) => error instanceof RuntimeEventRegistryError && error.code === 'INVALID_EVENT_PAYLOAD',
  );
});
