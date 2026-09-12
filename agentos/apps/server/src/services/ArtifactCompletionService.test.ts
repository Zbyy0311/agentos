import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { inTransaction } from '../store/Transaction.js';
import { ArtifactCompletionRepository } from '../store/ArtifactCompletionRepository.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { deriveWorkspaceEventContext } from '../store/WorkspaceEventWriter.js';
import { ArtifactCompletionService } from './ArtifactCompletionService.js';
import { RuntimeArtifactService, type CreateRuntimeArtifactInput } from './RuntimeArtifactService.js';
import { CanonicalArtifactResultService, parseArtifactResult } from './CanonicalArtifactResultService.js';
import { isDirectTestCommand } from './RuntimeArtifactCollector.js';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../migrations/migrations/013-workflow-creation-metadata-v2.js';
import express from 'express';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createArtifactCompletionRoutes } from '../routes/artifactCompletions.js';
import { createMemoryRuntimeRoutes } from '../routes/memoryRuntime.js';
import { createArtifactRoutes } from '../routes/artifacts.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { RuntimeArtifactCollector } from './RuntimeArtifactCollector.js';
import { MemoryRuntimeEventEmitter } from './MemoryRuntimeEventEmitter.js';
import { DurableMemoryRuntimeEventContextAuthority } from './MemoryRuntimeEventContextAuthority.js';
import { CodexAdapter } from '@agentos/agent-core';

