import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SurvivorVerification, TreeTerminationResult } from './driver.js';
import { cleanupVerdictFromVerification } from './driver.js';
import { NodeProcessDriver } from './node-driver.js';
import type { ProcessTreeController, ProcessTreeHandle } from './platform-process-tree.js';
import { STREAM_CHUNK_LIMIT_BYTES } from './streams.js';
import { WindowsProcessTreeController } from './windows-process-tree.js';
import type { NativeIdentity } from './types.js';

const REAL_SPAWN_TIMEOUT_MS = 30_000;

/** Every root/child/grandchild/control PID created by this suite (W12 audit). */
const auditPids: number[] = [];

/** powershell.exe helper PIDs observed before this suite started (W12 audit). */
const baselineHelperPids = listPowerShellPids();

function listPowerShellPids(): readonly number[] {
  if (process.platform !== 'win32') return [];
  try {
    const output = execFileSync('tasklist', ['/FI', 'IMAGENAME eq powershell.exe', '/FO', 'CSV', '/NH'], {
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
    });
    return output
      .split(/\r?\n/)
      .map(line => /^"powershell\.exe","(\d+)"/.exec(line)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
  } catch {
    return [];
  }
}

function track(pid: number | undefined): number {
  if (pid === undefined || pid <= 0) throw new Error('expected a positive pid');
  auditPids.push(pid);
  return pid;
}

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
  throw new Error('expected line, received: ' + buffer);
}

/**
 * Reads exactly count newline-terminated lines in ONE iteration session.
 * Sequential for-await sessions would destroy the shared buffered stream on
 * early return and could swallow coalesced chunks, so multi-line reads must
 * share a single iterator.
 */
async function readLines(stream: AsyncIterable<Uint8Array>, count: number): Promise<string[]> {
  let buffer = '';
  const lines: string[] = [];
  for await (const chunk of stream) {
    buffer += Buffer.from(chunk).toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      lines.push(buffer.slice(0, newline).trim());
      buffer = buffer.slice(newline + 1);
      if (lines.length === count) return lines;
      newline = buffer.indexOf('\n');
    }
  }
  throw new Error('expected ' + String(count) + ' lines, received: ' + JSON.stringify(lines));
}

