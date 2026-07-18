import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { buildExecutionArchive } from '../apps/web/src/lib/executionArchive.ts';
import { upsertRunStep } from '../apps/web/src/lib/runSteps.ts';

const now = '2026-07-18T00:00:00.000Z';
const events = Array.from({ length: 1000 }, (_, index) => ({
  eventId: `event-${index}`,
  schemaVersion: 2,
  sequence: index + 1,
  type: index % 5 === 0 ? 'execution.tool.completed' : 'execution.status',
  workspaceId: 'fixture-workspace', conversationId: 'fixture-conversation', runId: 'fixture-run', timestamp: now,
  ...(index % 7 === 0 ? { agentId: `agent-${index % 3}` } : {}),
  payload: index % 5 === 0 ? { toolName: `tool-${index % 100}`, summary: `file-${index}.ts` } : { status: 'running' },
}));
const steps = Array.from({ length: 20 }, (_, index) => ({
  id: `step-${index}`, stableStepKey: `direct.step-${index}`, workspaceId: 'fixture-workspace', runId: 'fixture-run', kind: 'agent', title: `Step ${index}`, status: index === 19 ? 'completed' : 'running', sequence: (index + 1) * 10, attempt: 1, createdEventSequence: index + 1, updatedEventSequence: index + 1, createdAt: now, updatedAt: now,
}));
const messages = Array.from({ length: 500 }, (_, index) => ({ id: `message-${index}`, content: `message ${index}` }));
const toolPairs = Array.from({ length: 100 }, (_, index) => ({ started: `tool-started-${index}`, completed: `tool-completed-${index}` }));
const details = {
  run: { id: 'fixture-run', workspaceId: 'fixture-workspace', conversationId: 'fixture-conversation', sourceMessageId: 'fixture-message', objective: 'fixture', status: 'completed', createdAt: now, updatedAt: now, completedAt: now },
  sourceMessage: { id: 'fixture-message', conversationId: 'fixture-conversation', workspaceId: 'fixture-workspace', senderType: 'user', content: 'fixture', createdAt: now },
  executions: [], events, cliInvocations: [], fileChanges: Array.from({ length: 100 }, (_, index) => ({ path: `src/file-${index}.ts`, changeType: 'modified' })),
  artifacts: Array.from({ length: 5 }, (_, index) => ({ id: `artifact-${index}`, workspaceId: 'fixture-workspace', runId: 'fixture-run', sourceExecutionId: 'execution', agentId: 'codex', type: 'report', title: `report-${index}.md`, sizeBytes: 128, contentAvailable: true, createdAt: now })),
  usedMemories: [], preferenceApplications: [], steps,
};

const archiveStart = performance.now();
const archive = buildExecutionArchive(details);
const archiveDuration = performance.now() - archiveStart;
assert.equal(events.length, 1000);
assert.equal(steps.length, 20);
assert.equal(messages.length, 500);
assert.equal(toolPairs.length, 100);
assert.equal(details.artifacts.length, 5);
assert.equal(archive.length > 1000, true);
assert.ok(archiveDuration < 50, `buildExecutionArchive took ${archiveDuration.toFixed(2)}ms`);

let projected = [];
for (let index = 0; index < 300; index += 1) {
  projected = upsertRunStep(projected, { ...steps[index % steps.length], updatedEventSequence: index + 1 });
}
assert.equal(projected.length, 20, 'replayed step events must not duplicate rows');

if (process.env.AGENTOS_VERIFY_API_URL) {
  const started = performance.now();
  const response = await fetch(process.env.AGENTOS_VERIFY_API_URL);
  assert.equal(response.ok, true);
  assert.ok(performance.now() - started < 500, 'Run Details API exceeded 500ms');
} else {
  console.log('Run Details API gate skipped: set AGENTOS_VERIFY_API_URL for a live local endpoint.');
}
console.log(`Execution workbench fixture passed: ${archive.length} archive items, archive ${archiveDuration.toFixed(2)}ms.`);
