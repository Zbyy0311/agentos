export type CliProvider = 'codex' | 'plain';

export const NORMALIZED_CLI_EVENT_TYPES = [
  'status',
  'assistant.message',
  'tool.started',
  'tool.completed',
  'usage',
  'diagnostic',
] as const;

export type NormalizedCliEvent =
  | { type: 'status'; phase: 'starting' | 'thinking' | 'working' | 'finalizing'; label: string }
  | { type: 'assistant.message'; text: string; messageId?: string }
  | { type: 'tool.started'; callId: string; toolName: string; summary: string; inputPreview?: string }
  | { type: 'tool.completed'; callId: string; toolName: string; success: boolean; summary: string; outputPreview?: string; durationMs?: number }
  | { type: 'usage'; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }
  | { type: 'diagnostic'; level: 'warning' | 'error'; code: string; message: string };

export interface CliEventParser {
  push(chunk: string): NormalizedCliEvent[];
  finish(): NormalizedCliEvent[];
}

export interface AgentCliAdapter {
  readonly provider: CliProvider;
  matches(command: string): boolean;
  supportsStructuredOutput(helpText: string): boolean;
  decorateArgs(args: readonly string[]): string[];
  createParser(): CliEventParser;
}
