/**
 * Runtime Timeline projection (13-Runtime-Inspector.md §39-46).
 *
 * A Timeline is a user-readable projection of Runtime Events — not a Message
 * Timeline and not a raw log. It supports three modes (Summary / Detailed /
 * Raw), aggregates only high-frequency Event types (stream.text_delta and
 * friends), always keeps terminal/approval/error facts as individual items,
 * and can group items by Stage, Correlation or Domain.
 *
 * Pure projection: no I/O, no store access. The caller supplies already-read
 * Event records; this module never reads the database itself.
 */

export type TimelineMode = 'summary' | 'detailed' | 'raw';
export type TimelineGroup = 'none' | 'stage' | 'correlation' | 'domain';

export const TIMELINE_MODES: readonly TimelineMode[] = ['summary', 'detailed', 'raw'];
export const TIMELINE_GROUPS: readonly TimelineGroup[] = ['none', 'stage', 'correlation', 'domain'];

/**
 * §42: only these high-frequency Event types may aggregate into one item.
 * Terminal, Approval, Policy Deny, Error, Merge, Artifact Finalized and
 * Recovery Result are deliberately absent, so they always stay individual.
 */
export const TIMELINE_AGGREGATABLE_TYPES: readonly string[] = [
  'stream.text_delta',
  'process.usage.sample',
  'process.heartbeat',
  'run.heartbeat',
];

/** §41: the Timeline item kind vocabulary. */
export type TimelineKind =
  | 'run' | 'stage' | 'provider' | 'process' | 'tool' | 'command' | 'file'
  | 'test' | 'worktree' | 'memory' | 'policy' | 'approval' | 'artifact'
  | 'recovery' | 'error' | 'stream' | 'system';

export interface TimelineSourceRef {
  readonly resourceType: string;
  readonly resourceId: string;
}

export interface TimelinePayloadSummary {
  /** Top-level payload keys, so a reader knows what the Event carried. */
  readonly keys: readonly string[];
  /** Canonical JSON preview, truncated for display. */
  readonly preview: string;
}

/**
 * §41 RuntimeTimelineItem. `id` is the Event id for individual items and a
 * deterministic aggregation id for aggregated items, so a client can key its
 * list stably across refreshes.
 */
export interface InspectorTimelineItem {
  readonly id: string;
  readonly runId: string;
  readonly stageId?: string;
  readonly correlationId?: string;
  /** Event domain (first type segment), used by domain grouping and filters. */
  readonly domain: string;
  readonly kind: TimelineKind;
  /** Canonical Event type of the first aggregated Event. */
  readonly type: string;
  readonly status?: string;
  readonly title: string;
  readonly summary?: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly severity?: string;
  readonly visibility?: string;
  readonly sourceRefs: readonly TimelineSourceRef[];
  /** False when this is a single Event; an aggregated item is expandable. */
  readonly aggregated: boolean;
  /** Number of canonical Events folded into this item. */
  readonly eventCount: number;
  /** Present only in raw mode: a bounded payload digest, never the verbatim payload. */
  readonly payloadSummary?: TimelinePayloadSummary;
}

export interface InspectorTimelineGroup {
  readonly key: string;
  readonly label: string;
  readonly items: readonly InspectorTimelineItem[];
}

/** Minimal Event shape the projector needs; satisfied by InspectorEventSummary + payload. */
export interface TimelineEventInput {
  readonly eventId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly type: string;
  readonly timestamp: string;
  readonly severity: string;
  readonly visibility?: string;
  readonly source?: string;
  readonly stageId?: string;
  readonly processId?: string;
  readonly artifactId?: string;
  readonly approvalRequestId?: string;
  readonly correlationId: string;
  readonly payload?: unknown;
}

export interface TimelineFilter {
  /** Exact canonical Event types to keep (§44 Type). */
  readonly types?: ReadonlySet<string>;
  /** Severities to keep (§44 Severity). */
  readonly severities?: ReadonlySet<string>;
  /** One Stage to keep (§44 Stage). */
  readonly stageId?: string;
}

export interface TimelineProjectInput {
  readonly events: readonly TimelineEventInput[];
  readonly mode: TimelineMode;
  readonly filter?: TimelineFilter;
}

const PAYLOAD_PREVIEW_MAX_CHARS = 240;

