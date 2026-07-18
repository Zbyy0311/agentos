import type { AgentProvider } from '@agentos/shared';

export type CliProvider = AgentProvider | 'plain';

export const NORMALIZED_CLI_EVENT_TYPES = [
  'status',
  'assistant.message',
  'tool.started',
  'tool.completed',
  'usage',
  'diagnostic',
  'approval.requested',
  'approval.resolved',
] as const;

export type NormalizedCliEvent =
  | { type: 'status'; phase: 'starting' | 'thinking' | 'working' | 'finalizing'; label: string }
  | { type: 'assistant.message'; text: string; messageId?: string }
  | { type: 'tool.started'; callId: string; toolName: string; summary: string; inputPreview?: string }
  | { type: 'tool.completed'; callId: string; toolName: string; success: boolean; summary: string; outputPreview?: string; durationMs?: number }
  | { type: 'usage'; source?: 'structured' | 'database_delta' | 'unavailable'; provider?: AgentProvider; model?: string; estimated?: boolean; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }
  | { type: 'diagnostic'; level: 'warning' | 'error'; code: string; message: string }
  | { type: 'approval.requested'; requestId: string; toolName: string; riskLevel: 'low' | 'medium' | 'high' | 'critical'; summary: string; affectedPaths?: string[] }
  | { type: 'approval.resolved'; requestId: string; decision: import('@agentos/shared').ApprovalDecision };

export interface CliEventParser {
  push(chunk: string): NormalizedCliEvent[];
  finish(): NormalizedCliEvent[];
}

export interface AdapterCapabilities {
  structuredOutput: boolean;
  jsonSchemaOutput: boolean;
  assistantDelta: boolean;
  toolEvents: boolean;
  usage: boolean;
  workspaceReadOnly: boolean;
  approvalEvents: boolean;
}

export interface ProviderProbeResult {
  status: 'AVAILABLE' | 'UNAVAILABLE';
  configuredProvider: AgentProvider;
  detectedProvider?: AgentProvider;
  version?: string;
  capabilities: AdapterCapabilities;
  reason?: string;
  /** Kept for migration compatibility with the original Codex probe. */
  supportsStructuredOutput?: boolean;
  helpText?: string;
}

export interface ProviderInvocationInput {
  commandPath: string;
  baseArgs: readonly string[];
  prompt: string;
  workspaceRoot: string;
  workspaceWrite: boolean;
  imageArgs: readonly string[];
}

export interface ProviderInvocation {
  args: string[];
  promptTransport: 'argument' | 'stdin';
  env: NodeJS.ProcessEnv;
}

export interface ResolvedRuntime {
  configuredProvider: AgentProvider;
  detectedProvider?: AgentProvider;
  commandPath: string;
  version?: string;
  capabilities: AdapterCapabilities;
  mismatch: boolean;
}

export interface AgentCliAdapter {
  readonly provider: CliProvider;
  probe(commandPath: string): Promise<ProviderProbeResult>;
  buildInvocation(input: ProviderInvocationInput): ProviderInvocation;
  createParser(): CliEventParser;
  encodeApprovalDecision?(requestId: string, decision: import('@agentos/shared').ApprovalDecision): string;
}
