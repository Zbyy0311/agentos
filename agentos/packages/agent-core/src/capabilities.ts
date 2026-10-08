import type { AgentCapability, AgentProvider, AgentRole, ThinkingEffort } from '@agentos/shared';
import { isCodexCli, isOpenCodeCli } from './config.js';

export interface CliCapability {
  cliKind: 'kimi' | 'opencode' | 'codex' | 'unknown';
  modelFlag?: '--model' | '-m';
  thinkingEffortMode: 'arg' | 'env' | 'none';
  thinkingEffortValues: ThinkingEffort[];
}

const AUTO_ONLY: ThinkingEffort[] = ['auto'];
const ADJUSTABLE_EFFORTS: ThinkingEffort[] = ['auto', 'low', 'medium', 'high', 'max'];

export function getCliCapability(cliCommand: string, configuredProvider?: AgentProvider): CliCapability {
  if (configuredProvider) {
    if (configuredProvider === 'kimi') return { cliKind: 'kimi', modelFlag: '-m', thinkingEffortMode: 'env', thinkingEffortValues: [...ADJUSTABLE_EFFORTS] };
    if (configuredProvider === 'opencode') return { cliKind: 'opencode', modelFlag: '--model', thinkingEffortMode: 'arg', thinkingEffortValues: [...ADJUSTABLE_EFFORTS] };
    if (configuredProvider === 'codex') return { cliKind: 'codex', modelFlag: '-m', thinkingEffortMode: 'arg', thinkingEffortValues: [...ADJUSTABLE_EFFORTS] };
  }
  if (/^(?:kimi)(?:\.(?:exe|cmd|bat))?$/i.test(cliCommand) || /[\\/]kimi(?:\.(?:exe|cmd|bat))?$/i.test(cliCommand)) {
    return {
      cliKind: 'kimi',
      modelFlag: '-m',
      thinkingEffortMode: 'env',
      thinkingEffortValues: [...ADJUSTABLE_EFFORTS],
    };
  }
  if (isOpenCodeCli(cliCommand)) {
    return {
      cliKind: 'opencode',
      modelFlag: '--model',
      thinkingEffortMode: 'arg',
      thinkingEffortValues: [...ADJUSTABLE_EFFORTS],
    };
  }
  if (isCodexCli(cliCommand)) {
    return {
      cliKind: 'codex',
      modelFlag: '-m',
      thinkingEffortMode: 'arg',
      thinkingEffortValues: [...ADJUSTABLE_EFFORTS],
    };
  }
  return {
    cliKind: 'unknown',
    thinkingEffortMode: 'none',
    thinkingEffortValues: [...AUTO_ONLY],
  };
}

export function getAgentCapability(
  role: AgentRole,
  cliCommand: string,
  defaultModel?: string,
): AgentCapability {
  const cli = getCliCapability(cliCommand);
  const resolvedDefaultModel = defaultModel
    ?? (cli.cliKind === 'kimi' ? 'kimi-code/kimi-for-coding' : undefined)
    ?? (cli.cliKind === 'opencode' ? process.env.AGENTOS_OPENCODE_MODEL ?? 'deepseek/deepseek-v4-flash' : undefined);
  return {
    role,
    cliKind: cli.cliKind,
    models: resolvedDefaultModel ? [resolvedDefaultModel] : [],
    thinkingEfforts: [...cli.thinkingEffortValues],
    ...(resolvedDefaultModel ? { defaultModel: resolvedDefaultModel } : {}),
    defaultThinkingEffort: 'auto',
  };
}
