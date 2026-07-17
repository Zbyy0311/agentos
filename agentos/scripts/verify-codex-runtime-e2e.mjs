import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = join(repoRoot, 'scripts', 'fixtures', 'codex-artifact-project');
const runtimeFixture = join(repoRoot, 'scripts', 'fixtures', 'codex-runtime-agent');
const projectRoot = mkdtempSync(join(tmpdir(), 'agentos-codex-runtime-'));
const workspace = join(projectRoot, 'workspace-root');
const result = { fixture: false, plain: false, server: false, realCodex: 'UNAVAILABLE' };
let serverProcess;

function git(args, cwd = workspace) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function writeWorkspaceConfig(cliCommand) {
  const now = new Date().toISOString();
  mkdirSync(join(projectRoot, 'workspace'), { recursive: true });
  writeFileSync(join(projectRoot, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: 'fixture-ws',
      name: 'Codex Runtime Fixture',
      rootPath: workspace,
      gitEnabled: true,
      memoryEnabled: false,
      agents: [{
        id: 'codex', name: 'Codex Fixture', role: 'codex', enabled: true,
        cliCommand, cliArgs: ['exec'], thinkingEffort: 'auto',
      }],
      lastOpenedAt: now, createdAt: now, updatedAt: now,
    }],
  }, null, 2), 'utf8');
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The server may still be starting.
    }
    await sleep(50);
  }
  throw new Error('AgentOS server did not become healthy');
}

async function readSse(response) {
  if (!response.ok) throw new Error(`SSE request failed: ${await response.text()}`);
  assert.ok(response.body, 'SSE response body is missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  const consume = block => {
    const lines = block.split(/\r?\n/);
    let event = 'message';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data) events.push({ event, data: JSON.parse(data) });
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let boundary;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(buffer.match(/\r?\n\r?\n/)?.[0].length + boundary);
    }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  return events;
}

async function api(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  assert.equal(response.ok, true, `${options.method ?? 'GET'} ${path}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function runDeterministicServerGate() {
  cpSync(runtimeFixture, workspace, { recursive: true });
  git(['init']);
  git(['add', '.']);
  git(['-c', 'user.email=agentos@example.com', '-c', 'user.name=AgentOS', 'commit', '-m', 'clean baseline']);

  const cliCommand = join(workspace, 'codex.cmd');
  writeWorkspaceConfig(cliCommand);
  const port = 38000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [join(repoRoot, 'apps', 'server', 'dist', 'index.js')], {
    cwd: repoRoot,
    env: { ...process.env, AGENTOS_PROJECT_ROOT: projectRoot, AGENTOS_FORCE_MOCK: 'false', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverOutput = '';
  serverProcess.stdout?.on('data', chunk => { serverOutput += chunk.toString(); });
  serverProcess.stderr?.on('data', chunk => { serverOutput += chunk.toString(); });
  await waitForHealth(baseUrl).catch(error => {
    throw new Error(`${error.message}\n${serverOutput}`);
  });

  const workspaces = await api(baseUrl, '/api/workspaces');
  assert.equal(workspaces.workspaces[0].id, 'fixture-ws');
  const conversationResult = await api(baseUrl, '/api/workspaces/fixture-ws/conversations', {
    method: 'POST', body: JSON.stringify({ agentId: 'codex' }),
  });
  const conversationId = conversationResult.conversation.id;
  const streamResponse = await fetch(`${baseUrl}/api/workspaces/fixture-ws/conversations/${conversationId}/messages/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '完成一次确定性的运行时验收。' }),
  });
  const streamEvents = await readSse(streamResponse);
  const runEvent = streamEvents.find(item => item.event === 'run');
  assert.ok(runEvent?.data?.runId, 'SSE did not emit a run event');
  const runId = runEvent.data.runId;
  const runtimeEvents = streamEvents.filter(item => item.event === 'runtime').map(item => item.data);
  const runtimeTypes = new Set(runtimeEvents.map(item => item.type));
  assert.equal(runtimeTypes.has('execution.tool.started'), true, `runtime types: ${[...runtimeTypes].join(', ')}`);
  assert.equal(runtimeTypes.has('execution.tool.completed'), true, `runtime types: ${[...runtimeTypes].join(', ')}`);
  assert.equal(runtimeTypes.has('execution.output.appended'), true, `runtime types: ${[...runtimeTypes].join(', ')}`);
  assert.equal(runtimeTypes.has('execution.usage.recorded'), true, `runtime types: ${[...runtimeTypes].join(', ')}`);
  assert.equal(streamEvents.some(item => item.event === 'done'), true, `SSE events: ${streamEvents.map(item => item.event).join(', ')}`);
  const serializedRuntime = JSON.stringify(runtimeEvents);
  assert.equal(serializedRuntime.includes('thread.started'), false);
  assert.equal(serializedRuntime.includes('private reasoning'), false);

  const details = await api(baseUrl, `/api/workspaces/fixture-ws/runs/${runId}`);
  const artifactTypes = new Set(details.artifacts.map(artifact => artifact.type));
  for (const type of ['file', 'image', 'report', 'diff', 'log']) assert.equal(artifactTypes.has(type), true, `missing ${type} artifact; got ${details.artifacts.map(artifact => artifact.type + ':' + artifact.title).join(', ')}`);
  assert.equal(details.events.some(event => event.type === 'execution.artifact.created'), true);
  assert.equal(details.fileChanges.some(change => change.path === 'architecture.md'), true);
  assert.equal(details.fileChanges.some(change => change.path === 'artifacts/demo.png'), true);

  for (const artifact of details.artifacts.filter(item => item.contentAvailable)) {
    const content = await fetch(`${baseUrl}/api/workspaces/fixture-ws/artifacts/${encodeURIComponent(artifact.id)}/content`);
    assert.equal(content.ok, true, `artifact content failed for ${artifact.title}`);
    const bytes = Buffer.from(await content.arrayBuffer());
    assert.ok(bytes.length > 0, `artifact content is empty for ${artifact.title}`);
  }

  const replayResponse = await fetch(`${baseUrl}/api/workspaces/fixture-ws/conversations/${conversationId}/runs/${runId}/stream?cursor=0`);
  const replayEvents = await readSse(replayResponse);
  assert.equal(replayEvents.some(item => item.event === 'runtime'), true);
  assert.equal(replayEvents.some(item => item.event === 'done'), true);
  result.server = true;
}

