import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createConversationRuntimeRoutes } from './conversationRuntime.js';
import { createRuntimeInspectorRoutes } from './runtimeInspector.js';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-cr-compaction-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
      agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [], model: 'gpt-5.6-luna' }],
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
    app.use('/api/workspaces/:workspaceId/runtime', createConversationRuntimeRoutes(store, new WorkspaceManager(store)));
    // LITE-13-101: the Run-scoped Inspector is mounted beside the Conversation
    // runtime so one test can prove both surfaces read the same durable rows.
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

async function postJson(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

/**
 * S6 / LITE-09-105 + LITE-09-107 through the real HTTP turn path: the trigger
 * runs before context assembly, publishes one bounded summary, and the very
 * Turn that caused it is the Turn that adopts it. The Provider call itself is
 * mocked (deterministic), so this test proves the wiring and the application,
 * not the Provider's own output; real-Provider evidence lives in
 * scripts/verify-compaction-real-summary.mjs.
 */
test('S6: the automatic trigger compacts a long Conversation before the next Turn adopts it', async () => {
  process.env.AGENTOS_FORCE_MOCK = 'true';
  try {
    await withServer(async (baseUrl, store) => {
      const created = await postJson(`${baseUrl}/conversations`, { kind: 'direct', agentId: 'codex' });
      assert.equal(created.status, 201);
      const conversationId = created.json.conversation.id as string;

      // Seeded through the real message endpoint: long enough that the frozen
      // lite-v1 trigger ratio is exceeded.
      const seededIds: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        const posted = await postJson(`${baseUrl}/conversations/${conversationId}/messages`, {
          content: `message ${index}: ` + 'The runtime keeps Tasks, Runs and Processes distinct. '.repeat(90),
        });
        assert.equal(posted.status, 201);
        seededIds.push(posted.json.message.id);
      }

      const response = await fetch(`${baseUrl}/conversations/${conversationId}/messages/stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '请给出结论。' }),
      });
      assert.equal(response.status, 200);
      const stream = await response.text();
      assert.ok(stream.includes('event: turn.final') || stream.includes('event: turn.failed'));

      const db = store.getDatabase();
      const tasks = db.prepare(
        'SELECT id, status, summary, candidate_id, source_message_count, policy_id FROM conversation_compactions',
      ).all() as Array<{ id: string; status: string; summary: string | null; candidate_id: string | null; source_message_count: number; policy_id: string }>;
      assert.equal(tasks.length, 1, 'exactly one compaction task is created for this Conversation');
      const task = tasks[0]!;
      assert.equal(task.status, 'published');
      assert.ok((task.summary ?? '').length > 0, 'the published summary is durable');
      assert.ok(task.candidate_id, 'publishing records its review Candidate');
      assert.ok(task.source_message_count >= 1 && task.source_message_count < seededIds.length,
        'only a bounded old prefix is compressed');

      const policy = db.prepare('SELECT policy_version, min_recent_messages FROM conversation_compaction_policies WHERE id = ?')
        .get(task.policy_id) as { policy_version: string; min_recent_messages: number };
      assert.equal(policy.policy_version, 'lite-v1');

      // The Turn that caused the compaction is the Turn that adopts it.
      const snapshot = db.prepare(
        'SELECT budget_json FROM cr_turn_context_snapshots WHERE conversation_id = ? ORDER BY created_at DESC, id ASC LIMIT 1',
      ).get(conversationId) as { budget_json: string };
      const budget = JSON.parse(snapshot.budget_json) as {
        compactionSummaryId?: string; summarizedMessages?: number; frozenHistoryMessageIds: string[]; totalConversationMessages: number;
      };
      assert.equal(budget.compactionSummaryId, task.id);
      assert.equal(budget.summarizedMessages, task.source_message_count);
      // Summary + uncompressed tail: the covered Messages are no longer in the
      // frozen history, and the recent window is still present.
      for (const covered of seededIds.slice(0, task.source_message_count)) {
        assert.equal(budget.frozenHistoryMessageIds.includes(covered), false, `covered message ${covered} must not be re-sent`);
      }
      assert.ok(budget.frozenHistoryMessageIds.includes(seededIds[seededIds.length - 1]!), 'the newest seeded message stays in the tail');

      // LITE-13-101: the Inspector explains WHY this compaction happened
      // (thresholds and budget composition) and WHO adopted the summary.
      const inspector = await fetch(`${baseUrl}/conversations/${conversationId}/compactions`).then(r => r.json()) as {
        adoptions: Array<{ snapshotId: string; turnId: string | null; summaryId: string }>;
        tasks: Array<{ id: string; budget: Record<string, unknown> }>;
        policies: Array<{ policyVersion: string; triggerRatio: number }>;
      };
      assert.equal(inspector.policies[0]?.policyVersion, 'lite-v1');
      assert.equal(inspector.policies[0]?.triggerRatio, 0.7);
      const inspectorTask = inspector.tasks.find(entry => entry.id === task.id)!;
      assert.equal(inspectorTask.budget.triggerRatio, 0.7);
      assert.equal(inspectorTask.budget.targetRatio, 0.5);
      assert.equal(inspectorTask.budget.retainedRecentMessages, 8);
      assert.equal(inspectorTask.budget.applicationBudgetSource, 'lite-v1-fallback');
      const adoption = inspector.adoptions.find(entry => entry.summaryId === task.id);
      assert.ok(adoption, 'the Inspector must name the Turn that adopted the summary');
      assert.ok(adoption.turnId, 'the adopting Turn id is reported');
      // The adoption points at the very snapshot the Turn recorded, so the
      // Inspector cannot report a Turn that never received the summary.
      const adoptingTurn = db.prepare('SELECT context_snapshot_id FROM cr_agent_turns WHERE id = ?')
        .get(adoption.turnId) as { context_snapshot_id: string | null } | undefined;
      assert.equal(adoptingTurn?.context_snapshot_id, adoption.snapshotId);

      // Nothing was deleted or rewritten: every original Message is still there.
      const remaining = db.prepare('SELECT COUNT(*) AS n FROM cr_messages WHERE conversation_id = ? AND status <> ?')
        .get(conversationId, 'deleted') as { n: number | bigint };
      assert.ok(Number(remaining.n) >= seededIds.length + 2, 'the compressed Messages are preserved, not deleted');

      // A second Turn converges: no second Provider compaction for the same source.
      const second = await fetch(`${baseUrl}/conversations/${conversationId}/messages/stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '再给一次结论。' }),
      });
      assert.equal(second.status, 200);
      await second.text();
      const after = db.prepare('SELECT COUNT(*) AS n FROM conversation_compactions').get() as { n: number | bigint };
      assert.equal(Number(after.n), 1, 'a repeat does not create a second compaction task');

      // LITE-09-108: the explicit retry reports durable state rather than a bare
      // success, and is safe to call when nothing needs compacting.
      const retry = await fetch(`${baseUrl}/conversations/${conversationId}/compactions/retry`, { method: 'POST' });
      assert.equal(retry.status, 200);
      const retryBody = await retry.json() as { outcome: string; policyVersion: string };
      assert.equal(retryBody.outcome, 'noop', 'the effective tail is already inside the threshold');
      assert.equal(retryBody.policyVersion, 'lite-v1');
      const afterRetry = db.prepare('SELECT COUNT(*) AS n FROM conversation_compactions').get() as { n: number | bigint };
      assert.equal(Number(afterRetry.n), 1, 'a retry must not fabricate a second task');

      // LITE-13-101 through the Run-scoped Runtime Inspector: a Run started from
      // this Conversation must explain the same compaction the Conversation view
      // explains, naming the summary and the Snapshot that received it. The Run
      // is placed through the Task's source Conversation, which is the relation
      // the bridge actually writes, and the projection says so via linkVia.
      // A Run created for a Task that came from this Conversation, where the
      // Message is bound to the Task but not to the Run: the Task source
      // Conversation is the only relation, and the projection must say so.
      const createdTask = await postJson(`${baseUrl}/messages/${seededIds[0]}/create-task`, {});
      assert.equal(createdTask.status, 201);
      const sourceRun = store.runRepository().insert({
        workspaceId: 'workspace-a', taskId: createdTask.json.task.id, origin: 'v2_api', createdBy: 'user',
      });
      const runInspector = await fetch(`${baseUrl}/runs/${sourceRun.id}/inspector`).then(r => r.json()) as {
        projection: {
          compaction: {
            conversationId: string;
            linkVia: string;
            policy: { policyVersion: string; triggerRatio: number } | null;
            latest: { id: string; status: string; summary: string | null; sourceMessageCount: number } | null;
            adoptions: Array<{ snapshotId: string; summaryId: string }>;
            rejections: unknown[];
            thisTurn: unknown;
          } | null;
        };
      };
      const compactionProjection = runInspector.projection.compaction;
      assert.ok(compactionProjection, 'a Run started from a compacted Conversation must explain it');
      assert.equal(compactionProjection.conversationId, conversationId);
      assert.equal(compactionProjection.linkVia, 'task');
      assert.equal(compactionProjection.policy?.policyVersion, 'lite-v1');
      assert.equal(compactionProjection.policy?.triggerRatio, 0.7);
      assert.equal(compactionProjection.latest?.id, task.id);
      assert.equal(compactionProjection.latest?.status, 'published');
      assert.ok((compactionProjection.latest?.summary ?? '').length > 0, 'the Inspector exposes the published summary');
      assert.equal(compactionProjection.latest?.sourceMessageCount, task.source_message_count);
      assert.ok(compactionProjection.adoptions.length >= 1, 'every Turn that received the summary is named');
      for (const adoption of compactionProjection.adoptions) {
        assert.equal(adoption.summaryId, compactionProjection.latest?.id,
          'an adoption can only name a summary this Conversation actually published');
      }
      assert.equal(compactionProjection.thisTurn, null, 'this Run has no Turn-backed snapshot of its own');

      // The same read model backs both surfaces, so their task sets cannot drift.
      const conversationView = await fetch(`${baseUrl}/conversations/${conversationId}/compactions`).then(r => r.json()) as {
        tasks: Array<{ id: string }>;
      };
      assert.deepEqual(
        conversationView.tasks.map(entry => entry.id),
        [compactionProjection.latest?.id],
      );

      // A Run that no durable relation places in a Conversation is reported as
      // not placed, never as an empty compaction story.
      const orphanTask = store.taskRepository().insert({ workspaceId: 'workspace-a', title: 'Orphan', createdBy: 'user' });
      const orphanRun = store.runRepository().insert({
        workspaceId: 'workspace-a', taskId: orphanTask.id, origin: 'v2_api', createdBy: 'user',
      });
      const orphanInspector = await fetch(`${baseUrl}/runs/${orphanRun.id}/inspector`).then(r => r.json()) as {
        projection: { compaction: unknown };
      };
      assert.equal(orphanInspector.projection.compaction, null);

      // The CR-4a start-run entry binds the Message to the Run it creates, so a
      // Run started that way is placed through its Message and explains the very
      // same compaction through the very same shared read model.
      const startedRun = await postJson(`${baseUrl}/messages/${seededIds[1]}/start-run`, {});
      assert.equal(startedRun.status, 201);
      const startedInspector = await fetch(`${baseUrl}/runs/${startedRun.json.run.id}/inspector`).then(r => r.json()) as {
        projection: {
          compaction: { linkVia: string; latest: { id: string } | null; adoptions: unknown[] } | null;
        };
      };
      assert.equal(startedInspector.projection.compaction?.linkVia, 'message',
        'the bridge binds message.run_id, so the Message relation is the one used');
      assert.equal(startedInspector.projection.compaction?.latest?.id, task.id);
      assert.ok((startedInspector.projection.compaction?.adoptions.length ?? 0) >= 1);
    });
  } finally {
    delete process.env.AGENTOS_FORCE_MOCK;
  }
});
