import { execFile } from 'node:child_process';
import type { P1ProcessErrorCode } from './errors.js';

/** Bounded, provider-neutral request for a short executable capability probe. */
export interface ProcessProbeRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/** Result of a probe. Native output remains in-memory and is owned by the caller. */
export interface ProcessProbeResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly errorCode?: P1ProcessErrorCode;
}

/** Process Runtime-owned seam for provider validation probes. */
export interface ProcessProbePort {
  probe(request: ProcessProbeRequest): Promise<ProcessProbeResult>;
}

const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;

/**
 * Native one-shot probe implementation. Provider adapters never import this
 * implementation; production wiring injects the Process Runtime port.
 */
export class NodeProcessProbePort implements ProcessProbePort {
  probe(request: ProcessProbeRequest): Promise<ProcessProbeResult> {
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
      return Promise.resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        errorCode: 'PROCESS_REQUEST_INVALID',
      });
    }
    return new Promise((resolve) => {
      execFile(
        request.executable,
        [...request.args],
        {
          cwd: request.cwd,
          env: request.environment === undefined ? undefined : { ...request.environment },
          timeout: request.timeoutMs,
          maxBuffer: MAX_PROBE_OUTPUT_BYTES,
          windowsHide: true,
          shell: false,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          const output = {
            stdout: boundText(stdout),
            stderr: boundText(stderr),
            exitCode: typeof error?.code === 'number' ? error.code : error === null ? 0 : null,
            signal: error?.signal === undefined ? null : String(error.signal),
          } satisfies Omit<ProcessProbeResult, 'errorCode'>;
          if (error === null) {
            resolve(output);
            return;
          }
          const errorCode = mapProbeError(error);
          resolve({ ...output, ...(errorCode === undefined ? {} : { errorCode }) });
        },
      );
    });
  }
}

function boundText(value: string | Uint8Array): string {
  const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
  if (Buffer.byteLength(text, 'utf8') <= MAX_PROBE_OUTPUT_BYTES) return text;
  return `${text.slice(0, MAX_PROBE_OUTPUT_BYTES)}…`;
}

function mapProbeError(error: { readonly code?: string | number | null; readonly killed?: boolean }): P1ProcessErrorCode | undefined {
  if (error.code === 'ENOENT') return 'PROCESS_EXECUTABLE_NOT_FOUND';
  if (error.code === 'EACCES' || error.code === 'EPERM') return 'PROCESS_EXECUTABLE_NOT_ACCESSIBLE';
  if (error.code === 'ETIMEDOUT' || error.killed === true) return 'PROCESS_STARTUP_TIMEOUT';
  if (error.code !== undefined) return 'PROCESS_UNKNOWN_ERROR';
  return undefined;
}
