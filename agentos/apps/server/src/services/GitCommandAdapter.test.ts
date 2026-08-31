import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MockNativeProcessHandle,
  MockProcessDriver,
  type ExitEvidence,
  type NativeIdentity,
  type NativeProcessHandle,
  type NativeProcessStreams,
} from '@agentos/process-runtime';
import {
  GIT_COMMAND_ARGUMENTS_V1,
  GIT_COMMAND_DIAGNOSTIC_LIMIT_BYTES_V1,
  GIT_COMMAND_EXECUTION_CONTRACT_V1,
  GIT_COMMAND_STDOUT_LIMITS_V1,
  parseGitCommitObjectIdV1,
  type GitCommandRequestV1,
  type GitCommandResultV1,
  type GitCommitObjectIdV1,
} from '@agentos/shared';
import {
  GitCommandAdapter,
  GitCommandPortFactory,
  type GitCommandAdapterDependencies,
} from './GitCommandAdapter.js';

const BASE_SHA = parseGitCommitObjectIdV1('0123456789abcdef0123456789abcdef01234567');
assert.ok(BASE_SHA !== null);
const BASE: GitCommitObjectIdV1 = BASE_SHA;

interface TimerRecord {
  readonly callback: () => void;
  cancelled: boolean;
  cancelCalls: number;
}

interface SchedulerHarness {
  readonly dependencies: Pick<GitCommandAdapterDependencies, 'schedule'>;
  readonly timers: TimerRecord[];
  readonly fires: TimerRecord[];
  trigger(index?: number): void;
}

function createScheduler(): SchedulerHarness {
  const timers: TimerRecord[] = [];
  const fires: TimerRecord[] = [];
  const harness: SchedulerHarness = {
    timers,
    fires,
    dependencies: {
      schedule: (callback: () => void, _delayMs: number) => {
        const record: TimerRecord = { callback, cancelled: false, cancelCalls: 0 };
        timers.push(record);
        return {
          cancel: () => {
            record.cancelCalls += 1;
            record.cancelled = true;
          },
        };
      },
    },
    trigger(index = 0): void {
      const record = timers[index];
      assert.ok(record !== undefined, 'expected a scheduled timer');
      assert.equal(record.cancelled, false, 'timer must not be cancelled before firing');
      fires.push(record);
      record.callback();
    },
  };
  return harness;
}

function createAdapter(
  driver: MockProcessDriver,
  overrides: Partial<GitCommandAdapterDependencies> = {},
): { adapter: GitCommandAdapter; scheduler: SchedulerHarness } {
  const scheduler = createScheduler();
  const dependencies: GitCommandAdapterDependencies = {
    driver,
    schedule: scheduler.dependencies.schedule,
    baseEnvironment: { PATH: 'C:\\Git\\bin', GIT_DIR: 'C:\\host-override' },
    ...overrides,
  };
  return { adapter: new GitCommandAdapter(dependencies), scheduler };
}

function lastLaunch(driver: MockProcessDriver) {
  const launch = driver.spawnCalls[driver.spawnCalls.length - 1];
  assert.ok(launch !== undefined, 'expected a spawn call');
  return launch;
}

function makeHandle(driver: MockProcessDriver, pid: number): MockNativeProcessHandle {
  const handle = new MockNativeProcessHandle(pid, 'git');
  driver.settleSpawnSuccess(handle);
  return handle;
}

/** Settle the held spawn and yield until runOwned has started consuming the handle. */
async function spawnAndArm(driver: MockProcessDriver, pid: number): Promise<MockNativeProcessHandle> {
  const handle = makeHandle(driver, pid);
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  return handle;
}

interface ObservedAbortSignal {
  readonly signal: AbortSignal;
  readonly addCalls: () => number;
  readonly removeCalls: () => number;
}

