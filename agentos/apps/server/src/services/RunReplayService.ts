import type {
  Run,
  RunReplayQuery,
  RunReplayResponse,
  RunSnapshotPayload,
  RunStage,
  RuntimeEventRecord,
  ReplayCompatibilityWarning,
} from '@agentos/shared';
import type { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import type { RunStageRepository } from '../store/RunStageRepository.js';
import type { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import { buildV2RunDetailResponse } from '../routes/v2RunApi.js';
import {
  P5QueryError,
  parsePositiveInteger,
  parseSingleQueryValue,
  parseTypes,
} from './RunEventQueryService.js';

const REPLAY_QUERY_KEYS = new Set(['fromSequence', 'toSequence', 'types', 'stageId', 'includeArtifacts']);

export interface RunReplayServiceDependencies {
  runtimeEventRepository(): RuntimeEventRepository;
  runSnapshotRepository(): RunSnapshotRepository;
  runStageRepository(): RunStageRepository;
}

function parseExactIdentifier(value: unknown, field: string): string | undefined {
  const parsed = parseSingleQueryValue(value, field);
  if (parsed !== undefined && parsed.trim() !== parsed) {
    throw new P5QueryError('VALIDATION_FAILED', `${field} is invalid`);
  }
  return parsed;
}

function parseStrictBoolean(value: unknown, field: string): boolean | undefined {
  const parsed = parseSingleQueryValue(value, field);
  if (parsed === undefined) return undefined;
  if (parsed === 'true') return true;
  if (parsed === 'false') return false;
  throw new P5QueryError('VALIDATION_FAILED', `${field} is invalid`);
}

export function parseRunReplayQuery(raw: Record<string, unknown>): RunReplayQuery {
  for (const key of Object.keys(raw)) {
    if (!REPLAY_QUERY_KEYS.has(key)) throw new P5QueryError('VALIDATION_FAILED', 'Query parameter is not accepted');
  }
  const fromSequence = parsePositiveInteger(raw.fromSequence, 'fromSequence', 1)!;
  const toSequence = parsePositiveInteger(raw.toSequence, 'toSequence');
  if (toSequence !== undefined && fromSequence > toSequence) {
    throw new P5QueryError('VALIDATION_FAILED', 'sequence range is invalid');
  }
  const types = parseTypes(raw.types);
  const stageId = parseExactIdentifier(raw.stageId, 'stageId');
  const includeArtifacts = parseStrictBoolean(raw.includeArtifacts, 'includeArtifacts');
  return {
    fromSequence,
    ...(toSequence === undefined ? {} : { toSequence }),
    ...(types === undefined ? {} : { types }),
    ...(stageId === undefined ? {} : { stageId }),
    ...(includeArtifacts === undefined ? {} : { includeArtifacts }),
  };
}

function gapWarnings(sequences: readonly number[], fromSequence: number, toSequence: number): ReplayCompatibilityWarning[] {
  if (toSequence < fromSequence) return [];
  const warnings: ReplayCompatibilityWarning[] = [];
  let expected = fromSequence;
  for (const sequence of sequences) {
    if (sequence > expected) {
      warnings.push({
        code: 'EVENT_SEQUENCE_GAP',
        message: `Durable Runtime Event sequences ${expected}-${sequence - 1} are unavailable.`,
        fromSequence: expected,
        toSequence: sequence - 1,
      });
    }
    if (sequence >= expected) expected = sequence + 1;
  }
  if (expected <= toSequence) {
    warnings.push({
      code: 'EVENT_SEQUENCE_GAP',
      message: `Durable Runtime Event sequences ${expected}-${toSequence} are unavailable.`,
      fromSequence: expected,
      toSequence,
    });
  }
  return warnings;
}

export class RunReplayService {
  constructor(private readonly dependencies: RunReplayServiceDependencies) {}

  replay(workspaceId: string, run: Run, query: RunReplayQuery): RunReplayResponse {
    const events = this.dependencies.runtimeEventRepository();
    const highWatermark = events.getRunHighWatermark(workspaceId, run.id);
    const fromSequence = query.fromSequence ?? 1;
    const toSequence = Math.min(query.toSequence ?? highWatermark, highWatermark);
    const snapshot = this.dependencies.runSnapshotRepository().findByRunId(workspaceId, run.id);
    const stages = this.dependencies.runStageRepository().listByRun(workspaceId, run.id);
    const safe = buildV2RunDetailResponse({
      run,
      snapshot,
      stages,
      include: new Set(['snapshot', 'stages']),
    });

    const results: ReturnType<RuntimeEventRepository['queryByRun']>['results'][number][] = [];
    if (toSequence >= fromSequence) {
      let afterSequence = fromSequence - 1;
      while (afterSequence < toSequence) {
        const page = events.queryByRun({
          workspaceId,
          runId: run.id,
          afterSequence,
          ...(toSequence === Number.MAX_SAFE_INTEGER ? {} : { beforeSequence: toSequence + 1 }),
          limit: 200,
          ...(query.types === undefined ? {} : { types: query.types }),
          ...(query.stageId === undefined ? {} : { stageId: query.stageId }),
          visibilities: ['public', 'internal'],
        });
        results.push(...page.results);
        if (!page.hasMore || page.results.length === 0) break;
        afterSequence = page.results[page.results.length - 1]!.event.sequence;
      }
    }

    const warnings: ReplayCompatibilityWarning[] = [];
    if (snapshot === undefined) {
      warnings.push({ code: 'SNAPSHOT_UNAVAILABLE', message: 'The persisted Run Snapshot is unavailable.' });
    }
    const durableSequences = toSequence >= fromSequence
      ? events.listRunSequencesInRange(workspaceId, run.id, fromSequence, toSequence)
      : [];
    warnings.push(...gapWarnings(durableSequences, fromSequence, toSequence));
    for (const result of results) {
      if (result.kind === 'unknown') {
        warnings.push({
          code: 'UNKNOWN_RUNTIME_EVENT',
          message: 'A persisted Runtime Event uses an unknown type or schema and was preserved.',
          eventId: result.event.id,
        });
      }
    }
    if (run.origin === 'legacy_pipeline' && highWatermark === 0) {
      warnings.push({
        code: 'LEGACY_EVENT_HISTORY_UNAVAILABLE',
        message: 'This Legacy-origin Run has no canonical Task-domain Runtime Event history.',
      });
    }
    if (query.includeArtifacts === true) {
      warnings.push({
        code: 'ARTIFACT_INDEX_UNAVAILABLE',
        message: 'Canonical Task-domain Artifact indexing is not available in the current M3 foundation.',
      });
    }

    return {
      runSnapshot: (safe.snapshot ?? null) as RunSnapshotPayload | null,
      stageSnapshots: (safe.stages ?? []) as RunStage[],
      events: results.map(result => result.event) as RuntimeEventRecord[],
      artifactIndex: [],
      compatibilityWarnings: warnings,
    };
  }
}
