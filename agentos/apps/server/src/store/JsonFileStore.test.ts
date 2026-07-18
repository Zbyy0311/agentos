import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskItem } from '@agentos/shared';
import { JsonFileStore } from './JsonFileStore.js';

function makeTask(id: string): TaskItem {
  return {
    id,
    workspaceId: 'workspace-a',
    title: id,
    status: 'pending',
    currentAgent: null,
    outputs: [],
    reviewDecision: 'unknown',
    reviewBlocked: false,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

test('saveTask preserves tasks added after an older snapshot was loaded', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-json-store-'));
  try {
    const store = new JsonFileStore(root);
    const first = makeTask('task-a');
    store.saveTasks('workspace-a', [first]);
    const stale = store.loadTasks('workspace-a');

    store.saveTask('workspace-a', makeTask('task-b'));
    stale[0].status = 'running';
    store.saveTask('workspace-a', stale[0]);

    assert.deepEqual(
      store.loadTasks('workspace-a').map(task => `${task.id}:${task.status}`).sort(),
      ['task-a:running', 'task-b:pending'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