function observeAbortSignal(controller: AbortController): ObservedAbortSignal {
  const target = controller.signal;
  let additions = 0;
  let removals = 0;
  const signal = {
    get aborted(): boolean {
      return target.aborted;
    },
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void {
      additions += 1;
      target.addEventListener(type, listener, options);
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ): void {
      removals += 1;
      target.removeEventListener(type, listener, options);
    },
  } as AbortSignal;
  return {
    signal,
    addCalls: () => additions,
    removeCalls: () => removals,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => undefined;
  let rejectValue: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

class ControlledByteStream implements AsyncIterable<Uint8Array> {
  private readonly queue: Uint8Array[] = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<Uint8Array>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown = null;

  push(chunk: Uint8Array | string): void {
    if (this.ended || this.failure !== null) return;
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.queue.push(bytes);
      return;
    }
    waiter.resolve({ value: bytes, done: false });
  }

  end(): void {
    if (this.ended || this.failure !== null) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  reject(error: unknown): void {
    if (this.ended || this.failure !== null) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: (): Promise<IteratorResult<Uint8Array>> => {
        const chunk = this.queue.shift();
        if (chunk !== undefined) return Promise.resolve({ value: chunk, done: false });
        if (this.failure !== null) return Promise.reject(this.failure);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

class ControlledNativeProcessHandle implements NativeProcessHandle {
  readonly pid: number;
  readonly identity: NativeIdentity;
  readonly stdout = new ControlledByteStream();
  readonly stderr = new ControlledByteStream();
  readonly streams: NativeProcessStreams = { stdout: this.stdout, stderr: this.stderr };
  private readonly exit = deferred<ExitEvidence>();

  constructor(pid: number) {
    this.pid = pid;
    this.identity = { pid, startedAtMs: 0, executablePath: 'git' };
  }

  waitExit(): Promise<ExitEvidence> {
    return this.exit.promise;
  }

  emitExit(exitCode: number | null = 0): void {
    this.exit.resolve({ exitCode, signal: null, exitedAt: 0 });
    this.stdout.end();
    this.stderr.end();
  }

  rejectExit(error = new Error('raw controlled waitExit failure')): void {
    this.exit.reject(error);
    this.stdout.end();
    this.stderr.end();
  }

  rejectStdout(error = new Error('raw controlled stdout failure')): void {
    this.stdout.reject(error);
    this.stderr.end();
    this.exit.resolve({ exitCode: null, signal: 'SIGTERM', exitedAt: 0 });
  }

  rejectStderr(error = new Error('raw controlled stderr failure')): void {
    this.stderr.reject(error);
    this.stdout.end();
    this.exit.resolve({ exitCode: null, signal: 'SIGTERM', exitedAt: 0 });
  }
}

function settleControlledSpawn(
  driver: MockProcessDriver,
  handle: ControlledNativeProcessHandle,
): void {
  driver.settleSpawnSuccess(handle as unknown as MockNativeProcessHandle);
}

function envMap(launch: { readonly env: Readonly<Record<string, string>> }): Record<string, string> {
  return { ...launch.env };
}

const NO_EVIDENCE = Object.freeze([
  /no evidence/i,
  /raw stderr/i,
  /undefined/i,
]);

function assertBoundedPublicResult(result: GitCommandResultV1): void {
  // Uint8Array does not JSON-serialize as bytes, so bound the wire view
  // through Buffer explicitly: stdout <= the family cap (4 MiB worst case),
  // stderr diagnostic <= the frozen 16 KiB diagnostic cap.
  const serialized = JSON.stringify({
    ...result,
    stdout: Buffer.from(result.stdout).toString('base64'),
    stderrDiagnostic: Buffer.from(result.stderrDiagnostic).toString('base64'),
  });
  for (const pattern of NO_EVIDENCE) {
    assert.doesNotMatch(serialized, pattern);
  }
  assert.ok(Buffer.byteLength(serialized) <= 6 * 1024 * 1024);
}

function assertSuccess(result: GitCommandResultV1): asserts result is Extract<GitCommandResultV1, { termination: 'exited' }> {
  assert.equal(result.termination, 'exited');
}

describe('GitCommandAdapter launch sealing', () => {
  it('seals repository_root argv', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'repository_root', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    assert.deepEqual([...lastLaunch(driver).args], ['rev-parse', '--show-toplevel']);
    makeHandle(driver, 4101).emitExit({ exitCode: 0 });
    await pending;
  });

  it('seals head_commit argv to the frozen M1 canonical probe', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    assert.deepEqual([...lastLaunch(driver).args], [...GIT_COMMAND_ARGUMENTS_V1.head_commit]);
    assert.deepEqual([...lastLaunch(driver).args], ['rev-parse', '--verify', 'HEAD^{commit}']);
    makeHandle(driver, 4102).emitExit({ exitCode: 0 });
    await pending;
  });

  it('seals porcelain_v2_status argv and requires a validated relative prefix', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    driver.holdNextSpawn();
    const pending = adapter.execute({
      family: 'porcelain_v2_status',
      cwd: 'C:\\ws',
      workspacePathFromRepositoryRoot: '',
    });
    await driver.awaitSpawnEntered();
    assert.deepEqual(
      [...lastLaunch(driver).args],
      ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-ahead-behind', '--', '.'],
    );
    makeHandle(driver, 4103).emitExit({ exitCode: 0 });
    await pending;

    // The pathspec is the fixed literal '-- .' even for a nested Workspace;
    // workspacePathFromRepositoryRoot is validated but never enters argv.
    driver.holdNextSpawn();
    const nested = adapter.execute({
      family: 'porcelain_v2_status',
      cwd: 'C:\\ws',
      workspacePathFromRepositoryRoot: 'workspace-a',
    });
    await driver.awaitSpawnEntered(2);
    assert.deepEqual(
      [...lastLaunch(driver).args],
      ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-ahead-behind', '--', '.'],
    );
    makeHandle(driver, 4104).emitExit({ exitCode: 0 });
    await nested;

    await assert.rejects(
      adapter.execute({
        family: 'porcelain_v2_status',
        cwd: 'C:\\ws',
        // An invalid prefix must be rejected before spawn.
        workspacePathFromRepositoryRoot: '../sibling',
      }),
    );
  });

  it('seals bounded_diff argv and rejects an invalid base commit before spawn', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    driver.holdNextSpawn();
    // workspacePathFromRepositoryRoot is validated for later M1 path
    // projection but must never be substituted into the fixed argv.
    const pending = adapter.execute({
      family: 'bounded_diff',
      cwd: 'C:\\ws',
      baseCommitSha: BASE,
      workspacePathFromRepositoryRoot: 'nested/dir',
    });
    await driver.awaitSpawnEntered();
    assert.deepEqual(
      [...lastLaunch(driver).args],
      ['diff', '--no-ext-diff', '--no-textconv', BASE, '--', '.'],
    );
    makeHandle(driver, 4105).emitExit({ exitCode: 0 });
    await pending;

    await assert.rejects(
      adapter.execute({
        family: 'bounded_diff',
        cwd: 'C:\\ws',
        // @ts-expect-error arbitrary revisions and option-like strings are rejected
        baseCommitSha: 'HEAD~1',
        workspacePathFromRepositoryRoot: '',
      }),
    );
    await assert.rejects(
      adapter.execute({
        family: 'bounded_diff',
        cwd: 'C:\\ws',
        // @ts-expect-error arbitrary revisions and option-like strings are rejected
        baseCommitSha: '--output=/tmp/x',
        workspacePathFromRepositoryRoot: '',
      }),
    );
    assert.equal(driver.spawnCalls.length, 1, 'invalid requests must never spawn');
  });

  it('fixes the executable, shell:false, cwd and passes only the sanitized env', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'repository_root', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const launch = lastLaunch(driver);
    assert.equal(launch.executable, 'git');
    assert.equal(launch.shell, false);
    assert.equal(launch.cwd, 'C:\\ws');
    const env = envMap(launch);
    assert.equal(env.PATH, 'C:\\Git\\bin');
    assert.equal(env.GIT_DIR, undefined, 'host GIT_* values must be stripped');
    assert.deepEqual(launch.envDiagnostics, []);
    makeHandle(driver, 4106).emitExit({ exitCode: 0 });
    await pending;
  });
});

