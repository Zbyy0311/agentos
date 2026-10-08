import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { RuntimeArtifactService } from './RuntimeArtifactService.js';
import { RuntimeArtifactCollector } from './RuntimeArtifactCollector.js';
import { ArtifactCompletionRepository } from '../store/ArtifactCompletionRepository.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';

function git(root: string, args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

// Temp-dir cleanup is best-effort: on Windows a background process watching the
// filesystem can transiently hold a freshly created .git directory, so a failed
// removal must not fail an otherwise-passing test.
function removeTempDir(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // ignore — leftover temp dir is harmless
  }
}

test('LITE-07-104: actual collector finalizes test Artifact through Candidate/Event/review/Entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-artifact-collector-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
    id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
    agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
    lastOpenedAt: '2026-07-17T00:00:00.000Z', createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  }] }), 'utf8');
  const store = new SqliteStore(root);
  const now = '2026-07-17T00:00:00.000Z';
  store.createConversation({ id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'Artifacts', agentId: 'codex', createdAt: now, updatedAt: now });
  store.createMessage({ id: 'message-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', senderType: 'user', content: 'artifact test', createdAt: now });
  store.createRun({ id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: 'artifact test', status: 'running', createdAt: now, updatedAt: now });
  store.createExecution({ id: 'execution-a', runId: 'run-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', sourceMessageId: 'message-a', agentId: 'codex', status: 'running_cli', mode: 'real', createdAt: now, updatedAt: now });
  const source = join(root, 'executor.ts');
  writeFileSync(source, 'before', 'utf8');
  git(root, ['init']);
  git(root, ['add', 'executor.ts', 'workspace/workspaces.json']);
  git(root, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'initial']);
  const service = new RuntimeArtifactService(store, root);
  let notifications = 0;
  const collector = new RuntimeArtifactCollector(service, () => { notifications += 1; });
  const context = { workspaceId: 'workspace-a', workspaceRoot: root, runId: 'run-a', sourceExecutionId: 'execution-a', agentId: 'codex' };
  try {
    collector.start(context);
    writeFileSync(source, 'after', 'utf8');
    await collector.recordRuntimeEvent(context, { type: 'tool.started', callId: 'test-1', toolName: 'command_execution', summary: 'node --test proof.test.cjs', inputPreview: 'node --test proof.test.cjs' });
    const done = { type: 'tool.completed' as const, callId: 'test-1', toolName: 'command_execution', success: true,
      summary: 'command_execution 完成', outputPreview: '1 passed', commandResult: { command: 'node --test proof.test.cjs', exitCode: 0 } };
    await collector.recordRuntimeEvent(context, done);
    await collector.recordRuntimeEvent(context, done);
    assert.equal(notifications, 1);
    await assert.rejects(collector.recordRuntimeEvent(context, { ...done, success: false,
      commandResult: { ...done.commandResult, exitCode: 1 } }), /ARTIFACT_COMPLETION_CONFLICT/);
    await collector.collectFileChanges(context, [{ path: 'executor.ts', changeType: 'modified' }]);
    await collector.finalize(context);
    const artifacts = store.listRuntimeArtifacts('workspace-a', 'run-a');
    assert.deepEqual(new Set(artifacts.map(artifact => artifact.type)), new Set(['file', 'diff', 'test', 'log']));
    assert.equal(artifacts.every(artifact => artifact.sourceExecutionId === 'execution-a'), true);
    const artifact = artifacts.find(item => item.type === 'test')!;
    const completion = new ArtifactCompletionRepository(store.getDatabase()).findByArtifact('workspace-a', artifact.id)!;
    assert.equal(completion.conclusion, 'pass');
    assert.equal(completion.runId, null); // real legacy Run is not a canonical Run
    const candidates = new MemoryCandidateRepository(store.getDatabase());
    const candidate = candidates.findCandidateById('workspace-a', completion.candidateId)!;
    assert.equal(candidate.outcome, 'review-required');
    assert.equal(candidate.authority, 'agent-derived');
    assert.deepEqual(candidate.sources, [{ kind: 'artifact', id: artifact.id }]);
    const created = store.getDatabase().prepare('SELECT type, payload_json FROM workspace_events').all() as { type: string; payload_json: string }[];
    assert.equal(created.length, 1);
    assert.equal(created[0].type, 'memory.candidate_created');
    assert.equal(JSON.parse(created[0].payload_json).candidateId, candidate.id);
    const accepted = candidates.reviewCandidate({ workspaceId: 'workspace-a', candidateId: candidate.id,
      expectedVersion: 1, outcome: 'accept', reviewedAt: new Date().toISOString() }, { writer: store.workspaceEventWriter() });
    const entry = new MemoryEntryRepository(store.getDatabase()).findById('workspace-a', accepted.mergedIntoEntryId!)!;
    assert.deepEqual(entry.sources, [{ kind: 'artifact', id: artifact.id }]);
    assert.ok((await service.readContentBytes('workspace-a', artifact.id)).toString('utf8').includes('Status: passed'));
    const replay = new RuntimeArtifactCollector(service);
    await replay.recordRuntimeEvent(context, done);
    assert.equal(new ArtifactCompletionRepository(store.getDatabase()).list('workspace-a').length, 1);
    assert.equal((store.getDatabase().prepare("SELECT COUNT(*) AS n FROM workspace_events WHERE type = 'memory.candidate_created'").get() as { n: number }).n, 1);
  } finally {
    store.close();
    removeTempDir(root);
  }
});

