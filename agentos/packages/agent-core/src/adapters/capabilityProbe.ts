import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { AdapterCapabilities, ProviderProbeResult } from './types.js';

export type CodexProbeResult = ProviderProbeResult & { configuredProvider?: 'codex'; supportsStructuredOutput?: boolean };

export type ProbeCommand = (command: string, args: readonly string[], timeoutMs: number) => Promise<string>;

interface ProbeOptions {
  timeoutMs?: number;
  run?: ProbeCommand;
}

const cache = new Map<string, Promise<CodexProbeResult>>();

export const EMPTY_ADAPTER_CAPABILITIES: AdapterCapabilities = {
  structuredOutput: false,
  jsonSchemaOutput: false,
  assistantDelta: false,
  toolEvents: false,
  usage: false,
  workspaceReadOnly: false,
  approvalEvents: false,
};

export function probeCodexCli(command: string, options: ProbeOptions = {}): Promise<CodexProbeResult> {
  const key = resolve(command);
  if (!options.run) {
    const cached = cache.get(key);
    if (cached) return cached;
  }
  const result = probeUncached(command, options);
  if (!options.run) cache.set(key, result);
  return result;
}

async function probeUncached(command: string, options: ProbeOptions): Promise<CodexProbeResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const run = options.run ?? runProbeCommand;
  try {
    const version = await run(command, ['--version'], timeoutMs);
    const helpText = await run(command, ['exec', '--help'], timeoutMs);
    return {
      status: 'AVAILABLE',
      configuredProvider: 'codex',
      detectedProvider: 'codex',
      supportsStructuredOutput: /(?:^|\s)--json(?:\s|$)/m.test(helpText),
      version: version.trim(),
      helpText: helpText.trim(),
      capabilities: codexCapabilities(/(?:^|\s)--json(?:\s|$)/m.test(helpText)),
    };
  } catch (error) {
    return {
      status: 'UNAVAILABLE',
      configuredProvider: 'codex',
      supportsStructuredOutput: false,
      capabilities: EMPTY_ADAPTER_CAPABILITIES,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function codexCapabilities(structuredOutput: boolean): AdapterCapabilities {
  return {
    structuredOutput,
    jsonSchemaOutput: false,
    assistantDelta: structuredOutput,
    toolEvents: structuredOutput,
    usage: structuredOutput,
    workspaceReadOnly: true,
    approvalEvents: false,
  };
}

const runProbeCommand: ProbeCommand = (command, args, timeoutMs) => new Promise((resolvePromise, reject) => {
  const isBatch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
  const executable = isBatch ? (process.env.ComSpec ?? 'cmd.exe') : command;
  const executableArgs = isBatch
    ? ['/d', '/s', '/c', [quoteWindows(command), ...args.map(quoteWindows)].join(' ')]
    : [...args];
  execFile(executable, executableArgs, {
    timeout: timeoutMs,
    windowsHide: true,
    encoding: 'utf8',
    ...(isBatch ? { windowsVerbatimArguments: true } : {}),
  }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(stderr.trim() || error.message));
      return;
    }
    resolvePromise(`${stdout}${stderr}`);
  });
});

function quoteWindows(value: string): string {
  return /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