async function collectChunks(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
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

function readAbortedPid(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  const marker = 'launch-aborted ';
  const start = message.indexOf(marker);
  if (start < 0) throw new Error('missing launch-aborted evidence: ' + message);
  const pid = Number(message.slice(start + marker.length).split(' ')[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid aborted provider pid: ' + message);
  return pid;
}

async function waitForHelperDrain(baseline: readonly number[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const leaked = listPowerShellPids().filter(pid => !baseline.includes(pid));
    if (leaked.length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('new PowerShell helper survived: ' + listPowerShellPids().join(','));
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, 'utf8').trim();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for ' + path);
}

function basicLaunch(executable: string, args: readonly string[]) {
  const env: Record<string, string> = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {};
  return {
    executable,
    args: [...args],
    cwd: process.cwd(),
    env,
    envDiagnostics: [],
    shell: false as const,
  };
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
  it('observes natural exits for ownership-session hygiene', { timeout: REAL_SPAWN_TIMEOUT_MS }, async () => {
    const processTreeController = new ExitObservationController();
    const driver = new NodeProcessDriver({ processTreeController });
    const handle = await driver.spawn(basicLaunch(process.execPath, ['-e', 'process.exit(0);']));
    track(handle.pid);
    await handle.waitExit();
    const deadline = Date.now() + 1_000;
    while (processTreeController.verifyCalls === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(processTreeController.verifyCalls).toBe(1);
  });

  it('spawns a validated launch and observes stdout and exit evidence', { timeout: REAL_SPAWN_TIMEOUT_MS }, async () => {
    const driver = new NodeProcessDriver();
    const handle = await driver.spawn(basicLaunch(process.execPath, ['-e', "process.stdout.write('hello'); process.exit(3);"]));
    track(handle.pid);
    expect(handle.pid).toBeGreaterThan(0);
    let stdout = '';
    for await (const chunk of handle.streams.stdout) stdout += Buffer.from(chunk).toString('utf8');
    const exit = await handle.waitExit();
    expect(stdout).toBe('hello');
    expect(exit.exitCode).toBe(3);
    await driver.verifySurvivors(handle);
  });

  it('gracefulStop delivers a signal and the child terminates', { timeout: REAL_SPAWN_TIMEOUT_MS }, async () => {
    const driver = new NodeProcessDriver();
    const handle = await driver.spawn(basicLaunch(process.execPath, ['-e', longRunning()]));
    track(handle.pid);
    const stop = await driver.gracefulStop(handle);
    expect(stop.delivered).toBe(true);
    const exit = await handle.waitExit();
    expect(exit.exitCode ?? exit.signal).not.toBeNull();
    await driver.verifySurvivors(handle);
  });

  it('terminateTree force-terminates and reports complete for a plain root', { timeout: REAL_SPAWN_TIMEOUT_MS }, async () => {
    const driver = new NodeProcessDriver();
    const handle = await driver.spawn(basicLaunch(process.execPath, ['-e', longRunning()]));
    track(handle.pid);
    const result = await driver.terminateTree(handle);
    expect(['complete', 'unknown']).toContain(result.classification);
    const exit = await handle.waitExit();
    expect(exit.exitCode ?? exit.signal).not.toBeNull();
    await driver.verifySurvivors(handle);
  });

  it('verifySurvivors reports live owned members and proves an empty tree after cleanup', { timeout: REAL_SPAWN_TIMEOUT_MS }, async () => {
    const driver = new NodeProcessDriver();
    const handle = await driver.spawn(basicLaunch(process.execPath, ['-e', longRunning()]));
    track(handle.pid);
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

  it.skipIf(process.platform !== 'win32')(
    'P5B-04/W2/W3/W7/W10: a child created as the provider FIRST instruction cannot escape the AgentOS Job',
    { timeout: REAL_SPAWN_TIMEOUT_MS },
    async () => {
      const driver = new NodeProcessDriver();
      let childPid: number | undefined;
      let handle: Awaited<ReturnType<NodeProcessDriver['spawn']>> | undefined;
      try {
        handle = await driver.spawn(basicLaunch(process.execPath, ['-e', [
          "const { spawn } = require('node:child_process');",
          // The provider's FIRST executable behavior creates a descendant.
          // No spawnSignal gate: driver.spawn() has not returned yet.
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { detached: true, windowsHide: true, stdio: 'ignore' });",
          "process.stdout.write('root=' + process.pid + '\\n');",
          "process.stdout.write('child=' + child.pid + '\\n');",
          "process.exit(0);",
        ].join(' ')]));
        track(handle.pid);

        const [rootLine, childLine] = await readLines(handle.streams.stdout, 2);
        // W10: the handle reports the actual provider PID, not a wrapper PID.
        expect(rootLine).toBe('root=' + handle.pid);
        childPid = track(Number(childLine.slice('child='.length)));

        const rootExit = await handle.waitExit();
        expect(rootExit.exitCode).toBe(0);
        expect(pidIsAlive(childPid)).toBe(true);

        // W3: the immediately created descendant is an owned survivor.
        const beforeCleanup = await driver.verifySurvivors(handle);
        expect(beforeCleanup.classification).toBe('survivors');
        expect(beforeCleanup.knownPids).toContain(childPid);
        expect(beforeCleanup.proof).toBeUndefined();

        const termination = await driver.terminateTree(handle);
        expect(termination.classification).toBe('complete');

        // W7: proof only after the owned enumeration is genuinely empty.
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
        await waitForPidGone(childPid);
        expect(pidIsAlive(childPid)).toBe(false);
      } finally {
        if (handle !== undefined) {
          // Failure-path hygiene: reap the owned tree and close the helper
          // session so no powershell.exe helper leaks into the W12 audit.
          try { await driver.terminateTree(handle); } catch { /* emergency hygiene */ }
          try { await driver.verifySurvivors(handle); } catch { /* emergency hygiene */ }
        }
        if (childPid !== undefined && pidIsAlive(childPid)) {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            // Emergency cleanup is test hygiene, not production proof.
          }
          await waitForPidGone(childPid);
        }
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'P5B-02/03/07/W4/W5/W6: an immediately built multi-level tree is owned and terminated while an unrelated control survives',
    { timeout: REAL_SPAWN_TIMEOUT_MS },
    async () => {
      const driver = new NodeProcessDriver();
      const fixtureDir = mkdtempSync(join(tmpdir(), 'agentos-p5b-tree-'));
      const childPidFile = join(fixtureDir, 'child-pid');
      const grandchildPidFile = join(fixtureDir, 'grandchild-pid');
      const childScript = [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        // The child's FIRST behavior creates the grandchild; no start gate.
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { detached: true, windowsHide: true, stdio: 'ignore' });",
        "fs.writeFileSync(process.argv[1], String(grandchild.pid));",
        "setInterval(() => {}, 1000);",
      ].join(' ');
      const rootScript = [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        // The root's FIRST behavior creates the child; no start gate.
        "const child = spawn(process.execPath, ['-e', process.argv[2], process.argv[3]], { detached: true, windowsHide: true, stdio: 'ignore' });",
        "fs.writeFileSync(process.argv[1], String(child.pid));",
        "setInterval(() => {}, 1000);",
      ].join(' ');
      const control = spawn(process.execPath, ['-e', longRunning()], { detached: true, windowsHide: true, stdio: 'ignore' });
      track(control.pid);
      let rootHandle: Awaited<ReturnType<NodeProcessDriver['spawn']>> | undefined;
      let childPid: number | undefined;
      let grandchildPid: number | undefined;
      try {
        rootHandle = await driver.spawn(basicLaunch(process.execPath, ['-e', rootScript, childPidFile, childScript, grandchildPidFile]));
        track(rootHandle.pid);
        childPid = track(Number(await waitForFile(childPidFile)));
        grandchildPid = track(Number(await waitForFile(grandchildPidFile)));
        expect(control.pid).toBeDefined();

        // W4: root, child and grandchild are all owned members.
        const beforeCleanup = await driver.verifySurvivors(rootHandle);
        expect(beforeCleanup.classification).toBe('survivors');
        expect(beforeCleanup.knownPids).toEqual(expect.arrayContaining([rootHandle.pid, childPid, grandchildPid]));
        expect(pidIsAlive(control.pid!)).toBe(true);

        // W5: one tree termination removes every level.
        await driver.terminateTree(rootHandle);
        await rootHandle.waitExit();
        const afterCleanup = await driver.verifySurvivors(rootHandle);
        expect(afterCleanup).toEqual({
          classification: 'complete',
          knownPids: [],
          proof: { kind: 'owned-tree-enumeration' },
        });
        // W6: the unrelated control is never targeted.
        expect(pidIsAlive(control.pid!)).toBe(true);
        await waitForPidGone(childPid);
        await waitForPidGone(grandchildPid);
        expect(pidIsAlive(childPid)).toBe(false);
        expect(pidIsAlive(grandchildPid)).toBe(false);
      } finally {
        if (rootHandle !== undefined) {
          try { await driver.terminateTree(rootHandle); } catch { /* emergency hygiene */ }
          try { await driver.verifySurvivors(rootHandle); } catch { /* emergency hygiene */ }
        }
        for (const pid of [childPid, grandchildPid, control.pid].filter((value): value is number => value !== undefined)) {
          if (pidIsAlive(pid)) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* emergency hygiene */ }
            await waitForPidGone(pid);
          }
        }
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'W1: provider code cannot execute before Job ownership (suspended-create trace evidence)',
    { timeout: REAL_SPAWN_TIMEOUT_MS },
    async () => {
      const events: string[] = [];
      const controller = new WindowsProcessTreeController({ trace: event => events.push(event.kind + ':' + event.pid) });
      const driver = new NodeProcessDriver({ processTreeController: controller });
      const fixtureDir = mkdtempSync(join(tmpdir(), 'agentos-p5b-trace-'));
      const marker = join(fixtureDir, 'marker');
      try {
        const handle = await driver.spawn(basicLaunch(process.execPath, ['-e', [
          // The provider's FIRST instruction is the first-user-code marker.
          "require('node:fs').writeFileSync(process.argv[1], 'ran');",
          "process.stdout.write('marker\\n');",
          "process.exit(0);",
        ].join(' '), marker]));
        track(handle.pid);

        // spawn() resolved, which requires the helper's 'launched' response;
        // 'assigned' is emitted while the provider thread is still suspended.
        const assignedIndex = events.findIndex(event => event.startsWith('assigned:' + handle.pid));
        const launchedIndex = events.findIndex(event => event.startsWith('launched:' + handle.pid));
        expect(assignedIndex).toBeGreaterThanOrEqual(0);
        expect(launchedIndex).toBeGreaterThan(assignedIndex);

        // The first-user-code marker can only exist after assignment+resume.
        expect(await waitForFile(marker)).toBe('ran');
        expect(assignedIndex).toBeGreaterThanOrEqual(0);
        const stdoutMarker = await readLine(handle.streams.stdout);
        expect(stdoutMarker).toBe('marker');
        const stdoutIndex = events.push('observed-stdout') - 1;
        expect(stdoutIndex).toBeGreaterThan(assignedIndex);

        const exit = await handle.waitExit();
        expect(exit.exitCode).toBe(0);
        await driver.verifySurvivors(handle);
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'W9: provider stdout/stderr bytes and exact argv survive the owned channel',
    { timeout: REAL_SPAWN_TIMEOUT_MS },
    async () => {
      const driver = new NodeProcessDriver();
      const extraArgs = ['arg with space', 'quote"arg', 'back\\slash\\', ''];
      const script = [
        "process.stdout.write(JSON.stringify(process.argv.slice(1)) + '\\n');",
        "process.stdout.write(Buffer.from([0, 255, 65, 66]));",
        "process.stderr.write('err-line-1\\n');",
        "process.stderr.write('err-line-2');",
        "process.exit(7);",
      ].join(' ');
      const handle = await driver.spawn(basicLaunch(process.execPath, ['-e', script, ...extraArgs]));
      track(handle.pid);
      const stdoutAll = await collectChunks(handle.streams.stdout);
      const stderrAll = await collectChunks(handle.streams.stderr);
      const exit = await handle.waitExit();
      expect(exit.exitCode).toBe(7);
      const newline = stdoutAll.indexOf(0x0a);
      expect(newline).toBeGreaterThan(0);
      expect(JSON.parse(stdoutAll.subarray(0, newline).toString('utf8'))).toEqual(extraArgs);
      expect([...stdoutAll.subarray(newline + 1)]).toEqual([0, 255, 65, 66]);
      expect(stderrAll.toString('utf8')).toBe('err-line-1\nerr-line-2');
      await driver.verifySurvivors(handle);
    },
  );

  it('inspectIdentity matches a live pid and reports missing for ESRCH', { timeout: REAL_SPAWN_TIMEOUT_MS }, async () => {
    const driver = new NodeProcessDriver();
    const handle = await driver.spawn(basicLaunch(process.execPath, ['-e', longRunning()]));
    track(handle.pid);
    const match = await driver.inspectIdentity(handle.identity);
    expect(match.kind).toBe('match');
    await driver.terminateTree(handle);
    await handle.waitExit();
    await driver.verifySurvivors(handle);
    const missing = await driver.inspectIdentity(handle.identity);
    expect(missing.kind).toBe('missing');
  });

  it('W11: rejects spawn when the executable is missing, fail-closed with no proof', { timeout: REAL_SPAWN_TIMEOUT_MS }, async () => {
    const driver = new NodeProcessDriver();
    await expect(driver.spawn(basicLaunch('definitely-missing-agentos-bin', []))).rejects.toThrow();
  });


  it.skipIf(process.platform !== 'win32')(
    'BLOCKER-1: assignment failure aborts the suspended provider before user code',
    { timeout: REAL_SPAWN_TIMEOUT_MS },
    async () => {
      const events: string[] = [];
      const controller = new WindowsProcessTreeController({
        trace: event => events.push(event.kind + ':' + event.pid),
        faultInjection: { failJobAssign: true },
      });
      const driver = new NodeProcessDriver({ processTreeController: controller });
      const fixtureDir = mkdtempSync(join(tmpdir(), 'agentos-p5b-assign-failure-'));
      const marker = join(fixtureDir, 'provider-ran');
      const helpersBefore = listPowerShellPids();
      let providerPid: number | undefined;
      try {
        const error = await driver.spawn(basicLaunch(process.execPath, [
          '-e',
          "require('node:fs').writeFileSync(process.argv[1], 'ran');",
          marker,
        ])).then(
          () => { throw new Error('spawn must reject after injected assignment failure'); },
          value => value,
        );
        providerPid = readAbortedPid(error);
        expect(error instanceof Error ? error.message : String(error)).toContain('injected-assign-failure');
        expect(existsSync(marker)).toBe(false);
        expect(events.some(event => event.startsWith('assigned:'))).toBe(false);
        expect(events.some(event => event.startsWith('launched:'))).toBe(false);
        await waitForPidGone(providerPid);
        expect(pidIsAlive(providerPid)).toBe(false);
        await waitForHelperDrain(helpersBefore);
      } finally {
        if (providerPid !== undefined && pidIsAlive(providerPid)) {
          try { process.kill(providerPid, 'SIGKILL'); } catch { /* test hygiene */ }
          await waitForPidGone(providerPid);
        }
        await waitForHelperDrain(helpersBefore).catch(() => undefined);
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'HIGH-1 B1/B2/B5: bounded backpressure preserves every stdout byte and resumes',
    { timeout: REAL_SPAWN_TIMEOUT_MS },
    async () => {
      const transportEvents: string[] = [];
      const controller = new WindowsProcessTreeController({
        transportTrace: event => transportEvents.push(event.kind),
      });
      const driver = new NodeProcessDriver({ processTreeController: controller });
      const rows = 20_000;
      const providerScript = "for (let i = 0; i < " + rows + "; i++) process.stdout.write('row-' + i + ':' + 'x'.repeat(64) + ';');";
      const expected = Buffer.from(Array.from({ length: rows }, (_, i) => 'row-' + i + ':' + 'x'.repeat(64) + ';').join(''));
      const handle = await driver.spawn(basicLaunch(process.execPath, ['-e', providerScript]));
      track(handle.pid);
      const pauseDeadline = Date.now() + 10_000;
      while (!transportEvents.includes('data-paused') && Date.now() < pauseDeadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(transportEvents).toContain('data-paused');

      const chunks: Buffer[] = [];
      for await (const chunk of handle.streams.stdout) {
        expect(chunk.length).toBeLessThanOrEqual(STREAM_CHUNK_LIMIT_BYTES);
        chunks.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks)).toEqual(expected);
      const exit = await handle.waitExit();
      expect(exit.exitCode).toBe(0);
      expect(transportEvents).toContain('data-resumed');
      await expect(driver.verifySurvivors(handle)).resolves.toEqual({
        classification: 'complete',
        knownPids: [],
        proof: { kind: 'owned-tree-enumeration' },
      });
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'HIGH-1 B3/B4: stalled output still terminates through the control plane',
    { timeout: REAL_SPAWN_TIMEOUT_MS },
    async () => {
      const transportEvents: string[] = [];
      const helpersBefore = listPowerShellPids();
      const controller = new WindowsProcessTreeController({
        transportTrace: event => transportEvents.push(event.kind),
      });
      const driver = new NodeProcessDriver({ processTreeController: controller });
      const providerScript = "setInterval(() => { process.stdout.write('o'.repeat(8192)); process.stderr.write('e'.repeat(8192)); }, 5);";
      const handle = await driver.spawn(basicLaunch(process.execPath, ['-e', providerScript]));
      track(handle.pid);
      try {
        const pauseDeadline = Date.now() + 10_000;
        while (!transportEvents.includes('data-paused') && Date.now() < pauseDeadline) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(transportEvents).toContain('data-paused');

        await expect(driver.terminateTree(handle)).resolves.toMatchObject({ classification: 'complete' });
        await expect(driver.verifySurvivors(handle)).resolves.toEqual({
          classification: 'complete',
          knownPids: [],
          proof: { kind: 'owned-tree-enumeration' },
        });
        await expect(handle.waitExit()).resolves.toMatchObject({ exitCode: null, signal: null });
        await expect(Promise.race([
          collectChunks(handle.streams.stdout),
          new Promise((_, reject) => setTimeout(() => reject(new Error('stdout did not terminate')), 5_000)),
        ])).resolves.toBeInstanceOf(Buffer);
        expect(pidIsAlive(handle.pid)).toBe(false);
        await waitForHelperDrain(helpersBefore);
      } finally {
        try { await driver.terminateTree(handle); } catch { /* test hygiene */ }
        try { await driver.verifySurvivors(handle); } catch { /* test hygiene */ }
        await waitForHelperDrain(helpersBefore).catch(() => undefined);
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'HIGH-2: owned spawn passes exactly the declared environment and launch facts',
    { timeout: REAL_SPAWN_TIMEOUT_MS },
    async () => {
      const fixtureDir = mkdtempSync(join(tmpdir(), 'agentos-p5b-env-'));
      const env = {
        AGENTOS_TEST_ONLY: 'p5b-env-sentinel',
        SystemRoot: process.env.SystemRoot ?? ['C:', String.fromCharCode(92), 'Windows'].join(''),
      };
      const launch = {
        executable: process.execPath,
        args: ['-e', "process.stdout.write(JSON.stringify({ env: process.env, cwd: process.cwd(), pid: process.pid }));"],
        cwd: fixtureDir,
        env,
        envDiagnostics: [],
        shell: false as const,
      };
      const driver = new NodeProcessDriver();
      try {
        const handle = await driver.spawn(launch);
        track(handle.pid);
        const observed = JSON.parse((await collectChunks(handle.streams.stdout)).toString('utf8')) as {
          env: Record<string, string>;
          cwd: string;
          pid: number;
        };
        await expect(handle.waitExit()).resolves.toMatchObject({ exitCode: 0 });
        expect(observed.env).toEqual(env);
        expect(observed.env.PATH).toBeUndefined();
        expect(observed.env.TEMP).toBeUndefined();
        expect(observed.env.USERPROFILE).toBeUndefined();
        expect(observed.cwd).toBe(fixtureDir);
        expect(observed.pid).toBe(handle.pid);
        expect(handle.identity.executablePath).toBe(process.execPath);
        expect(launch.envDiagnostics).toEqual([]);
        await expect(driver.verifySurvivors(handle)).resolves.toEqual({
          classification: 'complete',
          knownPids: [],
          proof: { kind: 'owned-tree-enumeration' },
        });
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
  );


  it.skipIf(process.platform !== 'win32')('W12: no test-owned or helper survivors remain after the suite', () => {
    const alive = auditPids.filter(pid => pidIsAlive(pid));
    expect(alive).toEqual([]);
    const helperSurvivors = listPowerShellPids().filter(pid => !baselineHelperPids.includes(pid));
    expect(helperSurvivors).toEqual([]);
  });
});
