import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { EventBus } from '../events/EventBus.js';
import { RunStepService } from './RunStepService.js';

function createStore(): { root: string; store: SqliteStore } {
  const root = mkdtempSync(join(tmpdir(), 'agentos-run-steps-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
    id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
    agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
    lastOpenedAt: '2026-07-18T00:00:00.000Z', createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
  }] }), 'utf8');
  const store = new SqliteStore(root);
  store.createConversation({ id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'Steps', agentId: 'codex', createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z' });
  store.createMessage({ id: 'message-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', senderType: 'user', content: 'steps', createdAt: '2026-07-18T00:00:01.000Z' });
  store.createRun({ id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: 'steps', status: 'running', createdAt: '2026-07-18T00:00:01.000Z', updatedAt: '2026-07-18T00:00:01.000Z' });
  return { root, store };
}

test('createOrGet is idempotent by stable key and sibling sequence is unique', async () => {
  const { root, store } = createStore();
  try {
    const service = new RunStepService(store, new EventBus(draft => store.appendAgentEvent(draft)));
    const input = { stableStepKey: 'direct.agent', workspaceId: 'workspace-a', runId: 'run-a', kind: 'agent' as const, title: 'Agent 执行', sequence: 20 };
    const first = await service.createOrGet(input);
    const second = await service.createOrGet(input);
    assert.equal(first.id, second.id);
    assert.equal(store.listRunSteps('workspace-a', 'run-a').length, 1);

    await assert.rejects(service.createOrGet({ ...input, stableStepKey: 'direct.review', kind: 'review', title: 'Review' }), /already exists|UNIQUE/);
    assert.equal(store.listRunSteps('workspace-a', 'run-a').length, 1);
    assert.equal(store.listAgentEvents('workspace-a', 'run-a').length, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('enforces state transitions, increments attempt on waiting resume, and records terminal duration', async () => {
  const { root, store } = createStore();
  try {
    const service = new RunStepService(store);
    await service.createOrGet({ stableStepKey: 'direct.agent', workspaceId: 'workspace-a', runId: 'run-a', kind: 'agent', title: 'Agent 执行', sequence: 20 });
    await service.update({ workspaceId: 'workspace-a', runId: 'run-a', stableStepKey: 'direct.agent', status: 'running', executionId: 'execution-a' });
    await service.update({ workspaceId: 'workspace-a', runId: 'run-a', stableStepKey: 'direct.agent', status: 'waiting', summary: '等待补充信息' });
    const resumed = await service.update({ workspaceId: 'workspace-a', runId: 'run-a', stableStepKey: 'direct.agent', status: 'running', executionId: 'execution-b' });
    assert.equal(resumed.attempt, 2);
    assert.equal(resumed.executionId, 'execution-b');
    const completed = await service.update({ workspaceId: 'workspace-a', runId: 'run-a', stableStepKey: 'direct.agent', status: 'completed', summary: '完成' });
    assert.equal(completed.completedAt !== undefined, true);
    assert.equal(completed.updatedEventSequence > completed.createdEventSequence, true);
    await assert.rejects(service.update({ workspaceId: 'workspace-a', runId: 'run-a', stableStepKey: 'direct.agent', status: 'running' }), /Invalid RunStep transition/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('initializes the four direct steps and recovery is idempotent', async () => {
  const { root, store } = createStore();
  try {
    const service = new RunStepService(store);
    const steps = await service.initializeDirectRun({ workspaceId: 'workspace-a', runId: 'run-a', agentId: 'codex' });
    assert.deepEqual(steps.map(step => `${step.sequence}:${step.stableStepKey}`), [
      '10:direct.context', '20:direct.agent', '30:direct.artifacts', '40:direct.summary',
    ]);
    await service.update({ workspaceId: 'workspace-a', runId: 'run-a', stableStepKey: 'direct.context', status: 'running' });
    await service.reconcileInterruptedRun({ workspaceId: 'workspace-a', runId: 'run-a', reason: '服务重启导致执行中断' });
    await service.reconcileInterruptedRun({ workspaceId: 'workspace-a', runId: 'run-a', reason: '服务重启导致执行中断' });
    const recovered = store.listRunSteps('workspace-a', 'run-a');
    assert.equal(recovered.find(step => step.stableStepKey === 'direct.context')?.status, 'failed');
    assert.equal(recovered.filter(step => step.status === 'skipped').length, 3);
    assert.equal(store.listAgentEvents('workspace-a', 'run-a').length, 9);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
