/**
 * Stable Process error taxonomy for the M4-P1 schema-light foundation.
 *
 * The union below is the exact 30-member authoritative ProcessErrorCode set
 * from the merged M4-P0 event/error contract. P1 freezes the 19-code subset
 * covering validation, launch/environment/spawn, stdio/output, timers,
 * idempotent cancel, exit uncertainty, shutdown and the catch-all. Codes
 * outside the P1 subset remain authoritative vocabulary for later phases and
 * must not be emitted by this package.
 */
export const PROCESS_ERROR_CODES = [
  'PROCESS_REQUEST_INVALID',
  'PROCESS_POLICY_DENIED',
  'PROCESS_EXECUTABLE_NOT_FOUND',
  'PROCESS_EXECUTABLE_NOT_ACCESSIBLE',
  'PROCESS_CWD_INVALID',
  'PROCESS_ENVIRONMENT_INVALID',
  'PROCESS_REGISTRATION_FAILED',
  'PROCESS_SPAWN_FAILED',
  'PROCESS_STDIN_CLOSED',
  'PROCESS_STDIN_WRITE_FAILED',
  'PROCESS_OUTPUT_DECODE_FAILED',
  'PROCESS_OUTPUT_LIMIT_EXCEEDED',
  'PROCESS_STARTUP_TIMEOUT',
  'PROCESS_IDLE_TIMEOUT',
  'PROCESS_TOTAL_TIMEOUT',
  'PROCESS_TOOL_TIMEOUT',
  'PROCESS_PAUSE_UNSUPPORTED',
  'PROCESS_PAUSE_FAILED',
  'PROCESS_RESUME_FAILED',
  'PROCESS_CANCEL_FAILED',
  'PROCESS_TREE_TERMINATION_FAILED',
  'PROCESS_SURVIVORS_DETECTED',
  'PROCESS_EXIT_UNKNOWN',
  'PROCESS_PID_REUSED',
  'PROCESS_RECOVERY_FAILED',
  'PROCESS_ORPHANED',
  'PROCESS_RESOURCE_LIMIT',
  'PROCESS_ARTIFACT_WRITE_FAILED',
  'PROCESS_MANAGER_SHUTTING_DOWN',
  'PROCESS_UNKNOWN_ERROR',
] as const;

export type ProcessErrorCode = (typeof PROCESS_ERROR_CODES)[number];

export const P1_PROCESS_ERROR_CODES = [
  'PROCESS_REQUEST_INVALID',
  'PROCESS_POLICY_DENIED',
  'PROCESS_EXECUTABLE_NOT_FOUND',
  'PROCESS_EXECUTABLE_NOT_ACCESSIBLE',
  'PROCESS_CWD_INVALID',
  'PROCESS_ENVIRONMENT_INVALID',
  'PROCESS_REGISTRATION_FAILED',
  'PROCESS_SPAWN_FAILED',
  'PROCESS_STDIN_CLOSED',
  'PROCESS_STDIN_WRITE_FAILED',
  'PROCESS_OUTPUT_DECODE_FAILED',
  'PROCESS_OUTPUT_LIMIT_EXCEEDED',
  'PROCESS_STARTUP_TIMEOUT',
  'PROCESS_IDLE_TIMEOUT',
  'PROCESS_TOTAL_TIMEOUT',
  'PROCESS_CANCEL_FAILED',
  'PROCESS_EXIT_UNKNOWN',
  'PROCESS_MANAGER_SHUTTING_DOWN',
  'PROCESS_UNKNOWN_ERROR',
] as const satisfies readonly ProcessErrorCode[];

export type P1ProcessErrorCode = (typeof P1_PROCESS_ERROR_CODES)[number];

export type ProcessErrorPhase =
  | 'validation'
  | 'reservation'
  | 'spawn'
  | 'stdio'
  | 'runtime'
  | 'timeout'
  | 'cancel'
  | 'tree-cleanup'
  | 'recovery'
  | 'artifact'
  | 'shutdown';

export interface ProcessErrorMetadata {
  readonly phase: ProcessErrorPhase;
  readonly httpStatus: number;
  readonly retryable: boolean;
}

const P1_ERROR_METADATA: Record<P1ProcessErrorCode, ProcessErrorMetadata> = {
  PROCESS_REQUEST_INVALID: { phase: 'validation', httpStatus: 400, retryable: false },
  PROCESS_POLICY_DENIED: { phase: 'validation', httpStatus: 403, retryable: false },
  PROCESS_EXECUTABLE_NOT_FOUND: { phase: 'validation', httpStatus: 422, retryable: false },
  PROCESS_EXECUTABLE_NOT_ACCESSIBLE: { phase: 'validation', httpStatus: 422, retryable: false },
  PROCESS_CWD_INVALID: { phase: 'validation', httpStatus: 422, retryable: false },
  PROCESS_ENVIRONMENT_INVALID: { phase: 'validation', httpStatus: 422, retryable: false },
  PROCESS_REGISTRATION_FAILED: { phase: 'spawn', httpStatus: 500, retryable: false },
  PROCESS_SPAWN_FAILED: { phase: 'spawn', httpStatus: 503, retryable: false },
  PROCESS_STDIN_CLOSED: { phase: 'stdio', httpStatus: 409, retryable: false },
  PROCESS_STDIN_WRITE_FAILED: { phase: 'stdio', httpStatus: 500, retryable: false },
  PROCESS_OUTPUT_DECODE_FAILED: { phase: 'stdio', httpStatus: 500, retryable: false },
  PROCESS_OUTPUT_LIMIT_EXCEEDED: { phase: 'runtime', httpStatus: 409, retryable: false },
  PROCESS_STARTUP_TIMEOUT: { phase: 'timeout', httpStatus: 503, retryable: false },
  PROCESS_IDLE_TIMEOUT: { phase: 'timeout', httpStatus: 409, retryable: false },
  PROCESS_TOTAL_TIMEOUT: { phase: 'timeout', httpStatus: 409, retryable: false },
  PROCESS_CANCEL_FAILED: { phase: 'cancel', httpStatus: 409, retryable: true },
  PROCESS_EXIT_UNKNOWN: { phase: 'runtime', httpStatus: 500, retryable: false },
  PROCESS_MANAGER_SHUTTING_DOWN: { phase: 'shutdown', httpStatus: 503, retryable: false },
  PROCESS_UNKNOWN_ERROR: { phase: 'runtime', httpStatus: 500, retryable: false },
};

export function processErrorMetadata(code: P1ProcessErrorCode): ProcessErrorMetadata {
  return P1_ERROR_METADATA[code];
}

/**
 * Stable, sanitized Process error. The detail string must already be safe:
 * no raw stderr, no environment values, no secret material, no native handles.
 */
export class ProcessError extends Error {
  readonly code: P1ProcessErrorCode;
  readonly phase: ProcessErrorPhase;
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(code: P1ProcessErrorCode, detail: string) {
    super(detail);
    this.name = 'ProcessError';
    this.code = code;
    const meta = P1_ERROR_METADATA[code];
    this.phase = meta.phase;
    this.httpStatus = meta.httpStatus;
    this.retryable = meta.retryable;
  }

  static isProcessError(value: unknown): value is ProcessError {
    return value instanceof ProcessError;
  }

  /** Normalize an arbitrary failure into a stable catch-all without leaking detail. */
  static unknown(detail = 'unclassified process failure'): ProcessError {
    return new ProcessError('PROCESS_UNKNOWN_ERROR', detail);
  }
}

