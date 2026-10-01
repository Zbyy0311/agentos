import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import { MemoryRetrievalService } from './MemoryRetrievalService.js';
import { PreferenceConfirmationService } from './PreferenceConfirmationService.js';
import { PreferenceService } from './PreferenceService.js';
import { migration044 } from '../migrations/migrations/044-preference-confirmations.js';
import type { PreferenceProjection } from '@agentos/shared';

const NOW = '2026-10-01T00:00:00.000Z';

function createRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'agentos-pref-confirm-'));
  mkdirSync(join(path, 'workspace'), { recursive: true });
  writeFileSync(join(path, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: ['a', 'b'].map(id => ({
    id: `workspace-${id}`, name: id, rootPath: path, gitEnabled: true, memoryEnabled: true, agents: [],
    lastOpenedAt: NOW, createdAt: NOW, updatedAt: NOW,
  })) }));
  return path;
}

function seedProjection(
  store: SqliteStore,
  overrides: Partial<PreferenceProjection> = {},
  links: Array<{ evidenceId: string; contribution: number }> = [],
): PreferenceProjection {
  const projection: PreferenceProjection = {
    id: 'projection-a', profileId: 'default', scope: 'workspace', workspaceId: 'workspace-a',
    dimension: 'response_detail', contextKind: 'coding', preferredValue: 'concise', confidence: 82,
    score: 12, evidenceCount: 4, independentRunCount: 4, status: 'stable', lastSupportedAt: NOW,
    createdAt: NOW, updatedAt: NOW, ...overrides,
  };
  store.upsertPreferenceProjection(projection, links);
  return projection;
}

