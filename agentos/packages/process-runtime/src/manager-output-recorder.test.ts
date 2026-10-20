import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileArtifactSink } from './artifact-sink.js';
import { NodeProcessDriver } from './node-driver.js';
import { ProcessManager } from './manager.js';
import type {
  ProcessOutputRecorder,
  ProcessOutputRecorderHandle,
} from './manager.js';
import { NodeFileSystemProbe } from './validation.js';
import type { StreamChunk } from './index.js';

/** Real subprocess + real FileArtifactSink: stdout/stderr must land in the
 * artifact already redacted, finalized with the retained-byte sha256. */
describe('ProcessManager outputRecorder (Raw Output Artifact §55)', () => {
  it('persists redacted stdout/stderr chunks and finalizes with sha256', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-recorder-'));
    const sink = new FileArtifactSink(root);
    const finalized: Array<{ stream: string; sha256: string; bytes: number }> = [];
    const recorder: ProcessOutputRecorder = {
      begin: (processId, stream): ProcessOutputRecorderHandle => {
        const sessionPromise = sink.open('artifact_' + processId.slice(-8), 'sink/' + stream + '/' + processId);
        return {
          append: async (chunk: StreamChunk) => {
            const session = await sessionPromise;
            await session.append(chunk.bytes);
          },
          finalize: async () => {
            const session = await sessionPromise;
            const result = await session.finalize();
            finalized.push({ stream, sha256: result.sha256, bytes: result.retainedBytes });
          },
        };
      },
    };
    const manager = new ProcessManager({
      driver: new NodeProcessDriver(),
      probe: new NodeFileSystemProbe(),
      policy: { workspaceRoot: root },
      outputRecorder: recorder,
      reclaim: { ttlMs: 60_000, sweepIntervalMs: 60_000 },
    });
    const secret = 'sup3r-s3cret-token';
    const reservation = await manager.reserve({
      claim: { key: 'recorder-claim', owner: 'test', epoch: 1 },
      launch: {
        executable: process.execPath,
        args: [
          '-e',
          'console.log("hello stdout");'
            + 'console.error("err line with sup3r-s3cret-token");'
            + 'process.stdout.write("partial");',
        ],
        cwd: root,
        // Windows node.exe needs a minimal host env (CSPRNG/SystemRoot);
        // secret-looking base keys are rejected, so keep only safe picks.
        env: {
          base: Object.fromEntries(
            Object.entries(process.env).filter(([key]) =>
              /^(SystemRoot|PATH|TEMP|TMP|USERPROFILE|ProgramData|ProgramFiles|windir|ComSpec|PATHEXT|HOME|HOMEDRIVE|HOMEPATH)$/i.test(key),
            ),
          ),
          profile: {},
          overrides: {},
          secretRefs: { MY_API_TOKEN: secret },
        },
      },
    });
    const started = await manager.start(reservation.snapshot.id, {
      key: reservation.snapshot.claimKey,
      owner: reservation.snapshot.claimOwner,
      epoch: reservation.snapshot.claimEpoch,
    });
    expect(started.snapshot.state).toBe('starting');
    const terminal = await manager.waitForTerminal(reservation.snapshot.id, { timeoutMs: 15_000 });
    expect(terminal.state).toBe('exited');
    // Native exit precedes stream completion: wait until both streams are
    // drained and finalized before reading the artifacts.
    for (let attempt = 0; attempt < 100 && finalized.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(finalized).toHaveLength(2);

    const stdoutArtifact = readFileSync(join(root, 'sink', 'stdout', reservation.snapshot.id)).toString('utf-8');
    expect(stdoutArtifact).toContain('hello stdout');
    expect(stdoutArtifact).toContain('partial');

    const stderrArtifact = readFileSync(join(root, 'sink', 'stderr', reservation.snapshot.id)).toString('utf-8');
    expect(stderrArtifact).toContain('err line with');
    expect(stderrArtifact).not.toContain(secret);
    expect(stderrArtifact).toContain('[REDACTED]');

    // Finalize ran exactly once per stream with the retained-byte sha256.
    for (const entry of finalized) {
      const content = readFileSync(join(root, 'sink', entry.stream, reservation.snapshot.id));
      expect(createHash('sha256').update(content).digest('hex')).toBe(entry.sha256);
      expect(entry.bytes).toBe(content.length);
    }

    // The in-memory bounded read-back surface agrees and stays redacted.
    const readBack = manager.readProcessOutput(reservation.snapshot.id, 'stderr');
    expect(readBack).toBeDefined();
    expect(readBack!.text).not.toContain(secret);
    await manager.dispose(reservation.snapshot.id);
  });

  it('recorder failure degrades to the in-memory buffer and records a fact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-recorder-fail-'));
    const recorder: ProcessOutputRecorder = {
      begin: () => {
        throw new Error('recorder unavailable');
      },
    };
    const manager = new ProcessManager({
      driver: new NodeProcessDriver(),
      probe: new NodeFileSystemProbe(),
      policy: { workspaceRoot: root },
      outputRecorder: recorder,
    });
    const reservation = await manager.reserve({
      claim: { key: 'recorder-fail-claim', owner: 'test', epoch: 1 },
      launch: {
        executable: process.execPath,
        args: ['-e', 'console.log("still observable");'],
        cwd: root,
        env: {
          base: Object.fromEntries(
            Object.entries(process.env).filter(([key]) =>
              /^(SystemRoot|PATH|TEMP|TMP|USERPROFILE|ProgramData|ProgramFiles|windir|ComSpec|PATHEXT|HOME|HOMEDRIVE|HOMEPATH)$/i.test(key),
            ),
          ),
        },
      },
    });
    await manager.start(reservation.snapshot.id, {
      key: reservation.snapshot.claimKey,
      owner: reservation.snapshot.claimOwner,
      epoch: reservation.snapshot.claimEpoch,
    });
    const terminal = await manager.waitForTerminal(reservation.snapshot.id, { timeoutMs: 15_000 });
    expect(terminal.facts.map((fact) => fact.type)).toContain('process.output_persistence_failed');
    const readBack = manager.readProcessOutput(reservation.snapshot.id, 'stdout');
    expect(readBack).toBeDefined();
    expect(readBack!.text).toContain('still observable');
    await manager.dispose(reservation.snapshot.id);
  });
});