const NOW = '2026-09-12T00:00:00.000Z';
const WS = 'ws_artifact';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-artifact-final-'));
  const store = new SqliteStore(root);
  store.saveWorkspaces([{ id: WS, name: WS, rootPath: root, agents: [], gitEnabled: false,
    memoryEnabled: true, createdAt: NOW, updatedAt: NOW, lastOpenedAt: NOW }]);
  store.createConversation({ id: 'conv', workspaceId: WS, type: 'direct', title: 'test', agentId: 'agent', createdAt: NOW, updatedAt: NOW });
  store.createMessage({ id: 'msg', workspaceId: WS, conversationId: 'conv', senderType: 'user', content: 'test', createdAt: NOW });
  store.createRun({ id: 'legacy_run', workspaceId: WS, conversationId: 'conv', sourceMessageId: 'msg', objective: 'test', status: 'running', createdAt: NOW, updatedAt: NOW });
  store.createExecution({ id: 'execution', runId: 'legacy_run', workspaceId: WS, conversationId: 'conv', sourceMessageId: 'msg', agentId: 'agent', mode: 'real', status: 'running_cli', createdAt: NOW, updatedAt: NOW });
  const artifacts = new RuntimeArtifactService(store, root);
  const service = new ArtifactCompletionService(store);
  return { root, store, artifacts, service, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function draft(fx: ReturnType<typeof fixture>, overrides: Partial<CreateRuntimeArtifactInput> = {}): CreateRuntimeArtifactInput {
  return { workspaceId: WS, workspaceRoot: fx.root, runId: 'legacy_run', sourceExecutionId: 'execution', agentId: 'agent',
    type: 'test', title: 'Test result', source: { kind: 'text', content: 'one test passed' },
    completion: { conclusion: 'pass', sourceKey: 'execution:execution:tool:one' }, ...overrides };
}
function count(fx: ReturnType<typeof fixture>, table: string): number {
  return Number((fx.store.getDatabase().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

test('LITE-07-104/108: exact concurrent finalization and replay converge, conflicting conclusion rejects', async () => {
  const fx = fixture();
  try {
    const [a, b] = await Promise.all([fx.artifacts.create(draft(fx)), fx.artifacts.create(draft(fx))]);
    assert.equal(a.id, b.id);
    const completion = new ArtifactCompletionRepository(fx.store.getDatabase()).findByArtifact(WS, a.id)!;
    const input = { workspaceId: WS, artifactId: a.id, sourceKey: completion.sourceKey, conclusion: 'pass', decidedAt: NOW };
    assert.equal(fx.service.complete(input).converged, true);
    assert.throws(() => fx.service.complete({ ...input, conclusion: 'fail' }), /ARTIFACT_COMPLETION_CONFLICT/);
    assert.throws(() => fx.service.complete({ ...input, conclusion: 'approved' }), /INPUT_INVALID/);
    assert.throws(() => fx.service.complete({ ...input, workspaceId: 'other' }), /NOT_FOUND/);
    assert.throws(() => fx.service.complete({ ...input, runId: 'legacy_run' }), /INPUT_INVALID/);
    assert.equal(count(fx, 'artifact_completions'), 1);
    assert.equal(count(fx, 'runtime_artifacts'), 1);
    assert.equal(count(fx, 'memory_candidate_entries'), 1);
    assert.equal(count(fx, 'workspace_events'), 1);
    assert.equal(count(fx, 'runtime_events'), 0);
    assert.equal(count(fx, 'outbox_messages'), 0);
    assert.equal(count(fx, 'operations'), 0);
    assert.throws(() => fx.store.getDatabase().prepare('UPDATE artifact_completions SET conclusion = ? WHERE id = ?').run('fail', completion.id), /IMMUTABLE/);
  } finally { fx.close(); }
});

for (const table of ['memory_candidate_entries', 'memory_candidate_sources', 'artifact_completions', 'workspace_events']) {
  test(`LITE-07-104/108: ${table} failure rolls back Artifact, completion, Candidate, Event and files`, async () => {
    const fx = fixture();
    try {
      fx.store.getDatabase().exec(`CREATE TRIGGER fail_finalization BEFORE INSERT ON ${table}
        BEGIN SELECT RAISE(ABORT, 'injected finalization failure'); END`);
      await assert.rejects(fx.artifacts.create(draft(fx)));
      for (const name of ['runtime_artifacts', 'artifact_completions', 'memory_candidate_entries', 'memory_candidate_sources', 'workspace_events']) {
        assert.equal(count(fx, name), 0, name);
      }
      assert.equal((fx.store.getDatabase().prepare('SELECT next_event_sequence AS n FROM workspaces WHERE id = ?').get(WS) as { n: number }).n, 1);
      assert.deepEqual(readdirSync(join(fx.root, '.agentos', 'artifacts', WS, 'legacy_run')), []);
      fx.store.getDatabase().exec('DROP TRIGGER fail_finalization');
      assert.ok(await fx.artifacts.create(draft(fx)));
    } finally { fx.close(); }
  });
}

test('LITE-07-108: source-specific Workspace creation cannot be redirected to a different Candidate or Event', async () => {
  const fx = fixture();
  try {
    const artifact = await fx.artifacts.create(draft(fx));
    const completion = new ArtifactCompletionRepository(fx.store.getDatabase()).findByArtifact(WS, artifact.id)!;
    const origin = { kind: 'memory.artifact_completion', completionId: completion.id } as const;
    for (const changes of [{ candidateId: 'another' }, { authority: 'user-explicit' }, { scope: 'global' }]) {
      assert.throws(() => inTransaction(fx.store.getDatabase(), () => fx.store.workspaceEventWriter().appendWithinTransaction({
        type: 'memory.candidate_created', workspaceId: WS, timestamp: NOW, origin, context: deriveWorkspaceEventContext(origin),
        payload: { candidateId: completion.candidateId, authority: 'agent-derived', scope: 'workspace', category: 'decision', decision: 'review-required', ...changes },
      })), /ORIGIN_UNPROVEN/);
    }
    assert.equal(count(fx, 'workspace_events'), 1);
  } finally { fx.close(); }
});

test('LITE-07-104: database refuses substituted Artifact/type/Workspace/Run source even outside the service', async () => {
  const fx = fixture();
  try {
    const a = await fx.artifacts.create(draft(fx));
    const unrelated = await fx.artifacts.create(draft(fx, { completion: undefined }));
    const completion = new ArtifactCompletionRepository(fx.store.getDatabase()).findByArtifact(WS, a.id)!;
    const insert = fx.store.getDatabase().prepare(`INSERT INTO artifact_completions
      (id,workspace_id,artifact_id,artifact_type,run_id,conclusion,candidate_id,source_key,decided_at,created_at)
      VALUES ('substitution',?,?,?,?,?,?, 'substitution',?,?)`);
    for (const [workspace, artifact, type, run, conclusion] of [
      [WS, unrelated.id, 'test', null, 'pass'], [WS, a.id, 'review', null, 'approved'],
      ['different-workspace', a.id, 'test', null, 'pass'], [WS, a.id, 'test', 'legacy_run', 'pass'],
    ]) {
      assert.throws(() => insert.run(workspace, artifact, type, run, conclusion, completion.candidateId, NOW, NOW), /ARTIFACT_COMPLETION_SOURCE_INVALID/);
    }
    assert.equal(count(fx, 'artifact_completions'), 1);
  } finally { fx.close(); }
});

function seedCanonical(fx: ReturnType<typeof fixture>): void {
  const db = fx.store.getDatabase();
  db.prepare("INSERT INTO tasks (id,workspace_id,title,status,created_by,created_at,updated_at) VALUES ('task',?,'review','open','test',?,?)").run(WS, NOW, NOW);
  db.prepare("INSERT INTO runs (id,workspace_id,task_id,root_run_id,status,reason,created_by,created_at,updated_at) VALUES ('run',?,'task','run','running','initial','test',?,?)").run(WS, NOW, NOW);
  db.prepare("INSERT INTO run_snapshots (id,workspace_id,run_id,workflow_definition_id,snapshot_schema_version,snapshot_json,content_hash,redaction_applied,captured_at) VALUES ('snap',?,'run',?,2,'{}',?,0,?)").run(WS, M3_013_LEGACY_WORKFLOW_V2_ID, '0'.repeat(64), NOW);
  db.prepare("INSERT INTO run_stages (id,workspace_id,run_id,run_snapshot_id,workflow_stage_key,name,sequence,attempt,status,created_at,updated_at) VALUES ('stage',?,'run','snap','review','review',1,1,'running',?,?)").run(WS, NOW, NOW);
  db.prepare("INSERT INTO operations (id,type,status,workspace_id,aggregate_type,aggregate_id,run_id,correlation_id,created_at,updated_at) VALUES ('op','run.start','running',?,'run','run','run','correlation',?,?)").run(WS, NOW, NOW);
}
const output = JSON.stringify({ agentosArtifact: { version: 1, type: 'review', conclusion: 'changes_requested', summary: 'A real review conclusion requiring changes.' } });

test('LITE-07-104: explicit canonical review result creates real-source Event/Outbox then reviews to Entry', async () => {
  const fx = fixture();
  try {
    seedCanonical(fx);
    const producer = new CanonicalArtifactResultService(fx.artifacts);
    const input = { workspaceId: WS, runId: 'run', stageId: 'stage', stageAttempt: 1, operationId: 'op', agentId: 'agent', output };
    const ids = await producer.capture(input);
    assert.equal(ids.length, 1);
    assert.deepEqual(await producer.capture(input), ids);
    assert.equal(fx.store.getRuntimeArtifactRecord(WS, ids[0]), undefined);
    assert.equal(fx.store.getCanonicalRuntimeArtifactRecord(WS, ids[0])?.canonicalRunId, 'run');
    const completion = new ArtifactCompletionRepository(fx.store.getDatabase()).findByArtifact(WS, ids[0])!;
    assert.equal(completion.runId, 'run');
    const candidates = new MemoryCandidateRepository(fx.store.getDatabase());
    const candidate = candidates.findCandidateById(WS, completion.candidateId)!;
    assert.deepEqual(candidate.sources, [{ kind: 'artifact', id: ids[0] }, { kind: 'run', id: 'run' }]);
    assert.equal(count(fx, 'runtime_events'), 1);
    assert.equal(count(fx, 'outbox_messages'), 1);
    assert.equal(count(fx, 'workspace_events'), 0);
    const accepted = candidates.reviewCandidate({ workspaceId: WS, candidateId: candidate.id, expectedVersion: 1, outcome: 'accept', reviewedAt: NOW }, { writer: fx.store.workspaceEventWriter() });
    assert.deepEqual(new MemoryEntryRepository(fx.store.getDatabase()).findById(WS, accepted.mergedIntoEntryId!)?.sources, candidate.sources);
    assert.equal((await fx.artifacts.readContentBytes(WS, ids[0])).toString(), 'A real review conclusion requiring changes.');
  } finally { fx.close(); }
});

test('LITE-07-104: concurrent conflicting producer result has stable conflict and one committed Artifact', async () => {
  const fx = fixture();
  try {
    const results = await Promise.allSettled([
      fx.artifacts.create(draft(fx)),
      fx.artifacts.create(draft(fx, { completion: { conclusion: 'fail', sourceKey: 'execution:execution:tool:one' } })),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(rejected.reason), /ARTIFACT_COMPLETION_CONFLICT/);
    for (const name of ['runtime_artifacts', 'artifact_completions', 'memory_candidate_entries', 'workspace_events']) assert.equal(count(fx, name), 1);
  } finally { fx.close(); }
});

test('LITE-07-104: stale canonical attempt or cancelled Run cannot publish a new result', async () => {
  const fx = fixture();
  try {
    seedCanonical(fx);
    const producer = new CanonicalArtifactResultService(fx.artifacts);
    const input = { workspaceId: WS, runId: 'run', stageId: 'stage', stageAttempt: 2, operationId: 'op', agentId: 'agent', output };
    await assert.rejects(producer.capture(input), /ARTIFACT_COMPLETION_SOURCE_INVALID/);
    fx.store.getDatabase().exec("UPDATE runs SET status = 'cancelled' WHERE id = 'run'");
    await assert.rejects(producer.capture({ ...input, stageAttempt: 1 }), /ARTIFACT_COMPLETION_SOURCE_INVALID/);
    assert.equal(count(fx, 'runtime_artifacts'), 0);
    assert.equal(count(fx, 'artifact_completions'), 0);
  } finally { fx.close(); }
});

test('LITE-07-108: canonical completion emitter rejects unrelated Candidate and completion identity', async () => {
  const fx = fixture();
  try {
    seedCanonical(fx);
    const ids = await new CanonicalArtifactResultService(fx.artifacts).capture({ workspaceId: WS, runId: 'run',
      stageId: 'stage', stageAttempt: 1, operationId: 'op', agentId: 'agent', output });
    const completion = new ArtifactCompletionRepository(fx.store.getDatabase()).findByArtifact(WS, ids[0])!;
    const emitter = new MemoryRuntimeEventEmitter({ store: fx.store, factWriter: fx.store.runtimeEventOutboxWriter(),
      eventAuthority: new DurableMemoryRuntimeEventContextAuthority(fx.store.getDatabase()) });
    for (const change of [{ candidateId: 'other' }, { completionId: 'other' }]) {
      assert.throws(() => inTransaction(fx.store.getDatabase(), () => emitter.emitPersistedCandidateWithinTransaction({
        workspaceId: WS, runId: 'run', candidateId: completion.candidateId, completionId: completion.id, timestamp: NOW,
        eventContext: { origin: 'operation', operationId: 'op', context: { correlationId: 'correlation', causationId: 'op' } }, ...change,
      })), /MEMORY_EVENT_INPUT_INVALID/);
    }
    assert.equal(count(fx, 'runtime_events'), 1);
    assert.equal(count(fx, 'outbox_messages'), 1);
  } finally { fx.close(); }
});

for (const table of ['runtime_events', 'outbox_messages']) {
  test(`LITE-07-104: canonical ${table} failure rolls back the whole finalization`, async () => {
    const fx = fixture();
    try {
      seedCanonical(fx);
      fx.store.getDatabase().exec(`CREATE TRIGGER fail_canonical BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected'); END`);
      await assert.rejects(new CanonicalArtifactResultService(fx.artifacts).capture({ workspaceId: WS, runId: 'run', stageId: 'stage', stageAttempt: 1, operationId: 'op', agentId: 'agent', output }));
      for (const name of ['runtime_artifacts', 'artifact_completions', 'memory_candidate_entries', 'runtime_events', 'outbox_messages']) assert.equal(count(fx, name), 0);
      assert.equal((fx.store.getDatabase().prepare("SELECT next_event_sequence AS n FROM runs WHERE id = 'run'").get() as { n: number }).n, 1);
      assert.deepEqual(readdirSync(join(fx.root, '.agentos', 'artifacts', 'canonical-results')), []);
    } finally { fx.close(); }
  });
}

test('LITE-07-104: only explicit typed results and direct test invocations are eligible', () => {
  assert.ok(parseArtifactResult(output));
  for (const value of ['approved', '{"status":"pass"}', output.replace('changes_requested', 'pass'), output + '\nextra', output.replace('"version":1', '"version":2')]) {
    assert.equal(parseArtifactResult(value), undefined);
  }
  assert.equal(isDirectTestCommand('node --test proof.test.cjs'), true);
  for (const command of ['npm test', 'pnpm run test', 'echo npm test', 'npm test || exit 0', 'npm test; echo ok', 'pytest --collect-only', 'vitest --help', 'pnpm test --watch', 'cmd /c npm test']) assert.equal(isDirectTestCommand(command), false, command);
});

test('LITE-07-104: real test subprocess -> collector -> HTTP queue/review -> Entry/source content', async () => {
  const fx = fixture();
  const app = express();
  app.use(express.json());
  const manager = new WorkspaceManager(fx.store);
  app.use('/api/workspaces/:workspaceId', createArtifactCompletionRoutes(fx.store, manager));
  app.use('/api/workspaces/:workspaceId', createMemoryRuntimeRoutes(fx.store, manager));
  app.use('/api/workspaces/:workspaceId', createArtifactRoutes(fx.store, manager, fx.artifacts));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/workspaces/${WS}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const testRoot = join(fx.root, 'real-test');
    mkdirSync(testRoot);
    writeFileSync(join(testRoot, 'proof.test.cjs'), "const test=require('node:test'); const assert=require('node:assert/strict'); test('real artifact evidence',()=>assert.equal(2+2,4));");
    // This executes a real test; normalized tool observations below describe
    // its actual status/output. It is not a live model invocation.
    // A node:test worker marks its environment. Forwarding that marker makes
    // the child skip its tests as a recursive runner, even with exit code 0.
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const stdout = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'proof.test.cjs'], {
      cwd: testRoot, encoding: 'utf8', env: childEnvironment,
    });
    assert.match(stdout, /ok 1 - real artifact evidence/);
    assert.match(stdout, /# tests 1/);
    assert.match(stdout, /# fail 0/);
    const collector = new RuntimeArtifactCollector(fx.artifacts);
    const ctx = { workspaceId: WS, workspaceRoot: testRoot, runId: 'legacy_run', sourceExecutionId: 'execution', agentId: 'agent' };
    const parser = new CodexAdapter().createParser();
    const observations = parser.push([
      { type: 'item.started', item: { type: 'command_execution', id: 'real', command: 'node --test proof.test.cjs' } },
      { type: 'item.completed', item: { type: 'command_execution', id: 'real', command: 'node --test proof.test.cjs', exit_code: 0, aggregated_output: stdout } },
    ].map(event => JSON.stringify(event)).join('\n') + '\n');
    for (const observation of observations) await collector.recordRuntimeEvent(ctx, observation);
    const listed = await (await fetch(base + '/artifact-completions')).json() as { completions: { id: string; candidateId: string; artifactId: string }[] };
    assert.equal(listed.completions.length, 1);
    const completion = listed.completions[0];
    const queue = await (await fetch(base + '/memory/candidates?outcome=review-required')).json() as { candidates: { id: string }[] };
    assert.ok(queue.candidates.some(candidate => candidate.id === completion.candidateId));
    assert.equal((await post('/artifact-completions', { artifactId: completion.artifactId, conclusion: 'pass' })).status, 200);
    assert.equal((await post('/artifact-completions', { artifactId: completion.artifactId, conclusion: 'fail' })).status, 409);
    assert.equal((await post('/artifact-completions', { artifactId: completion.artifactId, artifactType: 'review', conclusion: 'approved' })).status, 400);
    const response = await post(`/memory/candidates/${completion.candidateId}/review`, { expectedVersion: 1, outcome: 'accept' });
    assert.equal(response.status, 200);
    const candidate = new MemoryCandidateRepository(fx.store.getDatabase()).findCandidateById(WS, completion.candidateId)!;
    const entry = new MemoryEntryRepository(fx.store.getDatabase()).findById(WS, candidate.mergedIntoEntryId!)!;
    assert.deepEqual(entry.sources, [{ kind: 'artifact', id: completion.artifactId }]);
    const content = await fetch(`${base}/artifacts/${completion.artifactId}/content`);
    assert.equal(content.status, 200);
    assert.match(await content.text(), /real artifact evidence/);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/workspaces/other/artifact-completions/${completion.id}`)).status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fx.close();
  }
});
