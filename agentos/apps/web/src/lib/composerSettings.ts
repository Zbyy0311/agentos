import type { AgentModelOption, AgentProfile, ThinkingEffort } from '@agentos/shared';

const FALLBACK_THINKING_EFFORTS: ThinkingEffort[] = ['auto'];

export interface ComposerSettings {
  model?: string;
  thinkingEffort: ThinkingEffort;
}

export type ComposerRuntimeOverrides = Partial<Pick<ComposerSettings, 'model' | 'thinkingEffort'>>;

export function getModelOptions(agent?: AgentProfile): AgentModelOption[] {
  if (!agent?.capability) return [];
  const discovered = agent.capability.modelOptions?.length
    ? agent.capability.modelOptions
    : agent.capability.models.map(id => ({
    id,
    label: id,
    thinkingEfforts: [...agent.capability!.thinkingEfforts],
    defaultThinkingEffort: agent.capability!.defaultThinkingEffort,
    }));
  if (agent.model && !discovered.some(option => option.id === agent.model)) {
    return [...discovered, {
      id: agent.model,
      label: `当前配置 · ${agent.model}`,
      thinkingEfforts: [...agent.capability.thinkingEfforts],
      defaultThinkingEffort: agent.capability.defaultThinkingEffort,
    }];
  }
  return discovered;
}

export function getThinkingEfforts(agent: AgentProfile | undefined, model?: string): ThinkingEffort[] {
  const selected = getModelOptions(agent).find(option => option.id === model);
  return selected?.thinkingEfforts.length
    ? selected.thinkingEfforts
    : agent?.capability?.thinkingEfforts?.length
      ? agent.capability.thinkingEfforts
      : FALLBACK_THINKING_EFFORTS;
}

export function normalizeThinkingEffort(
  effort: ThinkingEffort | undefined,
  supportedEfforts: readonly ThinkingEffort[],
  fallback?: ThinkingEffort,
): ThinkingEffort {
  const supported = supportedEfforts.length ? supportedEfforts : FALLBACK_THINKING_EFFORTS;
  if (effort && supported.includes(effort)) return effort;
  if (fallback && supported.includes(fallback)) return fallback;
  return supported.includes('auto') ? 'auto' : supported[0];
}

export function getInitialComposerSettings(agent?: AgentProfile, conversationSettings?: ComposerRuntimeOverrides): ComposerSettings {
  const model = conversationSettings?.model?.trim() || agent?.model?.trim() || undefined;
  const selectedOption = getModelOptions(agent).find(option => option.id === model);
  const supportedEfforts = getThinkingEfforts(agent, model);
  const preferredEffort = conversationSettings?.thinkingEffort
    ?? agent?.thinkingEffort
    ?? selectedOption?.defaultThinkingEffort
    ?? agent?.capability?.defaultThinkingEffort
    ?? 'auto';
  return {
    model,
    thinkingEffort: normalizeThinkingEffort(preferredEffort, supportedEfforts, selectedOption?.defaultThinkingEffort),
  };
}

export function getRuntimeOverrides(agent: AgentProfile | undefined, settings: ComposerSettings): ComposerRuntimeOverrides {
  const model = settings.model && settings.model !== agent?.model ? settings.model : undefined;
  const defaultThinkingEffort = agent?.thinkingEffort ?? 'auto';
  const thinkingEffort = settings.thinkingEffort !== defaultThinkingEffort ? settings.thinkingEffort : undefined;
  return { model, thinkingEffort };
}
