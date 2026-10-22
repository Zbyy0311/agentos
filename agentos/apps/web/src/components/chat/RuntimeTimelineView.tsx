'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { InspectorStageDto } from './RuntimeInspectorView';
import type {
  RuntimeTimelineGroup,
  RuntimeTimelineItemDto,
  RuntimeTimelineMode,
  RuntimeTimelineProjectionDto,
  RuntimeStreamConnectionState,
} from '../../lib/runtimeInspectorClient';

export interface RuntimeTimelineFilters {
  readonly type: string;
  readonly domain: string;
  readonly severity: string;
  readonly stageId: string;
}

export interface RuntimeTimelineViewProps {
  readonly timeline: RuntimeTimelineProjectionDto;
  readonly mode: RuntimeTimelineMode;
  readonly group: RuntimeTimelineGroup;
  readonly filters: RuntimeTimelineFilters;
  readonly stages: readonly InspectorStageDto[];
  readonly connectionState: RuntimeStreamConnectionState;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error?: string;
  readonly onModeChange: (mode: RuntimeTimelineMode) => void;
  readonly onGroupChange: (group: RuntimeTimelineGroup) => void;
  readonly onFilterChange: (key: keyof RuntimeTimelineFilters, value: string) => void;
  readonly onLoadMore: () => void;
}

interface TimelineBucket {
  readonly key: string;
  readonly label: string;
  readonly items: readonly RuntimeTimelineItemDto[];
}

const CONTROL_STYLE = {
  backgroundColor: 'var(--surface-elevated)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  padding: '4px 6px',
  maxWidth: '100%',
} as const;

export function groupRuntimeTimelineItems(
  items: readonly RuntimeTimelineItemDto[],
  group: RuntimeTimelineGroup,
): TimelineBucket[] {
  if (group === 'none') return [{ key: 'all', label: '', items }];
  const buckets = new Map<string, RuntimeTimelineItemDto[]>();
  for (const item of items) {
    const key = group === 'stage'
      ? item.stageId ?? 'unstaged'
      : group === 'correlation'
        ? item.correlationId ?? 'uncorrelated'
        : item.domain;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [item]);
    else bucket.push(item);
  }
  return [...buckets.entries()].map(([key, groupedItems]) => ({
    key,
    label: key === 'unstaged' ? 'No stage' : key === 'uncorrelated' ? 'No correlation' : key,
    items: groupedItems,
  }));
}

export function isKeyRuntimeTimelineItem(item: RuntimeTimelineItemDto): boolean {
  return item.severity === 'error'
    || item.severity === 'critical'
    || item.kind === 'approval'
    || item.kind === 'error'
    || item.kind === 'recovery'
    || /^(?:git\.merge_|worktree\.merged$)|(^|\.)merge(\.|$)/u.test(item.type)
    || /^(run|stage)\.(completed|failed|cancelled|skipped)$/u.test(item.type)
    || /^(policy\.denied|artifact\.finalized|recovery\..*result)$/u.test(item.type);
}

export function mergeRuntimeTimelineItems(
  previous: readonly RuntimeTimelineItemDto[],
  additions: readonly RuntimeTimelineItemDto[],
  mode: RuntimeTimelineMode,
): RuntimeTimelineItemDto[] {
  const merged = [...previous];
  for (const item of additions) {
    const last = merged[merged.length - 1];
    if (last !== undefined && item.lastSequence <= last.lastSequence) continue;
    const foldable = mode === 'summary'
      && last !== undefined
      && last.type === item.type
      && item.type === 'stream.text_delta'
      && last.stageId === item.stageId
      && last.correlationId === item.correlationId
      && last.severity === item.severity
      && last.visibility === item.visibility
      && !isKeyRuntimeTimelineItem(last)
      && !isKeyRuntimeTimelineItem(item)
      && last.lastSequence + 1 === item.firstSequence;
    if (foldable) {
      const eventCount = last.eventCount + item.eventCount;
      merged[merged.length - 1] = {
        ...last,
        id: last.id,
        lastSequence: item.lastSequence,
        completedAt: item.completedAt ?? item.startedAt,
        summary: `${eventCount} × ${last.type}`,
        aggregated: eventCount > 1,
        eventCount,
      };
    } else {
      merged.push(item);
    }
  }
  return merged;
}

export function shouldRuntimeTimelineFollowTail(
  previousSequence: number | null,
  nextSequence: number,
  wasAtBottom: boolean,
): boolean {
  return previousSequence === null
    || (nextSequence > previousSequence && wasAtBottom);
}