describe('GitCommandAdapter environment sanitization', () => {
  it('produces the frozen deterministic environment and strips host GIT_* keys', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'repository_root', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const env = envMap(lastLaunch(driver));
    assert.equal(env.LC_ALL, 'C');
    assert.equal(env.LANG, 'C');
    assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_PAGER, 'cat');
    assert.equal(env.PAGER, 'cat');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_CONFIG_GLOBAL, 'NUL');
    assert.equal(env.GIT_CONFIG_SYSTEM, 'NUL');
    assert.equal(env.GIT_ATTR_NOSYSTEM, '1');
    assert.equal(env.GIT_CEILING_DIRECTORIES, '');
    assert.equal(env.GIT_DISCOVERY_ACROSS_FILESYSTEM, '0');
    // Controlled command-scope config disables repository-local fsmonitor and
    // forces repository-relative status paths without any config write; host
    // GIT_CONFIG_* values never win.
    assert.equal(env.GIT_CONFIG_COUNT, '2');
    assert.equal(env.GIT_CONFIG_KEY_0, 'core.fsmonitor');
    assert.equal(env.GIT_CONFIG_VALUE_0, 'false');
    assert.equal(env.GIT_CONFIG_KEY_1, 'status.relativePaths');
    assert.equal(env.GIT_CONFIG_VALUE_1, 'false');
    assert.equal(env.GIT_FSMONITOR_TEST, undefined);
    assert.equal(env.SSH_ASKPASS, undefined);
    makeHandle(driver, 4107).emitExit({ exitCode: 0 });
    await pending;
  });

  it('never lets a hostile base environment override frozen or controlled values', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver, {
      baseEnvironment: {
        PATH: 'C:\\Git\\bin',
        LC_ALL: 'zh_CN.UTF-8',
        GIT_TERMINAL_PROMPT: '1',
        GIT_EXEC_PATH: 'C:\\evil',
        GIT_SSH_COMMAND: 'evil',
        GIT_EXTERNAL_DIFF: 'evil',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.fsmonitor',
        GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_KEY_1: 'status.relativePaths',
        GIT_CONFIG_VALUE_1: 'true',
        PATH_INFO: 'kept',
        HOME: 'C:\\Users\\attacker',
        COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
        SystemRoot: 'C:\\Windows',
      },
    });
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'repository_root', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const env = envMap(lastLaunch(driver));
    assert.equal(env.LC_ALL, 'C');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_EXEC_PATH, undefined);
    assert.equal(env.GIT_SSH_COMMAND, undefined);
    assert.equal(env.GIT_EXTERNAL_DIFF, undefined);
    assert.equal(env.GIT_CONFIG_COUNT, '2', 'controlled count overrides the host value');
    assert.equal(env.GIT_CONFIG_KEY_0, 'core.fsmonitor');
    assert.equal(env.GIT_CONFIG_VALUE_0, 'false', 'host fsmonitor config must not win');
    assert.equal(env.GIT_CONFIG_KEY_1, 'status.relativePaths');
    assert.equal(env.GIT_CONFIG_VALUE_1, 'false', 'host relativePaths config must not win');
    assert.equal(env.PATH, 'C:\\Git\\bin', 'PATH is required to locate git');
    assert.equal(env.COMSPEC, 'C:\\Windows\\System32\\cmd.exe', 'allowlisted Windows shell key');
    assert.equal(env.SystemRoot, 'C:\\Windows', 'allowlisted Windows system root');
    assert.equal(env.PATH_INFO, undefined, 'arbitrary non-GIT host keys are not retained');
    assert.equal(env.HOME, undefined, 'unrelated HOME is not required to locate/execute git');
    makeHandle(driver, 4108).emitExit({ exitCode: 0 });
    await pending;
  });

  it('exposes the frozen M1 execution contract and rejects unexpected families', () => {
    const factory = GitCommandPortFactory.create();
    assert.equal(factory.executionContract, GIT_COMMAND_EXECUTION_CONTRACT_V1);
    const adapter = new GitCommandAdapter({ driver: new MockProcessDriver() });
    return assert.rejects(
      // @ts-expect-error unknown families are rejected before any spawn
      adapter.execute({ family: 'arbitrary', cwd: 'C:\\ws' }),
    );
  });
});

describe('GitCommandAdapter factory sealing', () => {
  it('production factory accepts only an AbortSignal option', () => {
    const factory = GitCommandPortFactory.create({ signal: new AbortController().signal });
    assert.equal(typeof factory.execute, 'function');
    // @ts-expect-error deadlines are server-owned and frozen
    assert.throws(() => GitCommandPortFactory.create({ deadlines: { head_commit: 1 } }));
    // @ts-expect-error stdout limits are server-owned and frozen
    assert.throws(() => GitCommandPortFactory.create({ stdoutLimits: { head_commit: 1 } }));
    // @ts-expect-error callers must not inject drivers through the production factory
    assert.throws(() => GitCommandPortFactory.create({ driver: new MockProcessDriver() }));
  });
});

describe('GitCommandAdapter successful execution', () => {
  it('returns exit code with exactly-bounded stdout and stderr, settled once', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'repository_root', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const handle = makeHandle(driver, 4200);
    const stdout = new Uint8Array(GIT_COMMAND_STDOUT_LIMITS_V1.repository_root).fill(0x61);
    const stderr = new Uint8Array(GIT_COMMAND_DIAGNOSTIC_LIMIT_BYTES_V1).fill(0x62);
    handle.pushStdout(stdout);
    handle.pushStderr(stderr);
    handle.emitExit({ exitCode: 0 });
    const result = await pending;
    assertSuccess(result);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.byteLength, GIT_COMMAND_STDOUT_LIMITS_V1.repository_root);
    assert.deepEqual([...result.stdout.slice(0, 3)], [0x61, 0x61, 0x61]);
    assert.equal(result.stderrDiagnostic.byteLength, GIT_COMMAND_DIAGNOSTIC_LIMIT_BYTES_V1);
    assert.equal(result.stderrDiagnosticTruncated, false);
    assert.equal(scheduler.timers.length, 1);
    assert.equal(scheduler.timers[0].cancelled, true, 'deadline timer is cancelled exactly once');
    assert.equal(driver.terminateTreeCalls, 0);
    assert.equal(driver.verifySurvivorsCalls, 0);
    assertBoundedPublicResult(result);
  });

  it('keeps exitCode 0 as exited and passes non-zero through to M1 classifiers', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'repository_root', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const handle = makeHandle(driver, 4201);
    handle.pushStderr('fatal: not a git repository (or any of the parent directories): .git');
    handle.emitExit({ exitCode: 128 });
    const result = await pending;
    assertSuccess(result);
    assert.equal(result.exitCode, 128);
    assert.equal(result.stderrDiagnosticTruncated, false);
    assertBoundedPublicResult(result);
  });
});

