import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { SurvivorVerification, TreeTerminationResult } from './driver.js';
import type { NativeIdentity, ValidatedLaunch } from './types.js';
import { canonicalizeNativeBirthIdentityDecimal } from './native-birth-identity.js';
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
const FRAME_STDOUT_EOF = 3;
const FRAME_STDERR_EOF = 4;

/**
 * MEDIUM-1: translate a stable Win32 native spawn error code to the
 * Node-style errno code the rest of the runtime already understands.
 *
 * Only the numeric native identity is used; localized message text is never
 * parsed. Codes outside the stable known set map to null (unknown).
 *
 *   ERROR_FILE_NOT_FOUND (2)  -> ENOENT
 *   ERROR_PATH_NOT_FOUND (3)  -> ENOENT
 *   ERROR_ACCESS_DENIED (5)   -> EACCES
 *   everything else           -> null (unknown)
 */
export function translateWin32SpawnErrorCode(
  nativeCode: number,
): 'ENOENT' | 'EACCES' | null {
  if (nativeCode === 2 || nativeCode === 3) return 'ENOENT';
  if (nativeCode === 5) return 'EACCES';
  return null;
}

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

export interface WindowsTransportTraceEvent {
  readonly kind: 'data-paused' | 'data-resumed';
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
 * Transport uses TWO dedicated named pipes so control can never deadlock
 * behind data backpressure:
 * - control pipe: channel-0 frames carrying UTF-8 control lines,
 * - data pipe: channels 1/2 carrying raw provider stdout/stderr bytes and
 *   channels 3/4 carrying the matching end-of-stream markers. Every byte
 *   of a stream strictly precedes its EOF frame on the ordered data pipe.
 *
 * The Node side pauses only the data socket when a stream's buffered
 * bytes reach the PassThrough high-water mark, so provider output is
 * bounded end-to-end: data socket -> helper pipe write -> provider pipe
 * write. The control pipe is never paused; members/terminate/close/exit
 * evidence always progress. The 'exit|pid|code' control line is sent
 * after process termination plus a bounded pump-drain wait; pumps keep
 * running after that wait, so late provider bytes are still delivered.
 */
const WINDOWS_JOB_HELPER_BODY = String.raw`
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

    public void WriteEof(byte channel)
    {
        WriteFrame(channel, new byte[0]);
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

/// <summary>
/// Read-only Windows process-creation identity (birth) primitive.
///
/// GetProcessTimes returns the creation time as a 64-bit FILETIME expressed as
/// two 32-bit halves. The canonical durable value is the invariant unsigned
/// decimal text of the full 64-bit FILETIME (dwHigh * 2^32 + dwLow). It is
/// computed with 64-bit integers only and is NEVER routed through a 32-bit or
/// floating-point/Number representation, so the full precision survives.
///
/// This type only READS process times. It never creates, attaches, signals,
/// terminates, or otherwise modifies the target process or any Job.
/// </summary>
public static class AgentOsProcessIdentity
{
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    /// <summary>
    /// Reads the creation FILETIME for an already-open process handle and
    /// returns it as invariant unsigned decimal text. Throws a Win32Exception
    /// when the OS call fails; the caller must treat any failure as
    /// identity-unavailable (fail-closed), never as process absence.
    /// </summary>
    public static string ReadCreationFileTime(IntPtr processHandle)
    {
        FILETIME_NATIVE creation;
        FILETIME_NATIVE exit;
        FILETIME_NATIVE kernel;
        FILETIME_NATIVE user;
        if (!GetProcessTimes(processHandle, out creation, out exit, out kernel, out user))
        {
            AgentOsJob.ThrowLastError();
        }
        ulong value = ((ulong)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
        return value.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Read-only probe: opens the target PID with the minimum query right,
    /// reads its creation FILETIME, and returns the invariant unsigned decimal
    /// text. The process is opened only to read its times; it is never placed
    /// in a Job, never terminated, and never signaled. Any failure throws so
    /// the caller fails closed (identity unavailable), never guessing absence.
    /// </summary>
    public static string ProbeCreationFileTime(uint pid)
    {
        var handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle == IntPtr.Zero) AgentOsJob.ThrowLastError();
        try
        {
            return ReadCreationFileTime(handle);
        }
        finally
        {
            AgentOsJob.CloseHandle(handle);
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
        IntPtr hProcess,
        out FILETIME_NATIVE lpCreationTime,
        out FILETIME_NATIVE lpExitTime,
        out FILETIME_NATIVE lpKernelTime,
        out FILETIME_NATIVE lpUserTime);

    /// <summary>
    /// Native Win32 FILETIME layout: two consecutive 32-bit halves of one
    /// 64-bit value. Declared explicitly so the GetProcessTimes P/Invoke
    /// matches the real ABI (four LPFILETIME out pointers) instead of relying
    /// on an accidental byte-size coincidence.
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME_NATIVE
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
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
    private const uint STILL_ACTIVE = 259;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;

    private readonly AgentOsFrameWriter writer;
    private readonly AgentOsFrameWriter dataWriter;
    private readonly ManualResetEvent exitFrameSent = new ManualResetEvent(false);
    private bool abortAttempted;
    private IntPtr processHandle;
    private IntPtr threadHandle;
    private IntPtr readOut;
    private IntPtr readErr;
    private Thread pumpOut;
    private Thread pumpErr;

    public readonly int Pid;

    private AgentOsOwnedProcess(int pid, IntPtr processHandle, IntPtr threadHandle, IntPtr readOut, IntPtr readErr, AgentOsFrameWriter writer, AgentOsFrameWriter dataWriter)
    {
        Pid = pid;
        this.processHandle = processHandle;
        this.threadHandle = threadHandle;
        this.readOut = readOut;
        this.readErr = readErr;
        this.writer = writer;
        this.dataWriter = dataWriter;
    }

    public IntPtr Handle { get { return processHandle; } }

    public static AgentOsOwnedProcess LaunchSuspended(AgentOsLaunchSpec spec, AgentOsFrameWriter writer, AgentOsFrameWriter dataWriter)
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
            return new AgentOsOwnedProcess(unchecked((int)pi.dwProcessId), pi.hProcess, pi.hThread, readOut, readErr, writer, dataWriter);
        }
        finally
        {
            if (writeOut != IntPtr.Zero) AgentOsJob.CloseHandle(writeOut);
            if (writeErr != IntPtr.Zero) AgentOsJob.CloseHandle(writeErr);
            if (nul != new IntPtr(-1)) AgentOsJob.CloseHandle(nul);
        }
    }

    public void AbortBeforeLaunch()
    {
        if (abortAttempted) return;
        abortAttempted = true;
        if (processHandle == IntPtr.Zero)
        {
            exitFrameSent.Set();
            return;
        }
        uint code = 0;
        if (!GetExitCodeProcess(processHandle, out code))
        {
            Dispose();
            exitFrameSent.Set();
            throw new InvalidOperationException("abort-get-exit-code");
        }
        if (code == STILL_ACTIVE)
        {
            if (!TerminateProcess(processHandle, 1))
            {
                var detail = new Win32Exception(Marshal.GetLastWin32Error()).Message;
                Dispose();
                exitFrameSent.Set();
                throw new InvalidOperationException("abort-terminate-failed-" + detail);
            }
            var wait = WaitForSingleObject(processHandle, 5000);
            if (wait != 0)
            {
                Dispose();
                exitFrameSent.Set();
                throw new InvalidOperationException("abort-wait-failed-" + wait);
            }
        }
        Dispose();
        exitFrameSent.Set();
    }

    public void Resume()
    {
        if (ResumeThread(threadHandle) == 0xFFFFFFFF) AgentOsJob.ThrowLastError();
        AgentOsJob.CloseHandle(threadHandle);
        threadHandle = IntPtr.Zero;
        pumpOut = new Thread(delegate() { Pump(readOut, 1, 3); });
        pumpErr = new Thread(delegate() { Pump(readErr, 2, 4); });
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

    private void Pump(IntPtr readHandle, byte channel, byte eofChannel)
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
                    dataWriter.WriteData(channel, buffer, read);
                }
            }
        }
        catch
        {
            // Teardown closes the pipe reads; the session fails closed.
        }
        finally
        {
            try { dataWriter.WriteEof(eofChannel); } catch { /* teardown */ }
        }
    }

    private void MonitorExit()
    {
        try
        {
            WaitForSingleObject(processHandle, INFINITE);
            // The bounded join prevents exit evidence from waiting behind a stalled data consumer.
            // Pumps remain alive after the deadline so bytes are not silently discarded.
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

    // The provider environment is exactly the validated launch environment.
    // The helper host environment is never used as an implicit fallback.
    private static byte[] BuildEnvironmentBlock(Dictionary<string, string> env)
    {
        var entries = new List<string>();
        if (env != null)
        {
            foreach (var pair in env)
            {
                if (pair.Key.Length == 0 || pair.Key.IndexOf('=') >= 0) throw new InvalidOperationException("launch-env-invalid-key");
                entries.Add(pair.Key + "=" + (pair.Value ?? string.Empty));
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
    internal static string Sanitize(string message)
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
        var serializer = new DataContractJsonSerializer(typeof(AgentOsLaunchSpec), new DataContractJsonSerializerSettings { UseSimpleDictionaryFormat = true });
        using (var stream = new MemoryStream(bytes))
        {
            var spec = (AgentOsLaunchSpec)serializer.ReadObject(stream);
            if (spec == null || string.IsNullOrEmpty(spec.Executable)) throw new InvalidOperationException("launch-spec-invalid");
            return spec;
        }
    }

    public static void Run()
    {
        var controlPipeName = Environment.GetEnvironmentVariable("AGENTOS_JOB_CONTROL_PIPE");
        var dataPipeName = Environment.GetEnvironmentVariable("AGENTOS_JOB_DATA_PIPE");
        if (string.IsNullOrEmpty(controlPipeName)) throw new InvalidOperationException("missing-control-pipe");
        if (string.IsNullOrEmpty(dataPipeName)) throw new InvalidOperationException("missing-data-pipe");
        AgentOsJob job = null;
        AgentOsOwnedProcess owned = null;
        using (var controlPipe = new NamedPipeClientStream(".", controlPipeName, PipeDirection.Out))
        using (var dataPipe = new NamedPipeClientStream(".", dataPipeName, PipeDirection.Out))
        {
            controlPipe.Connect(30000);
            dataPipe.Connect(30000);
            var writer = new AgentOsFrameWriter(controlPipe);
            var dataWriter = new AgentOsFrameWriter(dataPipe);
            writer.WriteLine("ready");
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                var closing = false;
                try
                {
                    if (line.StartsWith("launch|") || line.StartsWith("launch-test-fail-assign|"))
                    {
                        if (owned != null) throw new InvalidOperationException("launch-already-used");
                        var separator = line.IndexOf('|');
                        var failAssign = line.StartsWith("launch-test-fail-assign|");
                        var spec = ParseSpec(line.Substring(separator + 1));
                        var newJob = AgentOsJob.Create();
                        AgentOsOwnedProcess created = null;
                        var resumed = false;
                        var createdPid = 0;
                        try
                        {
                            created = AgentOsOwnedProcess.LaunchSuspended(spec, writer, dataWriter);
                            createdPid = created.Pid;
                            if (failAssign) throw new InvalidOperationException("injected-assign-failure");
                            newJob.Assign(created.Handle);
                            job = newJob;
                            owned = created;
                            // Capture the lossless native creation identity from the
                            // already-open provider handle AFTER atomic Job assignment
                            // and BEFORE ResumeThread, so no provider-controlled code
                            // can run first and there is no PID-lookup race. Any
                            // capture failure fails closed: identity stays null and
                            // the normal lifecycle/ownership order is unchanged.
                            string birthIdentity = null;
                            try { birthIdentity = AgentOsProcessIdentity.ReadCreationFileTime(created.Handle); }
                            catch { birthIdentity = null; }
                            writer.WriteLine("assigned|" + owned.Pid);
                            owned.Resume();
                            resumed = true;
                            writer.WriteLine("launched|" + owned.Pid + "|" + (birthIdentity == null ? "-" : birthIdentity));
                        }
                        catch (Exception error)
                        {
                            if (!resumed && created != null)
                            {
                                Exception abortError = null;
                                try { created.AbortBeforeLaunch(); } catch (Exception abortFailure) { abortError = abortFailure; }
                                try { newJob.Dispose(); } catch { }
                                job = null;
                                owned = null;
                                if (abortError != null) throw new InvalidOperationException("launch-abort-hard-failure|" + createdPid + "|" + Sanitize(abortError.Message));
                                throw new InvalidOperationException("launch-aborted|" + createdPid + "|" + Sanitize(error.Message));
                            }
                            try { newJob.Dispose(); } catch { }
                            throw;
                        }
                    }
                    else if (line.StartsWith("attach|"))
                    {
                        if (job != null) throw new InvalidOperationException("job-already-attached");
                        uint attachPid;
                        if (!uint.TryParse(line.Substring("attach|".Length), out attachPid)) throw new InvalidOperationException("invalid-attach-pid");
                        job = AgentOsJob.Attach(attachPid);
                        writer.WriteLine("ok|attach");
                    }
                    else if (line.StartsWith("probe-identity|"))
                    {
                        // Read-only native birth-identity probe. Opens the target
                        // PID with PROCESS_QUERY_LIMITED_INFORMATION only, reads its
                        // creation FILETIME, and replies with invariant unsigned
                        // decimal text. It never creates/attaches the target to a
                        // Job, never signals/terminates it, and never changes
                        // ownership. Any failure fails closed (identity-unavailable).
                        uint probePid;
                        if (!uint.TryParse(line.Substring("probe-identity|".Length), out probePid) || probePid == 0)
                        {
                            writer.WriteLine("identity|error|invalid-pid");
                        }
                        else
                        {
                            try
                            {
                                var value = AgentOsProcessIdentity.ProbeCreationFileTime(probePid);
                                writer.WriteLine("identity|" + probePid + "|" + value);
                            }
                            catch (Exception error)
                            {
                                writer.WriteLine("identity|error|" + Sanitize(error.Message));
                            }
                        }
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
                    // MEDIUM-1: preserve stable Win32 native error identity in
                    // a bounded machine-readable field. Only the numeric
                    // NativeErrorCode is emitted; localized message text is
                    // never relied upon for classification.
                    var win32Error = error as Win32Exception;
                    if (win32Error != null)
                    {
                        writer.WriteLine("error|win32|" + win32Error.NativeErrorCode.ToString(System.Globalization.CultureInfo.InvariantCulture) + "|" + Sanitize(error.Message));
                    }
                    else
                    {
                        writer.WriteLine("error|" + Sanitize(error.Message));
                    }
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
`;

/**
 * Tiny fixed PowerShell loader. It reads ONE bounded base64 frame carrying the
 * C# body from STDIN, compiles it with Add-Type, and runs the helper. This keeps
 * the launch command line short (under the Windows ~32K limit) while preserving
 * the fixed-script model: no provider-controlled text is ever interpolated into
 * PowerShell or C# source; the launch spec still arrives separately as bounded
 * base64 on the command channel.
 */
const WINDOWS_JOB_HELPER_LOADER = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  $b64 = [Console]::In.ReadLine()',
  "  if ($b64 -eq $null -or $b64.Length -eq 0 -or $b64.Length -gt 2097152) { throw 'helper-body-invalid' }",
  '  $src = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))',
  "  $null = Add-Type -TypeDefinition $src -ReferencedAssemblies 'System', 'System.Core', 'System.Runtime.Serialization', 'System.Xml'",
  '  [AgentOsJobServer]::Run()',
  '} catch {',
  "  $detail = $_.Exception.Message -replace '[\r\n|]', ' '",
  '  if ($detail.Length -gt 400) { $detail = $detail.Substring(0, 400) }',
  "  [Console]::Error.WriteLine('helper-fatal|' + $detail)",
  '  exit 1',
  '}',
].join('\n');

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
  readonly transportTrace?: (event: WindowsTransportTraceEvent) => void;
  readonly faultInjection?: { readonly failJobAssign?: boolean };
}

