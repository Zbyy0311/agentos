import { AgentOSError, normalizeError } from './errors';
import { newIdempotencyKey } from './idempotency';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  readonly method?: HttpMethod;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** §109: attach an Idempotency-Key header (mutating methods only by default). */
  readonly idempotency?: boolean | string;
  /** §110: require the server's current ETag via If-Match. */
  readonly ifMatch?: string;
}

export interface RestTransport {
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
  rawRequest(path: string, options?: RequestOptions): Promise<Response>;
  request<T>(path: string, options?: RequestOptions): Promise<T>;
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

export function createRestTransport(baseUrl: string, fetchImpl?: typeof fetch): RestTransport {
  const impl = fetchImpl ?? globalThis.fetch;

  async function rawRequest(path: string, options: RequestOptions = {}): Promise<Response> {
    const method = options.method ?? 'GET';
    const controller = new AbortController();
    const externalSignal = options.signal;
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(), options.timeoutMs);

    const headers: Record<string, string> = {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(MUTATING_METHODS.has(method) && options.idempotency
        ? { 'Idempotency-Key': typeof options.idempotency === 'string' ? options.idempotency : newIdempotencyKey(method.toLowerCase()) }
        : {}),
      ...(options.ifMatch !== undefined ? { 'If-Match': options.ifMatch } : {}),
      ...(options.headers ?? {}),
    };

    try {
      let response: Response;
      try {
        response = await impl(joinUrl(baseUrl, path), {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          cache: 'no-store',
          signal: controller.signal,
        });
      } catch (error) {
        if (externalSignal?.aborted) throw error;
        if (controller.signal.aborted) {
          throw new AgentOSError(`Request timed out after ${options.timeoutMs ?? 0}ms`, {
            status: 0,
            code: 'REQUEST_TIMEOUT',
          });
        }
        if (error instanceof AgentOSError) throw error;
        throw new AgentOSError(error instanceof Error ? error.message : String(error), { status: 0, code: 'NETWORK_ERROR' });
      }
      if (!response.ok) throw await normalizeError(response);
      return response;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await rawRequest(path, options);
    return response.json() as Promise<T>;
  }

  return { baseUrl, fetchImpl: impl, rawRequest, request };
}