describe('GitCommandAdapter deadline', () => {
  it('maps deadline firing to timed_out, terminates the owned tree and verifies it', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const handle = await spawnAndArm(driver, 4300);
    scheduler.trigger();
    handle.emitExit({ exitCode: null, signal: 'SIGTERM' });
    const result = await pending;
    assert.equal(result.termination, 'timed_out');
    assert.equal(result.exitCode, null);
    assert.equal(result.stdout.byteLength, 0);
    assert.equal(driver.terminateTreeCalls, 1);
    assert.equal(driver.verifySurvivorsCalls, 1);
    assert.equal(scheduler.timers[0].cancelled, true);
    assertBoundedPublicResult(result);
  });

  it('passes the frozen per-family deadline to the injected scheduler', async () => {
    const driver = new MockProcessDriver();
    const scheduler = createScheduler();
    const delays: number[] = [];
    const adapter = new GitCommandAdapter({
      driver,
      schedule: (callback, delayMs) => {
        delays.push(delayMs);
        return scheduler.dependencies.schedule!(callback, delayMs);
      },
    });
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    (await spawnAndArm(driver, 4301)).emitExit({ exitCode: 0 });
    await pending;
    assert.deepEqual(delays, [5000]);
  });

  it('a timeout fired after settlement is ignored', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const handle = await spawnAndArm(driver, 4302);
    handle.pushStdout('abc');
    handle.emitExit({ exitCode: 0 });
    const first = await pending;
    assertSuccess(first);
    assert.equal(first.stdout.byteLength, 3);
    // Give the natural-exit microtask a chance to run before competing with a
    // late timer fire; either way the settled exited result must win.
    await flushMicrotasks();
    const terminationsBefore = driver.terminateTreeCalls;
    scheduler.timers[0].callback();
    assert.equal(driver.terminateTreeCalls, terminationsBefore);
  });
});

describe('GitCommandAdapter cancellation', () => {
  it('maps abort to cancelled, terminates and verifies the owned tree', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    const controller = new AbortController();
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' }, { signal: controller.signal });
    await driver.awaitSpawnEntered();
    const handle = makeHandle(driver, 4400);
    controller.abort();
    handle.emitExit({ exitCode: null, signal: 'SIGTERM' });
    const result = await pending;
    assert.equal(result.termination, 'cancelled');
    assert.equal(driver.terminateTreeCalls, 1);
    assert.equal(driver.verifySurvivorsCalls, 1);
    assert.equal(scheduler.timers[0].cancelled, true);
    assertBoundedPublicResult(result);
  });

  it('a pre-aborted signal cancels without spawning', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    const controller = new AbortController();
    controller.abort();
    const result = await adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' }, { signal: controller.signal });
    assert.equal(result.termination, 'cancelled');
    assert.equal(result.stdout.byteLength, 0);
    assert.equal(result.stderrDiagnostic.byteLength, 0);
    assert.equal(driver.spawnCalls.length, 0);
    assertBoundedPublicResult(result);
  });

  it('a deadline firing after cancellation is ignored exactly once', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    const controller = new AbortController();
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' }, { signal: controller.signal });
    await driver.awaitSpawnEntered();
    const handle = makeHandle(driver, 4401);
    controller.abort();
    handle.emitExit({ exitCode: null, signal: 'SIGTERM' });
    const result = await pending;
    assert.equal(result.termination, 'cancelled');
    scheduler.timers[0].callback();
    assert.equal(driver.terminateTreeCalls, 1);
    assert.equal(driver.verifySurvivorsCalls, 1);
  });
});

describe('GitCommandAdapter stdout bound', () => {
  it('overflow maps to output_limit, stops retaining and terminates the tree', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'repository_root', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const handle = makeHandle(driver, 4500);
    handle.pushStdout(new Uint8Array(4096).fill(0x78));
    handle.pushStdout(new Uint8Array(1).fill(0x78));
    handle.pushStdout(new Uint8Array(8192).fill(0x78));
    handle.pushStderr('late diagnostic');
    handle.emitExit({ exitCode: null, signal: 'SIGTERM' });
    const result = await pending;
    assert.equal(result.termination, 'output_limit');
    assert.equal(result.exitCode, null);
    assert.equal(result.stdout.byteLength, 4096);
    assert.equal(driver.terminateTreeCalls, 1);
    assert.equal(driver.verifySurvivorsCalls, 1);
    assert.equal(scheduler.timers[0].cancelled, true);
    assertBoundedPublicResult(result);
  });

  it('exactly the family limit is not an overflow', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const handle = makeHandle(driver, 4501);
    handle.pushStdout(new Uint8Array(4096).fill(0x61));
    handle.emitExit({ exitCode: 0 });
    const result = await pending;
    assertSuccess(result);
    assert.equal(result.stdout.byteLength, 4096);
  });
});

