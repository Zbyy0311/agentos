import type { ApiProblem, ApiOperation, Run } from '@agentos/shared';

/**
 * M3 P4B Basic OpenAPI document (OpenAPI 3.1, spec Part XXXII §208 and
 * §40). This inline TypeScript object is the single authoritative source;
 * both serving endpoints serialize this one value, so the JSON and YAML
 * endpoints can never diverge (JSON is valid YAML 1.2).
 *
 * Truth rules (P4 freeze):
 * - implemented Legacy, current-v2, and canonical route families are each
 *   marked with `x-agentos-route-family`;
 * - future P5 routes (run events / replay / stream) are documented with
 *   `x-agentos-implementation: 'contract-only-future-p5'` and only the 404
 *   they truthfully return today — no 2xx response is advertised;
 * - no route family is described as migrated or retired;
 * - the Web client default is unchanged (Legacy routes remain live).
 */

type JsonObject = Record<string, unknown>;

type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T];
type AssertNever<T extends never> = T;

const API_PROBLEM_REQUIRED = [
  'type',
  'title',
  'status',
  'code',
  'detail',
  'instance',
  'requestId',
  'retryable',
] as const satisfies readonly RequiredKeys<ApiProblem>[];
type _ApiProblemRequiredComplete = AssertNever<
  Exclude<RequiredKeys<ApiProblem>, (typeof API_PROBLEM_REQUIRED)[number]>
>;

const RUN_REQUIRED = [
  'id',
  'workspaceId',
  'taskId',
  'rootRunId',
  'status',
  'reason',
  'origin',
  'nextEventSequence',
  'createdBy',
  'createdAt',
  'updatedAt',
  'version',
] as const satisfies readonly RequiredKeys<Run>[];
type _RunRequiredComplete = AssertNever<
  Exclude<RequiredKeys<Run>, (typeof RUN_REQUIRED)[number]>
>;

const OPERATION_REQUIRED = [
  'id',
  'type',
  'status',
  'workspaceId',
  'aggregateType',
  'aggregateId',
  'runId',
  'correlationId',
  'createdAt',
  'version',
] as const satisfies readonly RequiredKeys<ApiOperation>[];
type _OperationRequiredComplete = AssertNever<
  Exclude<RequiredKeys<ApiOperation>, (typeof OPERATION_REQUIRED)[number]>
>;

const RUN_STATUSES = ['queued', 'starting', 'running', 'waiting_approval', 'paused', 'completed', 'failed', 'cancelled'] as const;
const RUN_REASONS = ['initial', 'retry', 'resume-fallback', 'review-fix', 'provider-comparison', 'manual'] as const;
const OPERATION_STATUSES = ['queued', 'running', 'waiting_approval', 'paused', 'completed', 'failed', 'cancelled'] as const;

const X_REQUEST_ID_RESPONSE_HEADER = {
  description: 'Stable request identifier. Echoed from a valid client X-Request-ID or server-generated; present on every API response (M3 P4A).',
  schema: { type: 'string' },
} as const;

const ETAG_RESPONSE_HEADER = {
  description: 'Strong version ETag of the mutable aggregate, formatted as "vN" (M3 P4A).',
  schema: { type: 'string' },
} as const;

const IDEMPOTENCY_REPLAYED_RESPONSE_HEADER = {
  description: 'Present with the value "true" when the response is the immutable replay of a previously accepted Idempotency-Key.',
  schema: { type: 'string' },
} as const;

const IDEMPOTENCY_KEY_PARAMETER = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description: 'Optional durable idempotency key (8-128 chars, ASCII alphanumeric first, then [A-Za-z0-9._:-]). Replaying the same key with the same normalized request returns the stored original response; the same key with a different request hash returns 409 IDEMPOTENCY_KEY_REUSED.',
  schema: { type: 'string' },
} as const;

const IDEMPOTENCY_KEY_REQUIRED_PARAMETER = {
  ...IDEMPOTENCY_KEY_PARAMETER,
  required: true,
  description: 'Required durable idempotency key, exactly once (M3 P3C Retry freeze).',
} as const;

