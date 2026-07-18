import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const plannerCli = join(repoRoot, 'scripts', 'fixtures', 'codex.cmd');
const codexCli = process.env.AGENTOS_CODEX_CLI || 'codex';
const kimiCli = process.env.AGENTOS_KIMI_CLI || 'kimi';
const projectRoot = mkdtempSync(join(tmpdir(), 'agentos-real-worktree-gate-'));
const workspace = join(projectRoot, 'workspace-root');
const worktreeRoot = join(projectRoot, '.agentos', 'worktrees');
const workspaceId = 'real-worktree-ws';
const port = 39600 + Math.floor(Math.random() * 300);
const baseUrl = `http://127.0.0.1:${port}`;
const baseline = 'WORKTREE_BASELINE\n';
let serverProcess;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(args, cwd = workspace) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForHealth() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('AgentOS worktree gate server did not become healthy');
}

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const event = block.match(/^event:\s*(.+)$/m)?.[1] ?? 'message';
    const raw = block.match(/^data:\s*(.+)$/m)?.[1];
    if (raw) {
      try { events.push({ event, data: JSON.parse(raw) }); } catch { events.push({ event, data: raw }); }
    }
  }
  return events;
}

async function runGroup(conversationId, content) {
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/conversations/${conversationId}/messages/stream`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
  });
  const text = await response.text();
  assert(response.ok, `group SSE failed: ${text.slice(0, 500)}`);
  const events = parseSse(text);
  const errorEvent = events.find(event => event.event === 'error');
  if (errorEvent) throw new Error(`group SSE emitted an error: ${JSON.stringify(errorEvent.data)}`);
  assert(events.some(event => event.event === 'done'), `group SSE did not finish: ${events.map(event => event.event).join(',')}`);
  return events;
}

function writeWorkspaceConfig() {
  const now = new Date().toISOString();
  mkdirSync(join(projectRoot, 'workspace'), { recursive: true });
  writeFileSync(join(projectRoot, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
    id: workspaceId,
    name: 'Real Worktree Gate',
    rootPath: workspace,
    gitEnabled: true,
    memoryEnabled: false,
    agents: [
      { id: 'planner', name: 'Deterministic Planner', provider: 'codex', role: 'codex', enabled: true, cliCommand: plannerCli, cliArgs: [], thinkingEffort: 'auto' },
      { id: 'kimi', name: 'KimiCode', provider: 'kimi', role: 'kimi', enabled: true, cliCommand: kimiCli, cliArgs: ['-m', 'kimi-code/kimi-for-coding', '-p'], model: 'kimi-code/kimi-for-coding', thinkingEffort: 'auto' },
      { id: 'codex-worker', name: 'Codex Worker', provider: 'codex', role: 'codex', enabled: true, cliCommand: codexCli, cliArgs: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--ephemeral'], thinkingEffort: 'auto' },
    ],
    lastOpenedAt: now, createdAt: now, updatedAt: now,
  }] }), 'utf8');
}

function readWorktreeList() {
  return git(['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/).filter(Boolean).map(block => ({
    path: block.match(/^worktree (.+)$/m)?.[1],
    branch: block.match(/^branch (.+)$/m)?.[1],
  }));
}

async function downloadArtifact(artifact) {
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/artifacts/${encodeURIComponent(artifact.id)}/content`);
  assert(response.ok, `artifact content failed: ${artifact.title}`);
  return Buffer.from(await response.arrayBuffer());
}

function assertNoWorktreeGitDirectories(root) {
  if (!existsSync(root)) return;
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        assert(entry.name !== '.git', `worktree root contains a leftover .git directory: ${path}`);
        visit(path);
      }
    }
  };
  visit(root);
}

