import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentProfile } from '@agentos/shared';
import { getInitialComposerSettings, getModelOptions, getRuntimeOverrides, getThinkingEfforts, normalizeThinkingEffort } from './composerSettings';

const agent: AgentProfile = {
  id: 'codex', workspaceId: 'workspace-a', name: 'Codex', role: 'codex', enabled: true,
  cliCommand: 'codex', cliArgs: [], roleTitle: '架构师', systemPrompt: '完成任务。', permissions: ['read'],
  model: 'codex-default', thinkingEffort: 'high',
  capability: {
    role: 'codex', cliKind: 'codex', models: ['legacy-model'],
    modelOptions: [
      { id: 'codex-default', label: 'Codex Default', thinkingEfforts: ['auto', 'medium', 'high'], defaultThinkingEffort: 'medium' },
      { id: 'fast-model', label: 'Fast Model', thinkingEfforts: ['auto'], defaultThinkingEffort: 'auto' },
    ],
    thinkingEfforts: ['auto', 'medium', 'high'], defaultModel: 'codex-default', defaultThinkingEffort: 'medium',
  },
  createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
};

test('prefers dynamically discovered model options over legacy model ids', () => {
    assert.deepEqual(getModelOptions(agent).map(model => model.id), ['codex-default', 'fast-model']);
  });

test('falls back to auto when a selected model does not support the current effort', () => {
    assert.equal(normalizeThinkingEffort('high', getThinkingEfforts(agent, 'fast-model')), 'auto');
  });

test('initializes from the Agent default without inventing a model override', () => {
    assert.deepEqual(getInitialComposerSettings(agent), { model: 'codex-default', thinkingEffort: 'high' });
  });

test('restores conversation settings over the Agent default', () => {
    assert.deepEqual(getInitialComposerSettings(agent, { model: 'fast-model', thinkingEffort: 'auto' }), { model: 'fast-model', thinkingEffort: 'auto' });
  });

test('normalizes a saved effort when the saved model no longer supports it', () => {
    assert.deepEqual(getInitialComposerSettings(agent, { model: 'fast-model', thinkingEffort: 'high' }), { model: 'fast-model', thinkingEffort: 'auto' });
  });

test('uses capability defaults when the profile has no model', () => {
    const withoutModel = { ...agent, model: undefined, thinkingEffort: undefined };
    assert.deepEqual(getInitialComposerSettings(withoutModel), { model: undefined, thinkingEffort: 'medium' });
  });

test('does not send the Agent default as a fake per-message override', () => {
    assert.deepEqual(getRuntimeOverrides(agent, { model: 'codex-default', thinkingEffort: 'high' }), { model: undefined, thinkingEffort: undefined });
    assert.deepEqual(getRuntimeOverrides(agent, { model: 'fast-model', thinkingEffort: 'medium' }), { model: 'fast-model', thinkingEffort: 'medium' });
  });
