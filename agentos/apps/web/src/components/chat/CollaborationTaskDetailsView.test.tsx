import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CollaborationProgress } from '@agentos/shared';
import type { CollaborationProgressState } from '../../lib/useCollaborationProgress';
import { shouldRenderCollaborationRecoveryPanel } from './CollaborationRecoveryPanel';
import { CollaborationTaskDetailsView } from './CollaborationTaskDetailsView';

function renderDetails(status: 'failed' | 'blocked' | 'running' | 'queued' | 'awaiting_application'): string {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const task = {
    id: 'collab-recovery-view', status, title: 'Recover a failed task', objective: 'Keep the original goal and history.',
    version: 3, baseCommit: '0123456789abcdef', reworkRound: 0, maxReworkRounds: 2,
    currentCandidateId: status === 'awaiting_application' ? 'frozen-preview' : undefined,
    plannerAgentId: 'planner', implementerAgentId: 'implementer', reviewerAgentId: 'reviewer',
    scope: ['README.md'], acceptanceCommands: ['git status --short'],
  } as unknown as CollaborationProgress['task'];
  const candidate = {
    id: 'frozen-preview', round: 0, diffHash: 'd'.repeat(64), contentHash: 'a'.repeat(64), testStatus: 'passed',
  } as unknown as CollaborationProgress['candidates'][number];
  const progress = {
    task, currentRunId: undefined, currentStage: null, runs: [],
    candidates: status === 'awaiting_application' ? [candidate] : [], waitingReason: undefined,
  } as unknown as CollaborationProgress;
  const state = {
    tasks: [task], hasMoreTasks: false, loadingMoreTasks: false, selectedTaskId: task.id,
    progress, loading: false, error: '', connection: 'disconnected', refreshRevision: 0,
    selectTask: () => undefined, loadMoreTasks: () => undefined, refresh: () => undefined,
  } as unknown as CollaborationProgressState;
  return renderToStaticMarkup(<CollaborationTaskDetailsView
    workspaceId="workspace-test" apiBase="http://127.0.0.1:1" state={state} agents={[]}
    onBack={() => undefined} onOpenRun={() => undefined}
  />);
}

test('failed collaboration details render recovery while ordinary queued and active tasks stay quiet', () => {
  assert.match(renderDetails('failed'), /aria-label="协作任务恢复"/u);
  assert.match(renderDetails('blocked'), /aria-label="协作任务恢复"/u);
  assert.doesNotMatch(renderDetails('queued'), /aria-label="协作任务恢复"/u);
  assert.doesNotMatch(renderDetails('running'), /aria-label="协作任务恢复"/u);
});

test('queued recovery UI appears only after the server offers a resumable action', () => {
  const unavailable = { actions: { retryKnownFailure: false, newLinkedTask: false } } as Parameters<typeof shouldRenderCollaborationRecoveryPanel>[0];
  const resumable = { actions: { retryKnownFailure: true, newLinkedTask: false } } as Parameters<typeof shouldRenderCollaborationRecoveryPanel>[0];
  const linkedOnly = { actions: { retryKnownFailure: false, newLinkedTask: true } } as Parameters<typeof shouldRenderCollaborationRecoveryPanel>[0];
  assert.equal(shouldRenderCollaborationRecoveryPanel(null, false), false, 'queued loading state has no placeholder');
  assert.equal(shouldRenderCollaborationRecoveryPanel(unavailable, false), false);
  assert.equal(shouldRenderCollaborationRecoveryPanel(resumable, false), true);
  assert.equal(shouldRenderCollaborationRecoveryPanel(linkedOnly, false), true);
  assert.equal(shouldRenderCollaborationRecoveryPanel(unavailable, true), true, 'failed tasks retain their unavailable explanation');
});

test('collaboration details render frozen preview and keep Apply disabled until it is inspected', () => {
  const markup = renderDetails('awaiting_application');
  assert.match(markup, /查看冻结文件与差异/u);
  assert.match(markup, /先查看候选差异/u);
  assert.match(markup, /disabled=""/u);
  assert.match(markup, /a{64}/u);
});
