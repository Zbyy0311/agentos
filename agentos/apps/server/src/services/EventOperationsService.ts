import {
  COMPACTABLE_RUNTIME_EVENT_TYPES,
  applyEventCorrections,
  isEventCompactedPayload,
  isEventCorrectedPayload,
  type EventCompactedPayload,
  type EventCorrectedPayload,
  type RuntimeEventConsumptionResult,
  type RuntimeEventContext,
} from '@agentos/shared';
import { canonicalizeJson } from '../snapshots/canonicalJson.js';
import {
  RuntimeEventOutboxWriter,
  RuntimeEventRepository,
  RuntimeEventRepositoryError,
  type DurableRuntimeFactResult,
} from '../store/RuntimeEventRepository.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import type { RetentionPolicyRepository } from '../store/RetentionPolicyRepository.js';
import type { EventPayloadOffloadService } from './EventPayloadOffloadService.js';
import type { OutboxMessage, OutboxRepository } from '../store/OutboxRepository.js';

/**
 * P5A Event Operations service (03-Event-Model §58/§59/§61).
 *
 * One explicit operational entry point per spec area — no background
 * scheduler is wired here:
 *  - correctEvent: §61 correction as an append-only `event.corrected` fact.
 *  - compactRunHighVolumeEvents: §59 compaction of high-volume types into one
 *    raw replacement Artifact plus one `event.compacted` durable fact.
 *  - enforceRetention: §58 age-based cleanup of non-permanent durable Events.
 *  - listByRunWithCorrections: §61 projection read with corrections applied;
 *    the raw append-only reads on RuntimeEventRepository are untouched.
 */
export interface EventRetentionPolicy {
  /** null means durable non-permanent Events are kept forever. */
  readonly durableRetentionDays: number | null;
  readonly rawStreamRetentionDays: number;
  readonly debugEventRetentionDays: number;
  readonly restrictedRetentionDays: number;
}

export const DEFAULT_EVENT_RETENTION_POLICY: EventRetentionPolicy = Object.freeze({
  durableRetentionDays: 30,
  rawStreamRetentionDays: 7,
  debugEventRetentionDays: 3,
  restrictedRetentionDays: 14,
});

export interface EventCompactionConfig {
  /** Defaults to the §59 compactible high-volume set. */
  readonly eventTypes?: readonly string[];
  /** Minimum Events in one contiguous block before it is compacted. */
  readonly minEvents?: number;
  /** Only Events below this Run sequence are considered. */
  readonly beforeSequence?: number;
}

export interface EventCompactionResult {
  readonly compacted: readonly {
    readonly eventId: string;
    readonly fromSequence: number;
    readonly toSequence: number;
    readonly eventTypes: readonly string[];
    readonly replacementArtifactId: string;
    readonly originalCount: number;
  }[];
}

