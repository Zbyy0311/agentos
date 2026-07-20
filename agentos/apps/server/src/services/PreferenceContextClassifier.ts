import type { ConversationType, PreferenceContextKind } from '@agentos/shared';

export function classifyPreferenceContext(input: {
  objective: string;
  conversationType?: ConversationType;
  hasFileChanges?: boolean;
}): PreferenceContextKind {
  const text = input.objective.trim().toLocaleLowerCase();
  if (/(解释|说明|教程|原理|explain|tutorial|why)/i.test(text)) return 'explanation';
  if (/(修复|报错|错误|失败|崩溃|调试|debug|bug|fix)/i.test(text)) return 'debugging';
  if (/(审查|评审|review|pull request|pr)/i.test(text)) return 'review';
  if (/(规划|计划|方案|设计|架构|路线图|plan|design|architecture|roadmap)/i.test(text)) return 'planning';
  if (/(实现|开发|修改|编写|创建|构建|新增|implement|build|create|add|write)/i.test(text) || input.hasFileChanges) return 'coding';
  return 'general';
}