function setup() {
  const path = createRoot();
  const store = new SqliteStore(path);
  migration044.apply({ db: store.getDatabase() });
  store.createConversation({ id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'A', agentId: 'codex', createdAt: NOW, updatedAt: NOW });
  store.createMessage({ id: 'message-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', senderType: 'user', content: 'source', createdAt: NOW });
  store.createRun({ id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: 'preference', status: 'completed', resultSummary: 'ok', createdAt: NOW, updatedAt: NOW });
  store.createPreferenceEvidence({ id: 'evidence-a', profileId: 'default', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-a', sourceEventId: 'preference:message-a:conflict:projection-a', dimension: 'response_detail', contextKind: 'coding', candidateValue: 'concise', signalType: 'conflict', polarity: 'positive', weight: 3, summary: 'observed', status: 'active', observedAt: NOW, createdAt: NOW });
  let tick = 0;
  const service = new PreferenceConfirmationService(store, () => `2026-10-01T00:00:${String(tick++).padStart(2, '0')}.000Z`);
  const projection = seedProjection(store, {}, [{ evidenceId: 'evidence-a', contribution: 3 }]);
  service.synchronizeProjection(projection);
  return { path, store, service, projection, close() { store.close(); rmSync(path, { recursive: true, force: true }); } };
}

function addWorkspaceB(path: string, store: SqliteStore): void {
  const rootPath = join(path, 'workspace-b');
  mkdirSync(rootPath, { recursive: true });
  store.workspaceRepo.insert({ id: 'workspace-b', name: 'B', rootPath, gitEnabled: true,
    memoryEnabled: true, agents: [], lastOpenedAt: NOW, createdAt: NOW, updatedAt: NOW });
}

test('pending projection has no reply influence; explicit confirm binds the authoritative Entry once', () => {
  const fx = setup();
  try {
    assert.equal(fx.service.listSuggestions('workspace-a')[0]?.status, 'pending');
    const pendingReply = new PreferenceService(fx.store).resolveForRun({
      profileId: 'default', workspaceId: 'workspace-a', objective: 'implement', runId: 'run-a',
    });
    assert.equal(pendingReply.text, '');
    assert.deepEqual(pendingReply.applications, []);
    assert.deepEqual(new MemoryRetrievalService(new MemoryEntryRepository(fx.store.getDatabase())).retrieve({
      context: { workspaceId: 'workspace-a' }, categoryFilter: ['preference'],
    }), []);

    const confirmed = fx.service.confirm({ projectionId: 'projection-a', workspaceId: 'workspace-a', expectedVersion: 1 });
    assert.equal(confirmed.suggestion.status, 'confirmed');
    assert.equal(confirmed.suggestion.version, 2);
    assert.equal(confirmed.suggestion.entryId, confirmed.entry?.id);
    assert.equal(confirmed.entry?.authority, 'user-explicit');
    assert.equal(confirmed.entry?.scope, 'workspace');
    assert.equal(confirmed.entry?.category, 'preference');
    assert.equal(confirmed.entry?.confidence, 1);
    assert.deepEqual(confirmed.entry?.sources, [
      { kind: 'conversation', id: 'conversation-a' },
      { kind: 'message', id: 'message-a' },
      { kind: 'run', id: 'run-a' },
      { kind: 'user', id: 'default' },
    ]);
    const retrieved = new MemoryRetrievalService(new MemoryEntryRepository(fx.store.getDatabase())).retrieve({
      context: { workspaceId: 'workspace-a' }, query: 'implement coding task', categoryFilter: ['preference'],
    });
    assert.deepEqual(retrieved.map(row => row.entry.id), [confirmed.entry?.id]);
  } finally { fx.close(); }
});

test('confirmation uses CAS, verifies workspace, and requires explicit global opt-in', () => {
  const fx = setup();
  try {
    assert.throws(() => fx.service.confirm({ projectionId: 'projection-a', workspaceId: 'workspace-a', expectedVersion: 2 }), /VERSION_CONFLICT/);
    assert.throws(() => fx.service.confirm({ projectionId: 'projection-a', workspaceId: 'workspace-b', expectedVersion: 1 }), /NOT_FOUND/);
    assert.equal(fx.service.confirm({ projectionId: 'projection-a', workspaceId: 'workspace-a', expectedVersion: 1 }).suggestion.scope, 'workspace');
  } finally { fx.close(); }

  const other = setup();
  try {
    const global = other.service.confirm({ projectionId: 'projection-a', workspaceId: 'workspace-a', expectedVersion: 1, confirmGlobal: true });
    assert.equal(global.suggestion.scope, 'global');
  } finally { other.close(); }
});

test('reject and revoke are audited, versioned, and revocation archives only the bound Entry', () => {
  const fx = setup();
  try {
    const rejected = fx.service.reject({ projectionId: 'projection-a', workspaceId: 'workspace-a', expectedVersion: 1 });
    assert.equal(rejected.suggestion.status, 'rejected');
    assert.equal(rejected.suggestion.version, 2);
    assert.throws(() => fx.service.reject({ projectionId: 'projection-a', workspaceId: 'workspace-a', expectedVersion: 1 }), /NOT_FOUND/);

    const nextProjection = seedProjection(fx.store, { id: 'projection-b', dimension: 'execution_style', preferredValue: 'direct_execution' });
    fx.service.synchronizeProjection(nextProjection);
    const confirmed = fx.service.confirm({ projectionId: 'projection-b', workspaceId: 'workspace-a', expectedVersion: 1 });
    const revoked = fx.service.revoke({ projectionId: 'projection-b', workspaceId: 'workspace-a', expectedVersion: confirmed.suggestion.version });
    assert.equal(revoked.suggestion.status, 'revoked');
    assert.equal(revoked.entry?.status, 'archived');
    assert.equal(revoked.entry?.version, 2);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM preference_confirmation_audit WHERE action IN (\'rejected\',\'confirmed\',\'revoked\')').get() as { n: number }).n, 3);
    assert.throws(() => fx.service.revoke({ projectionId: 'projection-b', workspaceId: 'workspace-a', expectedVersion: confirmed.suggestion.version }), /NOT_FOUND/);
  } finally { fx.close(); }
});

