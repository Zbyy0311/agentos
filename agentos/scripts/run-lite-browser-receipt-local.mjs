import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const tag = `lite-browser-${Date.now()}`;
const tempRoot = join(tmpdir(), tag);
mkdirSync(tempRoot, { recursive: true });
const fixtureOut = join(tempRoot, 'fixture.stdout.log');
const fixtureErr = join(tempRoot, 'fixture.stderr.log');
const webOut = join(tempRoot, 'web.stdout.log');
const webErr = join(tempRoot, 'web.stderr.log');
const fixture = spawn(process.execPath, ['scripts/start-browser-runtime-fixture.mjs'], {
  cwd: root,
  env: process.env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const fixtureStdout = [];
fixture.stdout.on('data', chunk => fixtureStdout.push(String(chunk)));
fixture.stderr.on('data', chunk => writeFileSync(fixtureErr, chunk, { flag: 'a' }));
let state;
try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && state === undefined) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    const text = fixtureStdout.join('');
    for (const line of text.split(/\r?\n/)) {
      try {
        const candidate = JSON.parse(line);
        if (candidate.statePath) { state = candidate; break; }
      } catch { /* state line has not arrived */ }
    }
  }
  if (state === undefined) throw new Error('browser fixture did not publish state');
  writeFileSync(fixtureOut, fixtureStdout.join(''));

  const web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--port', '3125'], {
    cwd: join(root, 'apps/web'),
    env: { ...process.env, NEXT_PUBLIC_API_URL: `http://127.0.0.1:${state.serverPort}` },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const webStdout = [];
  web.stdout.on('data', chunk => webStdout.push(String(chunk)));
  web.stderr.on('data', chunk => writeFileSync(webErr, chunk, { flag: 'a' }));
  try {
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
      const probe = spawnSync(process.execPath, [
        '--input-type=module', '-e',
        "const r=await fetch('http://127.0.0.1:3125/workspace/browser-fixture-ws/runtime'); process.exit(r.ok ? 0 : 1);",
      ], { cwd: root, stdio: 'ignore' });
      ready = probe.status === 0;
    }
    if (!ready) throw new Error('browser web fixture did not become ready');
    writeFileSync(webOut, webStdout.join(''));

    const runDir = 'docs/implementation/lite-closeout/evidence/final-f466-affected-pass/browser-13-101-rerun';
    mkdirSync(resolve(root, runDir), { recursive: true });
    const old = JSON.parse(readFileSync(resolve(root, 'docs/implementation/lite-closeout/evidence/final-main-c517fbd8/browser-13-101/browser-13-101.json'), 'utf8'));
    writeFileSync(resolve(root, runDir, 'assertions.json'), `${JSON.stringify(old.assertionCoverage, null, 2)}\n`);
    const args = ['--test', '--test-concurrency=1', '--test-reporter=tap', 'scripts/verify-lite-13-101-browser.test.mjs'];
    const argsJson = JSON.stringify(args);
    const capture = spawnSync(process.execPath, [
      'scripts/capture-lite-test-run.mjs', '--cwd', '.', '--executable', 'node', '--args-json', argsJson, '--out-dir', runDir,
    ], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const receipt = 'docs/implementation/lite-closeout/evidence/final-f466-affected-pass/browser-13-101-rerun.json';
    const build = spawnSync(process.execPath, [
      'scripts/build-lite-tap-receipt.mjs', '--run-dir', runDir, '--source-file', 'scripts/verify-lite-13-101-browser.test.mjs',
      '--baseline', '33d12571b4a19fbbb17060a7d1a60f6fea756f09', '--cwd', '.', '--executable', 'node', '--args-json', argsJson,
      '--assertions-file', `${runDir}/assertions.json`, '--out', receipt,
    ], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    console.log(JSON.stringify({ statePath: state.statePath, fixturePid: fixture.pid, webPid: web.pid, captureExit: capture.status, buildExit: build.status, receipt }));
  } finally {
    web.kill('SIGTERM');
  }
} finally {
  fixture.kill('SIGTERM');
  if (state?.serverPid) process.kill(state.serverPid, 'SIGTERM');
  if (state?.webPid) process.kill(state.webPid, 'SIGTERM');
}
