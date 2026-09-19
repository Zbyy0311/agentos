import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentRunDetails } from '@agentos/shared';
import { ExecutionArchive } from './ExecutionArchive.js';

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

test('ExecutionArchive separates compact filters into aligned rows', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(<ExecutionArchive details={details} />);

  assert.match(markup, /搜索执行档案/);
  assert.match(markup, /全部类型/);
  assert.match(markup, /flex h-8 items-center gap-1\.5/);
  assert.doesNotMatch(markup, /<\/select>/);
});
