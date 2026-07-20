import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeFixture = join(repoRoot, 'scripts', 'fixtures', 'codex-runtime-agent');
const projectRoot = mkdtempSync(join(tmpdir(), 'agentos-browser-runtime-'));
const workspace = join(projectRoot, 'workspace-root');
const serverPort = 38100 + Math.floor(Math.random() * 400);
const webPort = 3110 + Math.floor(Math.random() * 30);
const now = new Date().toISOString();

cpSync(runtimeFixture, workspace, { recursive: true });
execFileSync('git', ['-C', workspace, 'init'], { stdio: 'ignore' });
execFileSync('git', ['-C', workspace, 'add', '.'], { stdio: 'ignore' });
execFileSync('git', ['-C', workspace, '-c', 'user.email=agentos@example.com', '-c', 'user.name=AgentOS', 'commit', '-m', 'clean baseline'], { stdio: 'ignore' });
mkdirSync(join(projectRoot, 'workspace'), { recursive: true });
writeFileSync(join(projectRoot, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
  id: 'browser-fixture-ws', name: 'Browser Runtime Fixture', rootPath: workspace, gitEnabled: true, memoryEnabled: false,
  agents: [{ id: 'codex', name: 'Codex Fixture', role: 'codex', enabled: true, cliCommand: join(workspace, 'codex.cmd'), cliArgs: ['exec'], thinkingEffort: 'auto' }],
  lastOpenedAt: now, createdAt: now, updatedAt: now,
}] }, null, 2), 'utf8');

const serverLog = join(projectRoot, 'server.log');
const webLog = join(projectRoot, 'web.log');
const server = spawn(process.execPath, [join(repoRoot, 'apps', 'server', 'dist', 'index.js')], {
  cwd: repoRoot,
  env: { ...process.env, AGENTOS_PROJECT_ROOT: projectRoot, AGENTOS_FORCE_MOCK: 'false', AGENTOS_FIXTURE_DELAY_MS: process.env.AGENTOS_FIXTURE_DELAY_MS ?? '20', PORT: String(serverPort) },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
const web = spawn(process.execPath, [join(repoRoot, 'apps', 'web', 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '--port', String(webPort)], {
  cwd: join(repoRoot, 'apps', 'web'),
  env: { ...process.env, NEXT_PUBLIC_API_URL: `http://127.0.0.1:${serverPort}` },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
for (const [stream, path] of [[server.stdout, serverLog], [server.stderr, serverLog], [web.stdout, webLog], [web.stderr, webLog]]) {
  stream?.on('data', chunk => { writeFileSync(path, chunk, { flag: 'a' }); });
}

const statePath = join(projectRoot, 'state.json');
writeFileSync(statePath, JSON.stringify({ projectRoot, workspace, serverPort, webPort, serverPid: server.pid, webPid: web.pid }, null, 2), 'utf8');
console.log(JSON.stringify({ statePath, projectRoot, workspace, serverPort, webPort, serverPid: server.pid, webPid: web.pid }));

const stop = () => {
  if (!server.killed) server.kill('SIGTERM');
  if (!web.killed) web.kill('SIGTERM');
};
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
await new Promise(() => {});
