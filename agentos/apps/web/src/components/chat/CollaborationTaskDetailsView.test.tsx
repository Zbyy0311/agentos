import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CollaborationProgress } from '@agentos/shared';
import type { CollaborationProgressState } from '../../lib/useCollaborationProgress';
import { CollaborationTaskDetailsView } from './CollaborationTaskDetailsView';

function renderDetails(status: 'failed' | 'running'): string {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const task = {
    id: 'collab-recovery-view', status, title: 'Recover a failed task', objective: 'Keep the original goal and history.',
    version: 3, baseCommit: '0123456789abcdef', reworkRound: 0, maxReworkRounds: 2,
    plannerAgentId: 'planner', implementerAgentId: 'implementer', reviewerAgentId: 'reviewer',
    scope: ['README.md'], acceptanceCommands: ['git status --short'],
  } as unknown as CollaborationProgress['task'];
  const progress = {
    task, currentRunId: undefined, currentStage: null, runs: [], candidates: [], waitingReason: undefined,
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

test('failed collaboration details render the recovery panel while active tasks do not', () => {
  assert.match(renderDetails('failed'), /aria-label="协作任务恢复"/u);
  assert.doesNotMatch(renderDetails('running'), /aria-label="协作任务恢复"/u);
});
