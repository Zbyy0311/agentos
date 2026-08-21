import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { SurvivorVerification, TreeTerminationResult } from './driver.js';
import type { NativeIdentity, ValidatedLaunch } from './types.js';
import {
  boundedErrorDetail,
  type OwnedSpawnResult,
  type ProcessTreeController,
  type ProcessTreeHandle,
} from './platform-process-tree.js';

const READY_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 5_000;
const CLEANUP_DEADLINE_MS = 2_000;
const CLEANUP_POLL_MS = 25;
const MAX_DIAGNOSTIC = 4 * 1024;
const MAX_LAUNCH_SPEC_BASE64 = 1_500_000;
const FRAME_CONTROL = 0;
const FRAME_STDOUT = 1;
const FRAME_STDERR = 2;

/**
 * Deterministic ownership evidence for tests and audits: 'assigned' is
 * emitted while the provider's primary thread is still suspended, so no
 * provider-controlled instruction can have executed before it fires.
 */
export interface WindowsOwnershipTraceEvent {
  readonly kind: 'assigned' | 'launched' | 'exit';
  readonly pid: number;
  readonly at: number;
}

/**
 * Fixed helper script. The only dynamic input ever received is a bounded
 * base64-encoded JSON launch spec on stdin; provider arguments, environment
 * and paths are never interpolated into PowerShell source text.
 *
 * Ownership sequence is atomic-at-creation: CreateProcessW(CREATE_SUSPENDED)
 * -> CreateJobObject(kill-on-close) -> AssignProcessToJobObject -> 'assigned'
 * -> ResumeThread. Provider code cannot execute before Job assignment.
 *
 * Provider stdout/stderr bytes and control messages travel as framed chunks
 * over a dedicated named pipe: [channel:1][length:4 LE][payload]. Channel 0
 * carries UTF-8 control lines, channels 1/2 carry raw provider bytes. The
 * 'exit|pid|code' control line is sent only after the exit monitor observed
 * process termination and both stream pumps drained, so every provider byte
 * strictly precedes the exit frame on the single ordered channel.
 */
const WINDOWS_JOB_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $null = Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

[DataContract]
public sealed class AgentOsLaunchSpec
{
    [DataMember(Name = "executable")] public string Executable;
    [DataMember(Name = "args")] public string[] Args;
    [DataMember(Name = "cwd")] public string Cwd;
    [DataMember(Name = "env")] public Dictionary<string, string> Env;
}

public sealed class AgentOsFrameWriter
{
    private readonly Stream stream;
    private readonly object sync = new object();

    public AgentOsFrameWriter(Stream stream) { this.stream = stream; }

    public void WriteLine(string line)
    {
        WriteFrame(0, Encoding.UTF8.GetBytes(line + "\n"));
    }

    public void WriteData(byte channel, byte[] buffer, int count)
    {
        if (count <= 0) return;
        var payload = new byte[count];
        Buffer.BlockCopy(buffer, 0, payload, 0, count);
        WriteFrame(channel, payload);
    }

    private void WriteFrame(byte channel, byte[] payload)
    {
        lock (sync)
        {
            var header = new byte[5];
            header[0] = channel;
            header[1] = (byte)(payload.Length & 0xFF);
            header[2] = (byte)((payload.Length >> 8) & 0xFF);
            header[3] = (byte)((payload.Length >> 16) & 0xFF);
            header[4] = (byte)((payload.Length >> 24) & 0xFF);
            stream.Write(header, 0, header.Length);
            if (payload.Length > 0) stream.Write(payload, 0, payload.Length);
            stream.Flush();
        }
    }
}

public sealed class AgentOsJob : IDisposable
{
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_SET_QUOTA = 0x0100;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const int JobObjectBasicProcessIdListClass = 3;

    private IntPtr handle;

    private AgentOsJob(IntPtr handle) { this.handle = handle; }

