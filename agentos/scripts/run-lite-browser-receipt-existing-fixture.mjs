import { createWriteStream } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const projectRoot = process.env.AGENTOS_BROWSER_PROJECT_ROOT
  ?? 'C:/Users/Administrator/AppData/Local/Temp/agentos-browser-runtime-Zv7KCi';
const apiPort = Number(process.env.AGENTOS_BROWSER_API_PORT ?? 38482);
const runDirRel = 'docs/implementation/lite-closeout/evidence/final-f466-affected-pass/browser-13-101-current';
const runDir = resolve(root, runDirRel);
const serverLogPath = join(projectRoot, 'server-current-33d.log');
const webLogPath = join(projectRoot, 'web-current-33d.log');

function wait(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function waitForWeb() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:3125/workspace/browser-fixture-ws/runtime');
      if (response.ok) return;
    } catch { /* wait for Next and the API to become ready */ }
    await wait(500);
  }
  throw new Error('browser web fixture did not become ready');
}

function stop(child) {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'apps/server/dist/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    AGENTOS_PROJECT_ROOT: projectRoot,
    AGENTOS_FORCE_MOCK: 'false',
    AGENTOS_WEB_ORIGINS: 'http://127.0.0.1:3125,http://localhost:3125',
    PORT: String(apiPort),
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = createWriteStream(serverLogPath, { flags: 'w' });
server.stdout.pipe(serverLog);
server.stderr.pipe(serverLog);

const web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--port', '3125'], {
  cwd: join(root, 'apps/web'),
  env: { ...process.env, NEXT_PUBLIC_API_URL: `http://127.0.0.1:${apiPort}` },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const webLog = createWriteStream(webLogPath, { flags: 'w' });
web.stdout.pipe(webLog);
web.stderr.pipe(webLog);

try {
  await waitForWeb();
  mkdirSync(runDir, { recursive: true });
  const source = JSON.parse(readFileSync(resolve(root, 'docs/implementation/lite-closeout/evidence/final-main-c517fbd8/browser-13-101/browser-13-101.json'), 'utf8'));
  writeFileSync(resolve(runDir, 'assertions.json'), `${JSON.stringify(source.assertionCoverage, null, 2)}\n`, 'utf8');
  const args = ['--test', '--test-concurrency=1', '--test-reporter=tap', 'scripts/verify-lite-13-101-browser.test.mjs'];
  const argsJson = JSON.stringify(args);
  const capture = spawnSync(process.execPath, [
    'scripts/capture-lite-test-run.mjs', '--cwd', '.', '--executable', 'node', '--args-json', argsJson, '--out-dir', runDirRel,
  ], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const receiptRel = `${runDirRel}/browser-13-101.json`;
  const build = spawnSync(process.execPath, [
    'scripts/build-lite-tap-receipt.mjs', '--run-dir', runDirRel,
    '--source-file', 'scripts/verify-lite-13-101-browser.test.mjs',
    '--baseline', '33d12571b4a19fbbb17060a7d1a60f6fea756f09',
    '--cwd', '.', '--executable', 'node', '--args-json', argsJson,
    '--assertions-file', `${runDirRel}/assertions.json`, '--out', receiptRel,
  ], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  console.log(JSON.stringify({
    projectRoot, apiPort, serverPid: server.pid, webPid: web.pid,
    captureExit: capture.status, captureOutput: capture.stdout + capture.stderr,
    buildExit: build.status, buildOutput: build.stdout + build.stderr, receipt: receiptRel,
  }));
  if (capture.status !== 0 || build.status !== 0) process.exitCode = 1;
} finally {
  stop(web);
  stop(server);
  serverLog.end();
  webLog.end();
}
