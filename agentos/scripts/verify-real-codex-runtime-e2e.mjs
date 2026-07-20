import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = join(repoRoot, 'scripts', 'fixtures', 'codex-artifact-project');
const cliCommand = process.env.AGENTOS_CODEX_CLI || 'codex';
const projectRoot = mkdtempSync(join(tmpdir(), 'agentos-real-codex-gate-'));
const workspace = join(projectRoot, 'workspace-root');
let serverProcess;

function git(args) {
  return execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(100);
  }
  throw new Error('AgentOS server did not become healthy');
}

async function api(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function readSse(response) {
  if (!response.ok) throw new Error(`SSE request failed: ${await response.text()}`);
  assert.ok(response.body, 'SSE response body is missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  const consume = block => {
    let event = 'message';
    let data = '';
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data) events.push({ event, data: JSON.parse(data) });
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) break;
      consume(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  return events;
}

function writeWorkspaceConfig() {
  const now = new Date().toISOString();
  mkdirSync(join(projectRoot, 'workspace'), { recursive: true });
  writeFileSync(join(projectRoot, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
    id: 'real-codex-ws',
    name: 'Real Codex Gate',
    rootPath: workspace,
    gitEnabled: true,
    memoryEnabled: false,
    agents: [{
      id: 'codex', name: 'Codex', role: 'codex', enabled: true,
      cliCommand, cliArgs: ['exec', '--ephemeral', '--skip-git-repo-check'], thinkingEffort: 'auto',
    }],
    lastOpenedAt: now, createdAt: now, updatedAt: now,
  }] }), 'utf8');
}

async function main() {
  const version = spawnSync(cliCommand, ['--version'], { encoding: 'utf8', windowsHide: true, shell: false });
  if (version.error || version.status !== 0) {
    console.log(`REAL_AGENTOS_CODEX: UNAVAILABLE (${version.error?.code || `exit ${version.status}`})`);
    process.exitCode = 2;
    return;
  }
  const help = spawnSync(cliCommand, ['exec', '--help'], { encoding: 'utf8', windowsHide: true, shell: false });
  if (help.error || help.status !== 0 || !/--json/.test(`${help.stdout}${help.stderr}`)) {
    throw new Error(`Codex structured probe failed: ${help.error?.message || help.stderr || help.stdout}`);
  }

  cpSync(fixture, workspace, { recursive: true });
  const baselineTest = readFileSync(join(workspace, 'test.mjs'), 'utf8');
  git(['init']);
  git(['add', '.']);
  git(['-c', 'user.email=agentos@example.com', '-c', 'user.name=AgentOS', 'commit', '-m', 'clean baseline']);
  writeWorkspaceConfig();

  const port = 39000 + Math.floor(Math.random() * 500);
  const baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [join(repoRoot, 'apps', 'server', 'dist', 'index.js')], {
    cwd: repoRoot,
    env: { ...process.env, AGENTOS_PROJECT_ROOT: projectRoot, AGENTOS_FORCE_MOCK: 'false', PORT: String(port), AGENTOS_CODEX_CLI: cliCommand },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverOutput = '';
  serverProcess.stdout?.on('data', chunk => { serverOutput += chunk.toString(); });
  serverProcess.stderr?.on('data', chunk => { serverOutput += chunk.toString(); });
  await waitForHealth(baseUrl).catch(error => { throw new Error(`${error.message}\n${serverOutput}`); });

  await api(baseUrl, '/api/workspaces/real-codex-ws/agents/codex', {
    method: 'PATCH', body: JSON.stringify({ permissions: ['read', 'write'] }),
  });
  const conversation = await api(baseUrl, '/api/workspaces/real-codex-ws/conversations', {
    method: 'POST', body: JSON.stringify({ agentId: 'codex', title: 'Real Codex artifact gate' }),
  });
  const conversationId = conversation.conversation.id;
  const prompt = '在当前 Git workspace 中执行一个受控任务：把 executor.ts 中 DEFAULT_TIMEOUT_MS 从 1000 改为 2000，运行 npm test，然后创建 architecture.md 说明这项配置。不要修改其他文件，不要创建 Git commit。完成后用简短中文总结。';
  const stream = await fetch(`${baseUrl}/api/workspaces/real-codex-ws/conversations/${conversationId}/messages/stream`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: prompt }),
  });
  const events = await readSse(stream);
  const run = events.find(event => event.event === 'run');
  assert.ok(run?.data?.runId, 'real Codex run event missing');
  assert.equal(events.some(event => event.event === 'error'), false, JSON.stringify(events.filter(event => event.event === 'error')));
  assert.equal(events.some(event => event.event === 'done'), true, `SSE events: ${events.map(event => event.event).join(', ')}`);
  const runtimeTypes = new Set(events.filter(event => event.event === 'runtime').map(event => event.data.type));
  assert.equal(runtimeTypes.has('execution.tool.started'), true);
  assert.equal(runtimeTypes.has('execution.tool.completed'), true);
  assert.equal(runtimeTypes.has('execution.output.appended'), true);

  const details = await api(baseUrl, `/api/workspaces/real-codex-ws/runs/${run.data.runId}`);
  const types = new Set(details.artifacts.map(artifact => artifact.type));
  for (const type of ['file', 'diff', 'report', 'log']) assert.equal(types.has(type), true, `missing real ${type} artifact`);
  assert.equal(details.fileChanges.some(change => change.path === 'executor.ts'), true);
  assert.equal(details.fileChanges.some(change => change.path === 'architecture.md'), true);
  assert.match(readFileSync(join(workspace, 'executor.ts'), 'utf8'), /DEFAULT_TIMEOUT_MS = 2000/);
  assert.equal(readFileSync(join(workspace, 'test.mjs'), 'utf8'), baselineTest);
  for (const artifact of details.artifacts.filter(item => item.contentAvailable)) {
    const content = await fetch(`${baseUrl}/api/workspaces/real-codex-ws/artifacts/${encodeURIComponent(artifact.id)}/content`);
    assert.equal(content.ok, true, `artifact content failed for ${artifact.title}`);
    assert.ok((await content.arrayBuffer()).byteLength > 0);
  }
  console.log(`REAL_AGENTOS_CODEX: passed (${version.stdout.trim()})`);
  console.log('REAL_AGENTOS_ARTIFACTS: file,diff,report,log');
}

try {
  await main();
} finally {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill();
    await Promise.race([new Promise(resolve => serverProcess.once('exit', resolve)), sleep(1000)]);
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
