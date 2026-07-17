import test from 'node:test';
import assert from 'node:assert/strict';
import type { PreferenceProjection } from '@agentos/shared';
import { classifyPreferenceContext } from './PreferenceContextClassifier.js';
import { resolvePreferenceProjections } from './PreferenceResolver.js';
import { buildPreferenceContext } from './PreferenceContextBuilder.js';

function projection(overrides: Partial<PreferenceProjection> = {}): PreferenceProjection {
  return {
    id: `projection-${overrides.dimension ?? 'response_detail'}-${overrides.contextKind ?? 'coding'}-${overrides.scope ?? 'global'}`,
    profileId: 'default',
    scope: 'global',
    dimension: 'response_detail',
    contextKind: 'coding',
    preferredValue: 'concise',
    confidence: 86,
    score: 12,
    evidenceCount: 4,
    independentRunCount: 4,
    status: 'stable',
    lastSupportedAt: '2026-07-17T00:00:00.000Z',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

test('classifies common interaction tasks and falls back to general', () => {
  assert.equal(classifyPreferenceContext({ objective: '修复登录接口报错' }), 'debugging');
  assert.equal(classifyPreferenceContext({ objective: '设计下一阶段架构方案' }), 'planning');
  assert.equal(classifyPreferenceContext({ objective: '请审查这个 PR' }), 'review');
  assert.equal(classifyPreferenceContext({ objective: '解释这段代码为什么失败' }), 'explanation');
  assert.equal(classifyPreferenceContext({ objective: '实现一个用户设置页面' }), 'coding');
  assert.equal(classifyPreferenceContext({ objective: '你好' }), 'general');
});

test('prefers Workspace scene projections over global defaults', () => {
  const resolved = resolvePreferenceProjections({
    workspaceId: 'workspace-a', contextKind: 'coding', projections: [
      projection({ id: 'global', scope: 'global', confidence: 95 }),
      projection({ id: 'local', scope: 'workspace', workspaceId: 'workspace-a', confidence: 62 }),
    ],
  });
  assert.deepEqual(resolved.map(item => item.projectionId), ['local']);
});

test('omits close-confidence opposite values at the same priority', () => {
  const resolved = resolvePreferenceProjections({
    workspaceId: 'workspace-a', contextKind: 'coding', projections: [
      projection({ id: 'concise', preferredValue: 'concise', confidence: 86 }),
      projection({ id: 'detailed', preferredValue: 'detailed', confidence: 82 }),
    ],
  });
  assert.deepEqual(resolved, []);
});

test('renders only provisional and stable preferences within 800 characters', () => {
  const result = buildPreferenceContext({
    runId: 'run-context', workspaceId: 'workspace-a', objective: '实现一个页面',
    projections: [
      projection({ id: 'stable', status: 'stable', confidence: 86 }),
      projection({ id: 'provisional', status: 'provisional', confidence: 68, dimension: 'execution_style', preferredValue: 'direct_execution' }),
      projection({ id: 'observed', status: 'observed', confidence: 62, dimension: 'verification_depth', preferredValue: 'targeted' }),
    ],
  });
  assert.ok(result.text.startsWith('## 用户交互与工作偏好\n以下内容仅为历史默认偏好；如与当前用户要求冲突，以当前要求为准。'));
  assert.ok(result.text.length <= 800);
  assert.match(result.text, /concise/);
  assert.match(result.text, /direct_execution/);
  assert.doesNotMatch(result.text, /targeted/);
  assert.equal(result.applications.length, 2);
});
