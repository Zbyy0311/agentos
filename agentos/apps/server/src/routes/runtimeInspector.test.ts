import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import { createRuntimeInspectorRoutes } from './runtimeInspector.js';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-inspector-route-'));
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

async function withServer(run: (baseUrl: string, store: SqliteStore) => Promise<void>): Promise<void> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  try {
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId/runtime', createRuntimeInspectorRoutes(store, new WorkspaceManager(store)));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/api/workspaces/workspace-a/runtime`, store);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * LITE-08-004 / LITE-13-002: when read-only could not be proven the Run is
 * MODIFYING, and the Inspector has to say so instead of leaving the effective
 * class unknown. A Run with no admission row keeps its authority state
 * explicitly `unknown`, which is distinct from the effective fail-closed class.
 */
test('GET /runs/:runId/inspector names the effective mutation class and the read-only enforcement state', async () => {
  await withServer(async (baseUrl, store) => {
    const task = store.taskRepository().insert({ workspaceId: 'workspace-a', title: 'T', createdBy: 'user' });
    const run = store.runRepository().insert({ workspaceId: 'workspace-a', taskId: task.id, origin: 'v2_api', createdBy: 'user' });

    // No admission row yet: the classification is genuinely unknown.
    const before = await fetch(`${baseUrl}/runs/${run.id}/inspector`).then(r => r.json()) as {
      projection: { overview: { mutationClass: string; admissionState: string; readOnlyEnforcement: string } };
    };
    assert.equal(before.projection.overview.mutationClass, 'MODIFYING');
    assert.equal(before.projection.overview.admissionState, 'unknown');
    assert.equal(before.projection.overview.readOnlyEnforcement, 'unknown');

    // A read-only request whose enforcement could not be proven is persisted as
    // MODIFYING; the Inspector must report that durable fact rather than imply
    // that enforcement was available.
    const now = '2026-09-12T20:00:00.000Z';
    store.getDatabase().prepare(`INSERT INTO workspace_admissions (
      id, workspace_id, subject_kind, canonical_run_id, legacy_run_id,
      requested_mutation_class, effective_mutation_class, enforcement_evidence_json,
      request_order, state, queue_reason, release_reason, requested_at, granted_at,
      released_at, created_at, updated_at, version
    ) VALUES (?, ?, 'CANONICAL_RUN', ?, NULL, 'READ_ONLY', 'MODIFYING', NULL, 1, 'GRANTED', NULL, NULL, ?, ?, NULL, ?, ?, 1)`)
      .run('adm_inspector_1', 'workspace-a', run.id, now, now, now, now);

    const after = await fetch(`${baseUrl}/runs/${run.id}/inspector`).then(r => r.json()) as {
      projection: { overview: { mutationClass: string | null; requestedMutationClass: string | null; readOnlyEnforcement: string } };
    };
    assert.equal(after.projection.overview.mutationClass, 'MODIFYING');
    assert.equal(after.projection.overview.requestedMutationClass, 'READ_ONLY');
    assert.equal(after.projection.overview.readOnlyEnforcement, 'unavailable');
  });
});

test('GET /runs/:runId/inspector returns the redacted projection for a canonical Run', async () => {
  await withServer(async (baseUrl, store) => {
    const task = store.taskRepository().insert({ workspaceId: 'workspace-a', title: 'T', createdBy: 'user' });
    const run = store.runRepository().insert({ workspaceId: 'workspace-a', taskId: task.id, origin: 'v2_api', createdBy: 'user' });
    const response = await fetch(`${baseUrl}/runs/${run.id}/inspector`);
    assert.equal(response.status, 200);
    const body = await response.json() as { projection: { overview: { runId: string; status: string }; stages: unknown[]; events: unknown[]; highWatermark: number } };
    assert.equal(body.projection.overview.runId, run.id);
    assert.equal(body.projection.overview.status, 'queued');
    assert.ok(Array.isArray(body.projection.stages));
    assert.ok(Array.isArray(body.projection.events));
  });
});

test('GET /runs/:runId/inspector fails closed for an unknown Run and workspace', async () => {
  await withServer(async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/runs/run_missing/inspector`);
    assert.equal(missing.status, 404);
  });
});

test('GET /runs/:runId/inspector surfaces the frozen Memory Context (MF-5 wiring)', async () => {
  await withServer(async (baseUrl, store) => {
    const task = store.taskRepository().insert({ workspaceId: 'workspace-a', title: 'T', createdBy: 'user' });
    const run = store.runRepository().insert({ workspaceId: 'workspace-a', taskId: task.id, origin: 'v2_api', createdBy: 'user' });
    const db = store.getDatabase();
    const entryId = 'mem_' + 'e'.repeat(26);
    new MemoryEntryRepository(db).createEntry({
      id: entryId,
      workspaceId: 'workspace-a',
      scope: 'workspace',
      category: 'decision',
      authority: 'system-verified',
      confidence: 0.9,
      importance: 0.8,
      title: 'Inspector-visible memory',
      status: 'active',
      sources: [{ kind: 'run', id: run.id }],
      createdAt: '2026-09-11T00:00:00.000Z',
    });
    const snapshotId = 'mctx_' + 'i'.repeat(26);
    new MemoryContextSnapshotRepository(db).createSnapshot({
      id: snapshotId,
      workspaceId: 'workspace-a',
      taskId: task.id,
      runId: run.id,
      queryHash: 'qh',
      retrievalStrategyVersion: 'mf3-ranking-v1',
      budget: {
        maxTokens: 100, maxEntries: 5, perScopeLimits: {}, perCategoryLimits: {},
        minConfidence: 0.5, minImportance: 0.3, maxTruncation: 1, requireDiversity: false,
      },
      totalTokens: 10,
      truncated: false,
      createdAt: '2026-09-11T00:00:01.000Z',
      selected: [{
        memoryId: entryId, memoryVersion: 1, rank: 1, score: 42.5,
        scope: 'workspace', category: 'decision', authority: 'system-verified',
        confidence: 0.9, importance: 0.8, tokenCost: 10,
        reasons: ['scope-match'], sourceRefs: [{ kind: 'run', id: run.id }],
      }],
      exclusions: [],
    });

    const response = await fetch(`${baseUrl}/runs/${run.id}/inspector`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      projection: { memoryContext: { memoryContextId: string; selected: Array<{ memoryId: string }> } | null };
    };
    assert.equal(body.projection.memoryContext?.memoryContextId, snapshotId);
    assert.equal(body.projection.memoryContext?.selected[0]?.memoryId, entryId);
  });
});

/**
 * LITE-13-101: a Run carried by a Turn that adopted a compaction summary must
 * explain that decision, and a Run whose Turn refused a summary must explain the
 * refusal. Both verdicts are read from that Run own snapshot row, so a Run can
 * never borrow another Turn explanation. The write path that produces these rows
 * is proven end to end in conversationRuntime.compaction.test.ts; this test
 * proves the Run-scoped projection over durable rows.
 */
test('GET /runs/:runId/inspector explains the compaction of the Conversation behind the Run', async () => {
  await withServer(async (baseUrl, store) => {
    const db = store.getDatabase();
    const now = '2026-09-13T00:00:00.000Z';
    db.prepare(
      'INSERT INTO cr_conversations (id, workspace_id, kind, title, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    ).run('conv_insp', 'workspace-a', 'direct', 'Inspector conversation', 'active', now, now);

    const adoptingTask = store.taskRepository().insert({ workspaceId: 'workspace-a', title: 'Adopting', createdBy: 'user' });
    const adoptingRun = store.runRepository().insert({
      workspaceId: 'workspace-a', taskId: adoptingTask.id, origin: 'v2_api', createdBy: 'user',
    });
    const refusingTask = store.taskRepository().insert({ workspaceId: 'workspace-a', title: 'Refusing', createdBy: 'user' });
    const refusingRun = store.runRepository().insert({
      workspaceId: 'workspace-a', taskId: refusingTask.id, origin: 'v2_api', createdBy: 'user',
    });

    db.prepare(
      'INSERT INTO cr_agent_turns (id, conversation_id, workspace_id, agent_id, status, context_snapshot_id, run_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
    ).run('turn_apply', 'conv_insp', 'workspace-a', 'codex', 'final', 'tsnap_apply', adoptingRun.id, now, now);
    db.prepare(
      'INSERT INTO cr_turn_context_snapshots (id, workspace_id, conversation_id, agent_id, turn_id, budget_json, selected_entry_ids_json, total_tokens, truncated, retrieval_strategy_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)',
    ).run('tsnap_apply', 'workspace-a', 'conv_insp', 'codex', 'turn_apply',
      JSON.stringify({ compactionSummaryId: 'snap_comp_1', summarizedMessages: 3, frozenHistoryMessages: 4 }),
      JSON.stringify([]), 'cr5-turn-context.v1', now);

    db.prepare(
      'INSERT INTO cr_agent_turns (id, conversation_id, workspace_id, agent_id, status, context_snapshot_id, run_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
    ).run('turn_refuse', 'conv_insp', 'workspace-a', 'codex', 'final', 'tsnap_refuse', refusingRun.id, now, now);
    db.prepare(
      'INSERT INTO cr_turn_context_snapshots (id, workspace_id, conversation_id, agent_id, turn_id, budget_json, selected_entry_ids_json, total_tokens, truncated, retrieval_strategy_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)',
    ).run('tsnap_refuse', 'workspace-a', 'conv_insp', 'codex', 'turn_refuse',
      JSON.stringify({ rejectedCompactionSummaryId: 'snap_comp_stale', rejectedCompactionReason: 'source-content-changed' }),
      JSON.stringify([]), 'cr5-turn-context.v1', now);

    const adopting = await fetch(`${baseUrl}/runs/${adoptingRun.id}/inspector`).then(r => r.json()) as {
      projection: {
        compaction: {
          conversationId: string; linkVia: string; turnId: string | null; contextSnapshotId: string | null;
          policy: unknown; latest: unknown; tasks: unknown[];
          adoptions: Array<{ snapshotId: string; turnId: string | null; summaryId: string; summarizedMessages: number | null }>;
          rejections: Array<{ snapshotId: string; turnId: string | null; summaryId: string; reason: string }>;
          thisTurn: { snapshotId: string; appliedSummaryId: string | null; summarizedMessages: number | null; rejectedSummaryId: string | null; rejectedReason: string | null } | null;
        } | null;
      };
    };
    const explanation = adopting.projection.compaction;
    assert.ok(explanation, 'a Turn-backed Run is placed in its Conversation');
    assert.equal(explanation.linkVia, 'turn');
    assert.equal(explanation.conversationId, 'conv_insp');
    assert.equal(explanation.turnId, 'turn_apply');
    assert.equal(explanation.contextSnapshotId, 'tsnap_apply');
    // The summary this Run received, read from its own snapshot row.
    assert.equal(explanation.thisTurn?.snapshotId, 'tsnap_apply');
    assert.equal(explanation.thisTurn?.appliedSummaryId, 'snap_comp_1');
    assert.equal(explanation.thisTurn?.summarizedMessages, 3);
    // No compaction task exists yet in this Conversation, so nothing is invented.
    assert.equal(explanation.latest, null);
    assert.equal(explanation.policy, null);
    assert.deepEqual(explanation.tasks, []);
    assert.equal(explanation.adoptions.length, 1);
    assert.equal(explanation.adoptions[0]?.turnId, 'turn_apply');
    // The Conversation-level refusal belongs to the OTHER Turn, so it is listed
    // while this Run own verdict stays applied: the two scopes are distinct.
    assert.equal(explanation.rejections.length, 1);
    assert.equal(explanation.rejections[0]?.turnId, 'turn_refuse');
    assert.equal(explanation.thisTurn?.rejectedSummaryId, null);

    const refusing = await fetch(`${baseUrl}/runs/${refusingRun.id}/inspector`).then(r => r.json()) as {
      projection: {
        compaction: {
          turnId: string | null;
          thisTurn: { appliedSummaryId: string | null; rejectedSummaryId: string | null; rejectedReason: string | null } | null;
          rejections: Array<{ snapshotId: string; summaryId: string; reason: string }>;
        } | null;
      };
    };
    assert.equal(refusing.projection.compaction?.turnId, 'turn_refuse');
    assert.equal(refusing.projection.compaction?.thisTurn?.appliedSummaryId, null,
      'a Turn that refused a summary must not be reported as having applied one');
    assert.equal(refusing.projection.compaction?.thisTurn?.rejectedSummaryId, 'snap_comp_stale');
    assert.equal(refusing.projection.compaction?.thisTurn?.rejectedReason, 'source-content-changed');
    assert.equal(refusing.projection.compaction?.rejections[0]?.reason, 'source-content-changed');
  });
});