describe('GitCommandAdapter stderr diagnostic bound', () => {
  it('retains only the bounded prefix, flags truncation and keeps draining', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'repository_root', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const handle = makeHandle(driver, 4600);
    const prefix = new Uint8Array(8000).fill(0x61);
    handle.pushStderr(prefix);
    handle.pushStderr(new Uint8Array(32768).fill(0x62));
    handle.pushStderr('tail');
    handle.emitExit({ exitCode: 1 });
    const result = await pending;
    assertSuccess(result);
    assert.equal(result.stderrDiagnostic.byteLength, GIT_COMMAND_DIAGNOSTIC_LIMIT_BYTES_V1);
    assert.equal(result.stderrDiagnosticTruncated, true);
    assert.deepEqual([...result.stderrDiagnostic.slice(0, 3)], [0x61, 0x61, 0x61]);
    assert.deepEqual(
      [...result.stderrDiagnostic.slice(GIT_COMMAND_DIAGNOSTIC_LIMIT_BYTES_V1 - 3)],
      [0x62, 0x62, 0x62],
    );
    assertBoundedPublicResult(result);
  });

  it('retains and truncates late stderr after a timeout winner', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    driver.holdNextSpawn();
    driver.holdVerifySurvivors();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const handle = await spawnAndArm(driver, 4601);
    scheduler.trigger();
    await driver.awaitTerminateTreeEntered();
    const lateDiagnostic = new Uint8Array(GIT_COMMAND_DIAGNOSTIC_LIMIT_BYTES_V1 + 4096).fill(0x64);
    handle.pushStderr(lateDiagnostic);
    handle.emitExit({ exitCode: null, signal: 'SIGTERM' });
    await driver.awaitVerifySurvivorsEntered();
    driver.settleVerifySurvivors('complete');
    const result = await pending;
    assert.equal(result.termination, 'timed_out');
    assert.equal(result.stderrDiagnostic.byteLength, GIT_COMMAND_DIAGNOSTIC_LIMIT_BYTES_V1);
    assert.equal(result.stderrDiagnosticTruncated, true);
    assert.deepEqual([...result.stderrDiagnostic.slice(-3)], [0x64, 0x64, 0x64]);
  });
});

describe('GitCommandAdapter spawn failure mapping', () => {
  it('maps ENOENT to not_found after arming and cancelling the deadline', async () => {
    const driver = new MockProcessDriver();
    const scheduler = createScheduler();
    const adapter = new GitCommandAdapter({ driver, schedule: scheduler.dependencies.schedule });
    const error = new Error('spawn git ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    driver.spawnError = error;
    const result = await adapter.execute({ family: 'repository_root', cwd: 'C:\\ws' });
    assert.equal(result.termination, 'spawn_failed');
    assert.equal((result as { spawnFailure: string }).spawnFailure, 'not_found');
    assert.equal(scheduler.timers.length, 1, 'deadline is armed before spawn');
    assert.equal(scheduler.timers[0].cancelCalls, 1);
    assertBoundedPublicResult(result);
  });

  it('maps permission-like spawn errors to permission', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    const error = new Error('spawn git EPERM') as NodeJS.ErrnoException;
    error.code = 'EPERM';
    driver.spawnError = error;
    const result = await adapter.execute({ family: 'repository_root', cwd: 'C:\\ws' });
    assert.equal(result.termination, 'spawn_failed');
    assert.equal((result as { spawnFailure: string }).spawnFailure, 'permission');
    assert.equal(scheduler.timers.length, 1);
    assert.equal(scheduler.timers[0].cancelCalls, 1);
    assertBoundedPublicResult(result);
  });

  it('maps other spawn errors to the frozen M1 unknown', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    const error = new Error('spawn git EINVAL') as NodeJS.ErrnoException;
    error.code = 'EINVAL';
    driver.spawnError = error;
    const result = await adapter.execute({ family: 'repository_root', cwd: 'C:\\ws' });
    assert.equal(result.termination, 'spawn_failed');
    assert.equal((result as { spawnFailure: string }).spawnFailure, 'unknown');
    assert.equal(scheduler.timers.length, 1);
    assert.equal(scheduler.timers[0].cancelCalls, 1);
    assertBoundedPublicResult(result);
  });
});

describe('GitCommandAdapter pre-spawn control races', () => {
  it('pending spawn + timeout waits for late handle cleanup proof and returns timed_out', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    driver.holdNextSpawn();
    driver.holdVerifySurvivors();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();

    const timer = scheduler.timers[0];
    if (timer === undefined) {
      driver.settleSpawnFailure(new Error('release missing pre-spawn timer'));
      await pending;
      assert.fail('family deadline was not armed before driver.spawn()');
    }
    scheduler.trigger();
    const probe = settlementProbe(pending);
    await flushMicrotasks();
    assert.equal(probe.settled(), false, 'pending spawn cannot return while a handle may arrive');

    const handle = new MockNativeProcessHandle(4720, 'git');
    driver.settleSpawnSuccess(handle);
    await driver.awaitTerminateTreeEntered();
    await driver.awaitVerifySurvivorsEntered();
    handle.emitExit({ exitCode: null, signal: 'SIGTERM' });
    await flushMicrotasks();
    assert.equal(probe.settled(), false, 'cleanup proof gates the timed_out result');
    driver.settleVerifySurvivors('complete');

    const result = await pending;
    assert.equal(result.termination, 'timed_out');
    assert.equal(driver.terminateTreeCalls, 1);
    assert.equal(driver.verifySurvivorsCalls, 1);
  });

  it('pending spawn + abort waits for late handle cleanup proof and returns cancelled', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    const controller = new AbortController();
    const observed = observeAbortSignal(controller);
    driver.holdNextSpawn();
    driver.holdVerifySurvivors();
    const pending = adapter.execute(
      { family: 'head_commit', cwd: 'C:\\ws' },
      { signal: observed.signal },
    );
    await driver.awaitSpawnEntered();

    if (observed.addCalls() !== 1) {
      driver.settleSpawnFailure(new Error('release missing pre-spawn listener'));
      await pending;
      assert.fail('AbortSignal listener was not installed before driver.spawn()');
    }
    assert.equal(scheduler.timers.length, 1, 'deadline is also armed before spawn');
    controller.abort();
    const probe = settlementProbe(pending);
    await flushMicrotasks();
    assert.equal(probe.settled(), false, 'pending spawn cannot return while a handle may arrive');

    const handle = new MockNativeProcessHandle(4721, 'git');
    driver.settleSpawnSuccess(handle);
    await driver.awaitTerminateTreeEntered();
    await driver.awaitVerifySurvivorsEntered();
    handle.emitExit({ exitCode: null, signal: 'SIGTERM' });
    driver.settleVerifySurvivors('complete');

    const result = await pending;
    assert.equal(result.termination, 'cancelled');
    assert.equal(driver.terminateTreeCalls, 1);
    assert.equal(driver.verifySurvivorsCalls, 1);
  });

  it('pending spawn + timeout then spawn rejection preserves timed_out', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const timer = scheduler.timers[0];
    if (timer === undefined) {
      driver.settleSpawnFailure(new Error('release missing pre-spawn timer'));
      await pending;
      assert.fail('family deadline was not armed before driver.spawn()');
    }
    scheduler.trigger();
    const lateError = new Error('late spawn ENOENT') as NodeJS.ErrnoException;
    lateError.code = 'ENOENT';
    driver.settleSpawnFailure(lateError);
    const result = await pending;
    assert.equal(result.termination, 'timed_out');
    assert.equal(driver.terminateTreeCalls, 0, 'no handle exists to clean up');
  });

  it('pending spawn + abort then spawn rejection preserves cancelled', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    const controller = new AbortController();
    const observed = observeAbortSignal(controller);
    driver.holdNextSpawn();
    const pending = adapter.execute(
      { family: 'head_commit', cwd: 'C:\\ws' },
      { signal: observed.signal },
    );
    await driver.awaitSpawnEntered();
    controller.abort();
    const lateError = new Error('late spawn EACCES') as NodeJS.ErrnoException;
    lateError.code = 'EACCES';
    driver.settleSpawnFailure(lateError);
    const result = await pending;
    assert.equal(observed.addCalls(), 1, 'listener is installed before spawn settles');
    assert.equal(result.termination, 'cancelled');
    assert.equal(driver.terminateTreeCalls, 0, 'no handle exists to clean up');
  });
});