class WindowsJobSession {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly lines = new ControlLineQueue();
  private readonly exitResolve: (exit: OwnedExit) => void;
  private exitSettled = false;
  private readonly blockedStreams = new Set<number>();
  private dataPaused = false;
  rootExited = false;
  readonly exitObserved: Promise<OwnedExit>;
  readonly stdout = new PassThrough({ highWaterMark: 64 * 1024 });
  readonly stderr = new PassThrough({ highWaterMark: 64 * 1024 });

  private constructor(
    private readonly helper: ChildProcess,
    private readonly controlServer: Server,
    private readonly dataServer: Server,
    private readonly controlSocket: Socket,
    private readonly dataSocket: Socket,
    private readonly trace?: (event: WindowsOwnershipTraceEvent) => void,
    private readonly transportTrace?: (event: WindowsTransportTraceEvent) => void,
  ) {
    let resolver: (exit: OwnedExit) => void = () => undefined;
    this.exitObserved = new Promise<OwnedExit>(resolve => { resolver = resolve; });
    this.exitResolve = resolver;
  }

  static async start(
    shell: string,
    trace?: (event: WindowsOwnershipTraceEvent) => void,
    transportTrace?: (event: WindowsTransportTraceEvent) => void,
  ): Promise<WindowsJobSession> {
    const suffix = process.pid + '-' + (pipeSequence++) + '-' + randomBytes(6).toString('hex');
    const controlPipeName = 'agentos-job-control-' + suffix;
    const dataPipeName = 'agentos-job-data-' + suffix;
    const pipePrefix = String.fromCharCode(92, 92) + '.' + String.fromCharCode(92) + 'pipe' + String.fromCharCode(92);
    const controlPipePath = pipePrefix + controlPipeName;
    const dataPipePath = pipePrefix + dataPipeName;
    const controlServer = createServer();
    const dataServer = createServer();
    const controlConnection = new Promise<Socket>((resolve, reject) => {
      controlServer.once('connection', resolve);
      controlServer.once('error', reject);
    });
    const dataConnection = new Promise<Socket>((resolve, reject) => {
      dataServer.once('connection', resolve);
      dataServer.once('error', reject);
    });
    let helper: ChildProcess | undefined;
    let controlSocket: Socket | undefined;
    let dataSocket: Socket | undefined;
    let diagnostics = '';
    try {
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          controlServer.once('error', reject);
          controlServer.listen(controlPipePath, () => resolve());
        }),
        new Promise<void>((resolve, reject) => {
          dataServer.once('error', reject);
          dataServer.listen(dataPipePath, () => resolve());
        }),
      ]);
     const spawned = spawn(shell, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_JOB_HELPER_LOADER,
      ], {
       shell: false,
       windowsHide: true,
       stdio: ['pipe', 'pipe', 'pipe'],
       env: { ...process.env, AGENTOS_JOB_CONTROL_PIPE: controlPipeName, AGENTOS_JOB_DATA_PIPE: dataPipeName },
     });
     helper = spawned;
      // Deliver the fixed C# helper body over STDIN as a single bounded base64
      // frame. The loader reads it before entering the command loop, so the
      // script body is not subject to the command-line length limit.
      spawned.stdin?.write(Buffer.from(WINDOWS_JOB_HELPER_BODY, 'utf8').toString('base64') + '\n');
      const capture = (chunk: unknown): void => {
        if (diagnostics.length < MAX_DIAGNOSTIC) diagnostics += String(chunk).slice(0, MAX_DIAGNOSTIC - diagnostics.length);
      };
      spawned.stdout?.setEncoding('utf8');
      spawned.stdout?.on('data', capture);
      spawned.stderr?.setEncoding('utf8');
      spawned.stderr?.on('data', capture);
      const helperFailure = new Promise<never>((_, reject) => {
        spawned.once('error', () => reject(new Error('windows-tree-helper-spawn-failed')));
        spawned.once('exit', code => reject(new Error('windows-tree-helper-exited-' + String(code))));
      });
      const connected = await withTimeout(Promise.race([
        Promise.all([controlConnection, dataConnection]),
        helperFailure,
      ]), READY_TIMEOUT_MS, 'windows-tree-helper-connect-timeout');
      [controlSocket, dataSocket] = connected;
      const session = new WindowsJobSession(spawned, controlServer, dataServer, controlSocket, dataSocket, trace, transportTrace);
      const controlDemux = new FrameDemux(
        line => session.handleLine(line),
        () => session.fail(new Error('windows-tree-control-protocol-violation')),
      );
      const dataDemux = new FrameDemux(
        () => session.fail(new Error('windows-tree-data-protocol-violation')),
        (channel, payload) => session.handleData(channel, payload),
      );
      controlSocket.on('data', chunk => controlDemux.push(chunk));
      dataSocket.on('data', chunk => dataDemux.push(chunk));
      const socketFailure = (error: unknown): void => session.fail(error instanceof Error ? error : new Error(String(error)));
      controlSocket.on('error', socketFailure);
      dataSocket.on('error', socketFailure);
      controlSocket.on('close', () => session.fail(new Error('windows-tree-control-closed')));
      dataSocket.on('close', () => session.fail(new Error('windows-tree-data-closed')));
      spawned.once('error', socketFailure);
      spawned.once('exit', () => session.fail(new Error('windows-tree-helper-exited')));
      const ready = await withTimeout(session.lines.next(), READY_TIMEOUT_MS, 'windows-tree-helper-ready-timeout');
      if (ready !== 'ready') throw new Error('windows-tree-helper-not-ready');
      return session;
    } catch (error) {
      controlSocket?.destroy();
      dataSocket?.destroy();
      controlServer.close();
      dataServer.close();
      try { helper?.stdin?.end(); } catch { /* best effort */ }
      if (helper !== undefined && helper.exitCode === null) helper.kill();
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
    this.controlSocket.destroy();
    this.dataSocket.destroy();
    this.controlServer.close();
    this.dataServer.close();
    this.settleExit({ exitCode: null, signal: null });
    this.endStreams();
  }

  private async requestNow(command: string): Promise<string> {
    if (this.closed && command !== 'close') throw new Error('windows-tree-helper-closed');
    this.helper.stdin?.write(command + '\n');
    const response = await withTimeout(this.lines.next(), COMMAND_TIMEOUT_MS, 'windows-tree-helper-response-timeout');
    if (response.startsWith('error|')) throw this.classifyErrorResponse(response);
    return response;
  }

 /**
   * MEDIUM-1: classify a helper `error|` response. When the helper preserved
   * a Win32 native code (`error|win32|<code>|<detail>`), translate the stable
   * numeric code to a Node-style errno and attach it as `error.code`. Raw
   * helper detail stays in the message only; classification never parses it.
   */
  private classifyErrorResponse(response: string): Error {
    const body = response.slice('error|'.length);
    if (body.startsWith('win32|')) {
      const rest = body.slice('win32|'.length);
      const separator = rest.indexOf('|');
      const codeText = separator === -1 ? rest : rest.slice(0, separator);
      const detail = separator === -1 ? '' : rest.slice(separator + 1);
      const nativeCode = Number(codeText);
      if (Number.isSafeInteger(nativeCode)) {
        const code = translateWin32SpawnErrorCode(nativeCode);
        const error = new Error(detail) as NodeJS.ErrnoException;
        if (code !== null) error.code = code;
        return error;
      }
    }
    return new Error(body);
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
    if (channel === FRAME_STDOUT_EOF) {
      this.unblockStream(FRAME_STDOUT);
      if (!this.stdout.writableEnded) this.stdout.end();
      return;
    }
    if (channel === FRAME_STDERR_EOF) {
      this.unblockStream(FRAME_STDERR);
      if (!this.stderr.writableEnded) this.stderr.end();
      return;
    }
    if (channel !== FRAME_STDOUT && channel !== FRAME_STDERR) {
      this.fail(new Error('windows-tree-data-channel-invalid'));
      return;
    }
    const stream = channel === FRAME_STDOUT ? this.stdout : this.stderr;
    if (!stream.writableEnded && !stream.write(payload)) this.blockStream(channel, stream);
  }

  private blockStream(channel: number, stream: PassThrough): void {
    if (this.blockedStreams.has(channel)) return;
    this.blockedStreams.add(channel);
    if (!this.dataPaused) {
      this.dataPaused = true;
      this.dataSocket.pause();
      this.transportTrace?.({ kind: 'data-paused', at: Date.now() });
    }
    stream.once('drain', () => this.unblockStream(channel));
  }

  private unblockStream(channel: number): void {
    this.blockedStreams.delete(channel);
    this.maybeResumeData();
  }

  private maybeResumeData(): void {
    if (this.dataPaused && this.blockedStreams.size === 0 && !this.closed) {
      this.dataPaused = false;
      this.dataSocket.resume();
      this.transportTrace?.({ kind: 'data-resumed', at: Date.now() });
    }
  }

  private endStreams(): void {
    if (!this.stdout.writableEnded) this.stdout.end();
    if (!this.stderr.writableEnded) this.stderr.end();
  }

  private settleExit(exit: OwnedExit): void {
    if (this.exitSettled) return;
    this.exitSettled = true;
    this.exitResolve(exit);
  }

  private fail(error: Error): void {
    this.lines.fail(error);
    this.settleExit({ exitCode: null, signal: null });
    this.endStreams();
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

export interface WindowsLaunchedIdentity {
  readonly pid: number;
  /**
   * Canonical lossless native process-creation identity
   * ('win32:filetime:<unsigned-decimal>'), or null when capture was unavailable
   * or the helper emitted a non-canonical value. Transported as a string so the
   * full 64-bit FILETIME precision is never routed through a JS Number.
   */
  readonly nativeBirthIdentity: string | null;
}

function parseLaunchedIdentity(response: string): WindowsLaunchedIdentity {
  if (!response.startsWith('launched|')) throw new Error('windows-tree-helper-launch-failed');
  const parts = response.split('|');
  const pid = Number(parts[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('windows-tree-helper-invalid-pid');
  // parts[2] is the invariant unsigned-decimal FILETIME, or '-' when capture was
  // unavailable. The raw decimal is validated and canonicalized into the
  // durable tagged form BEFORE it becomes OwnedSpawnResult state; a
  // non-canonical decimal fails closed to null and is never coerced to Number.
  const rawIdentity = parts.length >= 3 ? parts[2] : '-';
  const nativeBirthIdentity = rawIdentity === '-'
    ? null
    : canonicalizeNativeBirthIdentityDecimal(rawIdentity);
  return { pid, nativeBirthIdentity };
}

export class WindowsProcessTreeController implements ProcessTreeController {
  private readonly shell: string;
  private readonly trace?: (event: WindowsOwnershipTraceEvent) => void;
  private readonly transportTrace?: (event: WindowsTransportTraceEvent) => void;
  private readonly faultInjection?: { readonly failJobAssign?: boolean };

  constructor(options: WindowsProcessTreeOptions = {}) {
    this.shell = options.shell ?? (process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe');
    this.trace = options.trace;
    this.transportTrace = options.transportTrace;
    this.faultInjection = options.faultInjection;
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
    const session = await WindowsJobSession.start(this.shell, this.trace, this.transportTrace);
    let launched: WindowsLaunchedIdentity;
    try {
      const command = (this.faultInjection?.failJobAssign === true ? 'launch-test-fail-assign|' : 'launch|') + encoded;
      const response = await session.request(command);
      launched = parseLaunchedIdentity(response);
    } catch (error) {
      await session.close();
      throw error;
    }
    const pid = launched.pid;
    this.trace?.({ kind: 'launched', pid, at: Date.now() });
    const state: WindowsTreeState = { session, cleanupRequested: false };
    const tree: ProcessTreeHandle = { platform: 'windows', rootPid: pid, state };
    return {
      pid,
      nativeBirthIdentity: launched.nativeBirthIdentity,
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

  /**
   * Read-only native birth-identity probe for a live PID.
   *
   * Uses a SEPARATE short-lived helper session so the probe never shares or
   * mutates the production owned-spawn session. The helper opens the PID with
   * PROCESS_QUERY_LIMITED_INFORMATION only, reads its creation FILETIME, and
   * tears down WITHOUT attaching the target to a Job, terminating, or signaling
   * it. Returns the CANONICAL 'win32:filetime:<unsigned-decimal>' identity, or
   * null when identity cannot be positively read or the helper emitted a
   * non-canonical value (fail-closed: caller treats null as unavailable, never
   * as absence).
   */
  async probeNativeBirthIdentity(pid: number): Promise<string | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    let session: WindowsJobSession | undefined;
    try {
      session = await WindowsJobSession.start(this.shell, this.trace);
      const response = await session.request('probe-identity|' + pid);
      if (!response.startsWith('identity|')) return null;
      const parts = response.split('|');
      if (parts[1] === 'error') return null;
      const observedPid = Number(parts[1]);
      if (!Number.isSafeInteger(observedPid) || observedPid !== pid) return null;
      const raw = parts[2];
      return canonicalizeNativeBirthIdentityDecimal(raw);
    } catch {
      return null;
    } finally {
      await session?.close();
    }
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
