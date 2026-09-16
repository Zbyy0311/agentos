import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { RuntimeGroupCreator } from './RuntimeGroupCreator.js';

test('LITE-12-103 runtime group creator exposes bounded sequential setup', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(
    <RuntimeGroupCreator
      agents={[
        { id: 'agent_a', name: 'Codex', status: 'idle' },
        { id: 'agent_b', name: 'Kimi', status: 'idle' },
      ]}
      onClose={() => {}}
      onCreate={() => {}}
    />,
  );
  assert.ok(markup.includes('role="dialog"'));
  assert.ok(markup.includes('创建运行时群聊'));
  assert.ok(markup.includes('顺序回复（sequential）'));
  assert.ok(markup.includes('Codex'));
  assert.ok(markup.includes('Kimi'));
  assert.ok(markup.includes('至少选择两个'));
});
