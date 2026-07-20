import test from 'node:test';
import assert from 'node:assert/strict';
import { getArtifactContentUrl, getChatVisibleArtifacts, normalizeArtifacts } from './artifacts.js';
import type { RuntimeArtifact } from '@agentos/shared';

const base: RuntimeArtifact = {
  id: 'artifact-a', workspaceId: 'workspace/a', runId: 'run-a', sourceExecutionId: 'execution-a', agentId: 'codex',
  type: 'report', title: 'Test report', sizeBytes: 12, contentAvailable: true, createdAt: '2026-07-17T00:00:02.000Z',
};

test('sorts artifacts by creation time without mutating the API response', () => {
  const later = { ...base, id: 'artifact-b', createdAt: '2026-07-17T00:00:03.000Z' };
  const input = [later, base];
  assert.deepEqual(normalizeArtifacts(input).map(item => item.id), ['artifact-a', 'artifact-b']);
  assert.deepEqual(input.map(item => item.id), ['artifact-b', 'artifact-a']);
});

test('builds an encoded content URL and omits metadata-only content', () => {
  assert.equal(getArtifactContentUrl('http://localhost:3000', base), 'http://localhost:3000/api/workspaces/workspace%2Fa/artifacts/artifact-a/content');
  assert.equal(getArtifactContentUrl('http://localhost:3000', { ...base, contentAvailable: false }), undefined);
});

test('hides execution log artifacts from the chat shelf', () => {
  const log = { ...base, id: 'artifact-log', type: 'log' as const, title: 'Execution log' };
  const visible = getChatVisibleArtifacts([log, base]);
  assert.deepEqual(visible.map(item => item.id), ['artifact-a']);
});

test('does not expose a chat shelf when a run only produced a log', () => {
  const log = { ...base, id: 'artifact-log', type: 'log' as const, title: 'Execution log' };
  assert.deepEqual(getChatVisibleArtifacts([log]), []);
});
