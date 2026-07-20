import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const agentListSource = readFileSync(new URL('../components/chat/AgentList.tsx', import.meta.url), 'utf8');
const globalStyles = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

test('keeps group chats and project knowledge accessible in the collapsed sidebar', () => {
  assert.match(agentListSource, /workspace-group-button/);
  assert.match(agentListSource, /aria-label=\{group\.title\}/);
  assert.match(agentListSource, /workspace-knowledge-button/);
  assert.match(agentListSource, /workspace-knowledge-label/);
  assert.match(globalStyles, /\.workspace-group-button[\s\S]*justify-content: center/);
  assert.match(globalStyles, /\.workspace-knowledge-button[\s\S]*place-items: center/);
});