const IF_MATCH_PARAMETER = {
  name: 'If-Match',
  in: 'header',
  required: false,
  description: 'Optional version precondition in the exact "vN" form. A stale value returns 412 STORAGE_VERSION_CONFLICT. When absent, the body expectedVersion fallback applies and a stale value returns 409 VERSION_CONFLICT. A header/body pair must be consistent (M3 P4A dual mapping).',
  schema: { type: 'string' },
} as const;

function pathParameter(name: string, description: string): JsonObject {
  return { name, in: 'path', required: true, description, schema: { type: 'string' } };
}

function problemResponse(status: number, code: string, extra?: string): JsonObject {
  return {
    description: `${code}${extra ? ` — ${extra}` : ''}`,
    headers: { 'X-Request-ID': X_REQUEST_ID_RESPONSE_HEADER },
    content: {
      'application/problem+json': { schema: { $ref: '#/components/schemas/ApiProblem' } },
    },
    'x-agentos-status': status,
  };
}

function jsonResponse(status: number, description: string, schema: JsonObject, headers?: JsonObject): JsonObject {
  return {
    description,
    headers: { 'X-Request-ID': X_REQUEST_ID_RESPONSE_HEADER, ...(headers ?? {}) },
    content: { 'application/json': { schema } },
    'x-agentos-status': status,
  };
}

function jsonBody(schema: JsonObject, required = true): JsonObject {
  return { required, content: { 'application/json': { schema } } };
}

const RUN_SCHEMA_REF: JsonObject = { $ref: '#/components/schemas/Run' };
const RUN_ENVELOPE_REF: JsonObject = { $ref: '#/components/schemas/RunEnvelope' };
const RUN_DETAIL_ENVELOPE_REF: JsonObject = { $ref: '#/components/schemas/RunDetailEnvelope' };
const OPERATION_SCHEMA_REF: JsonObject = { $ref: '#/components/schemas/Operation' };
const OPERATION_ENVELOPE_REF: JsonObject = { $ref: '#/components/schemas/OperationEnvelope' };
const OPERATION_DATA_ENVELOPE_REF: JsonObject = { $ref: '#/components/schemas/OperationDataEnvelope' };
const RETRY_RUN_ENVELOPE_REF: JsonObject = { $ref: '#/components/schemas/RetryRunEnvelope' };

const IMPLEMENTED = 'implemented';
const P5_CONTRACT_ONLY = 'contract-only-future-p5';

function legacyOperation(summary: string, description: string, extra?: JsonObject): JsonObject {
  return {
    summary,
    description,
    'x-agentos-route-family': 'legacy',
    'x-agentos-implementation': IMPLEMENTED,
    ...extra,
  };
}

function v2Operation(summary: string, description: string, extra?: JsonObject): JsonObject {
  return {
    summary,
    description,
    'x-agentos-route-family': 'v2',
    'x-agentos-implementation': IMPLEMENTED,
    ...extra,
  };
}

function canonicalOperation(summary: string, description: string, extra?: JsonObject): JsonObject {
  return {
    summary,
    description,
    'x-agentos-route-family': 'canonical',
    'x-agentos-implementation': IMPLEMENTED,
    ...extra,
  };
}

function p5Operation(summary: string, description: string, parameters: readonly JsonObject[]): JsonObject {
  return {
    summary,
    description: `${description} NOT YET IMPLEMENTED — the production behavior belongs to M3 P5. Today every request to this path returns 404 NOT_FOUND, which is the only response documented here.`,
    'x-agentos-route-family': 'canonical',
    'x-agentos-implementation': P5_CONTRACT_ONLY,
    parameters: [...parameters],
    responses: {
      '404': problemResponse(404, 'NOT_FOUND', 'Route not found; the P5 behavior is not implemented'),
    },
  };
}