describe('GitCommandAdapter AbortSignal validation', () => {
  it('rejects a malformed signal before scheduling or spawning', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    const error = await adapter.execute(
      { family: 'head_commit', cwd: 'C:\\ws' },
      { signal: { aborted: false } as AbortSignal },
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'GIT_COMMAND_SIGNAL_INVALID');
    assert.equal(scheduler.timers.length, 0);
    assert.equal(driver.spawnCalls.length, 0);
  });
});

describe('GitCommandAdapter settlement and cleanup discipline', () => {
  it('arms controls before spawn and cancels/removes each exactly once on exit', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    const controller = new AbortController();
    const observed = observeAbortSignal(controller);
    driver.holdNextSpawn();
    const pending = adapter.execute(
      { family: 'head_commit', cwd: 'C:\\ws' },
      { signal: observed.signal },
    );
    await driver.awaitSpawnEntered();
    const additionsBeforeSpawnSettles = observed.addCalls();
    const timersBeforeSpawnSettles = scheduler.timers.length;
    const handle = makeHandle(driver, 4699);
    handle.emitExit({ exitCode: 0 });
    const result = await pending;
    assertSuccess(result);
    assert.equal(additionsBeforeSpawnSettles, 1);
    assert.equal(timersBeforeSpawnSettles, 1);
    assert.equal(scheduler.timers[0].cancelCalls, 1);
    assert.equal(observed.removeCalls(), 1);
  });

  it('settles exactly once when exit precedes a later cancellation', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    const controller = new AbortController();
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' }, { signal: controller.signal });
    await driver.awaitSpawnEntered();
    const handle = makeHandle(driver, 4700);
    handle.pushStdout('ok');
    handle.emitExit({ exitCode: 0 });
    const result = await pending;
    assertSuccess(result);
    controller.abort();
    assert.equal(driver.terminateTreeCalls, 0);
    assert.equal(driver.verifySurvivorsCalls, 0);
  });

  it('removeAllListeners on an already-aborted signal is a no-op', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    const controller = new AbortController();
    controller.abort();
    const result = await adapter.execute({ family: 'repository_root', cwd: 'C:\\ws' }, { signal: controller.signal });
    assert.equal(result.termination, 'cancelled');
    assert.equal(driver.spawnCalls.length, 0);
  });
});

describe('GitCommandAdapter no raw stderr leakage', () => {
  it('rejects invalid requests with a stable message containing no request data', async () => {
    const adapter = new GitCommandAdapter({ driver: new MockProcessDriver() });
    const error = await adapter
      .execute({
        family: 'bounded_diff',
        cwd: 'C:\\ws',
        // @ts-expect-error invalid base commit
        baseCommitSha: '../../etc/passwd',
        workspacePathFromRepositoryRoot: '',
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('../'));
    assert.doesNotMatch(error.message, /etc/);
    assert.ok(Buffer.byteLength(error.message) < 256);
  });

  it('adapter error paths never embed raw stderr', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    driver.spawnError = new Error('spawn git ENOENT with secret raw detail');
    const result = await adapter.execute({ family: 'repository_root', cwd: 'C:\\ws' });
    assertBoundedPublicResult(result);
  });
});

