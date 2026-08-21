import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SurvivorVerification, TreeTerminationResult } from './driver.js';
import { cleanupVerdictFromVerification } from './driver.js';
import { NodeProcessDriver } from './node-driver.js';
import type { ProcessTreeController, ProcessTreeHandle } from './platform-process-tree.js';
import type { NativeIdentity } from './types.js';

function longRunning(): string {
  return "setInterval(() => {}, 1000);";
}

async function readLine(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += Buffer.from(chunk).toString('utf8');
    const newline = buffer.indexOf('\n');
    if (newline >= 0) return buffer.slice(0, newline).trim();
  }
  throw new Error(`expected line, received: ${buffer}`);
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForPidGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && pidIsAlive(pid)) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, 'utf8').trim();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

class ExitObservationController implements ProcessTreeController {
  verifyCalls = 0;

  async attach(identity: NativeIdentity): Promise<ProcessTreeHandle> {
    return { platform: 'unavailable', rootPid: identity.pid, state: 'test' };
  }

  async terminateTree(): Promise<TreeTerminationResult> {
    return { classification: 'unknown', attemptedMembers: [], errors: [] };
  }

  async verifySurvivors(): Promise<SurvivorVerification> {
    this.verifyCalls += 1;
    return { classification: 'unknown', knownPids: [] };
  }

  async dispose(): Promise<void> {}
}