export interface EventRetentionResult {
  readonly deletedEvents: number;
  readonly deletedByCategory: Record<'rawStream' | 'debug' | 'restricted' | 'durable', number>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class EventOperationsService {
  constructor(
    private readonly db: TransactionDatabase,
    private readonly runtimeEvents: RuntimeEventRepository,
    private readonly writer: RuntimeEventOutboxWriter,
    private readonly artifacts: EventPayloadOffloadService,
    private readonly outbox: OutboxRepository,
    /**
     * Optional §116 retention policy source: an enabled 'runtime_events'
     * policy row overrides the built-in default per field.
     */
    private readonly retentionPolicies?: RetentionPolicyRepository,
  ) {
    if (runtimeEvents.transactionDatabase !== db || writer.transactionDatabase !== db) {
      throw new RuntimeEventRepositoryError(
        'RUNTIME_EVENT_PERSISTENCE_FAILED',
        'EventOperationsService requires every collaborator to share one TransactionDatabase',
      );
    }
  }

  /**
   * §61: append an `event.corrected` Event pointing at the original Event.
   * The original row is never UPDATEd (the BEFORE UPDATE trigger enforces
   * this too). Repeating an identical correction (same target, reason and
   * correctedFields) is idempotent: the already-appended correction is
   * returned and nothing new is written.
   */
  correctEvent(input: {
    readonly workspaceId: string;
    readonly originalEventId: string;
    readonly reason: string;
    readonly correctedFields: Record<string, unknown>;
    readonly eventContext: RuntimeEventContext;
    readonly timestamp: string;
  }): DurableRuntimeFactResult {
    const original = this.runtimeEvents.findById(input.originalEventId);
    if (!original || original.kind !== 'known') {
      throw new RuntimeEventRepositoryError('RUNTIME_EVENT_READ_FAILED', 'Correction target Event does not exist');
    }
    const target = original.event;
    if (target.workspaceId !== input.workspaceId) {
      throw new RuntimeEventRepositoryError('RUNTIME_EVENT_PERSISTENCE_FAILED', 'Correction target belongs to another Workspace');
    }
    if (target.durability !== 'durable') {
      throw new RuntimeEventRepositoryError('RUNTIME_EVENT_PERSISTENCE_FAILED', 'Only durable Events can be corrected');
    }
    const payload = {
      targetEventId: input.originalEventId,
      reason: input.reason,
      correctedFields: input.correctedFields,
    } satisfies EventCorrectedPayload as unknown as Record<string, unknown>;
    if (!isEventCorrectedPayload(payload)) {
      throw new RuntimeEventRepositoryError('RUNTIME_EVENT_PERSISTENCE_FAILED', 'Correction payload is invalid');
    }
    const fingerprint = canonicalizeJson(payload);
    for (const candidate of this.iterateRunCorrections(input.workspaceId, target.runId)) {
      if (candidate.kind === 'known'
        && candidate.event.type === 'event.corrected'
        && canonicalizeJson(candidate.event.payload) === fingerprint) {
        const outbox: OutboxMessage = this.outbox.findByEventId(candidate.event.id)!;
        return { event: candidate.event, outbox };
      }
    }
    return this.writer.appendWithinTransaction({
      type: 'event.corrected',
      workspaceId: input.workspaceId,
      runId: target.runId,
      timestamp: input.timestamp,
      source: 'event-store',
      eventContext: input.eventContext,
      payload,
    });
  }

  /**
   * §61 projection read: the same raw append-only page plus corrections
   * applied on top (later corrections win). The raw reads
   * (queryByRun/listByRunAfterSequence) remain available unchanged.
   */
  listByRunWithCorrections(query: Parameters<RuntimeEventRepository['queryByRun']>[0]): {
    results: RuntimeEventConsumptionResult[];
    hasMore: boolean;
  } {
    const raw = this.runtimeEvents.queryByRun(query);
    const payloads: EventCorrectedPayload[] = [];
    for (const item of this.iterateRunCorrections(query.workspaceId, query.runId)) {
      if (item.kind === 'known' && isEventCorrectedPayload(item.event.payload)) {
        payloads.push(item.event.payload);
      }
    }
    const known = raw.results.filter(item => item.kind === 'known');
    if (payloads.length === 0 || known.length === 0) return { results: [...raw.results], hasMore: raw.hasMore };
    const corrected = applyEventCorrections(known.map(item => (item as { kind: 'known'; event: { readonly id: string; readonly type: string; readonly payload: unknown } }).event), payloads);
    const byId = new Map(corrected.map(event => [event.id, event]));
    return {
      results: raw.results.map(item => {
        if (item.kind !== 'known') return item;
        const replacement = byId.get(item.event.id);
        return replacement === undefined ? item : { kind: 'known' as const, event: replacement as never };
      }),
      hasMore: raw.hasMore,
    };
  }

  private *iterateRunCorrections(workspaceId: string, runId: string): Generator<RuntimeEventConsumptionResult> {
    let afterSequence = 0;
    for (;;) {
      const page = this.runtimeEvents.queryByRun({
        workspaceId,
        runId,
        afterSequence,
        limit: 200,
        types: ['event.corrected'],
      });
      yield* page.results;
      if (!page.hasMore) return;
      afterSequence = page.results[page.results.length - 1]!.event.sequence;
    }
  }

  /**
   * §59 high-volume compaction. Contiguous blocks (same type, consecutive
   * sequences, sequence < beforeSequence when configured) of at least
   * minEvents compactible Events are written as one JSONL raw Artifact whose
   * lines preserve {id, sequence, timestamp, payload}, replaced by a single
   * durable `event.compacted` Event. Blocks containing an undelivered Outbox
   * handoff are skipped so at-least-once delivery is never compromised.
   * Terminal, approval, policy, correction and compaction facts are not
   * compactible by construction (they are absent from the compactible set and
   * permanently retained).
   */
  compactRunHighVolumeEvents(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly timestamp: string;
    readonly eventContext: RuntimeEventContext;
    readonly config?: EventCompactionConfig;
  }): EventCompactionResult {
    const allowed = new Set<string>(input.config?.eventTypes ?? COMPACTABLE_RUNTIME_EVENT_TYPES);
    for (const type of allowed) {
      if (!(COMPACTABLE_RUNTIME_EVENT_TYPES as readonly string[]).includes(type)) {
        throw new RuntimeEventRepositoryError('RUNTIME_EVENT_PERSISTENCE_FAILED', `Event type is not compactible: ${type}`);
      }
    }
    const minEvents = input.config?.minEvents ?? 4;
    if (!Number.isSafeInteger(minEvents) || minEvents < 2) {
      throw new RuntimeEventRepositoryError('RUNTIME_EVENT_PERSISTENCE_FAILED', 'Compaction minEvents must be an integer >= 2');
    }
    const conditions = ["workspace_id = ?", "run_id = ?", "durability = 'durable'", 'sequence > 0'];
    const parameters: unknown[] = [input.workspaceId, input.runId];
    if (input.config?.beforeSequence !== undefined) {
      conditions.push('sequence < ?');
      parameters.push(input.config.beforeSequence);
    }
    const rows = this.db.prepare(`
      SELECT id, sequence, type, timestamp, payload_json
      FROM runtime_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY sequence ASC
    `).all(...parameters) as Array<{ id: string; sequence: number; type: string; timestamp: string; payload_json: string }>;

    type CompactionRow = { id: string; sequence: number; type: string; timestamp: string; payload_json: string };
    // Any Event outside the compactible set (terminal, approval, correction…)
    // breaks the block so a compaction range never spans a surviving fact.
    const blocks: Array<{ type: string; rows: CompactionRow[] }> = [];
    let current: CompactionRow[] = [];
    for (const row of rows) {
      if (allowed.has(row.type)
        && current.length > 0
        && current[current.length - 1].type === row.type
        && current[current.length - 1].sequence + 1 === row.sequence) {
        current.push(row);
        continue;
      }
      if (current.length > 0) blocks.push({ type: current[0].type, rows: current });
      current = allowed.has(row.type) ? [row] : [];
    }
    if (current.length > 0) blocks.push({ type: current[0].type, rows: current });

    const outboxStatus = this.db.prepare('SELECT status FROM outbox_messages WHERE event_id = ?');
    const compacted: Array<EventCompactionResult['compacted'][number]> = [];
    for (const block of blocks) {
      if (block.rows.length < minEvents) continue;
      const undelivered = block.rows.some(row => {
        const outbox = outboxStatus.get(row.id) as { status: string } | undefined;
        return outbox !== undefined && outbox.status !== 'published' && outbox.status !== 'dead_letter';
      });
      if (undelivered) continue;
      const fromSequence = block.rows[0].sequence;
      const toSequence = block.rows[block.rows.length - 1].sequence;
      const jsonl = block.rows
        .map(row => canonicalizeJson({
          id: row.id,
          type: row.type,
          sequence: row.sequence,
          timestamp: row.timestamp,
          payload: JSON.parse(row.payload_json) as unknown,
        }))
        .join('\n');
      const { artifactId } = this.artifacts.storeCanonicalRawArtifact({
        workspaceId: input.workspaceId,
        runId: input.runId,
        title: `Compaction ${input.runId} sequences ${fromSequence}-${toSequence}`,
        summary: `${block.rows.length} ${block.type} Events compacted per 03-Event-Model §59`,
        bytes: Buffer.from(jsonl, 'utf8'),
        timestamp: input.timestamp,
      });
      const payload: EventCompactedPayload = {
        fromSequence,
        toSequence,
        eventTypes: [block.type],
        replacementArtifactId: artifactId,
        originalCount: block.rows.length,
      };
      const appended = this.writer.appendWithinTransaction({
        type: 'event.compacted',
        workspaceId: input.workspaceId,
        runId: input.runId,
        timestamp: input.timestamp,
        source: 'event-store',
        eventContext: input.eventContext,
        payload: payload as unknown as Record<string, unknown>,
      });
      if (!isEventCompactedPayload(appended.event.payload)) {
        throw new RuntimeEventRepositoryError('RUNTIME_EVENT_PERSISTENCE_FAILED', 'Compaction summary payload is invalid');
      }
      this.runtimeEvents.deleteEligibleEventsWithinTransaction(block.rows.map(row => row.id));
      compacted.push({
        eventId: appended.event.id,
        fromSequence,
        toSequence,
        eventTypes: [block.type],
        replacementArtifactId: artifactId,
        originalCount: block.rows.length,
      });
    }
    return { compacted };
  }