test('revocation retires stale bindings without re-archiving deleted Entries or archiving an edited preference', () => {
  const fx = setup();
  try {
    const entries = new MemoryEntryRepository(fx.store.getDatabase());
    const archivedProjection = seedProjection(fx.store, { id: 'projection-archived', dimension: 'execution_style', preferredValue: 'direct_execution' });
    fx.service.synchronizeProjection(archivedProjection);
    const archivedConfirmation = fx.service.confirm({ projectionId: archivedProjection.id, workspaceId: 'workspace-a', expectedVersion: 1 });
    const manuallyArchived = entries.updateStatus({ workspaceId: 'workspace-a', entryId: archivedConfirmation.entry!.id,
      expectedVersion: archivedConfirmation.entry!.version, status: 'archived', updatedAt: '2026-10-01T00:02:00.000Z' });
    const archivedRevoke = fx.service.revoke({ projectionId: archivedProjection.id, workspaceId: 'workspace-a', expectedVersion: archivedConfirmation.suggestion.version });
    assert.equal(archivedRevoke.suggestion.status, 'revoked');
    assert.equal(archivedRevoke.entry?.status, 'archived');
    assert.equal(archivedRevoke.entry?.version, manuallyArchived.version);

    const deletedProjection = seedProjection(fx.store, { id: 'projection-deleted', dimension: 'execution_style', contextKind: 'debugging', preferredValue: 'plan_first' });
    fx.service.synchronizeProjection(deletedProjection);
    const deletedConfirmation = fx.service.confirm({ projectionId: deletedProjection.id, workspaceId: 'workspace-a', expectedVersion: 1 });
    const manuallyDeleted = entries.softDelete('workspace-a', deletedConfirmation.entry!.id,
      deletedConfirmation.entry!.version, '2026-10-01T00:03:00.000Z');
    const deletedRevoke = fx.service.revoke({ projectionId: deletedProjection.id, workspaceId: 'workspace-a', expectedVersion: deletedConfirmation.suggestion.version });
    assert.equal(deletedRevoke.suggestion.status, 'revoked');
    assert.equal(deletedRevoke.entry?.status, 'deleted');
    assert.equal(deletedRevoke.entry?.version, manuallyDeleted.version);

    const editedProjection = seedProjection(fx.store, { id: 'projection-edited', dimension: 'execution_style', contextKind: 'planning', preferredValue: 'direct_execution' });
    fx.service.synchronizeProjection(editedProjection);
    const editedConfirmation = fx.service.confirm({ projectionId: editedProjection.id, workspaceId: 'workspace-a', expectedVersion: 1 });
    const editedEntry = entries.updateEntryWithinTransaction({ workspaceId: 'workspace-a', entryId: editedConfirmation.entry!.id,
      expectedVersion: editedConfirmation.entry!.version, updatedAt: '2026-10-01T00:04:00.000Z',
      content: '用户后来改为 contextual 执行风格。',
      tags: ['preference', 'dimension:execution_style', 'context:planning', 'value:contextual'] });
    const editedRevoke = fx.service.revoke({ projectionId: editedProjection.id, workspaceId: 'workspace-a', expectedVersion: editedConfirmation.suggestion.version });
    assert.equal(editedRevoke.suggestion.status, 'revoked');
    assert.equal(editedRevoke.entry?.status, 'active');
    assert.equal(editedRevoke.entry?.version, editedEntry.version);
    assert.equal(editedRevoke.entry?.content, editedEntry.content);
    const audit = fx.store.getDatabase().prepare(`SELECT details_json FROM preference_confirmation_audit
      WHERE projection_id = ? AND action = 'revoked' ORDER BY id DESC LIMIT 1`).get(editedProjection.id) as { details_json: string };
    assert.equal(JSON.parse(audit.details_json).entryPreservedReason, 'entry_version_changed');
  } finally { fx.close(); }
});

