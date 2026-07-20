import { describe, expect, it } from 'vitest';
import { NORMALIZED_CLI_EVENT_TYPES, type AgentCliAdapter, type CliEventParser, type CliProvider, type NormalizedCliEvent } from './types.js';

function eventLabel(event: NormalizedCliEvent): string {
  switch (event.type) {
    case 'status':
      return event.phase;
    case 'assistant.message':
      return event.text;
    case 'tool.started':
      return event.toolName;
    case 'tool.completed':
      return event.success ? 'success' : 'failed';
    case 'usage':
      return String(event.outputTokens ?? 0);
    case 'diagnostic':
      return event.code;
    case 'approval.requested':
      return event.toolName;
    case 'approval.resolved':
      return event.decision;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

describe('normalized CLI event protocol', () => {
  it('keeps the provider boundary limited to Codex and plain fallback', () => {
    const providers: CliProvider[] = ['codex', 'plain'];
    expect(providers).toEqual(['codex', 'plain']);
    expect(NORMALIZED_CLI_EVENT_TYPES).toEqual([
      'status',
      'assistant.message',
      'tool.started',
      'tool.completed',
      'usage',
      'diagnostic',
      'approval.requested',
      'approval.resolved',
    ]);
  });

  it('supports exhaustive public event projection', () => {
    const events: NormalizedCliEvent[] = [
      { type: 'status', phase: 'starting', label: '启动' },
      { type: 'assistant.message', text: '已完成' },
      { type: 'tool.started', callId: 'call-1', toolName: 'read_file', summary: '读取文件' },
      { type: 'tool.completed', callId: 'call-1', toolName: 'read_file', success: true, summary: '读取完成' },
      { type: 'usage', inputTokens: 10, outputTokens: 4 },
      { type: 'diagnostic', level: 'warning', code: 'example', message: '可恢复警告' },
    ];

    expect(events.map(eventLabel)).toEqual(['starting', '已完成', 'read_file', 'success', '4', 'example']);
  });

  it('describes the parser and adapter contract without coupling to a provider schema', () => {
    const parser: CliEventParser = {
      push: () => [],
      finish: () => [],
    };
    const adapter: AgentCliAdapter = {
      provider: 'plain',
      probe: async () => ({
        status: 'UNAVAILABLE',
        configuredProvider: 'custom' as const,
        capabilities: {
          structuredOutput: false,
          jsonSchemaOutput: false,
          assistantDelta: false,
          toolEvents: false,
          usage: false,
          workspaceReadOnly: false,
          approvalEvents: false,
        },
      }),
      buildInvocation: input => ({
        args: [...input.baseArgs],
        promptTransport: 'argument',
        env: {},
      }),
      createParser: () => parser,
    };

    expect(adapter.createParser().finish()).toEqual([]);
  });
});