export function RuntimeTimelineView(props: RuntimeTimelineViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const previousSequenceRef = useRef<number | null>(null);
  const previousWatermarkRef = useRef<number | null>(null);
  const [newEventCount, setNewEventCount] = useState(0);
  const [isFollowing, setIsFollowing] = useState(true);
  const buckets = useMemo(
    () => groupRuntimeTimelineItems(props.timeline.items, props.group),
    [props.group, props.timeline.items],
  );
  useEffect(() => {
    const viewport = scrollRef.current;
    if (viewport === null) return;
    if (props.loading) {
      previousSequenceRef.current = null;
      previousWatermarkRef.current = null;
      setNewEventCount(0);
      return;
    }
    const previousSequence = previousSequenceRef.current;
    if (previousSequence === null) {
      viewport.scrollTop = viewport.scrollHeight;
      wasAtBottomRef.current = true;
      setIsFollowing(true);
      setNewEventCount(0);
    } else if (props.timeline.nextAfterSequence !== previousSequence) {
      // Pagination exposes existing history. Only a rising durable tail is new.
      const addedCount = Math.max(0, props.timeline.highWatermark - (previousWatermarkRef.current ?? props.timeline.highWatermark));
      if (shouldRuntimeTimelineFollowTail(
        previousSequence,
        props.timeline.nextAfterSequence,
        wasAtBottomRef.current,
      )) {
        viewport.scrollTop = viewport.scrollHeight;
        setNewEventCount(0);
      } else {
        setNewEventCount(count => count + addedCount);
      }
    }
    previousSequenceRef.current = props.timeline.nextAfterSequence;
    previousWatermarkRef.current = props.timeline.highWatermark;
  }, [props.loading, props.timeline.highWatermark, props.timeline.items, props.timeline.nextAfterSequence]);

  const jumpToLatest = (): void => {
    const viewport = scrollRef.current;
    if (viewport === null) return;
    viewport.scrollTop = viewport.scrollHeight;
    wasAtBottomRef.current = true;
    setIsFollowing(true);
    setNewEventCount(0);
  };

  return (
    <section aria-label="Runtime Timeline" data-agentos="runtime-timeline" style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Timeline</h3>
        <span role="status" aria-label="Timeline connection" data-connection-state={props.connectionState} style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          {props.connectionState === 'live' ? 'Live' : props.connectionState === 'resyncing' ? 'Resyncing' : props.connectionState === 'reconnecting' ? 'Reconnecting' : props.connectionState === 'closed' ? 'Offline' : 'Connecting'}
        </span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        <label style={{ fontSize: 11 }}>Mode{' '}
          <select aria-label="Timeline mode" style={CONTROL_STYLE} value={props.mode} onChange={event => props.onModeChange(event.target.value as RuntimeTimelineMode)}>
            <option value="summary">Summary</option>
            <option value="detailed">Detailed</option>
            <option value="raw">Raw (advanced)</option>
          </select>
        </label>
        <label style={{ fontSize: 11 }}>Group{' '}
          <select aria-label="Group timeline by" style={CONTROL_STYLE} value={props.group} onChange={event => props.onGroupChange(event.target.value as RuntimeTimelineGroup)}>
            <option value="none">Sequence</option>
            <option value="stage">Stage</option>
            <option value="correlation">Correlation</option>
            <option value="domain">Domain</option>
          </select>
        </label>
        <label style={{ fontSize: 11 }}>Type{' '}
          <input aria-label="Filter timeline by type" style={CONTROL_STYLE} value={props.filters.type} placeholder="all types" onChange={event => props.onFilterChange('type', event.target.value)} />
        </label>
        <label style={{ fontSize: 11 }}>Domain{' '}
          <input aria-label="Filter timeline by domain" style={CONTROL_STYLE} value={props.filters.domain} placeholder="all domains" onChange={event => props.onFilterChange('domain', event.target.value)} />
        </label>
        <label style={{ fontSize: 11 }}>Severity{' '}
          <select aria-label="Filter timeline by severity" style={CONTROL_STYLE} value={props.filters.severity} onChange={event => props.onFilterChange('severity', event.target.value)}>
            <option value="">All</option>
            {['debug', 'info', 'notice', 'warning', 'error', 'critical'].map(severity => <option key={severity} value={severity}>{severity}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 11 }}>Stage{' '}
          <select aria-label="Filter timeline by stage" style={CONTROL_STYLE} value={props.filters.stageId} onChange={event => props.onFilterChange('stageId', event.target.value)}>
            <option value="">All</option>
            {props.stages.map(stage => <option key={stage.stageId} value={stage.stageId}>{stage.workflowStageKey}</option>)}
          </select>
        </label>
      </div>

      {props.timeline.retentionWarning ? (
        <p role="status" data-retention-warning="true" style={{ color: 'var(--status-warning)', fontSize: 12 }}>
          Some older Events have expired. Showing the available history.
        </p>
      ) : null}
      {props.error === undefined ? null : <p role="alert" style={{ color: 'var(--status-danger)', fontSize: 12 }}>{props.error}</p>}

      <div
        ref={scrollRef}
        onScroll={event => {
          const viewport = event.currentTarget;
          const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 12;
          wasAtBottomRef.current = atBottom;
          setIsFollowing(atBottom);
          if (atBottom) setNewEventCount(0);
        }}
        role="region"
        aria-label="Timeline events"
        tabIndex={0}
        style={{ maxHeight: 360, overflowY: 'auto', overflowWrap: 'anywhere', border: '1px solid var(--border-subtle)', borderRadius: 6, padding: 8 }}
        data-live-tail={isFollowing ? 'following' : 'paused'}
      >
        {buckets.length === 0 || buckets.every(bucket => bucket.items.length === 0) ? (
          <p style={{ margin: 0, color: 'var(--text-tertiary)', fontSize: 12 }}>{props.loading ? 'Loading Timeline…' : 'No timeline items match these filters.'}</p>
        ) : buckets.map(bucket => (
          <div key={bucket.key} data-timeline-group={props.group === 'none' ? undefined : bucket.key}>
            {props.group === 'none' ? null : <h4 style={{ margin: '8px 0', fontSize: 12, color: 'var(--text-secondary)' }}>{bucket.label}</h4>}
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {bucket.items.map(item => {
                const keyEvent = isKeyRuntimeTimelineItem(item);
                return (
                  <li
                    key={item.id}
                    data-timeline-item={item.id}
                    data-event-seq={item.firstSequence}
                    data-last-event-seq={item.lastSequence}
                    data-key-event={keyEvent ? 'true' : undefined}
                    style={{
                      fontSize: 12,
                      padding: '7px 8px',
                      marginBottom: 4,
                      borderBottom: '1px solid var(--border-subtle)',
                      borderLeft: keyEvent ? '3px solid var(--status-danger)' : '3px solid transparent',
                      backgroundColor: keyEvent ? 'color-mix(in srgb, var(--status-danger) 9%, transparent)' : 'transparent',
                    }}
                  >
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline' }}>
                      <span style={{ color: 'var(--text-tertiary)', fontFamily: 'monospace' }}>
                        {item.firstSequence === item.lastSequence ? `#${item.firstSequence}` : `#${item.firstSequence}–${item.lastSequence}`}
                      </span>
                      <strong>{item.title}</strong>
                      {item.severity ? <span data-severity={item.severity} style={{ color: item.severity === 'error' || item.severity === 'critical' ? 'var(--status-danger)' : 'var(--text-tertiary)' }}>{item.severity}</span> : null}
                      {item.stageId ? <span style={{ color: 'var(--text-tertiary)' }}>{item.stageId}</span> : null}
                      {item.aggregated ? <span>{item.eventCount} events</span> : null}
                    </div>
                    {item.summary ? <p style={{ margin: '4px 0 0', color: 'var(--text-secondary)' }}>{item.summary}</p> : null}
                    {props.mode === 'raw' && item.payloadSummary ? (
                      <details style={{ marginTop: 4 }}>
                        <summary>Payload ({item.payloadSummary.keys.join(', ') || 'empty'})</summary>
                        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0 0' }}>{item.payloadSummary.preview}</pre>
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6 }}>
        {props.timeline.hasMore ? (
          <button type="button" disabled={props.loadingMore} onClick={props.onLoadMore} style={CONTROL_STYLE}>
            {props.loadingMore ? 'Loading…' : 'Load next page'}
          </button>
        ) : <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Through sequence {props.timeline.nextAfterSequence}</span>}
        {newEventCount > 0 ? (
          <button type="button" onClick={jumpToLatest} style={CONTROL_STYLE}>
            {newEventCount} new Events · Jump to latest
          </button>
        ) : null}
      </div>
    </section>
  );
}
