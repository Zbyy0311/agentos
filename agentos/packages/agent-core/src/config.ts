import type { AgentConfig } from './types.js';
import type { AgentProvider, AgentRole, AgentStage, WorkspaceAgent } from '@agentos/shared';
import { getCliCapability } from './capabilities.js';

// CLI commands — assume they are in PATH, or override via env var
const CODEX_CLI = process.env.AGENTOS_CODEX_CLI ?? 'codex';
const KIMI_CLI = process.env.AGENTOS_KIMI_CLI ?? 'kimi';
const OPENCODE_CLI = process.env.AGENTOS_OPENCODE_CLI ?? 'opencode';
const KIMI_MODEL = process.env.AGENTOS_KIMI_MODEL ?? 'kimi-code/kimi-for-coding';
const OPENCODE_MODEL = process.env.AGENTOS_OPENCODE_MODEL ?? (OPENCODE_CLI === CODEX_CLI ? 'gpt-5.4' : 'deepseek/deepseek-v4-flash');
const OPENCODE_ARGS = OPENCODE_CLI === CODEX_CLI
  ? ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--ephemeral']
  : ['--pure', 'run', '--model', OPENCODE_MODEL];

export const FORCE_MOCK = process.env.AGENTOS_FORCE_MOCK === 'true';

export function resolveConfiguredProvider(config: Pick<AgentConfig, 'role' | 'cliCommand' | 'provider'>): AgentProvider {
  if (config.provider) return config.provider;
  const capability = getCliCapability(config.cliCommand);
  return capability.cliKind === 'kimi' || capability.cliKind === 'opencode' || capability.cliKind === 'codex'
    ? capability.cliKind
    : 'custom';
}

export function isCodexCli(command: string): boolean {
  return /(?:^|[\\/])codex(?:\.(?:exe|cmd|bat))?$/i.test(command)
    || /^codex(?:\.(?:exe|cmd|bat))?$/i.test(command);
}

export function isOpenCodeCli(command: string): boolean {
  return /(?:^|[\\/])opencode(?:\.(?:exe|cmd|bat))?$/i.test(command)
    || /^opencode(?:\.(?:exe|cmd|bat))?$/i.test(command);
}

export const STAGE_ROLE_MAP: Record<AgentStage, AgentRole> = {
  codex_manager: 'codex',
  kimi_worker: 'kimi',
  opencode_reviewer: 'opencode',
  codex_final_review: 'codex',
};

export const AGENT_CONFIGS: Record<AgentStage, AgentConfig> = {
  codex_manager: {
    name: 'Codex', role: 'codex_manager', provider: 'codex',
    cliCommand: CODEX_CLI,
    cliArgs: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--ephemeral'],
    thinkingEffort: 'auto',
  },
  kimi_worker: {
    name: 'KimiCode', role: 'kimi_worker', provider: 'kimi',
    cliCommand: KIMI_CLI,
    cliArgs: ['-m', KIMI_MODEL, '-p'],
    model: KIMI_MODEL,
    thinkingEffort: 'auto',
  },
  opencode_reviewer: {
    name: 'OpenCode', role: 'opencode_reviewer', provider: 'opencode',
    cliCommand: OPENCODE_CLI,
    cliArgs: OPENCODE_ARGS,
    model: OPENCODE_MODEL,
    thinkingEffort: 'auto',
  },
  codex_final_review: {
    name: 'Codex', role: 'codex_final_review', provider: 'codex',
    cliCommand: CODEX_CLI,
    cliArgs: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--ephemeral'],
    thinkingEffort: 'auto',
  },
};

export const DEFAULT_WORKSPACE_AGENTS: WorkspaceAgent[] = [
  {
    id: 'codex', name: 'Codex', provider: 'codex', role: 'codex', enabled: true,
    cliCommand: AGENT_CONFIGS.codex_manager.cliCommand,
    cliArgs: AGENT_CONFIGS.codex_manager.cliArgs,
    thinkingEffort: AGENT_CONFIGS.codex_manager.thinkingEffort,
  },
  {
    id: 'kimi', name: 'KimiCode', provider: 'kimi', role: 'kimi', enabled: true,
    cliCommand: AGENT_CONFIGS.kimi_worker.cliCommand,
    cliArgs: AGENT_CONFIGS.kimi_worker.cliArgs,
    model: AGENT_CONFIGS.kimi_worker.model,
    thinkingEffort: AGENT_CONFIGS.kimi_worker.thinkingEffort,
  },
  {
    id: 'opencode',
    name: AGENT_CONFIGS.opencode_reviewer.cliCommand === AGENT_CONFIGS.codex_manager.cliCommand
      ? 'OpenCode (Codex fallback)'
      : 'OpenCode',
    provider: 'opencode', role: 'opencode',
    enabled: true,
    cliCommand: AGENT_CONFIGS.opencode_reviewer.cliCommand,
    cliArgs: AGENT_CONFIGS.opencode_reviewer.cliArgs,
    model: AGENT_CONFIGS.opencode_reviewer.model,
    thinkingEffort: AGENT_CONFIGS.opencode_reviewer.thinkingEffort,
  },
];
