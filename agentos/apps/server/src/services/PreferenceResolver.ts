import type { PreferenceContextKind, PreferenceProjection } from '@agentos/shared';
import { PROMOTION_THRESHOLDS } from './PreferenceRules.js';

export interface ResolvedPreference {
  projectionId: string;
  dimension: PreferenceProjection['dimension'];
  contextKind: PreferenceContextKind;
  preferredValue: string;
  confidence: number;
  status: Extract<PreferenceProjection['status'], 'provisional' | 'stable'>;
  scope: PreferenceProjection['scope'];
  workspaceId?: string;
}

export function resolvePreferenceProjections(input: {
  projections: PreferenceProjection[];
  workspaceId: string;
  contextKind: PreferenceContextKind;
}): ResolvedPreference[] {
  const eligible = input.projections
    .filter(projection => projection.status === 'provisional' || projection.status === 'stable')
    .map(projection => ({ projection: projection as PreferenceProjection & { status: 'provisional' | 'stable' }, priority: projectionPriority(projection, input.workspaceId, input.contextKind) }))
    .filter(item => item.priority < Number.POSITIVE_INFINITY);
  const byDimension = new Map<PreferenceProjection['dimension'], typeof eligible>();
  for (const item of eligible) {
    const group = byDimension.get(item.projection.dimension) ?? [];
    group.push(item);
    byDimension.set(item.projection.dimension, group);
  }
  const resolved: ResolvedPreference[] = [];
  for (const group of byDimension.values()) {
    group.sort((a, b) => a.priority - b.priority || b.projection.confidence - a.projection.confidence || a.projection.id.localeCompare(b.projection.id));
    const top = group[0];
    const samePriority = group.filter(item => item.priority === top.priority);
    const values = new Set(samePriority.map(item => item.projection.preferredValue));
    if (values.size > 1 && Math.abs(samePriority[0].projection.confidence - samePriority[1].projection.confidence) < PROMOTION_THRESHOLDS.closeConfidenceDelta) continue;
    resolved.push({
      projectionId: top.projection.id,
      dimension: top.projection.dimension,
      contextKind: top.projection.contextKind,
      preferredValue: top.projection.preferredValue,
      confidence: top.projection.confidence,
      status: top.projection.status,
      scope: top.projection.scope,
      ...(top.projection.workspaceId ? { workspaceId: top.projection.workspaceId } : {}),
    });
  }
  return resolved.sort((a, b) => a.dimension.localeCompare(b.dimension));
}

function projectionPriority(projection: PreferenceProjection, workspaceId: string, contextKind: PreferenceContextKind): number {
  const isWorkspace = projection.scope === 'workspace' && projection.workspaceId === workspaceId;
  const isGlobal = projection.scope === 'global';
  const isScene = projection.contextKind === contextKind;
  const isGeneral = projection.contextKind === 'general';
  if (isWorkspace && isScene) return 0;
  if (isGlobal && isScene) return 1;
  if (isWorkspace && isGeneral) return 2;
  if (isGlobal && isGeneral) return 3;
  return Number.POSITIVE_INFINITY;
}