/** Probes whether a promise has settled without consuming its result. */
function settlementProbe(promise: Promise<unknown>): { readonly settled: () => boolean } {
  let isSettled = false;
  void promise.then(
    () => {
      isSettled = true;
    },
    () => {
      isSettled = true;
    },
  );
  return { settled: () => isSettled };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe('GitCommandAdapter awaited owned-tree cleanup proof', () => {
  it('timeout result stays pending until verifySurvivors reports proven complete', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    driver.holdNextSpawn();
    driver.holdVerifySurvivors();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const handle = await spawnAndArm(driver, 4800);
    scheduler.trigger();
    handle.emitExit({ exitCode: null, signal: 'SIGTERM' });
    const probe = settlementProbe(pending);
    await driver.awaitTerminateTreeEntered();
    await driver.awaitVerifySurvivorsEntered();
    await flushMicrotasks();
    assert.equal(probe.settled(), false, 'execute must await owned-tree cleanup proof');
    driver.settleVerifySurvivors('complete');
    const result = await pending;
    assert.equal(result.termination, 'timed_out');
    assert.equal(driver.terminateTreeCalls, 1);
    assert.equal(driver.verifySurvivorsCalls, 1);
  });

  it('cancellation result stays pending until verifySurvivors reports proven complete', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    const controller = new AbortController();
    driver.holdNextSpawn();
    driver.holdVerifySurvivors();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' }, { signal: controller.signal });
    await driver.awaitSpawnEntered();
    const handle = await spawnAndArm(driver, 4801);
    controller.abort();
    handle.emitExit({ exitCode: null, signal: 'SIGTERM' });
    const probe = settlementProbe(pending);
    await driver.awaitTerminateTreeEntered();
    await driver.awaitVerifySurvivorsEntered();
    await flushMicrotasks();
    assert.equal(probe.settled(), false);
    driver.settleVerifySurvivors('complete');
    const result = await pending;
    assert.equal(result.termination, 'cancelled');
  });

  it('output_limit result stays pending until verifySurvivors reports proven complete', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    driver.holdNextSpawn();
    driver.holdVerifySurvivors();
    const pending = adapter.execute({ family: 'repository_root', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const handle = await spawnAndArm(driver, 4802);
    handle.pushStdout(new Uint8Array(4097).fill(0x78));
    handle.emitExit({ exitCode: null, signal: 'SIGTERM' });
    const probe = settlementProbe(pending);
    await driver.awaitTerminateTreeEntered();
    await driver.awaitVerifySurvivorsEntered();
    await flushMicrotasks();
    assert.equal(probe.settled(), false);
    driver.settleVerifySurvivors('complete');
    const result = await pending;
    assert.equal(result.termination, 'output_limit');
  });
});

describe('GitCommandAdapter unproven cleanup', () => {
  async function timeoutWithVerification(
    configure: (driver: MockProcessDriver) => void,
    settle?: (driver: MockProcessDriver) => void,
  ): Promise<unknown> {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    configure(driver);
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' });
    const probe = settlementProbe(pending);
    void pending.catch(() => undefined); // observation only
    await driver.awaitSpawnEntered();
    const handle = await spawnAndArm(driver, 4810);
    scheduler.trigger();
    handle.emitExit({ exitCode: null, signal: 'SIGTERM' });
    await driver.awaitTerminateTreeEntered();
    await driver.awaitVerifySurvivorsEntered();
    await flushMicrotasks();
    if (settle !== undefined) settle(driver);
    const outcome = await pending.then(
      value => ({ kind: 'resolved' as const, value }),
      error => ({ kind: 'rejected' as const, error }),
    );
    assert.equal(probe.settled(), true);
    assert.equal(outcome.kind, 'rejected');
    const error = (outcome as { error: unknown }).error;
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'GIT_COMMAND_CLEANUP_UNPROVEN');
    return error;
  }

  it('survivors classification throws GIT_COMMAND_CLEANUP_UNPROVEN', async () => {
    await timeoutWithVerification(
      driver => {
        driver.holdVerifySurvivors();
      },
      driver => driver.settleVerifySurvivors('survivors'),
    );
  });

  it('unknown classification throws GIT_COMMAND_CLEANUP_UNPROVEN', async () => {
    await timeoutWithVerification(
      driver => {
        driver.holdVerifySurvivors();
      },
      driver => driver.settleVerifySurvivors('unknown'),
    );
  });

  it('complete without owned-tree-enumeration proof throws GIT_COMMAND_CLEANUP_UNPROVEN', async () => {
    await timeoutWithVerification(
      driver => {
        driver.verifyProofMode = 'bare';
      },
      undefined,
    );
  });

  it('rejected verification throws GIT_COMMAND_CLEANUP_UNPROVEN', async () => {
    await timeoutWithVerification(driver => {
      driver.verifyError = new Error('raw verifier detail that must never escape');
    });
  });

  it('terminateTree rejection does not prevent the final verify attempt', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    driver.terminateError = new Error('raw terminate detail that must never escape');
    driver.holdNextSpawn();
    driver.holdVerifySurvivors();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const handle = await spawnAndArm(driver, 4811);
    scheduler.trigger();
    handle.emitExit({ exitCode: null, signal: 'SIGTERM' });
    await driver.awaitTerminateTreeEntered();
    await driver.awaitVerifySurvivorsEntered();
    driver.settleVerifySurvivors('complete');
    const result = await pending;
    assert.equal(result.termination, 'timed_out');
    assert.equal(driver.terminateTreeCalls, 1);
    assert.equal(driver.verifySurvivorsCalls, 1, 'verify still attempted after terminate rejection');
  });

  it('cleanup runs exactly once under competing timeout and cancellation triggers', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    const controller = new AbortController();
    const observed = observeAbortSignal(controller);
    driver.holdNextSpawn();
    driver.holdVerifySurvivors();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' }, { signal: observed.signal });
    await driver.awaitSpawnEntered();
    const handle = await spawnAndArm(driver, 4812);
    controller.abort();
    scheduler.timers[0].callback();
    scheduler.trigger();
    controller.abort();
    handle.emitExit({ exitCode: null, signal: 'SIGTERM' });
    await driver.awaitTerminateTreeEntered();
    await driver.awaitVerifySurvivorsEntered();
    await flushMicrotasks();
    driver.settleVerifySurvivors('complete');
    const result = await pending;
    assert.equal(result.termination, 'cancelled');
    assert.equal(driver.terminateTreeCalls, 1, 'cleanup is exactly once');
    assert.equal(driver.verifySurvivorsCalls, 1, 'cleanup is exactly once');
    assert.equal(scheduler.timers[0].cancelled, true, 'timer cancelled exactly once');
    assert.equal(scheduler.timers[0].cancelCalls, 1, 'timer cancel is invoked exactly once');
    assert.equal(observed.removeCalls(), 1, 'abort listener is removed exactly once');
  });
});

/** Handle whose exit promise rejects with a raw driver error. */
class RejectingExitHandle extends MockNativeProcessHandle {
  readonly rawError = new Error('raw waitExit failure detail that must never escape');

  override waitExit(): Promise<never> {
    this.endStreams();
    return Promise.reject(this.rawError);
  }
}

