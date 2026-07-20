import type { AgentProfile, RunIntent, RuntimePolicy } from '@agentos/shared';
import { isCodexCli } from './config.js';

export function isRunIntent(value: unknown): value is RunIntent {
  return value === 'ask' || value === 'execute' || value === 'review';
}

export function resolveRuntimePolicy(intent: RunIntent, agent: Pick<AgentProfile, 'permissions' | 'cliCommand'>): RuntimePolicy {
  const readOnly = intent !== 'execute' || !agent.permissions.includes('write');
  const enforcement = readOnly
    ? (isCodexCli(agent.cliCommand) ? 'cli-flag' : 'unsupported')
    : 'unsupported';
  const promptPrefix = intent === 'review'
    ? '[Review mode] Inspect the workspace, cite evidence, describe severity and recommendations. Do not modify files.'
    : intent === 'ask'
      ? '[Ask mode] Answer the user using the available context. Do not modify files.'
      : '';
  return {
    workspaceWrite: !readOnly,
    networkPolicy: 'provider-default',
    toolPolicy: readOnly ? 'read-only' : 'configured',
    extraArgs: [],
    promptPrefix,
    enforcement,
  };
}

export function assertRuntimePolicySupported(policy: RuntimePolicy, forceMock = false): void {
  if (!policy.workspaceWrite && policy.enforcement === 'unsupported' && !forceMock) {
    throw new Error('This provider cannot enforce workspace read-only mode');
  }
}
