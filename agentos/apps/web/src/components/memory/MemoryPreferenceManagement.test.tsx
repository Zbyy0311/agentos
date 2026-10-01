import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PreferenceEvidenceDto, PreferenceSuggestionDto } from '../../lib/memoryManagement.js';
import { MemoryPreferenceEvidenceList, MemoryPreferenceManagement, MemoryPreferenceSuggestionCard } from './MemoryPreferenceManagement.js';

const pending: PreferenceSuggestionDto = {
  id: 'suggestion-1', projectionId: 'projection-1', workspaceId: 'workspace-a', status: 'pending',
  version: 3, entryId: null, preferredValue: 'concise', dimension: 'response_detail', contextKind: 'coding',
  scope: 'global', confidence: 0.82, evidenceCount: 4,
};

test('MPM-01 learned defaults render as pending with explicit global confirmation and current-instruction priority', async () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const card = renderToStaticMarkup(<MemoryPreferenceSuggestionCard
    workspaceId="workspace-a"
    suggestion={pending}
    busy={false}
    confirmGlobal={false}
    onOpenRun={() => {}}
    onConfirmGlobalChange={() => {}}
    onAction={() => {}}
  />);
  const panel = renderToStaticMarkup(<MemoryPreferenceManagement workspaceId="workspace-a" onOpenRun={() => {}} />);
  assert.ok(card.includes('data-status="pending"'));
  assert.ok(card.includes('待确认'));
  assert.ok(card.includes('type="checkbox"'));
  assert.match(card, /确认偏好<\/button>/);
  assert.ok(!card.includes('disabled=""'));
  assert.ok(panel.includes('默认偏好仍低于你当前对话中的明确指令'));
  assert.ok(panel.includes('正在加载偏好建议'));
});

test('MPM-02 confirmed preference suggestions expose revoke and hide pending-only controls', async () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const confirmed = renderToStaticMarkup(<MemoryPreferenceSuggestionCard
    workspaceId="workspace-a"
    suggestion={{ ...pending, status: 'confirmed', scope: 'workspace', entryId: 'memory-entry-1' }}
    busy={false}
    confirmGlobal={false}
    onOpenRun={() => {}}
    onConfirmGlobalChange={() => {}}
    onAction={() => {}}
  />);
  assert.ok(confirmed.includes('已确认'));
  assert.ok(confirmed.includes('撤销确认'));
  assert.ok(confirmed.includes('查看来源依据（4）'));
  assert.ok(!confirmed.includes('type="checkbox"'));
  assert.ok(!confirmed.includes('拒绝</button>'));
});

test('MPM-03 preference evidence exposes the source Run and event link details', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const evidence: PreferenceEvidenceDto = {
    id: 'evidence-1', profileId: 'default', workspaceId: 'workspace-a', conversationId: 'conversation-1',
    runId: 'run-1234567890', sourceEventId: 'event-1', dimension: 'response_detail', contextKind: 'coding',
    candidateValue: 'concise', signalType: 'direct_correction', polarity: 'positive', weight: 3,
    summary: 'Asked for a concise answer', status: 'active', observedAt: '2026-10-01T01:02:03.000Z',
    createdAt: '2026-10-01T01:02:03.000Z',
  };
  const markup = renderToStaticMarkup(<MemoryPreferenceEvidenceList
    evidence={[evidence]}
    loading={false}
    error=""
    onRetry={() => {}}
    onOpenRun={() => {}}
  />);
  assert.ok(markup.includes('Asked for a concise answer'));
  assert.ok(markup.includes('打开来源 Run run-123456'));
  assert.ok(markup.includes('event-1'));
  assert.ok(markup.includes('conversation-1'));
});
