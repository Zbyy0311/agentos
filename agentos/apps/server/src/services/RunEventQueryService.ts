import {
  RUNTIME_EVENT_SEVERITIES,
  RUNTIME_EVENT_SOURCES,
  RUNTIME_EVENT_VISIBILITIES,
  type RunEventsQuery,
  type RuntimeEventPage,
  type RuntimeEventSeverity,
  type RuntimeEventSource,
  type RuntimeEventVisibility,
} from '@agentos/shared';
import type { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';

export type P5QueryErrorCode = 'VALIDATION_FAILED' | 'INPUT_ENUM_INVALID' | 'EVENT_VISIBILITY_FORBIDDEN';

export class P5QueryError extends Error {
  constructor(readonly code: P5QueryErrorCode, message: string) {
    super(message);
    this.name = 'P5QueryError';
  }
}

const EVENT_QUERY_KEYS = new Set([
  'afterSequence',
  'beforeSequence',
  'limit',
  'types',
  'stageId',
  'severity',
  'visibility',
  'source',
  'correlationId',
]);

export function parseSingleQueryValue(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new P5QueryError('VALIDATION_FAILED', `${field} is invalid`);
  }
  return value;
}

export function parseNonNegativeInteger(value: unknown, field: string, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  const raw = parseSingleQueryValue(value, field)!;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new P5QueryError('VALIDATION_FAILED', `${field} is invalid`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new P5QueryError('VALIDATION_FAILED', `${field} is invalid`);
  return parsed;
}

export function parsePositiveInteger(value: unknown, field: string, fallback?: number): number | undefined {
  const parsed = parseNonNegativeInteger(value, field, fallback);
  if (parsed !== undefined && parsed < 1) throw new P5QueryError('VALIDATION_FAILED', `${field} is invalid`);
  return parsed;
}

export function parseTypes(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const raw = parseSingleQueryValue(value, 'types')!;
  const types = raw.split(',').map(item => item.trim());
  if (types.some(item => item.length === 0)) throw new P5QueryError('VALIDATION_FAILED', 'types is invalid');
  const deduplicated = [...new Set(types)];
  if (deduplicated.length > 50) throw new P5QueryError('VALIDATION_FAILED', 'types is invalid');
  return deduplicated;
}

function parseExactIdentifier(value: unknown, field: string): string | undefined {
  const parsed = parseSingleQueryValue(value, field);
  if (parsed !== undefined && parsed.trim() !== parsed) {
    throw new P5QueryError('VALIDATION_FAILED', `${field} is invalid`);
  }
  return parsed;
}

function parseEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  const parsed = parseSingleQueryValue(value, field);
  if (parsed === undefined) return undefined;
  if (!allowed.includes(parsed as T)) throw new P5QueryError('INPUT_ENUM_INVALID', `${field} is invalid`);
  return parsed as T;
}

export function parseRunEventsQuery(raw: Record<string, unknown>): RunEventsQuery {
  for (const key of Object.keys(raw)) {
    if (!EVENT_QUERY_KEYS.has(key)) throw new P5QueryError('VALIDATION_FAILED', 'Query parameter is not accepted');
  }
  const afterSequence = parseNonNegativeInteger(raw.afterSequence, 'afterSequence', 0)!;
  const beforeSequence = parsePositiveInteger(raw.beforeSequence, 'beforeSequence');
  const limit = parsePositiveInteger(raw.limit, 'limit', 50)!;
  if (limit > 200) throw new P5QueryError('VALIDATION_FAILED', 'limit is invalid');
  if (beforeSequence !== undefined && beforeSequence <= afterSequence) {
    throw new P5QueryError('VALIDATION_FAILED', 'sequence range is invalid');
  }
  const types = parseTypes(raw.types);
  const stageId = parseExactIdentifier(raw.stageId, 'stageId');
  const severity = parseEnum(raw.severity, 'severity', RUNTIME_EVENT_SEVERITIES);
  const visibility = parseEnum(raw.visibility, 'visibility', RUNTIME_EVENT_VISIBILITIES);
  if (visibility === 'restricted') {
    throw new P5QueryError('EVENT_VISIBILITY_FORBIDDEN', 'Restricted Runtime Events are not available');
  }
  const source = parseEnum(raw.source, 'source', RUNTIME_EVENT_SOURCES);
  const correlationId = parseExactIdentifier(raw.correlationId, 'correlationId');
  return {
    afterSequence,
    ...(beforeSequence === undefined ? {} : { beforeSequence }),
    limit,
    ...(types === undefined ? {} : { types }),
    ...(stageId === undefined ? {} : { stageId }),
    ...(severity === undefined ? {} : { severity: severity as RuntimeEventSeverity }),
    ...(visibility === undefined ? {} : { visibility }),
    ...(source === undefined ? {} : { source: source as RuntimeEventSource }),
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

export class RunEventQueryService {
  constructor(private readonly repository: RuntimeEventRepository) {}

  list(workspaceId: string, runId: string, query: RunEventsQuery): RuntimeEventPage {
    const visibility = query.visibility as RuntimeEventVisibility | undefined;
    const page = this.repository.queryByRun({
      workspaceId,
      runId,
      afterSequence: query.afterSequence ?? 0,
      ...(query.beforeSequence === undefined ? {} : { beforeSequence: query.beforeSequence }),
      limit: query.limit ?? 50,
      ...(query.types === undefined ? {} : { types: query.types }),
      ...(query.stageId === undefined ? {} : { stageId: query.stageId }),
      ...(query.severity === undefined ? {} : { severity: query.severity }),
      visibilities: visibility === undefined ? ['public', 'internal'] : [visibility],
      ...(query.source === undefined ? {} : { source: query.source }),
      ...(query.correlationId === undefined ? {} : { correlationId: query.correlationId }),
    });
    const events = page.results.map(result => result.event);
    return {
      events,
      ...(events.length === 0 ? {} : { nextAfterSequence: events[events.length - 1]!.sequence }),
      hasMore: page.hasMore,
    };
  }
}