test('replacement and revocation leave frozen historical memory snapshots unchanged', () => {
  const fx = setup();
  try {
    const snapshots = new MemoryContextSnapshotRepository(fx.store.getDatabase());
    const task = fx.store.taskRepository().insert({ workspaceId: 'workspace-a', title: 'snapshot fixture', createdBy: 'test' });
    const run = fx.store.runRepository().insert({ workspaceId: 'workspace-a', taskId: task.id,
      origin: 'v2_api', objective: 'snapshot fixture', createdBy: 'test' });
    const first = fx.service.confirm({ projectionId: 'projection-a', workspaceId: 'workspace-a', expectedVersion: 1 });
    const persistSnapshot = (id: string, entryId: string, entryVersion: number, contextText: string) => snapshots.createSnapshot({
      id, workspaceId: 'workspace-a', runId: run.id, queryHash: `${id}-query`,
      retrievalStrategyVersion: 'preference-confirmation-test',
      budget: { maxTokens: 100, maxEntries: 5, perScopeLimits: { workspace: 5 },
        perCategoryLimits: { preference: 5 }, minConfidence: 0.5, minImportance: 0.3,
        maxTruncation: 1, requireDiversity: true },
      totalTokens: 12, truncated: false, createdAt: NOW, contextText,
      selected: [{ memoryId: entryId, memoryVersion: entryVersion, rank: 1, score: 1,
        scope: 'workspace', category: 'preference', authority: 'user-explicit', confidence: 1,
        importance: 0.8, tokenCost: 12, reasons: ['scope-match'],
        sourceRefs: [{ kind: 'user', id: 'default' }] }], exclusions: [],
    } as Parameters<MemoryContextSnapshotRepository['createSnapshot']>[0]);
    const beforeReplacement = persistSnapshot('snapshot-preference-before-replacement', first.entry!.id,
      first.entry!.version, 'Historical context: concise coding answers.');
    const firstContext = snapshots.readContextText('workspace-a', beforeReplacement.id);

    const contradictory = { ...fx.projection, preferredValue: 'detailed', confidence: 91,
      evidenceCount: 5, updatedAt: '2026-10-01T00:01:00.000Z' };
    seedProjection(fx.store, contradictory);
    const pending = fx.service.synchronizeProjection(contradictory)!;
    const replacement = fx.service.confirm({ projectionId: 'projection-a', workspaceId: 'workspace-a',
      expectedVersion: pending.version });
    assert.deepEqual(snapshots.findById('workspace-a', beforeReplacement.id), beforeReplacement);
    assert.equal(snapshots.readContextText('workspace-a', beforeReplacement.id), firstContext);

    const beforeRevoke = persistSnapshot('snapshot-preference-before-revoke', replacement.entry!.id,
      replacement.entry!.version, 'Historical context: detailed coding answers.');
    const secondContext = snapshots.readContextText('workspace-a', beforeRevoke.id);
    fx.service.revoke({ projectionId: 'projection-a', workspaceId: 'workspace-a',
      expectedVersion: replacement.suggestion.version });
    assert.deepEqual(snapshots.findById('workspace-a', beforeRevoke.id), beforeRevoke);
    assert.equal(snapshots.readContextText('workspace-a', beforeRevoke.id), secondContext);
  } finally { fx.close(); }
});

