import type { PreferenceApplication, PreferenceContext, PreferenceEvidence, PreferenceProjection } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { buildPreferenceContext } from './PreferenceContextBuilder.js';
import { calculatePreferenceProjection, normalizePreferenceEvidence } from './PreferenceProjector.js';
import { PreferenceObserver, type ObserveRunInput } from './PreferenceObserver.js';

export interface ResolvePreferenceInput {
  profileId: string;
  workspaceId: string;
  objective: string;
  conversationType?: 'direct' | 'group';
  runId: string;
}

export class PreferenceService {
  constructor(
    private readonly store: SqliteStore,
    private readonly observer = new PreferenceObserver(),
  ) {}

  async recordRunEvidence(input: ObserveRunInput): Promise<PreferenceProjection[]> {
    const profile = this.store.getDefaultUserProfile();
    if (!profile.learningEnabled || profile.id !== input.profileId) return [];
    const priorEvidence = input.priorEvidence ?? this.store.listPreferenceEvidence(input.profileId, input.workspaceId);
    const observed = this.observer.observeRun({ ...input, priorEvidence });
    const inserted = observed
      .map(item => normalizePreferenceEvidence(item))
      .filter((item): item is PreferenceEvidence => Boolean(item))
      .map(item => this.store.createPreferenceEvidence(item));
    if (inserted.length === 0) return [];

    const affected = new Map<string, PreferenceEvidence>();
    for (const item of inserted) affected.set(`${item.dimension}:${item.contextKind}`, item);
    const projections: PreferenceProjection[] = [];
    for (const key of affected.keys()) {
      const [dimension, contextKind] = key.split(':');
      const workspaceEvidence = this.store.listPreferenceEvidence(input.profileId, input.workspaceId)
        .filter(item => item.dimension === dimension && item.contextKind === contextKind);
      const workspaceProjection = calculatePreferenceProjection(workspaceEvidence, 'workspace', input.workspaceId);
      if (workspaceProjection) {
        const links = workspaceEvidence
          .filter(item => item.candidateValue === workspaceProjection.preferredValue)
          .map(item => ({ evidenceId: item.id, contribution: item.polarity === 'negative' ? -item.weight : item.weight }));
        this.store.upsertPreferenceProjection(workspaceProjection, links);
        projections.push(workspaceProjection);
      }
      const globalEvidence = this.store.listPreferenceEvidence(input.profileId)
        .filter(item => item.dimension === dimension && item.contextKind === contextKind);
      const globalProjection = calculatePreferenceProjection(globalEvidence, 'global');
      if (globalProjection) {
        const links = globalEvidence
          .filter(item => item.candidateValue === globalProjection.preferredValue)
          .map(item => ({ evidenceId: item.id, contribution: item.polarity === 'negative' ? -item.weight : item.weight }));
        this.store.upsertPreferenceProjection(globalProjection, links);
        projections.push(globalProjection);
      }
    }
    return projections;
  }

  resolveForRun(input: ResolvePreferenceInput): PreferenceContext {
    const profile = this.store.getDefaultUserProfile();
    if (!profile.learningEnabled || profile.id !== input.profileId) {
      return { contextKind: 'general', text: '', applications: [] };
    }
    return buildPreferenceContext({
      runId: input.runId, workspaceId: input.workspaceId, objective: input.objective,
      conversationType: input.conversationType, projections: this.store.listPreferenceProjections(input.profileId, input.workspaceId),
    });
  }

  recordApplications(applications: PreferenceApplication[]): void {
    for (const application of applications) this.store.createPreferenceApplication(application);
  }

  pauseLearning(profileId: string): void {
    this.store.setPreferenceLearningEnabled(profileId, false);
  }

  resumeLearning(profileId: string): void {
    this.store.setPreferenceLearningEnabled(profileId, true);
  }

  clearLearning(profileId: string): void {
    this.store.clearPreferenceProjections(profileId);
  }

  sleepProjection(profileId: string, projectionId: string): PreferenceProjection {
    return this.store.sleepPreferenceProjection(profileId, projectionId);
  }
}

export type { ObserveRunInput } from './PreferenceObserver.js';
