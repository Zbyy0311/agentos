import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  createApiNotFoundHandler,
  createProblemErrorHandler,
  createRequestIdMiddleware,
} from '../problemDetails.js';
import { createOpenApiRoutes } from '../routes/openapi.js';

/**
 * M3 P4B Basic OpenAPI contract tests. The document is fetched over HTTP
 * from the same serving route used in production (index.ts mounts the
 * OpenAPI router at /api), so every assertion validates the actual served
 * artifact rather than a disconnected file.
 *
 * Truth rules under test:
 * - implemented Legacy / current-v2 / canonical paths are represented;
 * - future P5 routes are explicitly marked contract-only and are never
 *   advertised with an implemented (2xx) response;
 * - ApiProblem, Run, and Operation schemas exist;
 * - ETag / If-Match / Idempotency-Key / X-Request-ID are documented.
 */

function isFetchBadPortError(error: unknown): boolean {
  return (error as { cause?: { message?: unknown } } | null)?.cause?.message === 'bad port';
}

async function closeTestServer(server: ReturnType<express.Express['listen']>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function listenOnFetchSafePort(app: express.Express): Promise<{ server: ReturnType<express.Express['listen']>; origin: string }> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
      const origin = `http://127.0.0.1:${address.port}`;
      const probe = await fetch(`${origin}/__test_fetch_port_probe`, { method: 'HEAD' });
      if (probe.status !== 204) throw new Error(`test fetch probe returned ${probe.status}`);
      return { server, origin };
    } catch (error) {
      await closeTestServer(server);
      if (!isFetchBadPortError(error)) throw error;
    }
  }
  throw new Error('TEST_FETCH_SAFE_PORT_UNAVAILABLE');
}

interface Fixture {
  server: ReturnType<express.Express['listen']>;
  baseApi: string;
}

async function createFixture(): Promise<Fixture> {
  const app = express();
  app.use(createRequestIdMiddleware());
  app.head('/__test_fetch_port_probe', (_req, res) => {
    res.setHeader('Connection', 'close');
    res.status(204).end();
  });
  // P4B OpenAPI serving mount point (mirrors index.ts).
  app.use('/api', createOpenApiRoutes());
  app.use('/api', createApiNotFoundHandler());
  app.use(createProblemErrorHandler());
  const { server, origin } = await listenOnFetchSafePort(app);
  return { server, baseApi: `${origin}/api` };
}

async function closeFixture(fx: Fixture): Promise<void> {
  await closeTestServer(fx.server);
}

interface DocResponse {
  status: number;
  contentType: string;
  text: string;
}

async function fetchRaw(fx: Fixture, path: string): Promise<DocResponse> {
  const response = await fetch(`${fx.baseApi}${path}`);
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    text: await response.text(),
  };
}

interface OpenApiOperation {
  readonly summary?: string;
  readonly description?: string;
  readonly parameters?: readonly Record<string, unknown>[];
  readonly responses?: Record<string, Record<string, unknown>>;
  readonly [key: string]: unknown;
}

interface OpenApiDocument {
  readonly openapi?: string;
  readonly info?: { readonly title?: unknown; readonly version?: unknown };
  readonly paths?: Record<string, Record<string, OpenApiOperation>>;
  readonly components?: {
    readonly schemas?: Record<string, {
      readonly required?: readonly string[];
      readonly properties?: Record<string, unknown>;
    }>;
  };
}

async function fetchDocument(fx: Fixture): Promise<OpenApiDocument> {
  const raw = await fetchRaw(fx, '/openapi.json');
  assert.equal(raw.status, 200, `openapi.json must be served, got ${raw.status}`);
  return JSON.parse(raw.text) as OpenApiDocument;
}

function operationAt(doc: OpenApiDocument, path: string, method: string): OpenApiOperation {
  const pathItem = doc.paths?.[path];
  assert.ok(pathItem, `path ${path} must be documented`);
  const operation = pathItem[method];
  assert.ok(operation, `${method.toUpperCase()} ${path} must be documented`);
  return operation;
}

function headerParameterNames(operation: OpenApiOperation): string[] {
  return (operation.parameters ?? [])
    .filter(parameter => parameter.in === 'header')
    .map(parameter => String(parameter.name).toLowerCase());
}