describe('GitCommandAdapter IO failure', () => {
  it('waitExit rejection awaits proven cleanup then throws only GIT_COMMAND_IO_FAILED', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    driver.holdNextSpawn();
    driver.holdVerifySurvivors();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' });
    const observed = pending.then(
      value => ({ kind: 'resolved' as const, value }),
      error => ({ kind: 'rejected' as const, error }),
    );
    await driver.awaitSpawnEntered();
    const rejecting = new RejectingExitHandle(4820, 'git');
    driver.settleSpawnSuccess(rejecting);
    await flushMicrotasks();
    await driver.awaitTerminateTreeEntered();
    await driver.awaitVerifySurvivorsEntered();
    const probe = settlementProbe(observed);
    await flushMicrotasks();
    assert.equal(probe.settled(), false, 'IO failure must await cleanup proof');
    driver.settleVerifySurvivors('complete');
    const outcome = await observed;
    assert.equal(outcome.kind, 'rejected');
    const error = (outcome as { error: unknown }).error;
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'GIT_COMMAND_IO_FAILED');
    assert.doesNotMatch(error.message, /raw/);
    assert.equal(driver.terminateTreeCalls, 1);
    assert.equal(driver.verifySurvivorsCalls, 1);
  });

  it('unproven cleanup after IO failure yields GIT_COMMAND_CLEANUP_UNPROVEN', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    driver.verifyError = new Error('verifier raw detail');
    driver.holdNextSpawn();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' });
    const observed = pending.then(
      value => ({ kind: 'resolved' as const, value }),
      error => ({ kind: 'rejected' as const, error }),
    );
    await driver.awaitSpawnEntered();
    const rejecting = new RejectingExitHandle(4821, 'git');
    driver.settleSpawnSuccess(rejecting);
    await flushMicrotasks();
    const outcome = await observed;
    assert.equal(outcome.kind, 'rejected');
    const error = (outcome as { error: unknown }).error;
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'GIT_COMMAND_CLEANUP_UNPROVEN');
  });

  for (const failure of ['waitExit', 'stdout', 'stderr'] as const) {
    it(`${failure} rejection winning first awaits proof then throws only GIT_COMMAND_IO_FAILED`, async () => {
      const driver = new MockProcessDriver();
      const { adapter } = createAdapter(driver);
      driver.holdNextSpawn();
      driver.holdVerifySurvivors();
      const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' });
      const observed = pending.then(
        value => ({ kind: 'resolved' as const, value }),
        error => ({ kind: 'rejected' as const, error }),
      );
      await driver.awaitSpawnEntered();
      const handle = new ControlledNativeProcessHandle(4830 + ['waitExit', 'stdout', 'stderr'].indexOf(failure));
      settleControlledSpawn(driver, handle);
      await flushMicrotasks();
      if (failure === 'waitExit') handle.rejectExit();
      if (failure === 'stdout') handle.rejectStdout();
      if (failure === 'stderr') handle.rejectStderr();
      await driver.awaitTerminateTreeEntered();
      await driver.awaitVerifySurvivorsEntered();
      const probe = settlementProbe(observed);
      await flushMicrotasks();
      assert.equal(probe.settled(), false, 'IO winner must await cleanup proof');
      driver.settleVerifySurvivors('complete');
      const outcome = await observed;
      assert.equal(outcome.kind, 'rejected');
      const error = (outcome as { error: unknown }).error;
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'GIT_COMMAND_IO_FAILED');
      assert.doesNotMatch(error.message, /raw controlled/);
      assert.equal(driver.terminateTreeCalls, 1);
      assert.equal(driver.verifySurvivorsCalls, 1);
    });
  }
});

describe('GitCommandAdapter preserves an earlier non-exit winner over late IO faults', () => {
  it('preserves timed_out when waitExit rejects later', async () => {
    const driver = new MockProcessDriver();
    const { adapter, scheduler } = createAdapter(driver);
    driver.holdNextSpawn();
    driver.holdVerifySurvivors();
    const pending = adapter.execute({ family: 'head_commit', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const handle = new ControlledNativeProcessHandle(4840);
    settleControlledSpawn(driver, handle);
    await flushMicrotasks();
    scheduler.trigger();
    await driver.awaitTerminateTreeEntered();
    handle.rejectExit();
    await driver.awaitVerifySurvivorsEntered();
    driver.settleVerifySurvivors('complete');
    const result = await pending;
    assert.equal(result.termination, 'timed_out');
  });

  it('preserves cancelled when stdout rejects later', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    const controller = new AbortController();
    driver.holdNextSpawn();
    driver.holdVerifySurvivors();
    const pending = adapter.execute(
      { family: 'head_commit', cwd: 'C:\\ws' },
      { signal: controller.signal },
    );
    await driver.awaitSpawnEntered();
    const handle = new ControlledNativeProcessHandle(4841);
    settleControlledSpawn(driver, handle);
    await flushMicrotasks();
    controller.abort();
    await driver.awaitTerminateTreeEntered();
    handle.rejectStdout();
    await driver.awaitVerifySurvivorsEntered();
    driver.settleVerifySurvivors('complete');
    const result = await pending;
    assert.equal(result.termination, 'cancelled');
  });

  it('preserves output_limit when stderr rejects later', async () => {
    const driver = new MockProcessDriver();
    const { adapter } = createAdapter(driver);
    driver.holdNextSpawn();
    driver.holdVerifySurvivors();
    const pending = adapter.execute({ family: 'repository_root', cwd: 'C:\\ws' });
    await driver.awaitSpawnEntered();
    const handle = new ControlledNativeProcessHandle(4842);
    settleControlledSpawn(driver, handle);
    await flushMicrotasks();
    handle.stdout.push(new Uint8Array(GIT_COMMAND_STDOUT_LIMITS_V1.repository_root + 1).fill(0x78));
    await driver.awaitTerminateTreeEntered();
    handle.rejectStderr();
    await driver.awaitVerifySurvivorsEntered();
    driver.settleVerifySurvivors('complete');
    const result = await pending;
    assert.equal(result.termination, 'output_limit');
    assert.equal(result.stdout.byteLength, GIT_COMMAND_STDOUT_LIMITS_V1.repository_root);
  });
});
