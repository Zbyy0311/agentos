import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { SurvivorVerification, TreeTerminationResult } from './driver.js';
import type { NativeIdentity } from './types.js';
import { boundedErrorDetail, type ProcessTreeController, type ProcessTreeHandle } from './platform-process-tree.js';

const HELPER_TIMEOUT_MS = 2_000;
const CLEANUP_DEADLINE_MS = 2_000;
const CLEANUP_POLL_MS = 25;
const MAX_HELPER_LINE = 16 * 1024;

/**
 * This helper owns one Windows Job Object for one native provider process.
 * It is intentionally a fixed script: the only dynamic input is a numeric
 * PID sent over stdin, so provider arguments never reach PowerShell parsing.
 */
const WINDOWS_JOB_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$null = Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public sealed class AgentOsJob : IDisposable
{
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_SET_QUOTA = 0x0100;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const int JobObjectBasicProcessIdListClass = 3;

    private readonly IntPtr handle;

    private AgentOsJob(IntPtr handle) { this.handle = handle; }

    public static AgentOsJob Attach(uint pid)
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) ThrowLastError();
        try
        {
            SetKillOnClose(job);
            var process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) ThrowLastError();
            try
            {
                if (!AssignProcessToJobObject(job, process)) ThrowLastError();
            }
            finally
            {
                CloseHandle(process);
            }
            return new AgentOsJob(job);
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
    }

    public ulong[] Members()
    {
        var size = 4096;
        for (var attempt = 0; attempt < 4; attempt++)
        {
            var buffer = Marshal.AllocHGlobal(size);
            try
            {
                uint required;
                if (QueryInformationJobObject(handle, JobObjectBasicProcessIdListClass, buffer, (uint)size, out required))
                {
                    var header = Marshal.PtrToStructure<JobObjectBasicProcessIdListHeader>(buffer);
                    var values = new List<ulong>();
                    var offset = Marshal.SizeOf<JobObjectBasicProcessIdListHeader>();
                    for (var index = 0; index < header.NumberOfProcessIdsInList; index++)
                    {
                        var value = unchecked((ulong)Marshal.ReadInt64(buffer, offset + index * sizeof(long)));
                        if (value > 0) values.Add(value);
                    }
                    values.Sort();
                    return values.ToArray();
                }
                if (required > size && required <= 1024 * 1024) { size = (int)required; continue; }
                ThrowLastError();
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        throw new InvalidOperationException("job-process-list-too-large");
    }

    public void Terminate()
    {
        if (!TerminateJobObject(handle, 1)) ThrowLastError();
    }

    public void Dispose()
    {
        if (handle != IntPtr.Zero) CloseHandle(handle);
    }

    private static void SetKillOnClose(IntPtr job)
    {
        var limits = new JobObjectExtendedLimitInformation
        {
            BasicLimitInformation = new JobObjectBasicLimitInformation
            {
                LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };
        var size = Marshal.SizeOf<JobObjectExtendedLimitInformation>();
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformationClass, buffer, (uint)size)) ThrowLastError();
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void ThrowLastError() { throw new Win32Exception(Marshal.GetLastWin32Error()); }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicProcessIdListHeader
    {
        public uint NumberOfAssignedProcesses;
        public uint NumberOfProcessIdsInList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public IntPtr MinimumWorkingSetSize;
        public IntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public IntPtr ProcessMemoryLimit;
        public IntPtr JobMemoryLimit;
        public IntPtr PeakProcessMemoryUsed;
        public IntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint infoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint infoLength, out uint returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
'@

function Reply([string] $value) {
  [Console]::Out.WriteLine($value)
  [Console]::Out.Flush()
}

$job = $null
Reply 'ready'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    if ($line -match '^attach\|([0-9]+)$') {
      if ($null -ne $job) { throw 'job-already-attached' }
      $job = [AgentOsJob]::Attach([uint32]$Matches[1])
      Reply 'ok|attach'
    } elseif ($line -eq 'members') {
      if ($null -eq $job) { throw 'job-not-attached' }
      Reply ('members|' + (($job.Members() | Sort-Object -Unique) -join ','))
    } elseif ($line -eq 'terminate') {
      if ($null -eq $job) { throw 'job-not-attached' }
      $job.Terminate()
      Reply 'ok|terminate'
    } elseif ($line -eq 'close') {
      if ($null -ne $job) { $job.Dispose(); $job = $null }
      Reply 'ok|close'
      break
    } else {
      throw 'invalid-command'
    }
  } catch {
    $detail = $_.Exception.Message -replace '[\r\n|]', ' '
    if ($detail.Length -gt 200) { $detail = $detail.Substring(0, 200) }
    Reply ('error|' + $detail)
  }
}
if ($null -ne $job) { $job.Dispose() }
`;

class LineReader {
  private buffer = '';
  private readonly waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  private failure: Error | null = null;

  constructor(stream: Readable) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => this.push(String(chunk)));
    stream.on('error', error => this.fail(error instanceof Error ? error : new Error(String(error))));
    stream.on('end', () => this.fail(new Error('windows-tree-helper-ended')));
  }

  next(): Promise<string> {
    const newline = this.buffer.indexOf('\n');
    if (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      return Promise.resolve(line);
    }
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_HELPER_LINE) {
      this.fail(new Error('windows-tree-helper-line-too-large'));
      return;
    }
    while (this.waiters.length > 0) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const waiter = this.waiters.shift();
      if (waiter === undefined) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      waiter.resolve(line);
    }
  }

  fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

interface WindowsTreeState {
  readonly session: WindowsJobSession;
  cleanupRequested: boolean;
  closedVerification?: SurvivorVerification;
}

export interface WindowsProcessTreeOptions {
  readonly shell?: string;
}

class WindowsJobSession {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly helper: ChildProcess,
    private readonly reader: LineReader,
  ) {}

  static async start(shell: string): Promise<WindowsJobSession> {
    const helper = spawn(shell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_JOB_HELPER_SCRIPT,
    ], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const reader = new LineReader(helper.stdout!);
    helper.once('error', error => reader.fail(error instanceof Error ? error : new Error(String(error))));
    let stderr = '';
    helper.stderr?.setEncoding('utf8');
    helper.stderr?.on('data', chunk => {
      if (stderr.length < MAX_HELPER_LINE) stderr += String(chunk).slice(0, MAX_HELPER_LINE - stderr.length);
    });
    const session = new WindowsJobSession(helper, reader);
    let ready: string;
    try {
      ready = await withTimeout(reader.next(), HELPER_TIMEOUT_MS, 'windows-tree-helper-timeout');
    } catch (error) {
      const detail = stderr.replace(/[\r\n|]/g, ' ').trim().slice(0, 400);
      await session.close();
      throw new Error(detail.length > 0 ? `${boundedErrorDetail(error, 'windows-tree-helper-start-failed')}:${detail}` : boundedErrorDetail(error, 'windows-tree-helper-start-failed'));
    }
    if (ready !== 'ready') throw new Error('windows-tree-helper-not-ready');
    return session;
  }

  request(command: string): Promise<string> {
    const request = this.queue.then(() => this.requestNow(command));
    this.queue = request.then(() => undefined, () => undefined);
    return request;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.request('close'); } catch { /* helper failure is already fail-closed */ }
    try { this.helper.stdin?.end(); } catch { /* best effort */ }
    if (this.helper.exitCode === null) this.helper.kill();
  }

  private async requestNow(command: string): Promise<string> {
    if (this.closed && command !== 'close') throw new Error('windows-tree-helper-closed');
    this.helper.stdin?.write(`${command}\n`);
    const response = await withTimeout(this.reader.next(), HELPER_TIMEOUT_MS, 'windows-tree-helper-response-timeout');
    if (response.startsWith('error|')) throw new Error(response.slice('error|'.length));
    return response;
  }
}

function parseMembers(response: string): readonly number[] {
  if (!response.startsWith('members|')) throw new Error('windows-tree-helper-invalid-members-response');
  const raw = response.slice('members|'.length);
  if (raw.length === 0) return [];
  const values = raw.split(',').map(value => Number(value));
  if (values.some(value => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('windows-tree-helper-invalid-pid');
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

export class WindowsProcessTreeController implements ProcessTreeController {
  private readonly shell: string;

  constructor(options: WindowsProcessTreeOptions = {}) {
    this.shell = options.shell ?? (process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe');
  }

  async attach(identity: NativeIdentity): Promise<ProcessTreeHandle> {
    let session: WindowsJobSession | undefined;
    try {
      session = await WindowsJobSession.start(this.shell);
      const response = await session.request(`attach|${identity.pid}`);
      if (response !== 'ok|attach') throw new Error('windows-tree-helper-attach-failed');
      const state: WindowsTreeState = { session, cleanupRequested: false };
      return { platform: 'windows', rootPid: identity.pid, state };
    } catch (error) {
      await session?.close();
      return { platform: 'unavailable', rootPid: identity.pid, state: boundedErrorDetail(error, 'windows-tree-unavailable') };
    }
  }

  async terminateTree(handle: ProcessTreeHandle): Promise<TreeTerminationResult> {
    if (handle.platform !== 'windows') return { classification: 'unknown', attemptedMembers: [], errors: ['windows-handle-mismatch'] };
    const state = handle.state as WindowsTreeState;
    if (state.closedVerification?.classification === 'complete') {
      return { classification: 'complete', attemptedMembers: [], errors: [] };
    }
    let members: readonly number[] = [];
    try {
      members = parseMembers(await state.session.request('members'));
      state.cleanupRequested = true;
      const response = await state.session.request('terminate');
      if (response !== 'ok|terminate') throw new Error('windows-tree-helper-terminate-failed');
      return { classification: 'complete', attemptedMembers: members, errors: [] };
    } catch (error) {
      return { classification: 'unknown', attemptedMembers: members, errors: [boundedErrorDetail(error, 'windows-tree-termination-failed')] };
    }
  }

  async verifySurvivors(handle: ProcessTreeHandle): Promise<SurvivorVerification> {
    if (handle.platform !== 'windows') return { classification: 'unknown', knownPids: [] };
    const state = handle.state as WindowsTreeState;
    if (state.closedVerification !== undefined) return state.closedVerification;
    const deadline = Date.now() + (state.cleanupRequested ? CLEANUP_DEADLINE_MS : 0);
    while (true) {
      try {
        const members = parseMembers(await state.session.request('members'));
        if (members.length === 0) {
          const verification: SurvivorVerification = {
            classification: 'complete',
            knownPids: [],
            proof: { kind: 'owned-tree-enumeration' },
          };
          state.closedVerification = verification;
          await state.session.close();
          return verification;
        }
        if (!state.cleanupRequested || Date.now() >= deadline) return { classification: 'survivors', knownPids: members };
      } catch {
        if (state.closedVerification !== undefined) return state.closedVerification;
        return { classification: 'unknown', knownPids: [] };
      }
      await new Promise(resolve => setTimeout(resolve, CLEANUP_POLL_MS));
    }
  }

  async dispose(handle: ProcessTreeHandle): Promise<void> {
    if (handle.platform !== 'windows') return;
    const state = handle.state as WindowsTreeState;
    await state.session.close();
  }
}