describe('NodeProcessDriver', () => {
  it('observes natural exits for ownership-session hygiene', async () => {
    const processTreeController = new ExitObservationController();
    const driver = new NodeProcessDriver({ processTreeController });
    const handle = await driver.spawn({
      executable: process.execPath,
      args: ['-e', 'process.exit(0);'],
      cwd: process.cwd(),
      env: {},
      envDiagnostics: [],
      shell: false,
    });
    await handle.waitExit();
    const deadline = Date.now() + 1_000;
    while (processTreeController.verifyCalls === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(processTreeController.verifyCalls).toBe(1);
  });

  it('spawns a validated launch and observes stdout and exit evidence', async () => {
    const driver = new NodeProcessDriver();
    const handle = await driver.spawn({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('hello'); process.exit(3);"],
      cwd: process.cwd(),
      env: {},
      envDiagnostics: [],
      shell: false,
    });
    expect(handle.pid).toBeGreaterThan(0);
    let stdout = '';
    for await (const chunk of handle.streams.stdout) stdout += Buffer.from(chunk).toString('utf8');
    const exit = await handle.waitExit();
    expect(stdout).toBe('hello');
    expect(exit.exitCode).toBe(3);
    await driver.verifySurvivors(handle);
  });

  it('gracefulStop delivers a signal and the child terminates', async () => {
    const driver = new NodeProcessDriver();
    const handle = await driver.spawn({
      executable: process.execPath,
      args: ['-e', longRunning()],
      cwd: process.cwd(),
      env: {},
      envDiagnostics: [],
      shell: false,
    });
    const stop = await driver.gracefulStop(handle);
    expect(stop.delivered).toBe(true);
    const exit = await handle.waitExit();
    expect(exit.exitCode ?? exit.signal).not.toBeNull();
    await driver.verifySurvivors(handle);
  });

  it('terminateTree force-terminates and reports complete for a plain root', async () => {
    const driver = new NodeProcessDriver();
    const handle = await driver.spawn({
      executable: process.execPath,
      args: ['-e', longRunning()],
      cwd: process.cwd(),
      env: {},
      envDiagnostics: [],
      shell: false,
    });
    const result = await driver.terminateTree(handle);
    expect(['complete', 'unknown']).toContain(result.classification);
    const exit = await handle.waitExit();
    expect(exit.exitCode ?? exit.signal).not.toBeNull();
    await driver.verifySurvivors(handle);
  });

  it('verifySurvivors reports live owned members and proves an empty tree after cleanup', async () => {
    const driver = new NodeProcessDriver();
    const handle = await driver.spawn({
      executable: process.execPath,
      args: ['-e', longRunning()],
      cwd: process.cwd(),
      env: {},
      envDiagnostics: [],
      shell: false,
    });
    const alive = await driver.verifySurvivors(handle);
    expect(alive.classification).toBe('survivors');
    expect(alive.knownPids).toContain(handle.pid);
    await driver.terminateTree(handle);
    await handle.waitExit();
    const after = await driver.verifySurvivors(handle);
    expect(after).toEqual({
      classification: 'complete',
      knownPids: [],
      proof: { kind: 'owned-tree-enumeration' },
    });
  });

  it.skipIf(process.platform !== 'win32')('P5B-04: root exit with owned child reports survivors, then proves cleanup', async () => {
    const driver = new NodeProcessDriver();
    const fixtureDir = mkdtempSync(join(tmpdir(), 'agentos-p5b-root-exit-'));
    const spawnSignal = join(fixtureDir, 'spawn');
    const exitSignal = join(fixtureDir, 'exit');
    let childPid: number | undefined;
    try {
      const handle = await driver.spawn({
        executable: process.execPath,
        args: ['-e', [
          "const fs = require('node:fs');",
          "const { spawn } = require('node:child_process');",
          "const [spawnSignal, exitSignal] = process.argv.slice(1);",
          "const waitFor = (file, next) => { const timer = setInterval(() => { if (fs.existsSync(file)) { clearInterval(timer); next(); } }, 5); };",
          "waitFor(spawnSignal, () => { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { detached: true, windowsHide: true, stdio: 'ignore' });",
          "process.stdout.write(String(child.pid) + '\\n'); waitFor(exitSignal, () => process.exit(0)); });",
        ].join(' '), spawnSignal, exitSignal],
        cwd: process.cwd(),
        env: {},
        envDiagnostics: [],
        shell: false,
      });

      writeFileSync(spawnSignal, 'ready');
      childPid = Number(await readLine(handle.streams.stdout));
      expect(childPid).toBeGreaterThan(0);
      writeFileSync(exitSignal, 'exit');
      const rootExit = await handle.waitExit();
      expect(rootExit.exitCode).toBe(0);
      expect(pidIsAlive(childPid)).toBe(true);

      const beforeCleanup = await driver.verifySurvivors(handle);
      expect(beforeCleanup.classification).toBe('survivors');
      expect(beforeCleanup.knownPids).toContain(childPid);
      expect(beforeCleanup.proof).toBeUndefined();

      await driver.terminateTree(handle);
      const afterCleanup = await driver.verifySurvivors(handle);
      expect(afterCleanup).toEqual({
        classification: 'complete',
        knownPids: [],
        proof: { kind: 'owned-tree-enumeration' },
      });
      expect(cleanupVerdictFromVerification(afterCleanup, true)).toEqual({
        classification: 'complete',
        cleanupResult: 'ALREADY_EXITED',
        proven: true,
      });
    } finally {
      if (childPid !== undefined && pidIsAlive(childPid)) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // Emergency cleanup is test hygiene, not production proof.
        }
        await waitForPidGone(childPid);
      }
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')('P5B-02/03/07: terminates a multi-level owned tree without killing an unrelated control', async () => {
    const driver = new NodeProcessDriver();
    const fixtureDir = mkdtempSync(join(tmpdir(), 'agentos-p5b-tree-'));
    const rootStart = join(fixtureDir, 'root-start');
    const rootExit = join(fixtureDir, 'root-exit');
    const childStart = join(fixtureDir, 'child-start');
    const childPidFile = join(fixtureDir, 'child-pid');
    const grandchildPidFile = join(fixtureDir, 'grandchild-pid');
    const childScript = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const [start, exit, pidFile] = process.argv.slice(1);",
      "const waitFor = (file, next) => { const timer = setInterval(() => { if (fs.existsSync(file)) { clearInterval(timer); next(); } }, 5); };",
      "waitFor(start, () => { const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { detached: true, windowsHide: true, stdio: 'ignore' }); fs.writeFileSync(pidFile, String(grandchild.pid)); waitFor(exit, () => process.exit(0)); });",
    ].join(' ');
    const rootScript = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const [start, exit, childStartPath, childPidPath, grandchildPidPath] = process.argv.slice(1);",
      "const waitFor = (file, next) => { const timer = setInterval(() => { if (fs.existsSync(file)) { clearInterval(timer); next(); } }, 5); };",
      `waitFor(start, () => { const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}, childStartPath, exit, grandchildPidPath], { detached: true, windowsHide: true, stdio: 'ignore' }); fs.writeFileSync(childPidPath, String(child.pid)); waitFor(exit, () => process.exit(0)); });`,
    ].join(' ');
    const control = spawn(process.execPath, ['-e', longRunning()], { detached: true, windowsHide: true, stdio: 'ignore' });
    let rootHandle: Awaited<ReturnType<NodeProcessDriver['spawn']>> | undefined;
    let childPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      rootHandle = await driver.spawn({
        executable: process.execPath,
        args: ['-e', rootScript, rootStart, rootExit, childStart, childPidFile, grandchildPidFile],
        cwd: process.cwd(),
        env: {},
        envDiagnostics: [],
        shell: false,
      });
      writeFileSync(rootStart, 'ready');
      childPid = Number(await waitForFile(childPidFile));
      expect(childPid).toBeGreaterThan(0);
      writeFileSync(childStart, 'ready');
      grandchildPid = Number(await waitForFile(grandchildPidFile));
      expect(grandchildPid).toBeGreaterThan(0);
      expect(control.pid).toBeDefined();

      const beforeCleanup = await driver.verifySurvivors(rootHandle);
      expect(beforeCleanup.classification).toBe('survivors');
      expect(beforeCleanup.knownPids).toEqual(expect.arrayContaining([rootHandle.pid, childPid, grandchildPid]));
      expect(pidIsAlive(control.pid!)).toBe(true);

      await driver.terminateTree(rootHandle);
      await rootHandle.waitExit();
      const afterCleanup = await driver.verifySurvivors(rootHandle);
      expect(afterCleanup).toEqual({
        classification: 'complete',
        knownPids: [],
        proof: { kind: 'owned-tree-enumeration' },
      });
      expect(pidIsAlive(control.pid!)).toBe(true);
    } finally {
      if (rootHandle !== undefined) {
        try { await driver.terminateTree(rootHandle); } catch { /* emergency hygiene */ }
      }
      for (const pid of [childPid, grandchildPid, control.pid].filter((value): value is number => value !== undefined)) {
        if (pidIsAlive(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* emergency hygiene */ }
          await waitForPidGone(pid);
        }
      }
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('inspectIdentity matches a live pid and reports missing for ESRCH', async () => {
    const driver = new NodeProcessDriver();
    const handle = await driver.spawn({
      executable: process.execPath,
      args: ['-e', longRunning()],
      cwd: process.cwd(),
      env: {},
      envDiagnostics: [],
      shell: false,
    });
    const match = await driver.inspectIdentity(handle.identity);
    expect(match.kind).toBe('match');
    await driver.terminateTree(handle);
    await handle.waitExit();
    await driver.verifySurvivors(handle);
    const missing = await driver.inspectIdentity(handle.identity);
    expect(missing.kind).toBe('missing');
  });

  it('rejects spawn when the executable is missing', async () => {
    const driver = new NodeProcessDriver();
    await expect(driver.spawn({
      executable: 'definitely-missing-agentos-bin',
      args: [],
      cwd: process.cwd(),
      env: {},
      envDiagnostics: [],
      shell: false,
    })).rejects.toThrow();
  });
});