function nonBlank(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** §44 Domain filter dimension: the first segment of the canonical Event type. */
export function timelineDomainOf(type: string): string {
  const segment = type.split('.')[0];
  return nonBlank(segment) ? segment! : 'system';
}

const KIND_BY_PREFIX: Readonly<Record<string, TimelineKind>> = {
  run: 'run',
  stage: 'stage',
  provider: 'provider',
  process: 'process',
  tool: 'tool',
  command: 'command',
  file: 'file',
  test: 'test',
  worktree: 'worktree',
  memory: 'memory',
  policy: 'policy',
  approval: 'approval',
  artifact: 'artifact',
  recovery: 'recovery',
  error: 'error',
  stream: 'stream',
};

export function timelineKindOf(event: Pick<TimelineEventInput, 'type' | 'severity'>): TimelineKind {
  const prefix = event.type.split('.')[0];
  const mapped = KIND_BY_PREFIX[prefix ?? ''];
  if (mapped !== undefined) return mapped;
  if (event.severity === 'error') return 'error';
  return 'system';
}

/** Human-readable title: `stage.completed` -> "stage completed". */
export function timelineTitleOf(type: string): string {
  return type.replace(/\./g, ' ');
}

export function isAggregatableTimelineType(type: string): boolean {
  return TIMELINE_AGGREGATABLE_TYPES.includes(type);
}

function payloadSummaryOf(payload: unknown): TimelinePayloadSummary {
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const keys = record === null ? [] : Object.keys(record);
  let preview: string;
  try {
    preview = JSON.stringify(payload ?? null) ?? 'null';
  } catch {
    preview = '[unserializable payload]';
  }
  if (preview.length > PAYLOAD_PREVIEW_MAX_CHARS) {
    preview = `${preview.slice(0, PAYLOAD_PREVIEW_MAX_CHARS)}…`;
  }
  return { keys, preview };
}

function toItem(event: TimelineEventInput, mode: TimelineMode): InspectorTimelineItem {
  const kind = timelineKindOf(event);
  const base: InspectorTimelineItem = {
    id: event.eventId,
    runId: event.runId,
    domain: timelineDomainOf(event.type),
    kind,
    type: event.type,
    title: timelineTitleOf(event.type),
    firstSequence: event.sequence,
    lastSequence: event.sequence,
    startedAt: event.timestamp,
    sourceRefs: [
      ...(nonBlank(event.stageId) ? [{ resourceType: 'stage' as const, resourceId: event.stageId }] : []),
      ...(nonBlank(event.processId) ? [{ resourceType: 'process' as const, resourceId: event.processId }] : []),
      ...(nonBlank(event.artifactId) ? [{ resourceType: 'artifact' as const, resourceId: event.artifactId }] : []),
      ...(nonBlank(event.approvalRequestId) ? [{ resourceType: 'approval' as const, resourceId: event.approvalRequestId }] : []),
    ],
    aggregated: false,
    eventCount: 1,
  };
  const optional: Record<string, unknown> = {};
  if (nonBlank(event.stageId)) optional.stageId = event.stageId;
  if (nonBlank(event.correlationId)) optional.correlationId = event.correlationId;
  if (nonBlank(event.severity)) optional.severity = event.severity;
  if (nonBlank(event.visibility)) optional.visibility = event.visibility;
  if (mode === 'raw') optional.payloadSummary = payloadSummaryOf(event.payload);
  return { ...base, ...(optional as Partial<InspectorTimelineItem>) };
}

/**
 * §42 aggregation: aggregatable Events fold into one item only while type,
 * stage and correlation stay the same — a Stage boundary or a different
 * correlation chain always splits the fold.
 */
function foldAggregatable(run: readonly InspectorTimelineItem[]): InspectorTimelineItem {
  const first = run[0]!;
  const last = run[run.length - 1]!;
  return {
    ...first,
    id: `agg:${first.type}:${first.stageId ?? ''}:${first.correlationId ?? ''}:${first.firstSequence}`,
    lastSequence: last.lastSequence,
    completedAt: last.startedAt,
    summary: `${run.length} × ${first.type}`,
    aggregated: true,
    eventCount: run.length,
  };
}

function applyFilter(event: TimelineEventInput, filter: TimelineFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter.types !== undefined && !filter.types.has(event.type)) return false;
  if (filter.severities !== undefined && !filter.severities.has(event.severity)) return false;
  if (filter.stageId !== undefined && event.stageId !== filter.stageId) return false;
  return true;
}

/**
 * Projects Events into Timeline items for one mode. Aggregation runs only in
 * Summary mode; Detailed and Raw keep one item per Event (Raw adds the
 * bounded payload digest).
 */
export function projectTimelineItems(input: TimelineProjectInput): InspectorTimelineItem[] {
  const filtered = input.events.filter(event => applyFilter(event, input.filter));
  if (input.mode !== 'summary') {
    return filtered.map(event => toItem(event, input.mode));
  }
  const items: InspectorTimelineItem[] = [];
  let fold: InspectorTimelineItem[] = [];
  const flush = (): void => {
    if (fold.length === 0) return;
    items.push(fold.length === 1 ? fold[0]! : foldAggregatable(fold));
    fold = [];
  };
  for (const event of filtered) {
    const item = toItem(event, input.mode);
    const previous = fold[fold.length - 1];
    const continues = previous !== undefined
      && isAggregatableTimelineType(event.type)
      && previous.type === item.type
      && previous.stageId === item.stageId
      && previous.correlationId === item.correlationId;
    if (!continues) {
      flush();
      if (isAggregatableTimelineType(event.type)) {
        fold = [item];
        continue;
      }
    }
    items.push(item);
  }
  flush();
  return items;
}

/** §43 grouping: Stage / Correlation / Domain; the default remains flat sequence order. */
export function groupTimelineItems(
  items: readonly InspectorTimelineItem[],
  group: TimelineGroup,
): InspectorTimelineGroup[] {
  if (group === 'none') return [];
  const buckets = new Map<string, InspectorTimelineItem[]>();
  for (const item of items) {
    const key = group === 'stage'
      ? (item.stageId ?? 'unstaged')
      : group === 'correlation'
        ? (item.correlationId ?? 'uncorrelated')
        : item.domain;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [item]);
    else bucket.push(item);
  }
  return [...buckets.entries()].map(([key, bucket]) => ({
    key,
    label: group === 'stage' && key === 'unstaged' ? 'No stage'
      : group === 'correlation' && key === 'uncorrelated' ? 'No correlation'
        : key,
    items: bucket,
  }));
}
