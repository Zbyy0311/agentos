import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentRunDetails } from '@agentos/shared';
import { RunDetails } from './RunDetails.js';

const details: AgentRunDetails = {
  run: {
    id: 'run-1',
    workspaceId: 'workspace-1',
    conversationId: 'conversation-1',
    sourceMessageId: 'message-1',
    objective: '测试运行',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:01Z',
  },
  sourceMessage: {
    id: 'message-1',
    workspaceId: 'workspace-1',
    conversationId: 'conversation-1',
    senderType: 'user',
    content: '测试运行',
    createdAt: '2026-01-01T00:00:00Z',
  },
  executions: [],
  events: [],
  cliInvocations: [],
  fileChanges: [],
  artifacts: [],
  usedMemories: [],
  preferenceApplications: [],
  steps: [],
};

test('RunDetails keeps its action header sticky while details scroll', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(
    <RunDetails details={details} apiBase="http://localhost:4000" onClose={() => undefined} onGenerateCandidates={() => undefined} />,
  );

  assert.match(markup, /ui-modal-sticky-header/);
  assert.match(markup, /生成记忆候选/);
  assert.match(markup, /关闭/);
  assert.match(markup, /aria-label="Execution archive"/);
  assert.match(markup, /搜索执行档案/);
});
