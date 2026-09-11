/**
 * MF-5 Workspace Event stream -- the sanctioned PRODUCTION Workspace delete
 * seam (`SqliteStore.deleteWorkspace`, reached from `WorkspaceManager.remove`).
 *
 * Authorization: `docs/implementation/milestones/MF5-workspace-event-schema-authorization.md`
 * sections 6.5 and 9, gate MF5W-A15 at the store seam: a Workspace that holds
 * Events is hard-deleted only through the sanctioned path, which deletes that
 * Workspace's Events inside its own transaction BEFORE the Workspace row,
 * because `workspace_events.workspace_id` is ON DELETE RESTRICT.
 *
 * No memory Entry is created in either Workspace here: MF-1 migration 017
 * installs `memory_entries_no_delete` (RAISE ABORT
 * 'MEMORY_ENTRY_DELETE_FORBIDDEN'), so a Workspace holding an Entry cannot be
 * hard-deleted at all. That is a pre-existing, out-of-scope condition; a
 * `reject` review emits exactly one Event and creates no Entry, which keeps
 * this test on the frozen delete path only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryCandidateRepository } from './MemoryCandidateRepository.js';
import { SqliteStore } from './SqliteStore.js';

const WS_A = 'ws-a';
const WS_B = 'ws-b';
const CREATED_AT = '2026-09-11T00:00:00.000Z';
const REVIEWED_AT = '2026-09-11T00:05:00.000Z';

type StoreDatabase = ReturnType<SqliteStore['getDatabase']>;

function count(database: StoreDatabase, sql: string, ...params: unknown[]): number {
  const row = database.prepare(sql).get(...params) as { readonly n: number | bigint };
  return Number(row.n);
}

/**
 * Temp project root holding TWO Workspaces in workspace/workspaces.json, the
 * same shape the legacy migration seeds SQLite from. The two roots differ:
 * `workspaces.canonical_root_path` is UNIQUE, so a shared root would make the
 * second Workspace un-insertable.
 */
function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-mf5-ws-delete-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const workspace = (id: string): Record<string, unknown> => ({
    id, name: id, rootPath: join(root, id), gitEnabled: true, memoryEnabled: true, agents: [],
    lastOpenedAt: CREATED_AT, createdAt: CREATED_AT, updatedAt: CREATED_AT,
  });
  writeFileSync(
    join(root, 'workspace', 'workspaces.json'),
    JSON.stringify({ workspaces: [workspace(WS_A), workspace(WS_B)] }),
    'utf8',
  );
  return root;
}

/**
 * One `reject` review per Workspace through the production fact path and the
 * store's ONE writer (authorization section 9). A rejected review appends
 * exactly one `memory.candidate_reviewed` Event and creates no Entry, so the
 * Workspace holds an Event stream but nothing MF-1 forbids deleting.
 */
function emitRejectedReview(store: SqliteStore, workspaceId: string): void {
  const candidates = new MemoryCandidateRepository(store.getDatabase());
  const candidateId = 'mcand_' + (workspaceId === WS_A ? 'a' : 'b').repeat(26);
  candidates.createCandidate({
    id: candidateId,
    workspaceId,
    scope: 'workspace',
    category: 'decision',
    authority: 'system-verified',
    confidence: 0.6,
    importance: 0.5,
    title: 'reviewed candidate in ' + workspaceId,
    summary: 'candidate summary',
    content: 'candidate content',
    // Always review-required, so the row is created reviewable rather than
    // auto-accepted (which would promote an Entry and close the delete path).
    inferredPreference: true,
    sources: [{ kind: 'run', id: 'run-' + workspaceId }],
    createdAt: CREATED_AT,
    minConfidence: 0.5,
    maxTokenEstimate: 1000,
  });
  candidates.reviewCandidate(
    {
      workspaceId, candidateId, expectedVersion: 1, outcome: 'reject', reviewedAt: REVIEWED_AT,
    },
    { writer: store.workspaceEventWriter() },
  );
}

test('MF5W-A15 (store seam): the sanctioned Workspace delete removes exactly that Workspace Events and candidates', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    for (const workspaceId of [WS_A, WS_B]) emitRejectedReview(store, workspaceId);

    const database = store.getDatabase();
    for (const workspaceId of [WS_A, WS_B]) {
      // Each Workspace owns exactly ONE Event, and it is the review Event.
      assert.equal(count(database, 'SELECT COUNT(*) AS n FROM workspace_events WHERE workspace_id = ?', workspaceId), 1);
      const types = database.prepare('SELECT type FROM workspace_events WHERE workspace_id = ?')
        .all(workspaceId) as Array<{ readonly type: string }>;
      assert.deepEqual(types.map(row => row.type), ['memory.candidate_reviewed']);
      // One sequence was consumed, so the next allocation is 2.
      assert.equal(count(database, 'SELECT next_event_sequence AS n FROM workspaces WHERE id = ?', workspaceId), 2);
      // A rejected review leaves one reviewable Candidate and NO Entry, so
      // the MF-1 delete trigger can never be the reason a delete would fail.
      assert.equal(count(database, 'SELECT COUNT(*) AS n FROM memory_candidate_entries WHERE workspace_id = ?', workspaceId), 1);
      assert.equal(count(database, 'SELECT COUNT(*) AS n FROM memory_entries WHERE workspace_id = ?', workspaceId), 0);
    }

    // Section 6.5: `workspace_events.workspace_id` is ON DELETE RESTRICT, so
    // the unsanctioned order (Workspace row first) cannot commit, and the
    // frozen child-delete order is the only order the production path can use.
    assert.throws(
      () => database.prepare('DELETE FROM workspaces WHERE id = ?').run(WS_A),
      /FOREIGN KEY|constraint/iu,
    );
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM workspaces WHERE id = ?', WS_A), 1);

    // The sanctioned production path succeeds: Events, then the Workspace row,
    // then the tombstone, all inside SqliteStore's own transaction.
    store.deleteWorkspace(WS_A);

    // ws-a is gone, its Event stream with it, and the delete is tombstoned.
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM workspace_events WHERE workspace_id = ?', WS_A), 0);
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM workspaces WHERE id = ?', WS_A), 0);
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM _workspace_tombstones WHERE workspace_id = ?', WS_A), 1);
    // ws-b keeps its Event, its Workspace row, its counter, and its Candidate,
    // so the delete is provably scoped to one Workspace.
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM workspace_events WHERE workspace_id = ?', WS_B), 1);
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM workspaces WHERE id = ?', WS_B), 1);
    assert.equal(count(database, 'SELECT next_event_sequence AS n FROM workspaces WHERE id = ?', WS_B), 2);
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM memory_candidate_entries WHERE workspace_id = ?', WS_B), 1);

    // `memory_candidate_entries.workspace_id` is ON DELETE CASCADE, so the
    // deleted Workspace leaves no Candidate, no source, and no orphan anywhere.
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM memory_candidate_entries WHERE workspace_id = ?', WS_A), 0);
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM memory_candidate_sources s'
      + ' LEFT JOIN memory_candidate_entries c ON c.id = s.candidate_id WHERE c.id IS NULL'), 0);
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM workspace_events e'
      + ' LEFT JOIN workspaces w ON w.id = e.workspace_id WHERE w.id IS NULL'), 0);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    const integrity = database.prepare('PRAGMA integrity_check').get() as { readonly integrity_check: string };
    assert.equal(integrity.integrity_check, 'ok');
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