try {
  cpSync(fixture, join(projectRoot, 'fixture-basic'), { recursive: true });
  const basic = join(projectRoot, 'fixture-basic');
  git(['init'], basic);
  git(['add', '.'], basic);
  git(['-c', 'user.email=agentos@example.com', '-c', 'user.name=AgentOS', 'commit', '-m', 'clean baseline'], basic);
  const source = join(basic, 'executor.ts');
  writeFileSync(source, readFileSync(source, 'utf8').replace('1000', '2000'), 'utf8');
  const test = spawnSync(process.execPath, [join(basic, 'test.mjs')], { encoding: 'utf8' });
  assert.equal(test.status, 0, test.stderr || test.stdout);
  assert.match(git(['diff', '--no-ext-diff', 'HEAD'], basic), /DEFAULT_TIMEOUT_MS = 2000/);
  assert.match(git(['status', '--porcelain'], basic), /executor\.ts/);
  result.fixture = true;

  const plain = spawnSync(process.execPath, ['-e', "process.stdout.write('plain response')"], { encoding: 'utf8' });
  assert.equal(plain.status, 0);
  assert.equal(plain.stdout, 'plain response');
  result.plain = true;

  await runDeterministicServerGate();
  console.log('CODEX_FIXTURE: passed');
  console.log('PLAIN_FIXTURE: passed');
  console.log('SERVER_RUNTIME_FIXTURE: passed');

  const configured = process.env.AGENTOS_CODEX_CLI || 'codex';
  const probe = spawnSync(configured, ['--version'], { encoding: 'utf8', windowsHide: true, shell: false });
  if (probe.error || probe.status !== 0) {
    console.log(`REAL_CODEX: UNAVAILABLE (${probe.error?.code || `exit ${probe.status}`})`);
  } else {
    const help = spawnSync(configured, ['exec', '--help'], { encoding: 'utf8', windowsHide: true, shell: false });
    if (help.error || help.status !== 0 || !/--json/.test(help.stdout + help.stderr)) {
      throw new Error(`Codex structured probe failed: ${help.error?.message || help.stderr || help.stdout}`);
    }
    result.realCodex = 'AVAILABLE_STRUCTURED';
  }
  console.log(`REAL_CODEX: ${result.realCodex}`);
} finally {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill();
    await Promise.race([
      new Promise(resolve => serverProcess.once('exit', resolve)),
      sleep(1000),
    ]);
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(projectRoot, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 9) throw error;
      await sleep(100);
    }
  }
}

if (!result.fixture || !result.plain || !result.server) process.exitCode = 1;
