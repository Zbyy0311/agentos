import { getAgentCapability } from '@agentos/agent-core';
import type { AgentCapability, AgentModelOption, AgentProfile, ThinkingEffort } from '@agentos/shared';
import type { ModelDiscoveryService } from './CliModelDiscovery.js';

export type RuntimeModelOverrides = Pick<AgentProfile, 'model' | 'thinkingEffort'>;

/** Resolve the same live-or-fallback capability that the Agent settings API uses. */
export async function withAgentCapability(
  agent: AgentProfile,
  modelDiscovery: ModelDiscoveryService,
  forceRefresh = false,
): Promise<AgentProfile & { capability: AgentCapability }> {
  const baseCapability = getAgentCapability(agent.role, agent.cliCommand, agent.model);
  const fallbackModels: AgentModelOption[] = baseCapability.models.map(model => ({
    id: model,
    label: model,
    thinkingEfforts: [...baseCapability.thinkingEfforts],
    defaultThinkingEffort: baseCapability.defaultThinkingEffort,
  }));
  const discovery = await modelDiscovery.discover({
    cliCommand: agent.cliCommand,
    role: agent.role,
    fallbackModels,
    fallbackThinkingEfforts: baseCapability.thinkingEfforts,
    forceRefresh,
  });
  const modelOptions = discovery.models.length > 0 ? discovery.models : fallbackModels;
  const selectedModel = agent.model?.trim();
  const selectedOption = selectedModel ? modelOptions.find(model => model.id === selectedModel) : undefined;
  return {
    ...agent,
    thinkingEffort: agent.thinkingEffort ?? 'auto',
    capability: {
      ...baseCapability,
      models: modelOptions.map(model => model.id),
      modelOptions,
      modelSource: discovery.source,
      modelSourceStale: discovery.stale,
      ...(discovery.warning ? { modelSourceWarning: discovery.warning } : {}),
      thinkingEfforts: selectedOption?.thinkingEfforts ?? baseCapability.thinkingEfforts,
    },
  };
}

/** Validate a model/effort pair against the selected Agent's discovered capability. */
export function validateRuntimeOverrides(
  agent: AgentProfile & { capability: AgentCapability },
  overrides: RuntimeModelOverrides | undefined,
): void {
  if (!overrides) return;
  const modelOptions = agent.capability.modelOptions ?? agent.capability.models.map(model => ({
    id: model,
    label: model,
    thinkingEfforts: [...agent.capability.thinkingEfforts],
    defaultThinkingEffort: agent.capability.defaultThinkingEffort,
  }));
  const selectedModel = overrides.model ?? agent.model;
  const selectedModelOption = selectedModel ? modelOptions.find(model => model.id === selectedModel) : undefined;
  if (overrides.model && !selectedModelOption) {
    throw new Error(`Model "${overrides.model}" is not available for ${agent.name}`);
  }
  if (overrides.thinkingEffort) {
    const supportedEfforts = selectedModelOption?.thinkingEfforts ?? agent.capability.thinkingEfforts;
    if (!supportedEfforts.includes(overrides.thinkingEffort)) {
      throw new Error(`${agent.name} model does not support thinking effort "${overrides.thinkingEffort}"`);
    }
  }
}

export interface ParsedGroupMemberSettings {
  readonly roleTitle?: string;
  readonly model?: string;
  readonly thinkingEffort?: ThinkingEffort;
  readonly additionalInstructions?: string;
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string or null`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters`);
  return trimmed.length === 0 ? undefined : trimmed;
}

function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high' || value === 'max';
}

/** Parse only the bounded group-scoped settings; unknown fields are ignored. */
export function parseGroupMemberSettings(value: Record<string, unknown>): ParsedGroupMemberSettings {
  const roleTitle = optionalText(value.roleTitle, 'roleTitle', 80);
  const model = optionalText(value.model, 'model', 200);
  const additionalInstructions = optionalText(value.additionalInstructions, 'additionalInstructions', 4000);
  const thinkingEffort = value.thinkingEffort === undefined || value.thinkingEffort === null
    ? undefined
    : value.thinkingEffort;
  if (thinkingEffort !== undefined && !isThinkingEffort(thinkingEffort)) {
    throw new Error('thinkingEffort must be auto, low, medium, high, or max');
  }
  return {
    ...(roleTitle === undefined ? {} : { roleTitle }),
    ...(model === undefined ? {} : { model }),
    ...(thinkingEffort === undefined ? {} : { thinkingEffort }),
    ...(additionalInstructions === undefined ? {} : { additionalInstructions }),
  };
}
