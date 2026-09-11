import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { InspectorProjectionDto } from './RuntimeInspectorView.js';

const PROJECTION: InspectorProjectionDto = {
  overview: {
    runId: 'run_1', taskId: 'task_1', status: 'completed', reason: 'initial', origin: 'v2_api',
    attempt: 1, createdAt: '2026-09-01T00:00:00Z', startedAt: '2026-09-01T00:00:01Z',
    completedAt: '2026-09-01T00:00:04Z', durationMs: 3000, lastEventSequence: 12,
  },
  stages: [
    { stageId: 'stage_1', workflowStageKey: 'plan', status: 'completed', attempt: 1, durationMs: 1000 },
    { stageId: 'stage_2', workflowStageKey: 'implement', status: 'failed', attempt: 2, failureCode: 'X' },
  ],
  processes: [
    { processId: 'proc_1', status: 'terminated', platform: 'windows', nativePidEvidenceOnly: 5123, exitCode: 0, terminationReason: 'completed' },
  ],
  events: [
    { eventId: 'evt_1', sequence: 1, type: 'run.started', timestamp: 't', severity: 'info' },
    { eventId: 'evt_2', sequence: 2, type: 'stage.completed', timestamp: 't', severity: 'info' },
  ],
  highWatermark: 12,
  memoryContext: {
    memoryContextId: 'mctx_1', queryHash: 'qh', retrievalStrategyVersion: 'mf3-ranking-v1',
    totalTokens: 42, truncated: false, createdAt: '2026-09-01T00:00:00Z',
    selected: [{
      memoryId: 'mem_1', memoryVersion: 1, rank: 1, score: 42.5, scope: 'workspace',
      category: 'decision', authority: 'system-verified', confidence: 0.9, importance: 0.8,
      tokenCost: 42, reasons: ['scope-match', 'importance'], sourceRefs: [{ kind: 'run', id: 'run_1' }],
    }],
    exclusions: [{ memoryId: 'mem_2', reason: 'below-confidence' }],
  },
  truncated: false,
};

async function render(overrides: Record<string, unknown> = {}): Promise<string> {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const { RuntimeInspectorView } = await import('./RuntimeInspectorView.js');
  return renderToStaticMarkup(<RuntimeInspectorView theme="dark" projection={PROJECTION} {...overrides} />);
}

test('INS-01 the Run overview is distinct from Task/Process and shows duration', async () => {
  const markup = await render();
  assert.ok(markup.includes('data-agentos="runtime-inspector"'));
  assert.ok(markup.includes('run_1'));
  assert.ok(markup.includes('task_1'));
  assert.ok(markup.includes('3.0 s'));
  assert.ok(markup.includes('completed'));
});

test('INS-02 Stages list each Stage with its own status, never collapsed into Run state', async () => {
  const markup = await render();
  assert.ok(markup.includes('Stages (2)'));
  assert.ok(markup.includes('plan'));
  assert.ok(markup.includes('implement'));
  assert.ok(markup.includes('data-status="failed"'));
});

test('INS-03 the Process view labels the native PID as evidence-only, never as identity', async () => {
  const markup = await render();
  assert.ok(markup.includes('proc_1'));
  assert.ok(markup.includes('pid 5123 (evidence)'));
});

test('INS-04 Events render in strict sequence with their own ids', async () => {
  const markup = await render();
  assert.ok(markup.includes('Events (2)'));
  assert.ok(markup.indexOf('run.started') < markup.indexOf('stage.completed'));
  assert.ok(markup.includes('data-event-seq="1"'));
  assert.ok(markup.includes('data-event-seq="2"'));
});

test('INS-05 Memory Context is a section, and its absence is named, not hidden', async () => {
  const withMem = await render();
  assert.ok(withMem.includes('Memory Context'));
  assert.ok(withMem.includes('42'));
  const noMem = await render({ projection: { ...PROJECTION, memoryContext: null } });
  assert.ok(noMem.includes('No Memory Context snapshot'));
});

test('INS-07 Memory Context explains selection and exclusion from the frozen Snapshot', async () => {
  const markup = await render();
  assert.ok(markup.includes('data-agentos="memory-explanation"'));
  assert.ok(markup.includes('mctx_1'));
  assert.ok(markup.includes('mf3-ranking-v1'));
  assert.ok(markup.includes('#1 mem_1'));
  assert.ok(markup.includes('scope-match, importance'));
  assert.ok(markup.includes('run:run_1'));
  assert.ok(markup.includes('mem_2'));
  assert.ok(markup.includes('below-confidence'));
});

test('INS-06 a section error is an alert, never a page failure', async () => {
  const markup = await render({ error: 'RUNTIME_INSPECTOR_RUN_NOT_FOUND' });
  assert.ok(markup.includes('role="alert"'));
  assert.ok(markup.includes('RUNTIME_INSPECTOR_RUN_NOT_FOUND'));
  // the rest of the page still renders
  assert.ok(markup.includes('run_1'));
});
