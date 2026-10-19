export interface ProblemDetail {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly [key: string]: unknown;
}

export type AgentOSErrorCode =
  | 'NETWORK_ERROR'
  | 'REQUEST_TIMEOUT'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'UNKNOWN';

const STATUS_CODE_MAP: Record<number, AgentOSErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  412: 'PRECONDITION_FAILED',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

export class AgentOSError extends Error {
  readonly status: number;
  readonly code: AgentOSErrorCode;
  readonly detail?: string;
  readonly title?: string;
  readonly type?: string;
  readonly problem?: ProblemDetail;
  /** Machine-readable code string from the server payload (e.g. 'MEMORY_SECRET_DETECTED'). */
  readonly serverCode?: string;

  constructor(message: string, init: { status: number; code?: AgentOSErrorCode; detail?: string; title?: string; type?: string; problem?: ProblemDetail; serverCode?: string }) {
    super(message);
    this.name = 'AgentOSError';
    this.status = init.status;
    this.code = init.code ?? STATUS_CODE_MAP[init.status] ?? 'UNKNOWN';
    this.detail = init.detail;
    this.title = init.title;
    this.type = init.type;
    this.problem = init.problem;
    this.serverCode = init.serverCode;
  }
}

function isProblemDetail(value: unknown): value is ProblemDetail {
  return typeof value === 'object' && value !== null &&
    ('detail' in value || 'title' in value || 'type' in value || 'status' in value);
}

/**
 * Normalize a non-2xx Response into a typed AgentOSError.
 *
 * Handles both `application/problem+json` (RFC 7807/9457) and the legacy
 * `{ error, detail, title, code }` JSON envelope used by the AgentOS server.
 * Non-JSON bodies fall back to the HTTP status text.
 */
export async function normalizeError(response: Response): Promise<AgentOSError> {
  const fallbackMessage = response.statusText || `HTTP ${response.status}`;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (isProblemDetail(body)) {
    const problem = body;
    return new AgentOSError(problem.detail ?? problem.title ?? fallbackMessage, {
      status: response.status,
      detail: problem.detail,
      title: problem.title,
      type: problem.type,
      problem,
      serverCode: typeof problem.code === 'string' ? problem.code : undefined,
    });
  }

  if (typeof body === 'object' && body !== null) {
    const envelope = body as { error?: unknown; detail?: unknown; title?: unknown; code?: unknown };
    const message = [envelope.detail, envelope.error, envelope.title]
      .find((value): value is string => typeof value === 'string' && value.length > 0);
    if (message !== undefined) {
      return new AgentOSError(message, {
        status: response.status,
        detail: typeof envelope.detail === 'string' ? envelope.detail : undefined,
        title: typeof envelope.title === 'string' ? envelope.title : undefined,
        serverCode: typeof envelope.code === 'string' ? envelope.code : undefined,
      });
    }
  }

  return new AgentOSError(fallbackMessage, { status: response.status });
}

export function isAgentOSError(error: unknown): error is AgentOSError {
  return error instanceof AgentOSError;
}
