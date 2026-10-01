import type { PreferenceContext, PreferenceContextKind, PreferenceProjection } from '@agentos/shared';
import { classifyPreferenceContext } from './PreferenceContextClassifier.js';

export function buildPreferenceContext(input: {
  runId: string;
  workspaceId: string;
  objective: string;
  conversationType?: 'direct' | 'group';
  projections: PreferenceProjection[];
}): PreferenceContext {
  const contextKind = classifyPreferenceContext({ objective: input.objective, conversationType: input.conversationType });
  // Projections are learning evidence and pending suggestions. They are never
  // prompt authority; a confirmed Memory Entry is injected through retrieval.
  void input.projections;
  void input.runId;
  void input.workspaceId;
  return { contextKind, text: '', applications: [] };
}

export type { PreferenceContextKind };
