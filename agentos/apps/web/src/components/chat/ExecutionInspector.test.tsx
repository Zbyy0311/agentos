import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('shows token consumption from execution statistics', async () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const { ExecutionInspector } = await import('./ExecutionInspector.js');
  const markup = renderToStaticMarkup(
    <ExecutionInspector
      agent={{
        id: 'codex',
        name: 'Codex',
        role: 'codex',
        enabled: true,
        cliCommand: 'codex',
        cliArgs: [],
        workspaceId: 'workspace-a',
        roleTitle: '首席架构师',
        systemPrompt: '',
        permissions: ['read'],
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
      }}
      events={[]}
      runtimeEvents={[{
        eventId: 'usage-1',
        schemaVersion: 2,
        sequence: 1,
        type: 'execution.usage.recorded',
        workspaceId: 'workspace-a',
        conversationId: 'conversation-a',
        runId: 'run-a',
        executionId: 'execution-a',
        timestamp: '2026-07-18T00:00:00.000Z',
        payload: { inputTokens: 15, outputTokens: 6, cachedInputTokens: 7 },
      }]}
      executions={[]}
    />,
  );

  assert.equal(markup.includes('Tokens 28'), true);
  assert.equal(markup.includes('消耗'), true);
  assert.equal(markup.includes('Duration'), true);
  assert.equal(markup.includes('Files'), true);
});
