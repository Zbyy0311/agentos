import type { AgentRunStatus, PreferenceContextKind, PreferenceDimension, PreferenceEvidence, PreferenceProjection } from '@agentos/shared';
import { classifyPreferenceContext } from './PreferenceContextClassifier.js';

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

interface ParsedDirective {
  dimension: PreferenceDimension;
  contextKind: PreferenceContextKind;
  candidateValue: string;
}

function parsePreferenceDirective(objective: string, contextKind: PreferenceContextKind): ParsedDirective | undefined {
  const text = objective.toLocaleLowerCase();
  if (/(直接执行|直接做|不要先问|先别问)/i.test(text)) return { dimension: 'execution_style', contextKind: contextKind === 'general' ? 'coding' : contextKind, candidateValue: 'direct_execution' };
  if (/(先给计划|先规划|先拆分|先设计)/i.test(text)) return { dimension: 'execution_style', contextKind: contextKind === 'general' ? 'planning' : contextKind, candidateValue: 'plan_first' };
  if (/(简洁|简短|不要太长|少废话)/i.test(text)) return { dimension: 'response_detail', contextKind, candidateValue: 'concise' };
  if (/(详细|展开说明|多解释)/i.test(text)) return { dimension: 'response_detail', contextKind, candidateValue: 'detailed' };
  if (/(不要重构|最小改动|保持现有架构)/i.test(text)) return { dimension: 'change_scope', contextKind, candidateValue: 'surgical' };
  if (/(完整测试|全链路|端到端验收)/i.test(text)) return { dimension: 'verification_depth', contextKind, candidateValue: 'full_flow' };
  if (/(及时更新|每一步汇报|持续同步)/i.test(text)) return { dimension: 'progress_update_style', contextKind, candidateValue: 'frequent_updates' };
  if (/(命令.*验收|测试结果.*命令)/i.test(text)) return { dimension: 'delivery_format', contextKind, candidateValue: 'summary_commands_validation' };
  return undefined;
}

function isCorrectionFor(projection: PreferenceProjection, content: string): boolean {
  const text = content.toLocaleLowerCase();
  if (projection.dimension === 'response_detail' && projection.preferredValue === 'concise') return /(详细|展开|多解释|太简短|更多细节)/i.test(text);
  if (projection.dimension === 'response_detail' && projection.preferredValue === 'detailed') return /(简洁|简短|太长|少说)/i.test(text);
  if (projection.dimension === 'execution_style' && projection.preferredValue === 'direct_execution') return /(先规划|先计划|先问|不要直接)/i.test(text);
  if (projection.dimension === 'execution_style' && projection.preferredValue === 'plan_first') return /(直接做|直接执行|不要计划)/i.test(text);
  if (projection.dimension === 'change_scope' && projection.preferredValue === 'surgical') return /(可以重构|整体重做|扩大范围)/i.test(text);
  if (projection.dimension === 'verification_depth' && projection.preferredValue === 'full_flow') return /(不用全量|只测|简单验证)/i.test(text);
  return false;
}
