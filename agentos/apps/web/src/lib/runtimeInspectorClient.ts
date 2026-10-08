import type { InspectorProjectionDto } from '../components/chat/RuntimeInspectorView';

export interface RuntimeInspectorClientOptions {
  readonly workspaceId: string;
  readonly apiBase: string;
}

export interface RetryRunResponse {
  readonly run?: { readonly id?: string };
  readonly operation?: unknown;
}

export function buildRunInspectorUrl(apiBase: string, workspaceId: string, runId: string): string {
  const root = apiBase.replace(/\/+$/, '');
  return `${root}/api/workspaces/${encodeURIComponent(workspaceId)}/runtime/runs/${encodeURIComponent(runId)}/inspector`;
}

async function responseError(response: Response): Promise<Error & { readonly status?: number }> {
  const body = await response.json().catch(() => ({})) as {
    readonly error?: string;
    readonly detail?: string;
    readonly title?: string;
  };
  const error = new Error(body.error ?? body.detail ?? body.title ?? `HTTP ${response.status}`) as Error & { status?: number };
  error.status = response.status;
  return error;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<T>;
}

function jsonPostHeaders(idempotencyKey?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
  };
}

export function createInspectorIdempotencyKey(action: 'cancel' | 'retry'): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${action}-${uuid ?? Date.now().toString(36)}`;
}

export function runtimeInspectorClient(options: RuntimeInspectorClientOptions) {
  const root = options.apiBase.replace(/\/+$/, '');
  const workspace = encodeURIComponent(options.workspaceId);
  const runtimeBase = `${root}/api/workspaces/${workspace}/runtime`;
  const apiBase = `${root}/api`;

  return {
    inspectRun: async (runId: string, signal?: AbortSignal): Promise<InspectorProjectionDto> => {
      const body = await requestJson<{ readonly projection: InspectorProjectionDto }>(
        buildRunInspectorUrl(options.apiBase, options.workspaceId, runId),
        { ...(signal === undefined ? {} : { signal }) },
      );
      return body.projection;
    },
    cancelOperation: (operationId: string, expectedVersion: number) => requestJson<{ readonly data: unknown }>(
      `${apiBase}/operations/${encodeURIComponent(operationId)}/cancel`,
      {
        method: 'POST',
        headers: jsonPostHeaders(),
        body: JSON.stringify({ expectedVersion }),
      },
    ),
    cancelQueuedRun: (runId: string, expectedVersion: number, idempotencyKey: string) => requestJson<unknown>(
      `${apiBase}/runs/${encodeURIComponent(runId)}/cancel`,
      {
        method: 'POST',
        headers: jsonPostHeaders(idempotencyKey),
        body: JSON.stringify({ expectedVersion }),
      },
    ),
    retryRun: (runId: string, expectedVersion: number, idempotencyKey: string) => requestJson<RetryRunResponse>(
      `${apiBase}/runs/${encodeURIComponent(runId)}/retry`,
      {
        method: 'POST',
        headers: jsonPostHeaders(idempotencyKey),
        body: JSON.stringify({ expectedVersion }),
      },
    ),
    runtimeBase,
  };
}

export type RuntimeInspectorClient = ReturnType<typeof runtimeInspectorClient>;
