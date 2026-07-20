import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationMember } from '@agentos/shared';
import { GroupOrchestrator, MAX_GROUP_HANDOFF_CHARACTERS } from './GroupOrchestrator.js';

const members: ConversationMember[] = [
  { conversationId: 'group', agentId: 'leader', roleKind: 'leader', roleTitle: 'Leader', sequence: 10, createdAt: '2026-07-18T00:00:00.000Z' },
  { conversationId: 'group', agentId: 'worker', roleKind: 'worker', roleTitle: 'Worker', sequence: 20, createdAt: '2026-07-18T00:00:00.000Z' },
];

test('orchestrator keeps turn order and bounds handoff content', () => {
  const orchestrator = new GroupOrchestrator();
  assert.deepEqual(orchestrator.turns({ action: 'full_pipeline', publicReason: 'all' }, members, 'task').map(turn => turn.agentId), ['leader', 'worker']);
  const handoff = orchestrator.sanitizeHandoff({ objective: 'task', changedFiles: ['file.ts'], artifactTitles: [], publicConclusion: 'x'.repeat(MAX_GROUP_HANDOFF_CHARACTERS) });
  assert.ok(handoff.length <= MAX_GROUP_HANDOFF_CHARACTERS);
});