  /** Reconstruct the original Events of one compaction Artifact (§59). */
  readCompactionOriginals(replacementArtifactId: string): Array<{
    readonly id: string;
    readonly type: string;
    readonly sequence: number;
    readonly timestamp: string;
    readonly payload: unknown;
  }> {
    const bytes = this.artifacts.readCanonicalRawArtifact(replacementArtifactId);
    const lines = bytes.toString('utf8').split('\n').filter(line => line.length > 0);
    return lines.map(line => JSON.parse(line) as {
      id: string; type: string; sequence: number; timestamp: string; payload: unknown;
    });
  }

  /**
   * §58 retention enforcement — explicit service entry, no scheduler. Cleans
   * only non-permanent durable Events, newest-first categories overlapping at
   * the strictest applicable horizon: raw-stream (compactible) types, debug
   * severity, restricted visibility, then the general durable horizon.
   * Events with an undelivered Outbox handoff are skipped. Permanent facts
   * (terminal, approval, policy denial, merge, artifact/memory creation,
   * correction/compaction audit, critical errors) are never selected: the
   * repository guard and the migration 060 trigger both remain as backstops.
   * Raw Artifact bytes are not touched here; artifact cleanup is a separate
   * concern from durable Event cleanup.
   */
  enforceRetention(
    workspaceId: string,
    policy?: EventRetentionPolicy,
    now: Date = new Date(),
  ): EventRetentionResult {
    const effective = policy ?? this.resolveRetentionPolicy(workspaceId);
    const nowMs = now.getTime();
    const cutoff = (days: number): string => new Date(nowMs - days * DAY_MS).toISOString();
    const deletedByCategory: EventRetentionResult['deletedByCategory'] = {
      rawStream: 0,
      debug: 0,
      restricted: 0,
      durable: 0,
    };
    let deletedEvents = 0;

    const compactibleList = (COMPACTABLE_RUNTIME_EVENT_TYPES as readonly string[])
      .map(type => `'${type}'`).join(', ');
    const durableCutoff = effective.durableRetentionDays === null ? null : cutoff(effective.durableRetentionDays);

    // Categories are evaluated newest-first; each statement only selects rows
    // older than its own horizon and not already claimed by a stricter one.
    const clean = (
      category: keyof EventRetentionResult['deletedByCategory'],
      conditions: string[],
      parameters: unknown[],
    ): void => {
      const rows = this.db.prepare(`
        SELECT e.id, e.type, e.sequence FROM runtime_events e
        WHERE e.workspace_id = ? AND e.durability = 'durable'
          AND e.type NOT IN (${permanentTypeSqlList()})
          AND NOT (e.type = 'error.occurred' AND e.severity = 'critical')
          AND ${conditions.join(' AND ')}
        ORDER BY e.sequence ASC
        LIMIT 1000
      `).all(workspaceId, ...parameters) as Array<{ id: string; type: string; sequence: number }>;
      const outboxStatus = this.db.prepare('SELECT status FROM outbox_messages WHERE event_id = ?');
      const deletable = rows.filter(row => {
        const outbox = outboxStatus.get(row.id) as { status: string } | undefined;
        return outbox === undefined || outbox.status === 'published' || outbox.status === 'dead_letter';
      });
      if (deletable.length === 0) return;
      const removed = this.runtimeEvents.deleteEligibleEventsWithinTransaction(deletable.map(row => row.id));
      deletedByCategory[category] += removed;
      deletedEvents += removed;
    };

    clean('rawStream', [`e.type IN (${compactibleList})`, 'e.timestamp < ?'], [cutoff(effective.rawStreamRetentionDays)]);
    clean('debug', ["e.severity = 'debug'", 'e.timestamp < ?', `e.type NOT IN (${compactibleList})`], [cutoff(effective.debugEventRetentionDays)]);
    clean('restricted', ["e.visibility = 'restricted'", 'e.timestamp < ?', `e.type NOT IN (${compactibleList})`, "e.severity <> 'debug'"], [cutoff(effective.restrictedRetentionDays)]);
    if (durableCutoff !== null) {
      clean('durable', ['e.timestamp < ?', `e.type NOT IN (${compactibleList})`, "e.severity <> 'debug'", "e.visibility <> 'restricted'"], [durableCutoff]);
    }
    return { deletedEvents, deletedByCategory };
  }