const WORKSPACE_ID_PARAMETER = pathParameter('workspaceId', 'Workspace identifier');
const TASK_ID_PARAMETER = pathParameter('taskId', 'Opaque task identifier');
const RUN_ID_PARAMETER = pathParameter('runId', 'Opaque run identifier');
const OPERATION_ID_PARAMETER = pathParameter('operationId', 'Opaque operation identifier');

export const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'AgentOS Runtime API',
    version: '2.0.0-m3-p4',
    description:
      'M3 P4 runtime API contract. Documents the implemented Legacy, current-v2, and canonical '
      + 'top-level Run/Operation route families exactly as served. Legacy and current-v2 routes are '
      + 'preserved; the Web default is unchanged. Future P5 routes are marked contract-only.',
  },
  'x-agentos-implementation-markers': {
    implemented: IMPLEMENTED,
    contractOnlyFutureP5: P5_CONTRACT_ONLY,
  },
  paths: {
    '/api/workspaces/{workspaceId}/tasks': {
      get: legacyOperation('List legacy tasks', 'Legacy task collection read, preserved unchanged.', {
        parameters: [WORKSPACE_ID_PARAMETER],
        responses: { '200': jsonResponse(200, 'Legacy task list', { type: 'object' }) },
      }),
      post: legacyOperation('Create legacy task', 'Legacy task creation, preserved unchanged; the Legacy bridge maps it to the canonical Task/Run storage.', {
        parameters: [WORKSPACE_ID_PARAMETER],
        requestBody: jsonBody({ type: 'object' }),
        responses: { '201': jsonResponse(201, 'Legacy task created', { type: 'object' }) },
      }),
    },
    '/api/workspaces/{workspaceId}/tasks/{taskId}/run': {
      post: legacyOperation('Run legacy task', 'Legacy task execution entry, preserved unchanged (Legacy pipeline bridge).', {
        parameters: [WORKSPACE_ID_PARAMETER, TASK_ID_PARAMETER],
        responses: { '200': jsonResponse(200, 'Legacy run accepted', { type: 'object' }) },
      }),
    },
    '/api/workspaces/{workspaceId}/runs/{runId}': {
      get: legacyOperation('Get legacy run', 'Legacy run read, preserved unchanged.', {
        parameters: [WORKSPACE_ID_PARAMETER, RUN_ID_PARAMETER],
        responses: { '200': jsonResponse(200, 'Legacy run detail', { type: 'object' }) },
      }),
    },
    '/api/workspaces/{workspaceId}/v2/tasks': {
      get: v2Operation('List v2 tasks', 'Current-v2 task collection read.', {
        parameters: [WORKSPACE_ID_PARAMETER],
        responses: { '200': jsonResponse(200, 'Task list', { type: 'object' }) },
      }),
      post: v2Operation('Create v2 task', 'Current-v2 task creation with durable idempotency.', {
        parameters: [WORKSPACE_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: jsonBody({ $ref: '#/components/schemas/CreateV2TaskRequest' }),
        responses: {
          '201': jsonResponse(201, 'Task created', { type: 'object' }, { 'Idempotency-Replayed': IDEMPOTENCY_REPLAYED_RESPONSE_HEADER }),
          '400': problemResponse(400, 'VALIDATION_FAILED'),
          '404': problemResponse(404, 'WORKSPACE_NOT_FOUND'),
          '409': problemResponse(409, 'IDEMPOTENCY_KEY_REUSED'),
        },
      }),
    },
    '/api/workspaces/{workspaceId}/v2/tasks/{taskId}': {
      get: v2Operation('Get v2 task', 'Current-v2 task read emitting the P4A version ETag.', {
        parameters: [WORKSPACE_ID_PARAMETER, TASK_ID_PARAMETER],
        responses: {
          '200': jsonResponse(200, 'Task detail', { type: 'object' }, { ETag: ETAG_RESPONSE_HEADER }),
          '404': problemResponse(404, 'TASK_NOT_FOUND'),
        },
      }),
    },
    '/api/workspaces/{workspaceId}/v2/tasks/{taskId}/runs': {
      get: v2Operation('List v2 task runs', 'Current-v2 run collection read for a task.', {
        parameters: [WORKSPACE_ID_PARAMETER, TASK_ID_PARAMETER],
        responses: { '200': jsonResponse(200, 'Run list', { type: 'object' }) },
      }),
      post: v2Operation('Create v2 run', 'Current-v2 run creation with durable idempotency. The canonical POST /api/tasks/{taskId}/runs delegates to the same application behavior.', {
        parameters: [WORKSPACE_ID_PARAMETER, TASK_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: jsonBody({ $ref: '#/components/schemas/CreateRunRequest' }),
        responses: {
          '201': jsonResponse(201, 'Run created (queued)', RUN_ENVELOPE_REF, { 'Idempotency-Replayed': IDEMPOTENCY_REPLAYED_RESPONSE_HEADER }),
          '400': problemResponse(400, 'VALIDATION_FAILED'),
          '404': problemResponse(404, 'TASK_NOT_FOUND'),
          '409': problemResponse(409, 'RUN_ACTIVE_EXISTS or IDEMPOTENCY_KEY_REUSED'),
        },
      }),
    },
    '/api/workspaces/{workspaceId}/v2/tasks/{taskId}/accept': {
      post: v2Operation('Accept v2 task run', 'Current-v2 acceptance window command; If-Match precondition with body expectedVersion fallback.', {
        parameters: [WORKSPACE_ID_PARAMETER, TASK_ID_PARAMETER, IF_MATCH_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        responses: {
          '200': jsonResponse(200, 'Task accepted', { type: 'object' }),
          '409': problemResponse(409, 'VERSION_CONFLICT', 'body-sourced precondition failure'),
          '412': problemResponse(412, 'STORAGE_VERSION_CONFLICT', 'If-Match precondition failure'),
        },
      }),
    },
    '/api/workspaces/{workspaceId}/v2/tasks/{taskId}/cancel': {
      post: v2Operation('Cancel v2 task', 'Current-v2 task cancel; If-Match precondition with body expectedVersion fallback.', {
        parameters: [WORKSPACE_ID_PARAMETER, TASK_ID_PARAMETER, IF_MATCH_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        responses: {
          '200': jsonResponse(200, 'Task cancelled', { type: 'object' }),
          '409': problemResponse(409, 'VERSION_CONFLICT'),
          '412': problemResponse(412, 'STORAGE_VERSION_CONFLICT'),
        },
      }),
    },
    '/api/workspaces/{workspaceId}/v2/tasks/{taskId}/reopen': {
      post: v2Operation('Reopen v2 task', 'Current-v2 task reopen; If-Match precondition with body expectedVersion fallback.', {
        parameters: [WORKSPACE_ID_PARAMETER, TASK_ID_PARAMETER, IF_MATCH_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        responses: {
          '200': jsonResponse(200, 'Task reopened', { type: 'object' }),
          '409': problemResponse(409, 'VERSION_CONFLICT'),
          '412': problemResponse(412, 'STORAGE_VERSION_CONFLICT'),
        },
      }),
    },
    '/api/workspaces/{workspaceId}/v2/runs/{runId}': {
      get: v2Operation('Get v2 run', 'Current-v2 run detail emitting the P4A version ETag; include=stages,snapshot expands the stored snapshot.', {
        parameters: [
          WORKSPACE_ID_PARAMETER,
          RUN_ID_PARAMETER,
          { name: 'include', in: 'query', required: false, schema: { type: 'string' }, description: 'Comma-separated expansions: stages, snapshot.' },
        ],
        responses: {
          '200': jsonResponse(200, 'Run detail', RUN_DETAIL_ENVELOPE_REF, { ETag: ETAG_RESPONSE_HEADER }),
          '400': problemResponse(400, 'VALIDATION_FAILED'),
          '404': problemResponse(404, 'RUN_NOT_FOUND'),
        },
      }),
    },
    '/api/workspaces/{workspaceId}/v2/runs/{runId}/cancel': {
      post: v2Operation('Cancel v2 run', 'Current-v2 queued-run cancel with durable idempotency; If-Match precondition with body expectedVersion fallback. The canonical POST /api/runs/{runId}/cancel delegates to the same application behavior.', {
        parameters: [WORKSPACE_ID_PARAMETER, RUN_ID_PARAMETER, IF_MATCH_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: jsonBody({ $ref: '#/components/schemas/CancelRunRequest' }, false),
        responses: {
          '200': jsonResponse(200, 'Run cancelled', RUN_ENVELOPE_REF, { 'Idempotency-Replayed': IDEMPOTENCY_REPLAYED_RESPONSE_HEADER }),
          '400': problemResponse(400, 'VALIDATION_FAILED'),
          '404': problemResponse(404, 'RUN_NOT_FOUND'),
          '409': problemResponse(409, 'VERSION_CONFLICT / RUN_NOT_CANCELLABLE / IDEMPOTENCY_KEY_REUSED'),
          '412': problemResponse(412, 'STORAGE_VERSION_CONFLICT', 'If-Match precondition failure'),
        },
      }),
    },
    '/api/tasks/{taskId}/runs': {
      post: canonicalOperation('Create run', 'Canonical run creation (M3 P4B). Delegates to the same TaskRunService application behavior and durable idempotency chain as the current-v2 route; the owning workspace is resolved from the opaque taskId. Returns the created queued run (201).', {
        parameters: [TASK_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: jsonBody({ $ref: '#/components/schemas/CreateRunRequest' }, false),
        responses: {
          '201': jsonResponse(201, 'Run created (queued)', RUN_ENVELOPE_REF, { 'Idempotency-Replayed': IDEMPOTENCY_REPLAYED_RESPONSE_HEADER }),
          '400': problemResponse(400, 'VALIDATION_FAILED'),
          '404': problemResponse(404, 'TASK_NOT_FOUND'),
          '409': problemResponse(409, 'RUN_ACTIVE_EXISTS or IDEMPOTENCY_KEY_REUSED'),
        },
      }),
    },
    '/api/runs/{runId}': {
      get: canonicalOperation('Get run', 'Canonical run read (M3 P4B). Emits the P4A version ETag "vN" for the mutable Run aggregate; include=stages,snapshot behaves exactly like the current-v2 read.', {
        parameters: [
          RUN_ID_PARAMETER,
          { name: 'include', in: 'query', required: false, schema: { type: 'string' }, description: 'Comma-separated expansions: stages, snapshot.' },
        ],
        responses: {
          '200': jsonResponse(200, 'Run detail', RUN_DETAIL_ENVELOPE_REF, { ETag: ETAG_RESPONSE_HEADER }),
          '400': problemResponse(400, 'VALIDATION_FAILED'),
          '404': problemResponse(404, 'RUN_NOT_FOUND'),
        },
      }),
    },
    '/api/runs/{runId}/cancel': {
      post: canonicalOperation('Cancel run', 'Canonical queued-run cancel (M3 P4B). Delegates to the same TaskRunService application behavior as the current-v2 route. If-Match stale returns 412 STORAGE_VERSION_CONFLICT; the body expectedVersion fallback stays 409 VERSION_CONFLICT (P4A dual mapping).', {
        parameters: [RUN_ID_PARAMETER, IF_MATCH_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: jsonBody({ $ref: '#/components/schemas/CancelRunRequest' }, false),
        responses: {
          '200': jsonResponse(200, 'Run cancelled', RUN_ENVELOPE_REF, { 'Idempotency-Replayed': IDEMPOTENCY_REPLAYED_RESPONSE_HEADER }),
          '400': problemResponse(400, 'VALIDATION_FAILED'),
          '404': problemResponse(404, 'RUN_NOT_FOUND'),
          '409': problemResponse(409, 'VERSION_CONFLICT / RUN_NOT_CANCELLABLE / IDEMPOTENCY_KEY_REUSED'),
          '412': problemResponse(412, 'STORAGE_VERSION_CONFLICT', 'If-Match precondition failure'),
        },
      }),
    },
    '/api/runs/{runId}/start': {
      post: canonicalOperation('Start run', 'Canonical asynchronous run start (M3 P3C, reused unchanged). Queues a Start Operation and returns 202; the Run remains queued at acceptance. Idempotency-Key is optional; replay returns the original 202 queued Operation snapshot. Body-only expectedVersion (If-Match is not evaluated here).', {
        parameters: [RUN_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: jsonBody({ $ref: '#/components/schemas/StartRunRequest' }),
        responses: {
          '202': jsonResponse(202, 'Start accepted', OPERATION_ENVELOPE_REF, { 'Idempotency-Replayed': IDEMPOTENCY_REPLAYED_RESPONSE_HEADER }),
          '400': problemResponse(400, 'VALIDATION_FAILED'),
          '404': problemResponse(404, 'RUN_NOT_FOUND'),
          '409': problemResponse(409, 'VERSION_CONFLICT / RUN_START_ALREADY_ACTIVE / IDEMPOTENCY_KEY_REUSED'),
          '503': problemResponse(503, 'RUN_START_BUSY'),
        },
      }),
    },
    '/api/runs/{runId}/retry': {
      post: canonicalOperation('Retry run', 'Canonical run retry (M3 P3C Option A, reused unchanged). Requires a failed Parent Run at the exact body expectedVersion; creates a queued Child Run and a completed Retry Operation (201). Retry does not authorize the Engine — the Child requires an independent run.start. Idempotency-Key is required exactly once.', {
        parameters: [RUN_ID_PARAMETER, IDEMPOTENCY_KEY_REQUIRED_PARAMETER],
        requestBody: jsonBody({ $ref: '#/components/schemas/RetryRunRequest' }),
        responses: {
          '201': jsonResponse(201, 'Retry accepted', RETRY_RUN_ENVELOPE_REF, { 'Idempotency-Replayed': IDEMPOTENCY_REPLAYED_RESPONSE_HEADER }),
          '400': problemResponse(400, 'VALIDATION_FAILED'),
          '404': problemResponse(404, 'RUN_NOT_FOUND'),
          '409': problemResponse(409, 'VERSION_CONFLICT / RUN_NOT_RETRYABLE / RUN_RETRY_ALREADY_CREATED / RUN_ACTIVE_EXISTS / IDEMPOTENCY_KEY_REUSED'),
          '503': problemResponse(503, 'RUN_RETRY_BUSY'),
        },
      }),
    },
    '/api/operations/{operationId}': {
      get: canonicalOperation('Get operation', 'Canonical operation read (M3 P3D, reused unchanged). Emits the P4A version ETag for the Operation aggregate.', {
        parameters: [OPERATION_ID_PARAMETER],
        responses: {
          '200': jsonResponse(200, 'Operation detail', OPERATION_DATA_ENVELOPE_REF, { ETag: ETAG_RESPONSE_HEADER }),
          '404': problemResponse(404, 'OPERATION_NOT_FOUND'),
        },
      }),
    },
    '/api/operations/{operationId}/events': {
      get: canonicalOperation('Get operation events', 'Canonical operation event query (M3 P3D, reused unchanged). Returns only the persisted runtime events correlated to this operation, in ascending sequence.', {
        parameters: [OPERATION_ID_PARAMETER],
        responses: {
          '200': jsonResponse(200, 'Correlated events', { $ref: '#/components/schemas/OperationEventsEnvelope' }),
          '404': problemResponse(404, 'OPERATION_NOT_FOUND'),
        },
      }),
    },
    '/api/operations/{operationId}/cancel': {
      post: canonicalOperation('Cancel operation', 'Canonical operation cancel (M3 P3D, reused unchanged). Body-only expectedVersion transport: the P3D freeze does not accept ETag/If-Match as the canonical version transport on this endpoint. Stale non-cancelled versions return 409 VERSION_CONFLICT; an already-cancelled operation is a stable 200 no-op.', {
        parameters: [OPERATION_ID_PARAMETER],
        requestBody: jsonBody({ $ref: '#/components/schemas/OperationCancelRequest' }),
        responses: {
          '200': jsonResponse(200, 'Operation cancelled (or already cancelled)', OPERATION_DATA_ENVELOPE_REF),
          '400': problemResponse(400, 'VALIDATION_FAILED'),
          '404': problemResponse(404, 'OPERATION_NOT_FOUND'),
          '409': problemResponse(409, 'VERSION_CONFLICT / OPERATION_NOT_CANCELLABLE'),
        },
      }),
    },
    '/api/runs/{runId}/events': {
      get: p5Operation('Get run events', 'Contract reference (spec §86): durable run event page query with afterSequence/beforeSequence/limit/types/stageId/severity/visibility/source/correlationId filters returning a RuntimeEventPage.', [RUN_ID_PARAMETER]),
    },
    '/api/runs/{runId}/replay': {
      get: p5Operation('Replay run', 'Contract reference (spec §88): deterministic replay projection with fromSequence/toSequence/types/stageId/includeArtifacts filters.', [RUN_ID_PARAMETER]),
    },
    '/api/runs/{runId}/stream': {
      get: p5Operation('Stream run events', 'Contract reference (spec §89): live SSE stream with Last-Event-ID resume.', [RUN_ID_PARAMETER]),
    },
  },
  components: {
    schemas: {
      ApiProblem: {
        type: 'object',
        description: 'Stable HTTP problem envelope (application/problem+json). Clients must rely on code, never on detail.',
        required: [...API_PROBLEM_REQUIRED],
        properties: {
          type: { type: 'string', description: 'Deterministic urn:agentos:error:<code> URI.' },
          title: { type: 'string' },
          status: { type: 'integer' },
          code: { type: 'string', description: 'Stable machine-readable error code.' },
          detail: { type: 'string', description: 'Sanitized human-readable summary; never leaks internals.' },
          instance: { type: 'string', description: 'Path-only request URI; the query string is never reflected.' },
          requestId: { type: 'string', description: 'Matches the X-Request-ID response header.' },
          retryable: { type: 'boolean' },
          retryAfterMs: { type: 'integer' },
          suggestedAction: { type: 'string' },
          errors: { type: 'array', items: { $ref: '#/components/schemas/ApiProblemFieldError' } },
          context: { type: 'object', description: 'Optional aggregate identifiers (workspaceId/taskId/runId/stageId/operationId/...).' },
        },
      },
      ApiProblemFieldError: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          field: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      Run: {
        type: 'object',
        required: [...RUN_REQUIRED],
        properties: {
          id: { type: 'string' },
          workspaceId: { type: 'string' },
          taskId: { type: 'string' },
          parentRunId: { type: 'string' },
          rootRunId: { type: 'string' },
          status: { type: 'string', enum: [...RUN_STATUSES] },
          reason: { type: 'string', enum: [...RUN_REASONS] },
          origin: { type: 'string', enum: ['v2_api', 'legacy_pipeline'] },
          objective: { type: 'string' },
          failureCode: { type: 'string' },
          failureMessage: { type: 'string' },
          cancellationRequestedAt: { type: 'string' },
          recoveryRequired: { type: 'boolean' },
          nextEventSequence: { type: 'integer' },
          startedAt: { type: 'string' },
          completedAt: { type: 'string' },
          createdBy: { type: 'string' },
          createdAt: { type: 'string' },
          updatedAt: { type: 'string' },
          version: { type: 'integer', description: 'Optimistic-concurrency version; the ETag is "vN".' },
        },
      },
      RunEnvelope: {
        type: 'object',
        required: ['run'],
        properties: { run: RUN_SCHEMA_REF },
      },
      RunDetailEnvelope: {
        type: 'object',
        required: ['run', 'snapshotAvailable', 'snapshotSchemaVersion'],
        properties: {
          run: RUN_SCHEMA_REF,
          snapshotAvailable: { type: 'boolean' },
          snapshotSchemaVersion: { type: ['integer', 'null'] },
          snapshot: { type: ['object', 'null'], description: 'Present only with include=snapshot.' },
          contentHash: { type: ['string', 'null'], description: 'Present only with include=snapshot.' },
          stages: { type: 'array', items: { type: 'object' }, description: 'Present only with include=stages.' },
        },
      },
      Operation: {
        type: 'object',
        required: [...OPERATION_REQUIRED],
        properties: {
          id: { type: 'string' },
          type: { type: 'string', description: 'e.g. run.start, run.retry, run.cancel.' },
          status: { type: 'string', enum: [...OPERATION_STATUSES] },
          workspaceId: { type: 'string' },
          aggregateType: { type: 'string', enum: ['run'] },
          aggregateId: { type: 'string' },
          runId: { type: 'string' },
          correlationId: { type: 'string', description: 'Persisted correlation binding for the operation event query.' },
          progress: { type: 'object', description: 'ABSENT in the current M3 implementation.' },
          result: { type: 'object' },
          error: { $ref: '#/components/schemas/ApiProblem' },
          createdAt: { type: 'string' },
          startedAt: { type: 'string' },
          completedAt: { type: 'string' },
          version: { type: 'integer', description: 'Optimistic-concurrency version; the ETag is "vN".' },
        },
      },
      OperationEnvelope: {
        type: 'object',
        required: ['operation'],
        properties: { operation: { $ref: '#/components/schemas/Operation' } },
        description: 'run.start acceptance envelope: the queued Operation snapshot (version 1).',
      },
      OperationDataEnvelope: {
        type: 'object',
        required: ['data'],
        properties: { data: { $ref: '#/components/schemas/Operation' } },
      },
      RetryRunEnvelope: {
        type: 'object',
        required: ['run', 'operation'],
        properties: {
          run: { ...RUN_SCHEMA_REF, description: 'The queued Child Run (version 1).' },
          operation: { ...OPERATION_SCHEMA_REF, description: 'The completed Retry Operation (version 3).' },
        },
      },
      OperationEventsEnvelope: {
        type: 'object',
        required: ['events', 'hasMore'],
        properties: {
          events: { type: 'array', items: { type: 'object' }, description: 'Persisted runtime events bound to this operation correlation, ascending sequence.' },
          hasMore: { type: 'boolean', enum: [false] },
        },
      },
      CreateRunRequest: {
        type: 'object',
        description: 'Implemented subset of the spec CreateRunRequest; unsupported spec fields are not part of the M3 contract.',
        properties: {
          reason: { type: 'string', enum: [...RUN_REASONS] },
          parentRunId: { type: 'string' },
          objective: { type: 'string' },
          createdBy: { type: 'string', description: 'Defaults to v2_api.' },
        },
      },
      CreateV2TaskRequest: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
          sourceConversationId: { type: 'string' },
          sourceMessageId: { type: 'string' },
          createdBy: { type: 'string', description: 'Defaults to v2_api.' },
        },
      },
      StartRunRequest: {
        type: 'object',
        description: 'Empty object or the optional body-only expectedVersion; unknown fields return 400 VALIDATION_FAILED.',
        properties: {
          expectedVersion: { type: 'integer', minimum: 1 },
        },
      },
      RetryRunRequest: {
        type: 'object',
        required: ['expectedVersion'],
        description: 'Exactly one field: the Parent Run version (positive safe integer).',
        properties: {
          expectedVersion: { type: 'integer', minimum: 1 },
        },
      },
      CancelRunRequest: {
        type: 'object',
        description: 'Optional body expectedVersion fallback; inconsistent If-Match/body pairs return 400.',
        properties: {
          expectedVersion: { type: 'integer', minimum: 1 },
        },
      },
      OperationCancelRequest: {
        type: 'object',
        required: ['expectedVersion'],
        description: 'Exactly one field: the Operation version (P3D body-only freeze).',
        properties: {
          expectedVersion: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
} as const;

/** Deterministic serialization of the single authoritative document. */
export function serializeOpenApiDocument(): string {
  return JSON.stringify(OPENAPI_DOCUMENT, null, 2);
}
