import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('shows provider and CLI command as separate agent identity fields', async () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const { AgentEditor } = await import('./AgentEditor.js');
  const markup = renderToStaticMarkup(
    <AgentEditor
      agent={{
        id: 'reviewer', name: 'Reviewer', provider: 'opencode', role: 'opencode', enabled: true,
        cliCommand: 'C:/tools/opencode-wrapper.cmd', cliArgs: ['run'], runtime: { configuredProvider: 'opencode', detectedProvider: 'codex', mismatch: true }, workspaceId: 'workspace-a',
        roleTitle: '代码审查', systemPrompt: 'Review', permissions: ['read'],
        createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
      }}
      saving={false}
      onClose={() => undefined}
      onSave={() => undefined}
    />,
  );

  assert.match(markup, /Provider/);
  assert.match(markup, /value="opencode"/);
  assert.match(markup, /C:\/tools\/opencode-wrapper\.cmd/);
  assert.match(markup, /职责仍单独/);
  assert.match(markup, /配置：opencode；实际：codex/);
});
