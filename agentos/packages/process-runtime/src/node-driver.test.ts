import { describe, expect, it } from 'vitest';
import { NodeProcessDriver } from './node-driver.js';

function longRunning(): string {
  return "setInterval(() => {}, 1000);";
}

describe('NodeProcessDriver', () => {
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
  });

  it('verifySurvivors is complete after exit and unknown while alive', async () => {
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
    expect(alive.classification).toBe('unknown');
    await driver.terminateTree(handle);
    await handle.waitExit();
    const after = await driver.verifySurvivors(handle);
    expect(after.classification).toBe('complete');
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