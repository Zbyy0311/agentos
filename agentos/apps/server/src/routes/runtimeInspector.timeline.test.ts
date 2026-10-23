import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { RunSnapshotPayloadV1 } from '@agentos/shared';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createEntityId } from '../store/Identity.js';
import {
  M25_UNBOUND_DEFINITION_HASH,
  M25_UNBOUND_DEFINITION_KEY,
  M25_UNBOUND_DEFINITION_NAME,
  M25_UNBOUND_WORKFLOW_ID,
} from '../migrations/migrations/007-workflow-definitions.js';
import { createRuntimeInspectorRoutes } from './runtimeInspector.js';

/**
 * §39-46 Timeline projection route tests: modes, §42 aggregation, §43 grouping,
 * §44 filters and stable afterSequence/limit pagination, plus the §135
 * 410 CURSOR_EXPIRED contract for an unreconcilable cursor.
 */

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-inspector-timeline-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
      agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
      lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
    }],
  }), 'utf-8');
  return root;
}

interface TimelineFx {
  baseUrl: string;
  store: SqliteStore;
  runId: string;
  stageId: string;
}

async function withServer(run: (fx: TimelineFx) => Promise<void>): Promise<void> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  try {
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId/runtime', createRuntimeInspectorRoutes(store, new WorkspaceManager(store)));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    const task = store.taskRepository().insert({ workspaceId: 'workspace-a', title: 'T', createdBy: 'user' });
    const created = store.runRepository().insert({ workspaceId: 'workspace-a', taskId: task.id, origin: 'v2_api', createdBy: 'user' });
    const snapshot = store.runSnapshotRepository().insert({
      workspaceId: 'workspace-a',
      runId: created.id,
      workflowDefinitionId: M25_UNBOUND_WORKFLOW_ID,
      payload: {
        schemaVersion: 1,
        capturedAt: '2026-10-20T00:00:00.000Z',
        run: {
          workspaceId: 'workspace-a',
          taskId: task.id,
          origin: created.origin,
          reason: created.reason,
          parentRunId: created.parentRunId ?? null,
          rootRunId: created.rootRunId,
        },
        workflow: {
          definitionId: M25_UNBOUND_WORKFLOW_ID,
          definitionKey: M25_UNBOUND_DEFINITION_KEY,
          definitionVersion: 1,
          name: M25_UNBOUND_DEFINITION_NAME,
          definitionHash: M25_UNBOUND_DEFINITION_HASH,
          stages: [],
        },
        security: { redactionApplied: false },
      } satisfies RunSnapshotPayloadV1,
    });
    const stage = store.runStageRepository().insertInitial({
      workspaceId: 'workspace-a',
      runId: created.id,
      runSnapshotId: snapshot.id,
      workflowStageKey: 'timeline-test',
      sequence: 1,
    });
    const fx: TimelineFx = {
      baseUrl: `http://127.0.0.1:${address.port}/api/workspaces/workspace-a/runtime`,
      store,
      runId: created.id,
      stageId: stage.id,
    };
    seedTimelineEvents(fx.store, fx.runId, fx.stageId);
    await run(fx);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * seq 1 run.started
 * seq 2-4 stream.text_delta (same stage + correlation)   -> §42 fold of 3
 * seq 5 approval.required                                -> §42 individual
 * seq 6-7 stream.text_delta (same stage, new correlation)-> §42 fold of 2
 * seq 8 run.failed (severity error)                      -> §42 individual
 */
function seedTimelineEvents(store: SqliteStore, runId: string, stageId: string): void {
  const append = (input: {
    type: string;
    payload: Record<string, unknown>;
    source: string;
    stageId?: string;
    approvalRequestId?: string;
  }): void => {
    store.runInTransaction(() => {
      const sequence = store.runSequenceAllocator().allocateWithinTransaction('workspace-a', runId);
      store.runtimeEventRepository().appendWithinTransaction({
        id: createEntityId('event'),
        schemaVersion: 1,
        type: input.type,
        workspaceId: 'workspace-a',
        runId,
        sequence,
        timestamp: `2026-10-20T00:00:0${Math.min(sequence, 9)}.000Z`,
        source: input.source as never,
        correlationId: sequence <= 4 ? 'corr-a' : sequence <= 7 ? 'corr-b' : 'corr-c',
        causationId: 'op_timeline_test',
        ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
        ...(input.approvalRequestId === undefined ? {} : { approvalRequestId: input.approvalRequestId }),
        payload: input.payload as never,
      });
    });
  };

  append({ type: 'run.started', source: 'run-engine', payload: { startedAt: '2026-10-20T00:00:01.000Z' } });
  for (let index = 0; index < 3; index += 1) {
    append({ type: 'stream.text_delta', source: 'stage-executor', stageId, payload: { channel: 'assistant', delta: `d${index}` } });
  }
  append({
    type: 'approval.required', source: 'approval-service', approvalRequestId: 'approval_1',
    payload: {
      category: 'file-delete', riskLevel: 'high', title: 'Apply edits',
      description: 'The agent requests a workspace write.', requestSummary: { files: 2 },
    },
  });
  for (let index = 0; index < 2; index += 1) {
    append({ type: 'stream.text_delta', source: 'stage-executor', stageId, payload: { channel: 'assistant', delta: `e${index}` } });
  }
  append({
    type: 'run.failed', source: 'run-engine',
    payload: { errorCode: 'E_STAGE', message: 'stage failed', phase: 'execute', retryable: false },
  });
}

interface TimelineBody {
  timeline: {
    runId: string;
    mode: string;
    group: string;
    items: Array<{
      id: string; kind: string; type: string; title: string;
      firstSequence: number; lastSequence: number;
      aggregated: boolean; eventCount: number; summary?: string;
      stageId?: string; severity?: string;
      payloadSummary?: { keys: string[]; preview: string };
    }>;
    groups: Array<{ key: string; label: string; items: unknown[] }>;
    highWatermark: number;
    nextAfterSequence: number;
    hasMore: boolean;
    retentionWarning: boolean;
  };
}

async function getTimeline(fx: TimelineFx, query: string): Promise<{ status: number; body: TimelineBody | { code?: string } }> {
  const response = await fetch(`${fx.baseUrl}/runs/${fx.runId}/inspector/timeline?${query}`);
  const body = await response.json() as TimelineBody | { code?: string };
  return { status: response.status, body };
}

test('timeline summary mode aggregates stream.text_delta and keeps terminal/approval/error individual', async () => {
  await withServer(async fx => {
    const { status, body } = await getTimeline(fx, 'mode=summary');
    assert.equal(status, 200);
    const timeline = (body as TimelineBody).timeline;
    assert.equal(timeline.mode, 'summary');
    assert.equal(timeline.group, 'none');
    // run.started, fold(3), approval.required, fold(2), run.failed
    assert.equal(timeline.items.length, 5);
    const [started, foldA, approval, foldB, failed] = timeline.items;
    assert.equal(started!.aggregated, false);
    assert.equal(foldA!.aggregated, true);
    assert.equal(foldA!.type, 'stream.text_delta');
    assert.equal(foldA!.eventCount, 3);
    assert.equal(foldA!.firstSequence, 2);
    assert.equal(foldA!.lastSequence, 4);
    assert.equal(foldA!.summary, '3 × stream.text_delta');
    assert.equal(approval!.kind, 'approval');
    assert.equal(approval!.aggregated, false);
    assert.equal(foldB!.eventCount, 2);
    assert.equal(failed!.kind, 'run');
    assert.equal(failed!.severity, 'error');
    assert.equal(timeline.highWatermark, 8);
    assert.equal(timeline.nextAfterSequence, 8);
    assert.equal(timeline.hasMore, false);
  });
});

test('timeline detailed mode keeps one item per Event and raw mode adds a bounded payload digest', async () => {
  await withServer(async fx => {
    const detailed = await getTimeline(fx, 'mode=detailed');
    assert.equal(detailed.status, 200);
    const detailedItems = (detailed.body as TimelineBody).timeline.items;
    assert.equal(detailedItems.length, 8);
    assert.ok(detailedItems.every(item => item.aggregated === false && item.eventCount === 1));
    assert.equal(detailedItems[1]!.summary, undefined);

    const repository = fx.store.runtimeEventRepository();
    const originalList = repository.listByRunAfterSequence.bind(repository);
    fx.store.eventRedactionService().registerSecrets('workspace-a', ['timeline-known-secret-canary']);
    Object.defineProperty(repository, 'listByRunAfterSequence', {
      configurable: true,
      value: (runId: string, afterSequence: number, limit?: number) => originalList(runId, afterSequence, limit).map(record => (
        record.event.sequence === 1
          ? { ...record, event: { ...record.event, payload: {
            startedAt: '2026-10-20T00:00:01.000Z',
            apiKey: 'timeline-secret-field-canary',
            environment: { API_TOKEN: 'timeline-known-secret-canary' },
            diagnostic: 'response contained timeline-known-secret-canary',
          } } }
          : record
      )),
    });
    try {
      const raw = await getTimeline(fx, 'mode=raw');
      assert.equal(raw.status, 200);
      const rawItems = (raw.body as TimelineBody).timeline.items;
      assert.equal(rawItems.length, 8);
      const delta = rawItems.find(item => item.type === 'stream.text_delta')!;
      assert.deepEqual(delta.payloadSummary!.keys.sort(), ['channel', 'delta']);
      assert.ok(delta.payloadSummary!.preview.includes('assistant'));
      const started = rawItems[0]!;
      assert.deepEqual(started.payloadSummary!.keys, ['startedAt', 'apiKey', 'environment', 'diagnostic']);
      assert.ok(started.payloadSummary!.preview.includes('[REDACTED]'));
      assert.equal(started.payloadSummary!.preview.includes('timeline-secret-field-canary'), false);
      assert.equal(started.payloadSummary!.preview.includes('timeline-known-secret-canary'), false);
    } finally {
      Reflect.deleteProperty(repository, 'listByRunAfterSequence');
    }
  });
});

test('timeline filters by §44 types, severity and stageId', async () => {
  await withServer(async fx => {
    const byType = await getTimeline(fx, 'types=stream.text_delta,approval.required');
    assert.equal((byType.body as TimelineBody).timeline.items.length, 3);

    const bySeverity = await getTimeline(fx, 'severity=error');
    const errorItems = (bySeverity.body as TimelineBody).timeline.items;
    assert.equal(errorItems.length, 1);
    assert.equal(errorItems[0]!.type, 'run.failed');

    const byStage = await getTimeline(fx, `stageId=${fx.stageId}&mode=detailed`);
    const stageItems = (byStage.body as TimelineBody).timeline.items;
    assert.equal(stageItems.length, 5);
    assert.ok(stageItems.every(item => item.stageId === fx.stageId));

    const emptyStage = await getTimeline(fx, 'stageId=stage_missing');
    assert.equal((emptyStage.body as TimelineBody).timeline.items.length, 0);
    const byDomain = await getTimeline(fx, 'domain=stream&mode=detailed');
    assert.equal((byDomain.body as TimelineBody).timeline.items.length, 5);
    assert.ok((byDomain.body as TimelineBody).timeline.items.every(item => item.type === 'stream.text_delta'));
  });
});

test('timeline groups by stage, correlation and domain', async () => {
  await withServer(async fx => {
    const byStage = await getTimeline(fx, 'group=stage');
    const stageGroups = (byStage.body as TimelineBody).timeline.groups;
    const keys = stageGroups.map(group => group.key).sort();
    assert.deepEqual(keys, [fx.stageId, 'unstaged']);
    const staged = stageGroups.find(group => group.key === fx.stageId)!;
    // fold(3) + approval + fold(2): approval carries no stageId, so stage_1
    // only holds the two text_delta folds.
    assert.equal(staged.items.length, 2);

    const byCorrelation = await getTimeline(fx, 'group=correlation');
    const correlationKeys = (byCorrelation.body as TimelineBody).timeline.groups.map(group => group.key).sort();
    assert.deepEqual(correlationKeys, ['corr-a', 'corr-b', 'corr-c']);

    const byDomain = await getTimeline(fx, 'group=domain');
    const domainKeys = (byDomain.body as TimelineBody).timeline.groups.map(group => group.key).sort();
    assert.deepEqual(domainKeys, ['approval', 'run', 'stream']);
  });
});

test('timeline paginates over raw Event order with a stable cursor', async () => {
  await withServer(async fx => {
    const first = await getTimeline(fx, 'mode=detailed&limit=4');
    const firstTimeline = (first.body as TimelineBody).timeline;
    assert.equal(first.status, 200);
    assert.equal(firstTimeline.items.length, 4);
    assert.equal(firstTimeline.items[3]!.firstSequence, 4);
    assert.equal(firstTimeline.nextAfterSequence, 4);
    assert.equal(firstTimeline.hasMore, true);
    assert.equal(firstTimeline.highWatermark, 8);

    const second = await getTimeline(fx, `mode=detailed&limit=4&afterSequence=${firstTimeline.nextAfterSequence}`);
    const secondTimeline = (second.body as TimelineBody).timeline;
    assert.equal(secondTimeline.items.length, 4);
    assert.equal(secondTimeline.items[0]!.firstSequence, 5);
    assert.equal(secondTimeline.nextAfterSequence, 8);
    assert.equal(secondTimeline.hasMore, false);
  });
});

test('timeline rejects invalid mode, group, limit and unknown runs', async () => {
  await withServer(async fx => {
    assert.equal((await getTimeline(fx, 'mode=bogus')).status, 400);
    assert.equal((await getTimeline(fx, 'group=bogus')).status, 400);
    assert.equal((await getTimeline(fx, 'limit=0')).status, 400);
    assert.equal((await getTimeline(fx, 'limit=1001')).status, 400);
    const missing = await fetch(`${fx.baseUrl}/runs/run_missing/inspector/timeline`);
    assert.equal(missing.status, 404);
  });
});

test('timeline rejects a cursor beyond the durable tail and keeps the Lite Inspector compatible', async () => {
  await withServer(async fx => {
    const response = await fetch(`${fx.baseUrl}/runs/${fx.runId}/inspector/timeline?afterSequence=99`);
    assert.equal(response.status, 400);
    const body = await response.json() as { code?: string };
    assert.equal(body.code, 'INPUT_INVALID');
    // §135: the Lite single projection stays cursor-free and unaffected.
    const lite = await fetch(`${fx.baseUrl}/runs/${fx.runId}/inspector`);
    assert.equal(lite.status, 200);
  });
});

test('timeline returns 410 for a retained-history gap and exposes available history on a full sync', async () => {
  await withServer(async fx => {
    const removed = fx.store.runtimeEventRepository().findByRunAndSequence(fx.runId, 3)!.event;
    fx.store.runInTransaction(() => {
      fx.store.runtimeEventRepository().deleteEligibleEventsWithinTransaction([removed.id]);
    });

    const expired = await getTimeline(fx, 'afterSequence=2');
    assert.equal(expired.status, 410);
    assert.equal((expired.body as { code?: string }).code, 'CURSOR_EXPIRED');

    const fullSync = await getTimeline(fx, 'afterSequence=0');
    assert.equal(fullSync.status, 200);
    assert.equal((fullSync.body as TimelineBody).timeline.retentionWarning, true);
  });
});

test('full history pagination scans a deleted page boundary without returning an expired next cursor', async () => {
  await withServer(async fx => {
    const removed = fx.store.runtimeEventRepository().findByRunAndSequence(fx.runId, 3)!.event;
    fx.store.runInTransaction(() => fx.store.runtimeEventRepository().deleteEligibleEventsWithinTransaction([removed.id]));
    const first = await getTimeline(fx, 'afterSequence=0&limit=2&mode=raw');
    const timeline = (first.body as TimelineBody).timeline;
    assert.equal(timeline.nextAfterSequence, 3);
    assert.equal(timeline.retentionWarning, true);
    assert.deepEqual(timeline.items.map(item => item.firstSequence), [1, 2]);
    const next = await getTimeline(fx, `afterSequence=${timeline.nextAfterSequence}&limit=2&mode=raw`);
    assert.equal(next.status, 200);
    assert.deepEqual((next.body as TimelineBody).timeline.items.map(item => item.firstSequence), [4, 5]);
  });
});

test('full sync advances across deleted tail and fully expired history without reconnect loops', async () => {
  await withServer(async fx => {
    const task = fx.store.taskRepository().insert({ workspaceId: 'workspace-a', title: 'Retention', createdBy: 'user' });
    const run = fx.store.runRepository().insert({ workspaceId: 'workspace-a', taskId: task.id, origin: 'v2_api', createdBy: 'user' });
    fx = { ...fx, runId: run.id };
    for (let index = 0; index < 4; index += 1) fx.store.runInTransaction(() => {
      const sequence = fx.store.runSequenceAllocator().allocateWithinTransaction('workspace-a', fx.runId);
      fx.store.runtimeEventRepository().appendWithinTransaction({
        id: createEntityId('event'), schemaVersion: 1, type: 'run.started', workspaceId: 'workspace-a',
        runId: fx.runId, sequence, timestamp: '2026-10-22T00:00:00.000Z', source: 'run-engine',
        correlationId: 'corr_retention', causationId: 'op_retention', payload: { startedAt: '2026-10-22T00:00:00.000Z' },
      });
    });
    const events = fx.store.runtimeEventRepository().listByRunAfterSequence(fx.runId, 0);
    fx.store.runInTransaction(() => fx.store.runtimeEventRepository().deleteEligibleEventsWithinTransaction(
      events.filter(record => record.event.sequence > 2).map(record => record.event.id),
    ));
    const remaining = (await getTimeline(fx, 'afterSequence=0&mode=raw')).body as TimelineBody;
    assert.equal(remaining.timeline.nextAfterSequence, 4);
    assert.equal(remaining.timeline.retentionWarning, true);
    assert.equal(remaining.timeline.items.length, 2);
    assert.equal((await getTimeline(fx, 'afterSequence=4')).status, 200);
    fx.store.runInTransaction(() => fx.store.runtimeEventRepository().deleteEligibleEventsWithinTransaction(
      events.filter(record => record.event.sequence <= 2).map(record => record.event.id),
    ));
    assert.equal((await getTimeline(fx, 'afterSequence=2')).status, 410);
    const empty = (await getTimeline(fx, 'afterSequence=0')).body as TimelineBody;
    assert.equal(empty.timeline.items.length, 0);
    assert.equal(empty.timeline.retentionWarning, true);
    assert.equal(empty.timeline.nextAfterSequence, 4);
  });
});

test('empty filtered pages retain their raw cursor and the repository read is bounded to limit plus one', async () => {
  await withServer(async fx => {
    const repository = fx.store.runtimeEventRepository();
    const original = repository.listByRunAfterSequence.bind(repository);
    const limits: Array<number | undefined> = [];
    Object.defineProperty(repository, 'listByRunAfterSequence', {
      configurable: true,
      value: (runId: string, after: number, limit?: number) => { limits.push(limit); return original(runId, after, limit); },
    });
    try {
      const first = (await getTimeline(fx, 'domain=approval&limit=4')).body as TimelineBody;
      assert.equal(first.timeline.items.length, 0);
      assert.equal(first.timeline.nextAfterSequence, 4);
      assert.equal(first.timeline.hasMore, true);
      const next = (await getTimeline(fx, 'domain=approval&limit=4&afterSequence=4')).body as TimelineBody;
      assert.deepEqual(next.timeline.items.map(item => item.type), ['approval.required']);
      assert.deepEqual(limits, [5, 5]);
    } finally { Reflect.deleteProperty(repository, 'listByRunAfterSequence'); }
  });
});
