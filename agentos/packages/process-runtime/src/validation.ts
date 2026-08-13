import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { ProcessError } from './errors.js';
import { buildSafeEnvironment } from './environment.js';
import type {
  LaunchRequest,
  RedactedLaunchFacts,
  ValidatedLaunch,
} from './types.js';

/**
 * Injectable filesystem probe so launch validation stays deterministic in
 * tests and Provider-neutral in production.
 */
export interface FileSystemProbe {
  exists(path: string): boolean;
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
  isExecutable(path: string): boolean;
  realpath(path: string): string;
}

export class NodeFileSystemProbe implements FileSystemProbe {
  exists(path: string): boolean {
    try { statSync(path); return true; } catch { return false; }
  }
  isFile(path: string): boolean {
    try { return statSync(path).isFile(); } catch { return false; }
  }
  isDirectory(path: string): boolean {
    try { return statSync(path).isDirectory(); } catch { return false; }
  }
  isExecutable(path: string): boolean {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  }
  realpath(path: string): string {
    return realpathSync(path);
  }
}

export interface LaunchPolicy {
  /** Real path of the workspace/worktree root that cwd must stay inside. */
  readonly workspaceRoot: string;
  /** Directories searched for bare command names (defaults to PATH split). */
  readonly executablePathDirs?: readonly string[];
  /** Platform executable extensions used for bare-name lookup. */
  readonly executableExtensions?: readonly string[];
}

export function redactArgs(args: readonly string[]): readonly string[] {
  // Diagnostics never guess the flag/value structure of a raw argument:
  // every non-empty argument is masked wholesale. argCount keeps the shape.
  return args.map((arg) => (arg.length === 0 ? arg : '[REDACTED]'));
}

export function redactedLaunchFacts(launch: ValidatedLaunch): RedactedLaunchFacts {
  return {
    executable: launch.executable,
    argCount: launch.args.length,
    redactedArgs: redactArgs(launch.args),
    envKeys: launch.envDiagnostics.map((d) => d.key),
  };
}

export function validateLaunch(
  request: LaunchRequest,
  probe: FileSystemProbe,
  policy: LaunchPolicy,
): ValidatedLaunch {
  if (typeof request.executable !== 'string' || request.executable.length === 0) {
    throw new ProcessError('PROCESS_REQUEST_INVALID', 'executable is required');
  }
  if (request.executable.includes('\u0000')) {
    throw new ProcessError('PROCESS_REQUEST_INVALID', 'executable contains NUL');
  }
  if (!Array.isArray(request.args) || request.args.some((a) => typeof a !== 'string')) {
    throw new ProcessError('PROCESS_REQUEST_INVALID', 'args must be an array of strings');
  }
  if (request.args.some((a) => a.includes('\u0000'))) {
    throw new ProcessError('PROCESS_REQUEST_INVALID', 'argument contains NUL');
  }
  if (request.shell === true) {
    throw new ProcessError('PROCESS_POLICY_DENIED', 'shell launch is denied by default policy');
  }
  if (request.detached === true) {
    throw new ProcessError('PROCESS_POLICY_DENIED', 'detached launch is denied by default policy');
  }
  if (typeof request.cwd !== 'string' || request.cwd.length === 0 || !isAbsolute(request.cwd)) {
    throw new ProcessError('PROCESS_CWD_INVALID', 'cwd must be an absolute path');
  }

  let realCwd: string;
  try {
    realCwd = probe.realpath(request.cwd);
  } catch {
    throw new ProcessError('PROCESS_CWD_INVALID', 'cwd does not resolve');
  }
  const realRoot = probe.realpath(policy.workspaceRoot);
  if (realCwd !== realRoot && !realCwd.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) {
    throw new ProcessError('PROCESS_CWD_INVALID', 'cwd escapes the workspace boundary');
  }
  if (!probe.isDirectory(realCwd)) {
    throw new ProcessError('PROCESS_CWD_INVALID', 'cwd is not a directory');
  }

  const executable = resolveExecutable(request.executable, realCwd, probe, policy);
  const { env, diagnostics } = buildSafeEnvironment(request.env ?? {});

  return {
    executable,
    args: Object.freeze([...request.args]),
    cwd: realCwd,
    env,
    envDiagnostics: diagnostics,
    shell: false,
  };
}

function resolveExecutable(
  executable: string,
  cwd: string,
  probe: FileSystemProbe,
  policy: LaunchPolicy,
): string {
  const hasSeparator = executable.includes('/') || executable.includes('\\');
  if (hasSeparator || isAbsolute(executable)) {
    const candidate = isAbsolute(executable) ? executable : resolve(cwd, executable);
    return assertExecutableFile(candidate, probe);
  }
  const dirs = policy.executablePathDirs ?? splitPathEnv();
  const extensions = policy.executableExtensions ?? defaultExecutableExtensions();
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, executable + ext);
      if (probe.isFile(candidate)) {
        return assertExecutableFile(candidate, probe);
      }
    }
  }
  throw new ProcessError('PROCESS_EXECUTABLE_NOT_FOUND', 'executable not found');
}

function assertExecutableFile(candidate: string, probe: FileSystemProbe): string {
  if (!probe.exists(candidate)) {
    throw new ProcessError('PROCESS_EXECUTABLE_NOT_FOUND', 'executable not found');
  }
  if (!probe.isFile(candidate) || !probe.isExecutable(candidate)) {
    throw new ProcessError('PROCESS_EXECUTABLE_NOT_ACCESSIBLE', 'executable is not accessible');
  }
  return candidate;
}

function splitPathEnv(): readonly string[] {
  return (process.env.PATH ?? '').split(delimiter).filter((d) => d.length > 0);
}

function defaultExecutableExtensions(): readonly string[] {
  if (process.platform === 'win32') {
    return (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase());
  }
  return [''];
}