  /**
   * §116: an enabled 'runtime_events' policy row (workspace-specific first,
   * then global) overrides the built-in default per field. Unknown or
   * malformed fields fall back to the default so a bad policy row can never
   * disable cleanup or widen it silently.
   */
  private resolveRetentionPolicy(workspaceId: string): EventRetentionPolicy {
    const fallback = DEFAULT_EVENT_RETENTION_POLICY;
    const configured = this.retentionPolicies?.getEffective(workspaceId, 'runtime_events');
    if (!configured) return fallback;
    const readDays = (value: unknown): number | null | undefined => {
      if (value === null) return null;
      if (value === undefined) return undefined;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
      return undefined;
    };
    const override: Record<string, unknown> = configured.policy;
    const durableRetentionDays = readDays(override.durableRetentionDays) ?? fallback.durableRetentionDays;
    return {
      durableRetentionDays,
      rawStreamRetentionDays: readDays(override.rawStreamRetentionDays) ?? fallback.rawStreamRetentionDays,
      debugEventRetentionDays: readDays(override.debugEventRetentionDays) ?? fallback.debugEventRetentionDays,
      restrictedRetentionDays: readDays(override.restrictedRetentionDays) ?? fallback.restrictedRetentionDays,
    };
  }
}

function permanentTypeSqlList(): string {
  return [
    'run.cancelled',
    'run.completed',
    'run.failed',
    'stage.cancelled',
    'stage.completed',
    'stage.failed',
    'stage.skipped',
    'approval.required',
    'approval.resolved',
    'approval.expired',
    'approval.cancelled',
    'policy.denied',
    'git.merge_started',
    'git.merge_completed',
    'git.merge_conflicted',
    'worktree.merged',
    'artifact.created',
    'artifact.finalized',
    'memory.created',
    'event.corrected',
    'event.compacted',
  ].map(type => `'${type}'`).join(', ');
}
