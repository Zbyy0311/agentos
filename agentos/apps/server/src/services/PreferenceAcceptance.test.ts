import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreferenceEvidence } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { calculatePreferenceProjection } from './PreferenceProjector.js';

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-preference-acceptance-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [
    { id: 'workspace-a', name: 'A', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-17T00:00:00.000Z', createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z' },
    { id: 'workspace-b', name: 'B', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-17T00:00:00.000Z', createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z' },
  ] }), 'utf8');
  return root;
}

function evidence(input: Partial<PreferenceEvidence> & Pick<PreferenceEvidence, 'id' | 'workspaceId' | 'runId' | 'conversationId' | 'candidateValue' | 'polarity' | 'weight' | 'observedAt'>): PreferenceEvidence {
  return {
    profileId: 'default', sourceEventId: input.id, dimension: 'response_detail', contextKind: 'coding', signalType: input.polarity === 'negative' ? 'conflict' : 'repeated_instruction',
    summary: '观察到回答详略偏好', status: 'active', createdAt: input.observedAt, ...input,
  };
}

test('verifies lifecycle, scene separation, global eligibility, controls, and redaction', () => {
  const root = createRoot();
  const store = new SqliteStore(root);
  try {
    store.createConversation({ id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'A', agentId: 'codex', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' });
    store.createConversation({ id: 'conversation-b', workspaceId: 'workspace-b', type: 'direct', title: 'B', agentId: 'codex', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' });
    for (const [runId, workspaceId, conversationId] of [
      ['run-a-1', 'workspace-a', 'conversation-a'], ['run-a-2', 'workspace-a', 'conversation-a'], ['run-a-3', 'workspace-a', 'conversation-a'], ['run-a-4', 'workspace-a', 'conversation-a'],
      ['run-a-5', 'workspace-a', 'conversation-a'], ['run-a-6', 'workspace-a', 'conversation-a'], ['run-a-7', 'workspace-a', 'conversation-a'], ['run-b-1', 'workspace-b', 'conversation-b'],
    ] as const) {
      const messageId = `message-${runId}`;
      store.createMessage({ id: messageId, conversationId, workspaceId, senderType: 'user', content: 'source text is never stored in preference summaries', createdAt: '2026-07-01T00:00:00.000Z' });
      store.createRun({ id: runId, workspaceId, conversationId, sourceMessageId: messageId, objective: 'preference test', status: 'completed', resultSummary: 'completed', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' });
    }
    const first = evidence({ id: 'e1', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-a-1', candidateValue: 'detailed', polarity: 'positive', weight: 3, observedAt: '2026-07-01T00:00:00.000Z' });
    store.createPreferenceEvidence(first);
    const observed = calculatePreferenceProjection([first], 'workspace', 'workspace-a');
    assert.equal(observed?.status, 'observed');

    const second = evidence({ id: 'e2', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-a-2', candidateValue: 'detailed', polarity: 'positive', weight: 3, observedAt: '2026-07-03T00:00:00.000Z' });
    store.createPreferenceEvidence(second);
    const provisional = calculatePreferenceProjection(store.listPreferenceEvidence('default', 'workspace-a'), 'workspace', 'workspace-a');
    assert.equal(provisional?.status, 'provisional');

    const third = evidence({ id: 'e3', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-a-3', candidateValue: 'detailed', polarity: 'positive', weight: 3, observedAt: '2026-07-05T00:00:00.000Z' });
    const fourth = evidence({ id: 'e4', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-a-4', candidateValue: 'detailed', polarity: 'positive', weight: 3, observedAt: '2026-07-07T00:00:00.000Z' });
    store.createPreferenceEvidence(third); store.createPreferenceEvidence(fourth);
    const stable = calculatePreferenceProjection(store.listPreferenceEvidence('default', 'workspace-a'), 'workspace', 'workspace-a');
    assert.equal(stable?.status, 'stable');
    assert.equal(stable?.independentRunCount, 4);
    store.upsertPreferenceProjection(stable!);
    store.createPreferenceApplication({ runId: 'run-a-4', projectionId: stable!.id, resolvedValue: stable!.preferredValue, rank: 1, injectedCharacters: 42, appliedAt: '2026-07-07T00:00:00.000Z' });
    assert.equal(store.listPreferenceApplications('workspace-a', 'run-a-4')[0]?.injectedCharacters, 42);

    const planning = { ...evidence({ id: 'e5', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-a-5', candidateValue: 'detailed', polarity: 'positive', weight: 3, observedAt: '2026-07-08T00:00:00.000Z' }), contextKind: 'planning' as const };
    store.createPreferenceEvidence(planning);
    assert.equal(calculatePreferenceProjection([planning], 'workspace', 'workspace-a')?.contextKind, 'planning');

    const globalEvidence = evidence({ id: 'e6', workspaceId: 'workspace-b', conversationId: 'conversation-b', runId: 'run-b-1', candidateValue: 'detailed', polarity: 'positive', weight: 3, observedAt: '2026-07-09T00:00:00.000Z' });
    store.createPreferenceEvidence(globalEvidence);
    const global = calculatePreferenceProjection(store.listPreferenceEvidence('default'), 'global');
    assert.equal(global?.scope, 'global');
    assert.equal(new Set(store.listPreferenceEvidence('default').map(item => item.workspaceId)).size, 2);

    const negative1 = evidence({ id: 'e7', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-a-6', candidateValue: 'detailed', polarity: 'negative', weight: 4, observedAt: '2026-07-10T00:00:00.000Z' });
    const negative2 = evidence({ id: 'e8', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-a-7', candidateValue: 'detailed', polarity: 'negative', weight: 4, observedAt: '2026-07-11T00:00:00.000Z' });
    store.createPreferenceEvidence(negative1); store.createPreferenceEvidence(negative2);
    const dormant = calculatePreferenceProjection(store.listPreferenceEvidence('default', 'workspace-a'), 'workspace', 'workspace-a');
    assert.equal(dormant?.status, 'dormant');
    assert.doesNotMatch(store.listPreferenceEvidence('default')[0]?.summary ?? '', /SECRET|API_KEY|token/i);
    store.clearPreferenceProjections('default');
    assert.equal(store.listPreferenceProjections('default').length, 0);
    assert.equal(store.listPreferenceEvidence('default').length, 8);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