test('recognizes Windows shell wrappers around npm test for report artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-artifact-shell-'));
  const store = new SqliteStore(root);
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  execFileSync('git', ['-C', workspaceRoot, 'init'], { stdio: 'ignore' });
  writeFileSync(join(workspaceRoot, 'package.json'), '{"scripts":{"test":"node -e \\"console.log(1 passed)\\"}}', 'utf8');
  execFileSync('git', ['-C', workspaceRoot, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspaceRoot, '-c', 'user.email=agentos@example.com', '-c', 'user.name=AgentOS', 'commit', '-m', 'baseline'], { stdio: 'ignore' });
  const workspace = {
    id: 'workspace-shell', name: 'Shell', rootPath: workspaceRoot, gitEnabled: true, memoryEnabled: false, agents: [],
    lastOpenedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  store.saveWorkspaces([workspace]);
  store.createConversation({ id: 'conversation-shell', workspaceId: workspace.id, type: 'direct', title: 'Shell', agentId: 'codex', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  store.createMessage({ id: 'message-shell', conversationId: 'conversation-shell', workspaceId: workspace.id, senderType: 'user', content: 'test', createdAt: new Date().toISOString() });
  store.createRun({ id: 'run-shell', workspaceId: workspace.id, conversationId: 'conversation-shell', sourceMessageId: 'message-shell', objective: 'test', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  store.createExecution({ id: 'execution-shell', runId: 'run-shell', conversationId: 'conversation-shell', workspaceId: workspace.id, sourceMessageId: 'message-shell', agentId: 'codex', status: 'running_cli', mode: 'real', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const service = new RuntimeArtifactService(store, root);
  const collector = new RuntimeArtifactCollector(service);
  const context = { workspaceId: workspace.id, workspaceRoot, runId: 'run-shell', sourceExecutionId: 'execution-shell', agentId: 'codex' };
  collector.start(context);
  await collector.recordRuntimeEvent(context, { type: 'tool.started', callId: 'call-shell', toolName: 'command_execution', summary: 'command_execution', inputPreview: 'command_execution: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'npm test\'' });
  await collector.recordRuntimeEvent(context, { type: 'tool.completed', callId: 'call-shell', toolName: 'command_execution', success: true, summary: 'command_execution complete', outputPreview: '1 passed' });
  try {
    const artifacts = store.listRuntimeArtifacts(workspace.id, 'run-shell');
    assert.equal(artifacts.some(artifact => artifact.type === 'report'), true);
    await collector.recordRuntimeEvent(context, { type: 'tool.started', callId: 'unknown-exit', toolName: 'command_execution', summary: 'node --test proof.test.cjs' });
    await collector.recordRuntimeEvent(context, { type: 'tool.completed', callId: 'unknown-exit', toolName: 'command_execution', success: true, summary: 'completed' });
    assert.equal(new ArtifactCompletionRepository(store.getDatabase()).list(workspace.id).length, 0);
  } finally {
    store.close();
    removeTempDir(root);
  }
});
