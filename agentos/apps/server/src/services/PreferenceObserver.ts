import type { AgentRunStatus, PreferenceEvidence, PreferenceProjection } from '@agentos/shared';
import { classifyPreferenceContext } from './PreferenceContextClassifier.js';
import { parsePreferenceDirective } from './PreferenceDirectiveParser.js';

export interface PreferenceFollowUpMessage {
  id: string;
  content: string;
  createdAt: string;
}

export interface ObserveRunInput {
  profileId: string;
  workspaceId: string;
  conversationId: string;
  runId: string;
  objective: string;
  status: AgentRunStatus;
  resultSummary?: string;
  appliedProjections?: PreferenceProjection[];
  appliedProjectionIds?: string[];
  followUpMessages?: PreferenceFollowUpMessage[];
  priorEvidence?: PreferenceEvidence[];
}

export class PreferenceObserver {
  observeRun(input: ObserveRunInput): PreferenceEvidence[] {
    const observed: PreferenceEvidence[] = [];
    const applied = input.appliedProjections ?? [];
    const followUps = input.followUpMessages ?? [];
    const contextKind = classifyPreferenceContext({ objective: input.objective });

    for (const projection of applied) {
      const correction = followUps.find(message => isCorrectionFor(projection, message.content));
      if (correction) {
        observed.push(this.createEvidence(input, {
          sourceEventId: `preference:${correction.id}:conflict:${projection.id}`,
          dimension: projection.dimension,
          contextKind: projection.contextKind,
          candidateValue: projection.preferredValue,
          signalType: 'conflict', polarity: 'negative', weight: 4,
          summary: `用户纠正了 ${projection.dimension} 的默认偏好`,
        }));
      }
    }

    const directive = parsePreferenceDirective(input.objective, contextKind);
    if (directive) {
      const repeated = (input.priorEvidence ?? []).some(item =>
        item.dimension === directive.dimension && item.contextKind === directive.contextKind
        && item.candidateValue === directive.candidateValue && item.runId !== input.runId,
      );
      observed.push(this.createEvidence(input, {
        sourceEventId: `preference:${input.runId}:directive:${directive.dimension}:${directive.candidateValue}`,
        ...directive,
        signalType: repeated ? 'repeated_instruction' : 'workflow_choice',
        polarity: 'positive', weight: repeated ? 3 : 2,
        summary: `观察到 ${directive.dimension}=${directive.candidateValue} 的工作方式`,
      }));
    }

    if (input.status === 'completed') {
      for (const projection of applied) {
        if (followUps.some(message => isCorrectionFor(projection, message.content))) continue;
        observed.push(this.createEvidence(input, {
          sourceEventId: `preference:${input.runId}:success:${projection.id}`,
          dimension: projection.dimension,
          contextKind: projection.contextKind,
          candidateValue: projection.preferredValue,
          signalType: 'successful_application', polarity: 'positive', weight: 1,
          summary: `Run 成功沿用了 ${projection.dimension} 偏好`,
        }));
      }
    }
    return observed;
  }

  private createEvidence(input: ObserveRunInput, value: Omit<PreferenceEvidence, 'id' | 'profileId' | 'workspaceId' | 'conversationId' | 'runId' | 'observedAt' | 'createdAt' | 'status'>): PreferenceEvidence {
    const now = new Date().toISOString();
    return {
      id: value.sourceEventId,
      profileId: input.profileId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      runId: input.runId,
      ...value,
      status: 'active',
      observedAt: now,
      createdAt: now,
    };
  }
}

function isCorrectionFor(projection: PreferenceProjection, content: string): boolean {
  const directive = parsePreferenceDirective(content, projection.contextKind);
  return directive?.dimension === projection.dimension && directive.candidateValue !== projection.preferredValue;
}