test('replacement preserves an edited formerly bound Entry while binding the explicitly confirmed value', () => {
  const fx = setup();
  try {
    const entries = new MemoryEntryRepository(fx.store.getDatabase());
    const first = fx.service.confirm({ projectionId: 'projection-a', workspaceId: 'workspace-a', expectedVersion: 1 });
    const edited = entries.updateEntryWithinTransaction({ workspaceId: 'workspace-a', entryId: first.entry!.id,
      expectedVersion: first.entry!.version, updatedAt: '2026-10-01T00:01:00.000Z',
      content: '用户后来明确改为 detailed。',
      tags: ['preference', 'dimension:response_detail', 'context:coding', 'value:detailed'] });
    const alternate = seedProjection(fx.store, { id: 'projection-a', preferredValue: 'detailed' });
    fx.service.synchronizeProjection(alternate);

    const second = fx.service.confirm({ projectionId: alternate.id, workspaceId: 'workspace-a', expectedVersion: 1 });
    const preserved = entries.findById('workspace-a', edited.id)!;
    assert.equal(preserved.status, 'active');
    assert.equal(preserved.version, edited.version);
    assert.equal(preserved.content, edited.content);
    assert.equal(entries.findById('workspace-a', second.entry!.id)?.status, 'active');
    assert.equal(fx.service.listSuggestions('workspace-a').filter(item => item.status === 'confirmed').length, 1);
    const audit = fx.store.getDatabase().prepare(`SELECT details_json FROM preference_confirmation_audit
      WHERE projection_id = 'projection-a' AND action = 'replaced'`).get() as { details_json: string };
    assert.equal(JSON.parse(audit.details_json).entryPreservedReason, 'entry_version_changed');
  } finally { fx.close(); }
});

test('workspace and global confirmations coexist; contradictory scopes remain bound for retrieval precedence', () => {
  const fx = setup();
  try {
    const local = fx.service.confirm({ projectionId: 'projection-a', workspaceId: 'workspace-a', expectedVersion: 1 });
    const globalProjection = seedProjection(fx.store, {
      id: 'projection-global', scope: 'global', workspaceId: undefined, preferredValue: 'detailed',
    });
    fx.service.synchronizeProjection(globalProjection);
    const global = fx.service.confirm({ projectionId: globalProjection.id, workspaceId: 'workspace-a',
      expectedVersion: 1, confirmGlobal: true });

    const entries = new MemoryEntryRepository(fx.store.getDatabase());
    assert.equal(entries.findById('workspace-a', local.entry!.id)?.status, 'active');
    assert.equal(entries.findById('workspace-a', global.entry!.id)?.status, 'active');
    const bindings = fx.service.listSuggestions('workspace-a').filter(item => item.status === 'confirmed');
    assert.deepEqual(bindings.map(item => item.scope).sort(), ['global', 'workspace']);
    assert.equal(bindings.length, 2);
  } finally { fx.close(); }
});

test('explicit global binding is listable and revocable cross-workspace without exposing another workspace pending suggestion', () => {
  const fx = setup();
  try {
    addWorkspaceB(fx.path, fx.store);
    const global = fx.service.confirm({ projectionId: 'projection-a', workspaceId: 'workspace-a',
      expectedVersion: 1, confirmGlobal: true });
    const otherWorkspaceProjection = seedProjection(fx.store, {
      id: 'projection-workspace-a-pending', workspaceId: 'workspace-a', dimension: 'execution_style',
      preferredValue: 'direct_execution',
    });
    fx.service.synchronizeProjection(otherWorkspaceProjection);

    const visibleInB = fx.service.listSuggestions('workspace-b');
    assert.equal(visibleInB.some(row => row.projectionId === 'projection-workspace-a-pending'), false);
    assert.deepEqual(visibleInB.filter(row => row.projectionId === 'projection-a').map(row => ({
      status: row.status, scope: row.scope, entryId: row.entryId,
    })), [{ status: 'confirmed', scope: 'global', entryId: global.entry!.id }]);

    const revokedFromB = fx.service.revoke({ projectionId: 'projection-a', workspaceId: 'workspace-b',
      expectedVersion: global.suggestion.version });
    assert.equal(revokedFromB.suggestion.status, 'revoked');
    assert.equal(revokedFromB.entry?.workspaceId, 'workspace-a');
    assert.equal(revokedFromB.entry?.status, 'archived');
    assert.equal(fx.service.listSuggestions('workspace-b').find(row => row.projectionId === 'projection-a')?.status, 'revoked');
    assert.equal(fx.service.listSuggestions('workspace-a').find(row => row.projectionId === 'projection-a')?.status, 'revoked');
  } finally { fx.close(); }
});