test('P4B-R13 GET /api/openapi.json serves the OpenAPI 3.1 document', async () => {
  const fx = await createFixture();
  try {
    const raw = await fetchRaw(fx, '/openapi.json');
    assert.equal(raw.status, 200);
    assert.ok(raw.contentType.startsWith('application/json'), `unexpected content type ${raw.contentType}`);
    const doc = JSON.parse(raw.text) as OpenApiDocument;
    assert.equal(doc.openapi, '3.1.0');
    assert.equal(typeof doc.info?.title, 'string');
    assert.equal(typeof doc.info?.version, 'string');
    assert.ok(doc.paths && Object.keys(doc.paths).length > 0, 'paths object must exist');
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R13 GET /api/openapi.yaml serves the identical document as application/yaml', async () => {
  const fx = await createFixture();
  try {
    const json = await fetchRaw(fx, '/openapi.json');
    const yaml = await fetchRaw(fx, '/openapi.yaml');
    assert.equal(yaml.status, 200);
    assert.ok(yaml.contentType.startsWith('application/yaml'), `unexpected content type ${yaml.contentType}`);
    assert.equal(yaml.text, json.text, 'one authoritative document must back both endpoints');
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R14 implemented canonical P4 paths are represented', async () => {
  const fx = await createFixture();
  try {
    const doc = await fetchDocument(fx);
    const canonical: readonly (readonly [string, string])[] = [
      ['/api/tasks/{taskId}/runs', 'post'],
      ['/api/runs/{runId}', 'get'],
      ['/api/runs/{runId}/cancel', 'post'],
      ['/api/runs/{runId}/start', 'post'],
      ['/api/runs/{runId}/retry', 'post'],
      ['/api/operations/{operationId}', 'get'],
      ['/api/operations/{operationId}/events', 'get'],
      ['/api/operations/{operationId}/cancel', 'post'],
    ];
    for (const [path, method] of canonical) {
      const operation = operationAt(doc, path, method);
      assert.notEqual(
        operation['x-agentos-implementation'],
        'contract-only-future-p5',
        `${method.toUpperCase()} ${path} is implemented and must not be marked contract-only`,
      );
    }
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R14 implemented legacy and current-v2 families are represented', async () => {
  const fx = await createFixture();
  try {
    const doc = await fetchDocument(fx);
    operationAt(doc, '/api/workspaces/{workspaceId}/tasks', 'post');
    operationAt(doc, '/api/workspaces/{workspaceId}/tasks', 'get');
    operationAt(doc, '/api/workspaces/{workspaceId}/v2/tasks', 'post');
    operationAt(doc, '/api/workspaces/{workspaceId}/v2/tasks/{taskId}/runs', 'post');
    operationAt(doc, '/api/workspaces/{workspaceId}/v2/runs/{runId}', 'get');
    operationAt(doc, '/api/workspaces/{workspaceId}/v2/runs/{runId}/cancel', 'post');
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R15 future P5 routes are marked contract-only and never advertise a 2xx response', async () => {
  const fx = await createFixture();
  try {
    const doc = await fetchDocument(fx);
    for (const path of ['/api/runs/{runId}/events', '/api/runs/{runId}/replay', '/api/runs/{runId}/stream']) {
      const operation = operationAt(doc, path, 'get');
      assert.equal(
        operation['x-agentos-implementation'],
        'contract-only-future-p5',
        `${path} must be marked as a future P5 contract`,
      );
      const responses = Object.keys(operation.responses ?? {});
      assert.ok(responses.length > 0, `${path} must document its current truthful response`);
      for (const status of responses) {
        assert.ok(!status.startsWith('2'), `${path} must not advertise implemented response ${status}`);
      }
      assert.ok(responses.includes('404'), `${path} currently returns 404 and must say so`);
    }
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R14 ApiProblem schema matches the shared contract', async () => {
  const fx = await createFixture();
  try {
    const doc = await fetchDocument(fx);
    const schema = doc.components?.schemas?.ApiProblem;
    assert.ok(schema, 'ApiProblem schema must exist');
    const required = [...(schema.required ?? [])].sort();
    assert.deepEqual(required, ['code', 'detail', 'instance', 'requestId', 'retryable', 'status', 'title', 'type']);
    const properties = Object.keys(schema.properties ?? {});
    for (const field of ['type', 'title', 'status', 'code', 'detail', 'instance', 'requestId', 'retryable', 'errors', 'context']) {
      assert.ok(properties.includes(field), `ApiProblem must document ${field}`);
    }
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R14 Run and Operation schemas exist with their version fields', async () => {
  const fx = await createFixture();
  try {
    const doc = await fetchDocument(fx);
    const run = doc.components?.schemas?.Run;
    assert.ok(run, 'Run schema must exist');
    for (const field of ['id', 'taskId', 'status', 'version']) {
      assert.ok(run.required?.includes(field), `Run schema must require ${field}`);
    }
    const operation = doc.components?.schemas?.Operation;
    assert.ok(operation, 'Operation schema must exist');
    for (const field of ['id', 'type', 'status', 'version']) {
      assert.ok(operation.required?.includes(field), `Operation schema must require ${field}`);
    }
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R14 ETag, If-Match, Idempotency-Key, and X-Request-ID are documented', async () => {
  const fx = await createFixture();
  try {
    const doc = await fetchDocument(fx);
    const getRun = operationAt(doc, '/api/runs/{runId}', 'get');
    const okHeaders = Object.keys(getRun.responses?.['200']?.headers ?? {}).map(name => name.toLowerCase());
    assert.ok(okHeaders.includes('etag'), 'Get Run must document the ETag response header');
    assert.ok(okHeaders.includes('x-request-id'), 'Get Run must document the X-Request-ID response header');

    const cancel = operationAt(doc, '/api/runs/{runId}/cancel', 'post');
    const cancelHeaders = headerParameterNames(cancel);
    assert.ok(cancelHeaders.includes('if-match'), 'Cancel Run must document If-Match');
    assert.ok(cancelHeaders.includes('idempotency-key'), 'Cancel Run must document Idempotency-Key');

    const createRun = operationAt(doc, '/api/tasks/{taskId}/runs', 'post');
    assert.ok(headerParameterNames(createRun).includes('idempotency-key'), 'Create Run must document Idempotency-Key');
    const start = operationAt(doc, '/api/runs/{runId}/start', 'post');
    assert.ok(headerParameterNames(start).includes('idempotency-key'), 'Start must document Idempotency-Key');
    const retry = operationAt(doc, '/api/runs/{runId}/retry', 'post');
    assert.ok(headerParameterNames(retry).includes('idempotency-key'), 'Retry must document Idempotency-Key');
  } finally {
    await closeFixture(fx);
  }
});
