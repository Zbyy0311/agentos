'use client';

import type { ReactNode } from 'react';
import { UI_FONT_STACK, UI_SPACING_BASE_PX } from '../../lib/uiFoundation';

/**
 * MF-5 Memory explanation view (12-UI-Architecture section 14).
 *
 * Answers "why did this Run receive this Memory?" from one immutable Context
 * Snapshot: identity, retrieval strategy, query hash, budget and token cost,
 * per-Entry rank/score/Scope/Importance/Confidence/Authority/Source/reasons,
 * and exclusions with reasons. Presentational only; it never fetches and never
 * mutates. The raw query text is not frozen in the snapshot — only its hash
 * is — so the hash is displayed verbatim.
 */

export interface MemoryExplanationSourceRefDto {
  readonly kind: string;
  readonly id: string;
}

export interface MemoryExplanationSelectionDto {
  readonly memoryId: string;
  readonly memoryVersion: number;
  readonly rank: number;
  readonly score: number;
  readonly scope: string;
  readonly category: string;
  readonly authority: string;
  readonly confidence: number;
  readonly importance: number;
  readonly tokenCost: number;
  readonly reasons: readonly string[];
  readonly sourceRefs: readonly MemoryExplanationSourceRefDto[];
}

export interface MemoryExplanationExclusionDto {
  readonly memoryId: string;
  readonly reason: string;
}

export interface MemoryExplanationSnapshotDto {
  readonly memoryContextId: string;
  readonly queryHash: string;
  readonly retrievalStrategyVersion: string;
  readonly totalTokens: number;
  readonly maxTokens?: number;
  readonly truncated: boolean;
  readonly createdAt: string;
  readonly selected: readonly MemoryExplanationSelectionDto[];
  readonly exclusions: readonly MemoryExplanationExclusionDto[];
}

function Label(props: { readonly children: ReactNode }) {
  return (
    <span style={{ color: 'var(--text-tertiary)', fontSize: 11, letterSpacing: '0.04em' }}>
      {props.children}
    </span>
  );
}

export function MemoryExplanationView({ snapshot }: { readonly snapshot: MemoryExplanationSnapshotDto }) {
  return (
    <div data-agentos="memory-explanation" style={{ fontFamily: UI_FONT_STACK.ui, fontSize: 12 }}>
      <dl style={{ margin: 0, display: 'grid', rowGap: 2, marginBottom: UI_SPACING_BASE_PX * 2 }}>
        <div><Label>snapshot </Label><span data-field="snapshot-id">{snapshot.memoryContextId}</span></div>
        <div><Label>strategy </Label><span data-field="strategy">{snapshot.retrievalStrategyVersion}</span></div>
        <div><Label>query hash </Label><span data-field="query-hash">{snapshot.queryHash}</span></div>
        <div>
          <Label>tokens </Label>
          <span data-field="tokens">
            {snapshot.totalTokens}
            {snapshot.maxTokens === undefined ? '' : ` / ${snapshot.maxTokens}`}
          </span>
          {snapshot.truncated ? <span data-field="truncated" style={{ color: 'var(--status-warning, #b8860b)' }}> truncated</span> : null}
        </div>
        <div><Label>created </Label><span data-field="created-at">{snapshot.createdAt}</span></div>
      </dl>

      <div data-agentos="memory-explanation-selected">
        <Label>SELECTED ({snapshot.selected.length})</Label>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {snapshot.selected.map(item => (
            <li
              key={item.memoryId}
              data-memory-id={item.memoryId}
              style={{ borderTop: '1px solid var(--border-subtle)', padding: `${UI_SPACING_BASE_PX}px 0` }}
            >
              <div>
                <span style={{ color: 'var(--text-primary)' }}>#{item.rank} {item.memoryId}</span>
                <span style={{ color: 'var(--text-tertiary)' }}> v{item.memoryVersion} · score {item.score} · {item.tokenCost} tok</span>
              </div>
              <div style={{ color: 'var(--text-tertiary)' }}>
                {item.scope} · {item.category} · {item.authority}
                {' '}· conf {item.confidence} · imp {item.importance}
              </div>
              <div style={{ color: 'var(--text-tertiary)' }}>
                reasons: {item.reasons.join(', ')}
                {item.sourceRefs.length === 0 ? '' : ` · source: ${item.sourceRefs.map(ref => `${ref.kind}:${ref.id}`).join(', ')}`}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {snapshot.exclusions.length === 0 ? null : (
        <div data-agentos="memory-explanation-exclusions">
          <Label>EXCLUDED ({snapshot.exclusions.length})</Label>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {snapshot.exclusions.map(item => (
              <li key={item.memoryId} data-memory-id={item.memoryId} style={{ color: 'var(--text-tertiary)' }}>
                {item.memoryId} — {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
