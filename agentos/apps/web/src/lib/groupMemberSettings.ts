import type { AgentCapability, AgentModelOption, ThinkingEffort } from '@agentos/shared';

export interface GroupMemberSettingsSource {
  readonly model?: string;
  readonly thinkingEffort?: ThinkingEffort;
  readonly capability?: AgentCapability;
}

export const THINKING_EFFORT_LABELS: Record<ThinkingEffort, string> = {
  auto: '自动（默认）',
  low: '低',
  medium: '中',
  high: '高',
  max: '最大',
};

export function getGroupMemberModelOptions(agent: GroupMemberSettingsSource): AgentModelOption[] {
  const capability = agent.capability;
  const options = capability?.modelOptions?.length
    ? capability.modelOptions
    : (capability?.models ?? []).map(id => ({
      id,
      label: id,
      thinkingEfforts: [...(capability?.thinkingEfforts ?? ['auto'])],
      defaultThinkingEffort: capability?.defaultThinkingEffort ?? 'auto',
    }));
  if (agent.model && !options.some(option => option.id === agent.model)) {
    return [...options, {
      id: agent.model,
      label: `当前配置 · ${agent.model}`,
      thinkingEfforts: [...(capability?.thinkingEfforts ?? ['auto'])],
      defaultThinkingEffort: capability?.defaultThinkingEffort ?? 'auto',
    }];
  }
  return options;
}

export function getGroupMemberThinkingEfforts(
  agent: GroupMemberSettingsSource,
  model?: string,
): ThinkingEffort[] {
  const selected = getGroupMemberModelOptions(agent).find(option => option.id === model);
  if (selected?.thinkingEfforts.length) return selected.thinkingEfforts;
  if (agent.capability?.thinkingEfforts?.length) return agent.capability.thinkingEfforts;
  return ['auto'];
}
