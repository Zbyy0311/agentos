import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeEventRecord } from '@agentos/shared';
import {
  isLegacyProjectionMetadata,
  projectLegacyRuntimeEvent,
  type LegacyProjectionTaskLog,
  type LegacyRuntimeProjectionContext,
} from './LegacyRuntimeEventAdapter.js';

const context: LegacyRuntimeProjectionContext = {
  taskId: 'legacy-task-1',
  stageById: {
    'stage-manager': { stage: 'codex_manager', agentName: 'Codex Manager' },
    'stage-worker': { stage: 'kimi_worker', agentName: 'Kimi Worker' },
    'stage-reviewer': { stage: 'opencode_reviewer', agentName: 'OpenCode Reviewer' },
  },
};

const taskLog: LegacyProjectionTaskLog = {
  stage: 'kimi_worker',
  agentName: 'Kimi Worker',
  stdout: '## Evidence\n- persisted proof',
  stderr: '',
  exitCode: 0,
  timestamp: '2026-08-10T00:00:00.000Z',
  duration: 12,
  mode: 'real',
};

let eventSequence = 0;

function runtimeEvent(
  type: string,
  overrides: Record<string, unknown> = {},
): RuntimeEventRecord {
  eventSequence += 1;
  return {
    id: `event-${eventSequence}`,
    schemaVersion: 1,
    type,
    workspaceId: 'workspace-1',
    runId: 'run-1',
    sequence: eventSequence,
    timestamp: '2026-08-10T00:00:00.000Z',
    source: 'system',
    correlationId: 'correlation-1',
    severity: 'info',
    visibility: 'public',
    durability: 'durable',
    payload: {},
    ...overrides,
  } as RuntimeEventRecord;
}

test('projects the Legacy-compatible lifecycle and stream frames', () => {
  assert.deepEqual(projectLegacyRuntimeEvent(runtimeEvent('run.started'), context), [
    {
      event: 'status',
      data: {
        taskId: 'legacy-task-1',
        status: 'running',
        currentAgent: null,
        reviewDecision: 'unknown',
        reviewBlocked: false,
      },
    },
  ]);

  assert.deepEqual(projectLegacyRuntimeEvent(runtimeEvent('stage.started', {
    stageId: 'stage-worker',
    payload: {
      workflowStageKey: 'kimi_worker',
      name: 'kimi_worker',
      attempt: 1,
      agentSnapshot: { name: 'Kimi Worker' },
      providerSnapshot: {},
    },
  }), context), [
    { event: 'stage', data: { stage: 'kimi_worker', agent: 'Kimi Worker', status: 'running' } },
  ]);

  assert.deepEqual(projectLegacyRuntimeEvent(runtimeEvent('stream.text_delta', {
    stageId: 'stage-worker',
    payload: { channel: 'assistant', delta: 'hello' },
  }), context), [
    { event: 'thinking', data: { stage: 'kimi_worker', agentName: 'Kimi Worker', text: 'hello', done: false } },
  ]);

  assert.deepEqual(projectLegacyRuntimeEvent(runtimeEvent('stream.text_completed', {
    stageId: 'stage-worker',
    payload: { channel: 'assistant', characterCount: 5 },
  }), context), [
    { event: 'thinking', data: { stage: 'kimi_worker', agentName: 'Kimi Worker', text: '', done: true } },
  ]);

  assert.deepEqual(projectLegacyRuntimeEvent(runtimeEvent('stream.text_completed', {
    payload: { channel: 'assistant', characterCount: 5 },
  }), { ...context, activeStage: context.stageById['stage-worker'] }), [
    { event: 'thinking', data: { stage: 'kimi_worker', agentName: 'Kimi Worker', text: '', done: true } },
  ]);

  assert.deepEqual(projectLegacyRuntimeEvent(runtimeEvent('stage.completed', {
    stageId: 'stage-worker',
    payload: { attempt: 1, durationMs: 12, artifactIds: [], outputContractSatisfied: true },
    metadata: { legacyProjection: { log: taskLog } },
  }), context), [
    { event: 'stage', data: { stage: 'kimi_worker', status: 'completed', log: taskLog } },
  ]);

  assert.deepEqual(projectLegacyRuntimeEvent(runtimeEvent('stage.completed', {
    stageId: 'stage-worker',
    payload: { attempt: 1, durationMs: 12, artifactIds: [], outputContractSatisfied: false },
    metadata: { legacyProjection: { reviewBlocked: true } },
  }), context), [
    { event: 'stage', data: { stage: 'kimi_worker', status: 'completed' } },
    {
      event: 'status',
      data: {
        taskId: 'legacy-task-1',
        status: 'reviewing',
        reviewDecision: 'unknown',
        reviewBlocked: true,
      },
    },
  ]);

  const completedFrames = projectLegacyRuntimeEvent(runtimeEvent('run.completed', {
    metadata: {
      legacyProjection: {
        status: 'completed',
        reviewDecision: 'approve',
        reviewBlocked: false,
      },
    },
  }), context);
  assert.deepEqual(completedFrames, [
    {
      event: 'status',
      data: {
        taskId: 'legacy-task-1',
        status: 'completed',
        reviewDecision: 'approve',
        reviewBlocked: false,
      },
    },
    {
      event: 'done',
      data: {
        taskId: 'legacy-task-1',
        status: 'completed',
        reviewDecision: 'approve',
        reviewBlocked: false,
      },
    },
  ]);

  assert.deepEqual(projectLegacyRuntimeEvent(runtimeEvent('run.failed', {
    metadata: { legacyProjection: { reviewDecision: 'unknown', reviewBlocked: false } },
    payload: {
      errorCode: 'LEGACY_PIPELINE_FAILED',
      message: 'worker exploded',
      phase: 'kimi_worker',
      retryable: true,
    },
  }), context), [
    {
      event: 'status',
      data: {
        taskId: 'legacy-task-1',
        status: 'failed',
        error: 'worker exploded',
        reviewDecision: 'unknown',
        reviewBlocked: false,
      },
    },
    {
      event: 'done',
      data: {
        taskId: 'legacy-task-1',
        status: 'failed',
        error: 'worker exploded',
        reviewDecision: 'unknown',
        reviewBlocked: false,
      },
    },
  ]);

  assert.deepEqual(projectLegacyRuntimeEvent(runtimeEvent('run.cancelled'), context), [
    {
      event: 'status',
      data: {
        taskId: 'legacy-task-1',
        status: 'cancelled',
        error: 'Cancelled',
        reviewDecision: 'unknown',
        reviewBlocked: false,
      },
    },
    {
      event: 'done',
      data: {
        taskId: 'legacy-task-1',
        status: 'cancelled',
        error: 'Cancelled',
        reviewDecision: 'unknown',
        reviewBlocked: false,
      },
    },
  ]);
});

