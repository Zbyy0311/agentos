import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { RuntimeGroupSettings } from './RuntimeGroupSettings.js';

test('LITE-GROUP-032 runtime group settings renders member-scoped model and effort controls', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(
    <RuntimeGroupSettings
      agents={[
        {
          id: 'codex', name: 'Codex', status: 'idle',
          capability: {
            role: 'codex', cliKind: 'codex', models: ['model-a'],
            modelOptions: [{ id: 'model-a', label: 'Model A', thinkingEfforts: ['auto', 'high', 'max'], defaultThinkingEffort: 'high' }],
            thinkingEfforts: ['auto', 'high', 'max'], defaultThinkingEffort: 'high',
          },
        },
        { id: 'kimi', name: 'Kimi', status: 'idle' },
      ]}
      members={[
        { id: 'member_user', conversationId: 'conv', workspaceId: 'ws', subjectType: 'user', subjectId: 'user', displayNameSnapshot: 'You', role: 'owner', roleTitle: '用户', replyMode: 'always', status: 'active', joinedAt: 'now', removedAt: null, version: 1 },
        { id: 'member_codex', conversationId: 'conv', workspaceId: 'ws', subjectType: 'agent', subjectId: 'codex', displayNameSnapshot: 'Codex', role: 'participant', roleTitle: '规划', replyMode: 'always', status: 'active', model: 'model-a', thinkingEffort: 'high', additionalInstructions: '先规划', joinedAt: 'now', removedAt: null, version: 1 },
        { id: 'member_kimi', conversationId: 'conv', workspaceId: 'ws', subjectType: 'agent', subjectId: 'kimi', displayNameSnapshot: 'Kimi', role: 'participant', roleTitle: '执行', replyMode: 'always', status: 'active', joinedAt: 'now', removedAt: null, version: 1 },
      ]}
      saving={false}
      onClose={() => {}}
      onSave={() => {}}
    />,
  );
  assert.ok(markup.includes('群聊成员设置'));
  assert.ok(markup.includes('Codex'));
  assert.ok(markup.includes('Kimi'));
  assert.ok(markup.includes('使用模型'));
  assert.ok(markup.includes('思考强度'));
  assert.ok(markup.includes('Model A'));
  assert.ok(markup.includes('高'));
  assert.ok(markup.includes('aria-haspopup="listbox"'));
  assert.ok(!markup.includes('<select'));
  assert.ok(markup.includes('先规划'));
  assert.ok(markup.includes('设置版本校验'));
});