async function main() {
  const versionChecks = [
    ['codex', codexCli, ['--version']],
    ['kimi', kimiCli, ['--version']],
  ];
  for (const [name, command, args] of versionChecks) {
    const probe = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, shell: false });
    assert(!probe.error && probe.status === 0, `${name} unavailable: ${probe.error?.message ?? probe.stderr}`);
  }

  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'shared.txt'), baseline, 'utf8');
  writeFileSync(join(workspace, 'README.md'), '# Real Worktree Gate\n', 'utf8');
  writeFileSync(join(workspace, '.gitignore'), '.agentos/\n', 'utf8');
  git(['init']);
  git(['add', '.']);
  git(['-c', 'user.email=agentos@example.com', '-c', 'user.name=AgentOS', 'commit', '-m', 'clean worktree baseline']);
  writeWorkspaceConfig();

  serverProcess = spawn(process.execPath, [join(repoRoot, 'apps', 'server', 'dist', 'index.js')], {
    cwd: repoRoot,
    env: { ...process.env, AGENTOS_PROJECT_ROOT: projectRoot, AGENTOS_WORKTREE_ROOT: worktreeRoot, AGENTOS_WORKTREE_MODE: 'isolated', AGENTOS_FORCE_MOCK: 'false', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverOutput = '';
  serverProcess.stdout?.on('data', chunk => { serverOutput += chunk.toString(); });
  serverProcess.stderr?.on('data', chunk => { serverOutput += chunk.toString(); });
  await waitForHealth().catch(error => { throw new Error(`${error.message}\n${serverOutput}`); });

  await api(`/api/workspaces/${workspaceId}/agents/codex-worker`, { method: 'PATCH', body: JSON.stringify({ permissions: ['read', 'write'] }) });
  const created = await api(`/api/workspaces/${workspaceId}/conversations`, {
    method: 'POST',
    body: JSON.stringify({ type: 'group', title: 'Real isolated worktree gate', memberAgentIds: ['planner', 'kimi', 'codex-worker'], leaderAgentId: 'planner', dispatchMode: 'full_pipeline' }),
  });
  const conversationId = created.conversation.id;
  const prompt = [
    'This is a real AgentOS isolation acceptance gate. Do not ask questions and do not create a git commit.',
    'The deterministic leader delegates the implementation to both KimiCode and the Codex worker.',
    'Each write-capable worker must operate only in its assigned execution worktree and do exactly this:',
    '1. Replace shared.txt with exactly one line: WORKTREE_SHARED_OK.',
    '2. Create one new untracked file named agent-kimi.txt for KimiCode or agent-codex-worker.txt for the Codex worker, containing exactly its agent name and a newline.',
    '3. Do not modify README.md, agent-memory, or any other file.',
    'Report the changed files briefly after completing the write.',
  ].join('\n');
  await runGroup(conversationId, prompt);

  const runs = await api(`/api/workspaces/${workspaceId}/runs?conversationId=${encodeURIComponent(conversationId)}&limit=5`);
  assert(runs.runs?.[0]?.status === 'completed', `isolated group status=${runs.runs?.[0]?.status}`);
  const runId = runs.runs[0].id;
  const details = await api(`/api/workspaces/${workspaceId}/runs/${runId}`);
  const leasesResponse = await api(`/api/workspaces/${workspaceId}/worktrees`);
  const leases = leasesResponse.leases.filter(lease => lease.runId === runId);
  assert(leases.length === 2, `expected two worker leases, got ${leases.length}`);
  assert(leases.every(lease => lease.status === 'completed'), `worker leases were not completed: ${JSON.stringify(leases)}`);
  const worktreeEntries = readWorktreeList();

  const mainStatus = git(['status', '--porcelain']);
  assert(mainStatus === '', `main workspace changed during isolated run: ${mainStatus}`);
  assert(readFileSync(join(workspace, 'shared.txt'), 'utf8') === baseline, 'main shared.txt changed');

  const restoreRoot = mkdtempSync(join(projectRoot, 'restore-'));
  for (const lease of leases) {
    const executionPath = worktreeEntries.find(item => item.path?.replaceAll('\\', '/').endsWith(`/${lease.pathLabel.split('/').at(-1)}`))?.path;
    assert(executionPath, `could not locate worktree for ${lease.agentId}`);
    const actualShared = readFileSync(join(executionPath, 'shared.txt'), 'utf8');
    assert(actualShared !== baseline, `${lease.agentId} did not modify shared.txt`);
    const executionArtifacts = details.artifacts.filter(artifact => artifact.sourceExecutionId === lease.executionId);
    const patchArtifact = executionArtifacts.find(artifact => artifact.type === 'diff');
    const archive = executionArtifacts.find(artifact => artifact.type === 'archive');
    const manifest = executionArtifacts.find(artifact => artifact.type === 'manifest');
    assert(patchArtifact && archive && manifest, `missing recovery artifacts for ${lease.agentId}`);
    const patchBytes = await downloadArtifact(patchArtifact);
    assert(patchBytes.toString('utf8').includes('shared.txt'), `${lease.agentId} tracked patch omitted shared.txt`);
    const manifestData = JSON.parse((await downloadArtifact(manifest)).toString('utf8'));
    assert(Array.isArray(manifestData), `${lease.agentId} manifest is not an array`);
    const paths = manifestData.map(entry => entry.path);
    const untrackedPath = paths.find(path => path.startsWith('agent-'));
    assert(untrackedPath, `${lease.agentId} manifest omitted its untracked file`);
    const actualUntracked = readFileSync(join(executionPath, untrackedPath), 'utf8');
    const archivePath = join(restoreRoot, `${lease.agentId}.tar`);
    const patchPath = join(restoreRoot, `${lease.agentId}.patch`);
    const extracted = join(restoreRoot, lease.agentId);
    mkdirSync(extracted, { recursive: true });
    writeFileSync(join(extracted, 'shared.txt'), baseline, 'utf8');
    execFileSync('git', ['-C', extracted, 'init', '--quiet'], { stdio: 'ignore' });
    execFileSync('git', ['-C', extracted, 'config', 'core.autocrlf', 'false'], { stdio: 'ignore' });
    execFileSync('git', ['-C', extracted, 'add', 'shared.txt'], { stdio: 'ignore' });
    execFileSync('git', ['-C', extracted, '-c', 'user.email=agentos@example.com', '-c', 'user.name=AgentOS', 'commit', '--quiet', '-m', 'restore baseline'], { stdio: 'ignore' });
    writeFileSync(patchPath, patchBytes);
    execFileSync('git', ['-C', extracted, 'apply', patchPath], { stdio: 'ignore' });
    const restoredShared = readFileSync(join(extracted, 'shared.txt'), 'utf8');
    assert(restoredShared === actualShared, `${lease.agentId} tracked patch did not restore`);
    writeFileSync(archivePath, await downloadArtifact(archive));
    execFileSync('tar', ['-xf', archivePath, '-C', extracted], { stdio: ['ignore', 'pipe', 'pipe'] });
    assert(existsSync(join(extracted, untrackedPath)), `${lease.agentId} untracked file did not restore`);
    assert(readFileSync(join(extracted, untrackedPath), 'utf8') === actualUntracked, `${lease.agentId} untracked file content did not restore`);
  }

  for (const lease of leases) {
    const removed = await api(`/api/workspaces/${workspaceId}/worktrees/${lease.id}`, { method: 'DELETE', body: JSON.stringify({ confirmRecoveryBundle: true }) });
    assert(removed.lease.status === 'cleaned', `lease ${lease.id} was not cleaned`);
  }
  const worktrees = readWorktreeList();
  const normalizedWorkspace = realpathSync.native(workspace).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  const normalizedListedPath = worktrees[0]?.path ? realpathSync.native(worktrees[0].path).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() : '';
  assert(worktrees.length === 1 && normalizedListedPath === normalizedWorkspace, `git worktree list retained execution paths: ${JSON.stringify({ worktrees, normalizedWorkspace, normalizedListedPath })}`);
  assert(git(['status', '--porcelain']) === '', 'main workspace is dirty after cleanup');
  assert(readFileSync(join(workspace, 'shared.txt'), 'utf8') === baseline, 'main shared.txt changed after cleanup');
  assertNoWorktreeGitDirectories(worktreeRoot);
  console.log(`REAL_WORKTREE_GATE: passed (leases=${leases.length}, restored=${leases.length}, cleaned=${leases.length})`);
}

try {
  await main();
} finally {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill();
    await Promise.race([new Promise(resolve => serverProcess.once('exit', resolve)), sleep(1500)]);
  }
  try {
    for (const item of readWorktreeList()) {
      if (item.path && item.path !== workspace) {
        try { execFileSync('git', ['-C', workspace, 'worktree', 'remove', '--force', item.path], { stdio: 'ignore' }); } catch {}
      }
    }
  } catch {}
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { rmSync(projectRoot, { recursive: true, force: true }); break; } catch { await sleep(100); }
  }
}