test('returns zero frames for non-projecting, recovery, and future events', () => {
  const zeroProjectionTypes = [
    'run.created',
    'stage.created',
    'stage.ready',
    'run.dequeued',
    'stage.starting',
    'run.recovery_attempted',
    'run.recovered',
    'run.recovery_failed',
    'recovery.future_event',
    'run.future_event',
  ];

  for (const type of zeroProjectionTypes) {
    assert.deepEqual(projectLegacyRuntimeEvent(runtimeEvent(type), context), [], type);
  }

  assert.deepEqual(projectLegacyRuntimeEvent({
    kind: 'unknown_runtime_event',
    raw: { type: 'future.event' },
    id: 'unknown-1',
    type: 'future.event',
    schemaVersion: 99,
    workspaceId: 'workspace-1',
    runId: 'run-1',
    sequence: 99,
    timestamp: '2026-08-10T00:00:00.000Z',
    source: 'future-source',
    correlationId: 'correlation-1',
    severity: 'info',
    visibility: 'public',
    durability: 'durable',
    payload: {},
    warning: 'UNKNOWN_EVENT_TYPE',
  }, context), []);
});

test('keeps the adapter synchronous and pure without reading TaskLog from canonical payload', () => {
  const event = runtimeEvent('stage.completed', {
    stageId: 'stage-worker',
    payload: { attempt: 1, durationMs: 12, artifactIds: [], outputContractSatisfied: true, log: taskLog },
  });
  const frozenEvent = deepFreeze(event);
  const frozenContext = deepFreeze(context);
  const before = JSON.stringify(frozenEvent);

  const result = projectLegacyRuntimeEvent(frozenEvent, frozenContext);

  assert.equal(result instanceof Promise, false);
  assert.deepEqual(result, [
    { event: 'stage', data: { stage: 'kimi_worker', status: 'completed' } },
  ]);
  assert.equal(JSON.stringify(frozenEvent), before);
  assert.deepEqual(frozenContext, context);
});

test('guards JSON-safe legacy projection evidence and fails closed on malformed metadata', () => {
  assert.equal(isLegacyProjectionMetadata({ legacyProjection: { log: taskLog } }), true);
  assert.equal(isLegacyProjectionMetadata({
    legacyProjection: {
      stage: 'kimi_worker',
      agentName: 'Kimi Worker',
      status: 'failed',
      reviewDecision: 'unknown',
      reviewBlocked: false,
      error: 'worker exploded',
    },
  }), true);
  assert.equal(isLegacyProjectionMetadata({ legacyProjection: { status: 'completed', reviewBlocked: false } }), true);
  assert.equal(isLegacyProjectionMetadata({ legacyProjection: { reviewBlocked: 'yes' } }), false);
  assert.equal(isLegacyProjectionMetadata({ legacyProjection: { status: 'completed', extra: true } }), false);
  assert.equal(isLegacyProjectionMetadata({ legacyProjection: { log: { ...taskLog, stdout: 1 } } }), false);
  assert.equal(isLegacyProjectionMetadata(null), false);

  const malformed = runtimeEvent('run.completed', {
    metadata: { legacyProjection: { status: 'completed', reviewBlocked: 'yes' } },
  });
  assert.doesNotThrow(() => projectLegacyRuntimeEvent(malformed, context));
  assert.deepEqual(projectLegacyRuntimeEvent(malformed, context), []);

  const malformedStage = runtimeEvent('stage.completed', {
    stageId: 'stage-worker',
    metadata: { legacyProjection: { log: { stage: 'kimi_worker' } } },
  });
  assert.deepEqual(projectLegacyRuntimeEvent(malformedStage, context), []);
});

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