test('global-origin projection confirmed for one workspace cannot be revoked from another workspace', () => {
  const fx = setup();
  try {
    addWorkspaceB(fx.path, fx.store);
    const globalProjection = seedProjection(fx.store, {
      id: 'projection-global-source', scope: 'global', workspaceId: undefined,
      dimension: 'execution_style', preferredValue: 'direct_execution',
    });
    fx.service.synchronizeProjection(globalProjection);
    const confirmedLocal = fx.service.confirm({ projectionId: globalProjection.id,
      workspaceId: 'workspace-a', expectedVersion: 1 });
    assert.equal(confirmedLocal.suggestion.scope, 'workspace');
    assert.throws(() => fx.service.revoke({ projectionId: globalProjection.id,
      workspaceId: 'workspace-b', expectedVersion: confirmedLocal.suggestion.version }), /NOT_FOUND/);
    assert.equal(fx.service.revoke({ projectionId: globalProjection.id,
      workspaceId: 'workspace-a', expectedVersion: confirmedLocal.suggestion.version }).suggestion.status, 'revoked');
  } finally { fx.close(); }
});

test('later contradictory projection stays pending without mutating its bound Entry until explicitly confirmed', () => {
  const fx = setup();
  try {
    const first = fx.service.confirm({ projectionId: 'projection-a', workspaceId: 'workspace-a', expectedVersion: 1 });
    const entries = new MemoryEntryRepository(fx.store.getDatabase());
    const originalEntry = entries.findById('workspace-a', first.entry!.id)!;
    const contradictory = { ...fx.projection, preferredValue: 'detailed', confidence: 91, evidenceCount: 5, updatedAt: '2026-10-01T00:01:00.000Z' };
    seedProjection(fx.store, contradictory);
    const pending = fx.service.synchronizeProjection(contradictory)!;
    assert.equal(pending.status, 'pending');
    assert.equal(pending.preferredValue, 'detailed');
    const stillBound = entries.findById('workspace-a', first.entry!.id)!;
    assert.equal(stillBound.status, 'active');
    assert.equal(stillBound.version, originalEntry.version);
    assert.equal(stillBound.content, originalEntry.content);
    assert.equal(fx.service.listSuggestions('workspace-a').find(item => item.entryId === first.entry!.id)?.status, 'confirmed');

    const second = fx.service.confirm({ projectionId: 'projection-a', workspaceId: 'workspace-a', expectedVersion: pending.version });
    assert.equal(entries.findById('workspace-a', first.entry!.id)?.status, 'archived');
    assert.equal(entries.findById('workspace-a', second.entry!.id!)?.status, 'active');
    assert.equal(fx.service.listSuggestions('workspace-a').filter(item => item.status === 'confirmed').length, 1);
    assert.equal((fx.store.getDatabase().prepare("SELECT COUNT(*) AS n FROM preference_confirmation_audit WHERE action='replaced'").get() as { n: number }).n, 1);
  } finally { fx.close(); }
});

test('confirmation transaction rolls back Entry, sidecar, audit, and Workspace Event together', () => {
  const fx = setup();
  try {
    fx.store.getDatabase().exec(`CREATE TRIGGER fail_preference_audit BEFORE INSERT ON preference_confirmation_audit
      WHEN NEW.action='confirmed' BEGIN SELECT RAISE(ABORT,'injected preference audit failure'); END`);
    assert.throws(() => fx.service.confirm({ projectionId: 'projection-a', workspaceId: 'workspace-a', expectedVersion: 1 }), /injected preference audit failure/);
    assert.equal((fx.store.getDatabase().prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE category='preference'").get() as { n: number }).n, 0);
    assert.equal(fx.service.listSuggestions('workspace-a')[0]?.status, 'pending');
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM workspace_events').get() as { n: number }).n, 0);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM preference_confirmation_audit').get() as { n: number }).n, 1);
  } finally { fx.close(); }
});
