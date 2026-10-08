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
  compaction: {
    conversationId: 'conv_1',
    linkVia: 'turn',
    turnId: 'turn_1',
    contextSnapshotId: 'tsnap_1',
    policy: {
      policyVersion: 'lite-v1', triggerRatio: 0.7, targetRatio: 0.5,
      minRecentMessages: 8, summaryMaxTokens: 2048, maxAutomaticRetries: 1,
    },
    latest: {
      id: 'snap_comp_1', status: 'published', sourceMessageCount: 4,
      sourceStartMessageId: 'msg_1', sourceEndMessageId: 'msg_4',
      summary: 'The runtime keeps Tasks, Runs and Processes distinct.',
      summaryTokenEstimate: 12, candidateId: 'cand_1', model: 'gpt-5.6-luna',
      adapterId: 'cli.codex', attempts: 1, failureCode: null, failureMessage: null,
      publishedAt: '2026-09-01T00:00:02Z',
      budget: {
        historyTokens: 12400, historyBudgetTokens: 16384, triggerRatio: 0.7, targetRatio: 0.5,
        retainedRecentMessages: 8, applicationBudgetSource: 'lite-v1-fallback',
        estimatorVersion: 'lite-v1-chars4',
      },
    },
    tasks: [],
    tasksTruncated: false,
    adoptions: [{ snapshotId: 'tsnap_1', turnId: 'turn_1', summaryId: 'snap_comp_1', summarizedMessages: 4 }],
    rejections: [],
    thisTurn: {
      snapshotId: 'tsnap_1', appliedSummaryId: 'snap_comp_1', summarizedMessages: 4,
      rejectedSummaryId: null, rejectedReason: null,
    },
  },
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

test('INS-08 Compaction explains WHY it ran and WHO adopted the summary', async () => {
  const markup = await render();
  assert.ok(markup.includes('data-agentos="compaction-explanation"'));
  assert.ok(markup.includes('data-compaction-status="published"'));
  // the frozen inputs, as recorded: trigger value against its budget
  assert.ok(markup.includes('12400 / 16384 tokens'));
  assert.ok(markup.includes('trigger 0.7 · target 0.5'));
  assert.ok(markup.includes('lite-v1-fallback'));
  assert.ok(markup.includes('lite-v1-chars4'));
  // the source range, the summary and the policy version
  assert.ok(markup.includes('conv_1 (via turn)'));
  assert.ok(markup.includes('4 messages'));
  assert.ok(markup.includes('The runtime keeps Tasks, Runs and Processes distinct.'));
  assert.ok(markup.includes('lite-v1'));
  // the Turn and Snapshot that actually received it
  assert.ok(markup.includes('this Run · snapshot tsnap_1 · snap_comp_1'));
});

test('INS-09 an absent compaction is named, never rendered as a silent empty section', async () => {
  const notPlaced = await render({ projection: { ...PROJECTION, compaction: null } });
  assert.ok(notPlaced.includes('data-compaction="not-placed"'));
  const noTasks = await render({
    projection: { ...PROJECTION, compaction: { ...PROJECTION.compaction!, latest: null, tasks: [] } },
  });
  assert.ok(noTasks.includes('data-compaction="none"'));
});

test('LITE-12-010 unknown or unavailable read-only enforcement renders modifying', async () => {
  const unknown = await render({ projection: {
    ...PROJECTION,
    overview: {
      ...PROJECTION.overview,
      mutationClass: 'MODIFYING',
      requestedMutationClass: 'READ_ONLY',
      admissionState: 'unknown',
      readOnlyEnforcement: 'unknown',
    },
  } });
  assert.ok(unknown.includes('data-admission-state="unknown"'));
  assert.ok(unknown.includes('data-admission-mutation="MODIFYING">modifying</span>'));
  assert.ok(unknown.includes('data-read-only-enforcement="unknown"'));

  const unavailable = await render({ projection: {
    ...PROJECTION,
    overview: {
      ...PROJECTION.overview,
      mutationClass: 'MODIFYING',
      requestedMutationClass: 'READ_ONLY',
      admissionState: 'QUEUED',
      readOnlyEnforcement: 'unavailable',
    },
  } });
  assert.ok(unavailable.includes('data-admission-mutation="MODIFYING">modifying</span>'));
  assert.ok(unavailable.includes('data-read-only-enforcement="unavailable"'));
});

test('LITE-13-102 Inspector action controls are exposed only through callbacks', async () => {
  const markup = await render({ onCancel: () => {}, onRetry: () => {} });
  assert.ok(markup.includes('data-inspector-action="cancel"'));
  assert.ok(markup.includes('data-inspector-action="retry"'));
  assert.ok(markup.includes('aria-label="Run actions"'));
});
