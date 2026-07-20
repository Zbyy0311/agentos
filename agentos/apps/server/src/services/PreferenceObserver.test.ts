import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreferenceEvidence, PreferenceProjection } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { PreferenceObserver, type ObserveRunInput } from './PreferenceObserver.js';
import { PreferenceService } from './PreferenceService.js';

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-preference-observer-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [
    { id: 'workspace-a', name: 'A', rootPath: 'C:\\a', gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-17T00:00:00.000Z', createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z' },
  ] }), 'utf-8');
  return root;
}

function projection(): PreferenceProjection {
  return {
    id: 'projection-concise', profileId: 'default', scope: 'workspace', workspaceId: 'workspace-a',
    dimension: 'response_detail', contextKind: 'coding', preferredValue: 'concise', confidence: 86,
    score: 12, evidenceCount: 4, independentRunCount: 4, status: 'stable',
    lastSupportedAt: '2026-07-17T00:00:00.000Z', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

function input(overrides: Partial<ObserveRunInput> = {}): ObserveRunInput {
  return {
    profileId: 'default', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-5',
    objective: '实现设置页面', status: 'completed', resultSummary: '完成设置页面',
    appliedProjections: [projection()], followUpMessages: [], priorEvidence: [],
    ...overrides,
  };
}

test('creates negative evidence when a user corrects an applied preference', () => {
  const evidence = new PreferenceObserver().observeRun(input({
    followUpMessages: [{ id: 'message-correction', content: '请详细展开，不要只给简短结论', createdAt: '2026-07-17T00:01:00.000Z' }],
  }));
  const correction = evidence.find(item => item.polarity === 'negative');
  assert.equal(correction?.weight, 4);
  assert.equal(correction?.dimension, 'response_detail');
  assert.equal(correction?.candidateValue, 'concise');
  assert.doesNotMatch(correction?.summary ?? '', /详细展开|简短结论/);
});

test('creates positive repeated-instruction evidence across independent runs', () => {
  const prior: PreferenceEvidence = {
    id: 'prior', profileId: 'default', workspaceId: 'workspace-a', conversationId: 'conversation-old', runId: 'run-old',
    sourceEventId: 'event-old', dimension: 'execution_style', contextKind: 'coding', candidateValue: 'direct_execution',
    signalType: 'workflow_choice', polarity: 'positive', weight: 2, summary: '已观察到直接执行偏好', status: 'active',
    observedAt: '2026-07-16T00:00:00.000Z', createdAt: '2026-07-16T00:00:00.000Z',
  };
  const evidence = new PreferenceObserver().observeRun(input({
    objective: '以后直接执行，不要先问我', priorEvidence: [prior], appliedProjections: [],
  }));
  assert.equal(evidence[0]?.signalType, 'repeated_instruction');
  assert.equal(evidence[0]?.weight, 3);
  assert.equal(evidence[0]?.candidateValue, 'direct_execution');
});

test('does not learn concise from a negated concise instruction', () => {
  const evidence = new PreferenceObserver().observeRun(input({
    objective: '不要太简洁，保持信息完整',
    appliedProjections: [],
  }));
  assert.equal(evidence.some(item => item.candidateValue === 'concise'), false);
  assert.equal(evidence[0]?.candidateValue, 'balanced');
});

test('does not create successful-application evidence for failed runs', () => {
  const evidence = new PreferenceObserver().observeRun(input({ status: 'failed' }));
  assert.equal(evidence.some(item => item.signalType === 'successful_application'), false);
});

test('deduplicates evidence through the service and keeps user text out of storage', async () => {
  const root = createRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    store.createConversation({ id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'A', agentId: 'codex', createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z' });
    store.createMessage({ id: 'message-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', senderType: 'user', content: '实现设置页面', createdAt: '2026-07-17T00:00:00.000Z' });
    store.createRun({ id: 'run-5', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: '实现设置页面', status: 'completed', resultSummary: '完成', createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z' });
    const service = new PreferenceService(store, new PreferenceObserver());
    const observed = input({ followUpMessages: [{ id: 'message-correction', content: 'SECRET_KEY 请详细展开', createdAt: '2026-07-17T00:01:00.000Z' }] });
    await service.recordRunEvidence(observed);
    await service.recordRunEvidence(observed);
    const stored = store.listPreferenceEvidence('default', 'workspace-a');
    assert.equal(stored.length, 1);
    assert.doesNotMatch(stored[0]?.summary ?? '', /SECRET_KEY|详细展开/);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