    public static AgentOsJob Create()
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) ThrowLastError();
        try
        {
            SetKillOnClose(job);
            return new AgentOsJob(job);
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
    }

    public static AgentOsJob Attach(uint pid)
    {
        var job = Create();
        var process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero)
        {
            job.Dispose();
            ThrowLastError();
        }
        try
        {
            job.Assign(process);
        }
        finally
        {
            CloseHandle(process);
        }
        return job;
    }

    public void Assign(IntPtr processHandle)
    {
        if (!AssignProcessToJobObject(handle, processHandle)) ThrowLastError();
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
        if (handle != IntPtr.Zero)
        {
            CloseHandle(handle);
            handle = IntPtr.Zero;
        }
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

    internal static void ThrowLastError() { throw new Win32Exception(Marshal.GetLastWin32Error()); }

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
    internal static extern bool CloseHandle(IntPtr handle);
}

public sealed class AgentOsOwnedProcess : IDisposable
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;

    private readonly AgentOsFrameWriter writer;
    private readonly ManualResetEvent exitFrameSent = new ManualResetEvent(false);
    private IntPtr processHandle;
    private IntPtr threadHandle;
    private IntPtr readOut;
    private IntPtr readErr;
    private Thread pumpOut;
    private Thread pumpErr;

    public readonly int Pid;

    private AgentOsOwnedProcess(int pid, IntPtr processHandle, IntPtr threadHandle, IntPtr readOut, IntPtr readErr, AgentOsFrameWriter writer)
    {
        Pid = pid;
        this.processHandle = processHandle;
        this.threadHandle = threadHandle;
        this.readOut = readOut;
        this.readErr = readErr;
        this.writer = writer;
    }

    public IntPtr Handle { get { return processHandle; } }

    public static AgentOsOwnedProcess LaunchSuspended(AgentOsLaunchSpec spec, AgentOsFrameWriter writer)
    {
        var sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        sa.bInheritHandle = true;
        sa.lpSecurityDescriptor = IntPtr.Zero;

        IntPtr readOut = IntPtr.Zero;
        IntPtr writeOut = IntPtr.Zero;
        IntPtr readErr = IntPtr.Zero;
        IntPtr writeErr = IntPtr.Zero;
        IntPtr nul = new IntPtr(-1);
        try
        {
            if (!CreatePipe(out readOut, out writeOut, ref sa, 0)) AgentOsJob.ThrowLastError();
            if (!SetHandleInformation(readOut, HANDLE_FLAG_INHERIT, 0)) AgentOsJob.ThrowLastError();
            if (!CreatePipe(out readErr, out writeErr, ref sa, 0)) AgentOsJob.ThrowLastError();
            if (!SetHandleInformation(readErr, HANDLE_FLAG_INHERIT, 0)) AgentOsJob.ThrowLastError();
            nul = CreateFileW("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref sa, OPEN_EXISTING, 0, IntPtr.Zero);
            if (nul == new IntPtr(-1)) AgentOsJob.ThrowLastError();

            var si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            si.dwFlags = STARTF_USESTDHANDLES;
            si.hStdInput = nul;
            si.hStdOutput = writeOut;
            si.hStdError = writeErr;

            byte[] envBytes = BuildEnvironmentBlock(spec.Env);
            var envPin = GCHandle.Alloc(envBytes, GCHandleType.Pinned);
            var pi = new PROCESS_INFORMATION();
            bool created;
            try
            {
                var commandLine = new StringBuilder(BuildCommandLine(spec));
                created = CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, envPin.AddrOfPinnedObject(),
                    string.IsNullOrEmpty(spec.Cwd) ? null : spec.Cwd, ref si, out pi);
            }
            finally
            {
                envPin.Free();
            }
            if (!created)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return new AgentOsOwnedProcess(unchecked((int)pi.dwProcessId), pi.hProcess, pi.hThread, readOut, readErr, writer);
        }
        finally
        {
            if (writeOut != IntPtr.Zero) AgentOsJob.CloseHandle(writeOut);
            if (writeErr != IntPtr.Zero) AgentOsJob.CloseHandle(writeErr);
            if (nul != new IntPtr(-1)) AgentOsJob.CloseHandle(nul);
        }
    }

    public void Resume()
    {
        if (ResumeThread(threadHandle) == 0xFFFFFFFF) AgentOsJob.ThrowLastError();
        AgentOsJob.CloseHandle(threadHandle);
        threadHandle = IntPtr.Zero;
        pumpOut = new Thread(delegate() { Pump(readOut, 1); });
        pumpErr = new Thread(delegate() { Pump(readErr, 2); });
        pumpOut.IsBackground = true;
        pumpErr.IsBackground = true;
        pumpOut.Start();
        pumpErr.Start();
        var monitor = new Thread(MonitorExit);
        monitor.IsBackground = true;
        monitor.Start();
    }

    public void Terminate()
    {
        if (!TerminateProcess(processHandle, 1)) AgentOsJob.ThrowLastError();
    }

    public bool WaitExitFrame(int milliseconds)
    {
        return exitFrameSent.WaitOne(milliseconds);
    }

    private void Pump(IntPtr readHandle, byte channel)
    {
        try
        {
            using (var stream = new FileStream(new SafeFileHandle(readHandle, false), FileAccess.Read, 32768))
            {
                var buffer = new byte[32768];
                while (true)
                {
                    var read = stream.Read(buffer, 0, buffer.Length);
                    if (read <= 0) break;
                    writer.WriteData(channel, buffer, read);
                }
            }
        }
        catch
        {
            // Teardown closes the pipe reads; late provider bytes are dropped.
        }
    }

    private void MonitorExit()
    {
        try
        {
            WaitForSingleObject(processHandle, INFINITE);
            if (pumpOut != null) pumpOut.Join(2000);
            if (pumpErr != null) pumpErr.Join(2000);
            uint code = 0;
            GetExitCodeProcess(processHandle, out code);
            writer.WriteLine("exit|" + Pid + "|" + code);
        }
        catch
        {
            // The session teardown path resolves exit evidence fail-closed.
        }
        finally
        {
            exitFrameSent.Set();
        }
    }

    public void Dispose()
    {
        if (readOut != IntPtr.Zero) { AgentOsJob.CloseHandle(readOut); readOut = IntPtr.Zero; }
        if (readErr != IntPtr.Zero) { AgentOsJob.CloseHandle(readErr); readErr = IntPtr.Zero; }
        if (threadHandle != IntPtr.Zero) { AgentOsJob.CloseHandle(threadHandle); threadHandle = IntPtr.Zero; }
        if (processHandle != IntPtr.Zero) { AgentOsJob.CloseHandle(processHandle); processHandle = IntPtr.Zero; }
    }

    private static string QuoteArg(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return arg;
        var sb = new StringBuilder();
        sb.Append('"');
        var slashes = 0;
        foreach (var c in arg)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"')
            {
                sb.Append('\\', slashes * 2 + 1);
                sb.Append('"');
                slashes = 0;
                continue;
            }
            if (slashes > 0) { sb.Append('\\', slashes); slashes = 0; }
            sb.Append(c);
        }
        if (slashes > 0) sb.Append('\\', slashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    private static string BuildCommandLine(AgentOsLaunchSpec spec)
    {
        var sb = new StringBuilder(QuoteArg(spec.Executable));
        if (spec.Args != null)
        {
            foreach (var arg in spec.Args)
            {
                sb.Append(' ');
                sb.Append(QuoteArg(arg ?? string.Empty));
            }
        }
        return sb.ToString();
    }

    // libuv-compatible bootstrap variables: a missing SystemRoot otherwise
    // crashes Windows children during BCrypt CSPRNG initialization.
    private static readonly string[] BootstrapVariables = { "PATH", "SYSTEMROOT", "TEMP", "USERPROFILE" };

    private static byte[] BuildEnvironmentBlock(Dictionary<string, string> env)
    {
        var entries = new List<string>();
        var keys = new List<string>();
        if (env != null)
        {
            foreach (var pair in env)
            {
                if (pair.Key.Length == 0 || pair.Key.IndexOf('=') >= 0) throw new InvalidOperationException("launch-env-invalid-key");
                entries.Add(pair.Key + "=" + (pair.Value ?? string.Empty));
                keys.Add(pair.Key);
            }
        }
        foreach (var name in BootstrapVariables)
        {
            var present = false;
            foreach (var key in keys)
            {
                if (string.Equals(key, name, StringComparison.OrdinalIgnoreCase)) { present = true; break; }
            }
            if (!present)
            {
                var value = Environment.GetEnvironmentVariable(name);
                if (value != null) entries.Add(name + "=" + value);
            }
        }
        entries.Sort(StringComparer.OrdinalIgnoreCase);
        var sb = new StringBuilder();
        foreach (var entry in entries)
        {
            sb.Append(entry);
            sb.Append('\0');
        }
        sb.Append('\0');
        return Encoding.Unicode.GetBytes(sb.ToString());
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, ref SECURITY_ATTRIBUTES lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
}

public static class AgentOsJobServer
{
    private static string Sanitize(string message)
    {
        var detail = (message == null || message.Length == 0) ? "unknown" : message.Replace('\r', ' ').Replace('\n', ' ').Replace('|', ' ').Trim();
        if (detail.Length > 200) detail = detail.Substring(0, 200);
        return detail;
    }

    private static AgentOsLaunchSpec ParseSpec(string base64)
    {
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            throw new InvalidOperationException("launch-spec-invalid-base64");
        }
        if (bytes.Length == 0 || bytes.Length > 1048576) throw new InvalidOperationException("launch-spec-too-large");
        var serializer = new DataContractJsonSerializer(typeof(AgentOsLaunchSpec));
        using (var stream = new MemoryStream(bytes))
        {
            var spec = (AgentOsLaunchSpec)serializer.ReadObject(stream);
            if (spec == null || string.IsNullOrEmpty(spec.Executable)) throw new InvalidOperationException("launch-spec-invalid");
            return spec;
        }
    }

    public static void Run()
    {
        var pipeName = Environment.GetEnvironmentVariable("AGENTOS_JOB_CONTROL_PIPE");
        if (string.IsNullOrEmpty(pipeName)) throw new InvalidOperationException("missing-control-pipe");
        AgentOsJob job = null;
        AgentOsOwnedProcess owned = null;
        using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out))
        {
            pipe.Connect(30000);
            var writer = new AgentOsFrameWriter(pipe);
            writer.WriteLine("ready");
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                var closing = false;
                try
                {
                    if (line.StartsWith("launch|"))
                    {
                        if (owned != null) throw new InvalidOperationException("launch-already-used");
                        var spec = ParseSpec(line.Substring("launch|".Length));
                        var newJob = AgentOsJob.Create();
                        AgentOsOwnedProcess created = null;
                        try
                        {
                            created = AgentOsOwnedProcess.LaunchSuspended(spec, writer);
                            newJob.Assign(created.Handle);
                        }
                        catch
                        {
                            if (created != null) created.Dispose();
                            newJob.Dispose();
                            throw;
                        }
                        job = newJob;
                        owned = created;
                        writer.WriteLine("assigned|" + owned.Pid);
                        owned.Resume();
                        writer.WriteLine("launched|" + owned.Pid);
                    }
                    else if (line.StartsWith("attach|"))
                    {
                        if (job != null) throw new InvalidOperationException("job-already-attached");
                        uint attachPid;
                        if (!uint.TryParse(line.Substring("attach|".Length), out attachPid)) throw new InvalidOperationException("invalid-attach-pid");
                        job = AgentOsJob.Attach(attachPid);
                        writer.WriteLine("ok|attach");
                    }
                    else if (line == "members")
                    {
                        if (job == null) throw new InvalidOperationException("job-not-attached");
                        var members = job.Members();
                        var values = new List<string>();
                        foreach (var member in members) values.Add(member.ToString());
                        writer.WriteLine("members|" + string.Join(",", values.ToArray()));
                    }
                    else if (line == "terminate")
                    {
                        if (job == null) throw new InvalidOperationException("job-not-attached");
                        job.Terminate();
                        writer.WriteLine("ok|terminate");
                    }
                    else if (line == "stoproot")
                    {
                        if (owned == null) throw new InvalidOperationException("no-owned-process");
                        owned.Terminate();
                        writer.WriteLine("ok|stoproot");
                    }
                    else if (line == "close")
                    {
                        writer.WriteLine("ok|close");
                        closing = true;
                    }
                    else
                    {
                        throw new InvalidOperationException("invalid-command");
                    }
                }
                catch (Exception error)
                {
                    writer.WriteLine("error|" + Sanitize(error.Message));
                }
                if (closing) break;
            }
        }
        // Disposing a kill-on-close Job reaps any remaining owned survivors;
        // wait for the exit frame so waitExit evidence is delivered first.
        if (job != null) { job.Dispose(); job = null; }
        if (owned != null) { owned.WaitExitFrame(1500); owned.Dispose(); }
    }
}
'@ -ReferencedAssemblies 'System', 'System.Core', 'System.Runtime.Serialization', 'System.Xml'
  [AgentOsJobServer]::Run()
} catch {
  $detail = $_.Exception.Message -replace '[\r\n|]', ' '
  if ($detail.Length -gt 400) { $detail = $detail.Substring(0, 400) }
  [Console]::Error.WriteLine('helper-fatal|' + $detail)
  exit 1
}
`;

let pipeSequence = 0;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

interface OwnedExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

class ControlLineQueue {
  private lines: string[] = [];
  private waiter: { resolve: (line: string) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;

  push(line: string): void {
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve(line);
      return;
    }
    this.lines.push(line);
  }

  fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(error);
    }
  }

  next(): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
}

/** Demultiplexes the framed helper channel: control lines + raw byte streams. */
class FrameDemux {
  private buffer: Buffer = Buffer.alloc(0);
  private controlText = '';

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onData: (channel: number, payload: Buffer) => void,
  ) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 5) {
      const channel = this.buffer[0];
      const length = this.buffer.readUInt32LE(1);
      if (this.buffer.length < 5 + length) return;
      const payload = Buffer.from(this.buffer.subarray(5, 5 + length));
      this.buffer = this.buffer.subarray(5 + length);
      if (channel === FRAME_CONTROL) {
        this.controlText += payload.toString('utf8');
        let newline = this.controlText.indexOf('\n');
        while (newline >= 0) {
          const line = this.controlText.slice(0, newline).replace(/\r$/, '');
          this.controlText = this.controlText.slice(newline + 1);
          this.onLine(line);
          newline = this.controlText.indexOf('\n');
        }
      } else {
        this.onData(channel, payload);
      }
    }
  }
}

interface WindowsTreeState {
  readonly session: WindowsJobSession;
  cleanupRequested: boolean;
  closedVerification?: SurvivorVerification;
}

export interface WindowsProcessTreeOptions {
  readonly shell?: string;
  readonly trace?: (event: WindowsOwnershipTraceEvent) => void;
}

class WindowsJobSession {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly lines = new ControlLineQueue();
  private readonly exitResolve: (exit: OwnedExit) => void;
  private exitSettled = false;
  rootExited = false;
  readonly exitObserved: Promise<OwnedExit>;
  readonly stdout = new PassThrough({ highWaterMark: 64 * 1024 });
  readonly stderr = new PassThrough({ highWaterMark: 64 * 1024 });

  private constructor(
    private readonly helper: ChildProcess,
    private readonly server: Server,
    private readonly trace?: (event: WindowsOwnershipTraceEvent) => void,
  ) {
    let resolver: (exit: OwnedExit) => void = () => undefined;
    this.exitObserved = new Promise<OwnedExit>(resolve => { resolver = resolve; });
    this.exitResolve = resolver;
  }

  static async start(shell: string, trace?: (event: WindowsOwnershipTraceEvent) => void): Promise<WindowsJobSession> {
    const pipeName = 'agentos-job-' + process.pid + '-' + (pipeSequence++) + '-' + randomBytes(6).toString('hex');
    const pipePath = '\\\\.\\pipe\\' + pipeName;
    const server = createServer();
    const connection = new Promise<Socket>((resolve, reject) => {
      server.once('connection', resolve);
      server.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipePath, () => resolve());
    });
    const helper = spawn(shell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_JOB_HELPER_SCRIPT,
    ], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AGENTOS_JOB_CONTROL_PIPE: pipeName },
    });
    let diagnostics = '';
    const capture = (chunk: unknown): void => {
      if (diagnostics.length < MAX_DIAGNOSTIC) diagnostics += String(chunk).slice(0, MAX_DIAGNOSTIC - diagnostics.length);
    };
    helper.stdout?.setEncoding('utf8');
    helper.stdout?.on('data', capture);
    helper.stderr?.setEncoding('utf8');
    helper.stderr?.on('data', capture);
    const helperFailure = new Promise<Socket>((_, reject) => {
      helper.once('error', () => reject(new Error('windows-tree-helper-spawn-failed')));
      helper.once('exit', code => reject(new Error('windows-tree-helper-exited-' + String(code))));
    });
    try {
      const socket = await withTimeout(Promise.race([connection, helperFailure]), READY_TIMEOUT_MS, 'windows-tree-helper-connect-timeout');
      const session = new WindowsJobSession(helper, server, trace);
      const demux = new FrameDemux(
        line => session.handleLine(line),
        (channel, payload) => session.handleData(channel, payload),
      );
      socket.on('data', chunk => demux.push(chunk));
      socket.on('error', error => session.fail(error instanceof Error ? error : new Error(String(error))));
      socket.on('close', () => session.fail(new Error('windows-tree-helper-closed')));
      helper.once('error', error => session.fail(error instanceof Error ? error : new Error(String(error))));
      helper.once('exit', () => session.fail(new Error('windows-tree-helper-exited')));
      const ready = await withTimeout(session.lines.next(), READY_TIMEOUT_MS, 'windows-tree-helper-ready-timeout');
      if (ready !== 'ready') throw new Error('windows-tree-helper-not-ready');
      return session;
    } catch (error) {
      server.close();
      try { helper.stdin?.end(); } catch { /* best effort */ }
      if (helper.exitCode === null) helper.kill();
      const detail = diagnostics.replace(/[\r\n|]/g, ' ').trim().slice(0, 400);
      const base = boundedErrorDetail(error, 'windows-tree-helper-start-failed');
      throw new Error(detail.length > 0 ? base + ':' + detail : base);
    }
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
    if (this.helper.exitCode === null) {
      const exited = new Promise<void>(resolve => this.helper.once('exit', () => resolve()));
      await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 1_000))]);
      if (this.helper.exitCode === null) this.helper.kill();
    }
    this.server.close();
  }

  private async requestNow(command: string): Promise<string> {
    if (this.closed && command !== 'close') throw new Error('windows-tree-helper-closed');
    this.helper.stdin?.write(command + '\n');
    const response = await withTimeout(this.lines.next(), COMMAND_TIMEOUT_MS, 'windows-tree-helper-response-timeout');
    if (response.startsWith('error|')) throw new Error(response.slice('error|'.length));
    return response;
  }

  private handleLine(line: string): void {
    if (line.startsWith('assigned|')) {
      const pid = Number(line.slice('assigned|'.length));
      if (Number.isSafeInteger(pid) && pid > 0) this.trace?.({ kind: 'assigned', pid, at: Date.now() });
      return;
    }
    if (line.startsWith('exit|')) {
      const parts = line.split('|');
      const pid = Number(parts[1]);
      const exitCode = Number(parts[2]);
      this.rootExited = true;
      if (Number.isSafeInteger(pid) && pid > 0) this.trace?.({ kind: 'exit', pid, at: Date.now() });
      this.settleExit({ exitCode: Number.isSafeInteger(exitCode) ? exitCode : null, signal: null });
      return;
    }
    this.lines.push(line);
  }

  private handleData(channel: number, payload: Buffer): void {
    if (channel === FRAME_STDOUT && !this.stdout.writableEnded) this.stdout.write(payload);
    if (channel === FRAME_STDERR && !this.stderr.writableEnded) this.stderr.write(payload);
  }

  private settleExit(exit: OwnedExit): void {
    if (this.exitSettled) return;
    this.exitSettled = true;
    this.exitResolve(exit);
    if (!this.stdout.writableEnded) this.stdout.end();
    if (!this.stderr.writableEnded) this.stderr.end();
  }

  private fail(error: Error): void {
    this.lines.fail(error);
    this.settleExit({ exitCode: null, signal: null });
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

function parseLaunchedPid(response: string): number {
  if (!response.startsWith('launched|')) throw new Error('windows-tree-helper-launch-failed');
  const pid = Number(response.slice('launched|'.length));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('windows-tree-helper-invalid-pid');
  return pid;
}

export class WindowsProcessTreeController implements ProcessTreeController {
  private readonly shell: string;
  private readonly trace?: (event: WindowsOwnershipTraceEvent) => void;

  constructor(options: WindowsProcessTreeOptions = {}) {
    this.shell = options.shell ?? (process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe');
    this.trace = options.trace;
  }

  /**
   * Atomic owned spawn: the provider is created suspended, placed inside the
   * AgentOS-owned Job Object while still unable to execute, and only then
   * resumed. No provider-controlled instruction can execute before ownership.
   */
  async spawnOwned(launch: ValidatedLaunch): Promise<OwnedSpawnResult> {
    const spec = {
      executable: launch.executable,
      args: [...launch.args],
      cwd: launch.cwd,
      env: { ...launch.env },
    };
    const encoded = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
    if (encoded.length > MAX_LAUNCH_SPEC_BASE64) throw new Error('windows-launch-spec-too-large');
    const session = await WindowsJobSession.start(this.shell, this.trace);
    let pid: number;
    try {
      const response = await session.request('launch|' + encoded);
      pid = parseLaunchedPid(response);
    } catch (error) {
      await session.close();
      throw error;
    }
    this.trace?.({ kind: 'launched', pid, at: Date.now() });
    const state: WindowsTreeState = { session, cleanupRequested: false };
    const tree: ProcessTreeHandle = { platform: 'windows', rootPid: pid, state };
    return {
      pid,
      executablePath: launch.executable,
      stdout: session.stdout,
      stderr: session.stderr,
      waitExit: () => session.exitObserved.then(exit => ({
        exitCode: exit.exitCode,
        signal: exit.signal,
        exitedAt: Date.now(),
      })),
      requestGracefulStop: async () => {
        if (session.rootExited) return false;
        try {
          await session.request('stoproot');
          return true;
        } catch {
          return false;
        }
      },
      tree,
    };
  }

  async attach(identity: NativeIdentity): Promise<ProcessTreeHandle> {
    let session: WindowsJobSession | undefined;
    try {
      session = await WindowsJobSession.start(this.shell, this.trace);
      const response = await session.request('attach|' + identity.pid);
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
