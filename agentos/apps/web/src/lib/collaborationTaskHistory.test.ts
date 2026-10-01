import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCollaborationTaskPage, resolveExplicitTaskProgress } from './collaborationTaskHistory.ts';

function task(id: number, conversationId = 'group-a') {
  return { id: `task-${id}`, conversationId, updatedAt: new Date(2026, 0, id).toISOString() } as never;
}

test('task history pagination retains the selected task while appending page 2 past item 100', () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => task(index + 1));
  const secondPage = [task(101), task(102)];
  const merged = mergeCollaborationTaskPage(firstPage, secondPage, 'task-25');
  assert.equal(merged.tasks.length, 102);
  assert.equal(merged.selectedTaskId, 'task-25');
  assert.equal(merged.hasMore, false);
});

test('an explicit task absent from the first page is resolved directly and checked against its conversation', () => {
  const valid = { task: task(101), runs: [] } as never;
  const invalid = { task: task(101, 'group-b'), runs: [] } as never;
  assert.equal(resolveExplicitTaskProgress(valid, 'group-a'), valid);
  assert.equal(resolveExplicitTaskProgress(valid, 'group-a', 'task-101'), valid);
  assert.equal(resolveExplicitTaskProgress(invalid, 'group-a'), undefined);
  assert.equal(resolveExplicitTaskProgress(valid, 'group-a', 'task-other'), undefined);
});
