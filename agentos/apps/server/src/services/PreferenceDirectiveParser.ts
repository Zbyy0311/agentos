import type { PreferenceContextKind, PreferenceDimension } from '@agentos/shared';

export interface ParsedPreferenceDirective {
  dimension: PreferenceDimension;
  contextKind: PreferenceContextKind;
  candidateValue: string;
}

interface DirectiveRule {
  dimension: PreferenceDimension;
  candidateValue: string;
  phrases: readonly string[];
}

const DIRECTIVE_RULES: readonly DirectiveRule[] = [
  {
    dimension: 'execution_style',
    candidateValue: 'plan_first',
    phrases: ['先给计划', '先规划', '先拆分', '先设计'],
  },
  {
    dimension: 'execution_style',
    candidateValue: 'direct_execution',
    phrases: ['直接执行', '直接做'],
  },
  {
    dimension: 'response_detail',
    candidateValue: 'balanced',
    phrases: ['不要太简洁', '别太简短', '不要过于简洁', '不要过于简短'],
  },
  {
    dimension: 'response_detail',
    candidateValue: 'concise',
    phrases: ['简洁一点', '简短回答', '不要太长', '少废话', '不要详细展开', '不要展开说明'],
  },
  {
    dimension: 'response_detail',
    candidateValue: 'detailed',
    phrases: ['详细展开', '展开说明', '多解释', '更多细节'],
  },
  {
    dimension: 'change_scope',
    candidateValue: 'surgical',
    phrases: ['不要重构', '最小改动', '保持现有架构'],
  },
  {
    dimension: 'change_scope',
    candidateValue: 'broad_refactor',
    phrases: ['可以重构', '整体重做', '扩大范围'],
  },
  {
    dimension: 'verification_depth',
    candidateValue: 'full_flow',
    phrases: ['完整测试', '全链路', '端到端验收'],
  },
  {
    dimension: 'verification_depth',
    candidateValue: 'targeted',
    phrases: ['不用全量', '只测', '简单验证'],
  },
  {
    dimension: 'progress_update_style',
    candidateValue: 'frequent_updates',
    phrases: ['及时更新', '每一步汇报', '持续同步'],
  },
  {
    dimension: 'delivery_format',
    candidateValue: 'summary_commands_validation',
    phrases: ['命令和验收', '测试结果和命令'],
  },
] as const;

const PLAN_FIRST_NEGATIONS = ['先别直接执行', '不要直接执行', '先不要直接做'];

export function parsePreferenceDirective(
  text: string,
  contextKind: PreferenceContextKind,
): ParsedPreferenceDirective | undefined {
  const normalized = text.toLocaleLowerCase();
  const executionContext = contextKind === 'general' ? 'coding' : contextKind;

  if (containsAny(normalized, PLAN_FIRST_NEGATIONS)) {
    return { dimension: 'execution_style', contextKind: contextKind === 'general' ? 'planning' : executionContext, candidateValue: 'plan_first' };
  }

  if (containsAny(normalized, ['不要详细展开', '不要展开说明'])) {
    return { dimension: 'response_detail', contextKind, candidateValue: 'concise' };
  }

  if (containsAny(normalized, ['既要简洁又要详细', '既简洁又详细', '简洁和详细都要'])) return undefined;

  const matches = DIRECTIVE_RULES.filter(rule => containsAny(normalized, rule.phrases));
  const byDimension = new Map<PreferenceDimension, Set<string>>();
  for (const match of matches) {
    const values = byDimension.get(match.dimension) ?? new Set<string>();
    values.add(match.candidateValue);
    byDimension.set(match.dimension, values);
  }

  if ([...byDimension.values()].some(values => values.size > 1)) return undefined;
  const match = matches[0];
  if (!match) return undefined;
  return {
    dimension: match.dimension,
    contextKind: match.dimension === 'execution_style'
      ? (match.candidateValue === 'plan_first'
        ? (contextKind === 'general' ? 'planning' : executionContext)
        : (contextKind === 'general' ? 'coding' : executionContext))
      : contextKind,
    candidateValue: match.candidateValue,
  };
}

function containsAny(text: string, phrases: readonly string[]): boolean {
  return phrases.some(phrase => text.includes(phrase));
}
