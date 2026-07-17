import { JsonLineDecoder, type DecodedJsonLine } from './jsonLineDecoder.js';
import { redactRuntimeText, summarizeToolInput } from './redaction.js';
import type { AgentCliAdapter, CliEventParser, NormalizedCliEvent } from './types.js';

type JsonRecord = Record<string, unknown>;

class CodexJsonParser implements CliEventParser {
  private readonly decoder = new JsonLineDecoder();
  private generatedCallId = 0;
  private readonly openTools = new Map<string, string>();

  push(chunk: string): NormalizedCliEvent[] {
    return this.decoder.push(chunk).flatMap(line => this.mapDecoded(line));
  }

  finish(): NormalizedCliEvent[] {
    const events = this.decoder.finish().flatMap(line => this.mapDecoded(line));
    for (const [callId, toolName] of this.openTools) {
      events.push({ type: 'tool.completed', callId, toolName, success: false, summary: 'Tool interrupted before completion' });
    }
    this.openTools.clear();
    return events;
  }

  private mapDecoded(line: DecodedJsonLine): NormalizedCliEvent[] {
    if (!line.ok) {
      return [{ type: 'diagnostic', level: 'warning', code: `adapter.${line.error}`, message: line.error === 'invalid_json' ? 'Codex returned an invalid JSONL line' : 'Codex returned an oversized JSONL line' }];
    }
    if (!isRecord(line.value)) return [unknownEventDiagnostic()];
    return this.mapRecord(line.value);
  }

  private mapRecord(record: JsonRecord): NormalizedCliEvent[] {
    const eventType = stringValue(record.type ?? record.event);
    switch (eventType) {
      case 'thread.started':
        return [{ type: 'status', phase: 'starting', label: 'Codex 已启动' }];
      case 'turn.started':
        return [{ type: 'status', phase: 'thinking', label: '正在分析任务' }];
      case 'turn.completed':
        return [
          { type: 'status', phase: 'finalizing', label: '正在整理结果' },
          ...this.mapUsage(record.usage),
        ];
      case 'turn.failed':
        return [{ type: 'diagnostic', level: 'error', code: 'adapter.turn_failed', message: 'Codex turn 执行失败' }];
      case 'error':
        return [{ type: 'diagnostic', level: 'error', code: 'adapter.cli_error', message: 'Codex CLI 返回错误' }];
      case 'item.started':
        return this.mapItem(record.item, 'started');
      case 'item.completed':
        return this.mapItem(record.item, 'completed');
      default:
        return [unknownEventDiagnostic()];
    }
  }

  private mapUsage(value: unknown): NormalizedCliEvent[] {
    if (!isRecord(value)) return [];
    return [{
      type: 'usage',
      ...(numberValue(value.input_tokens ?? value.inputTokens) !== undefined ? { inputTokens: numberValue(value.input_tokens ?? value.inputTokens) } : {}),
      ...(numberValue(value.cached_input_tokens ?? value.cachedInputTokens) !== undefined ? { cachedInputTokens: numberValue(value.cached_input_tokens ?? value.cachedInputTokens) } : {}),
      ...(numberValue(value.output_tokens ?? value.outputTokens) !== undefined ? { outputTokens: numberValue(value.output_tokens ?? value.outputTokens) } : {}),
    }];
  }

  private mapItem(value: unknown, phase: 'started' | 'completed'): NormalizedCliEvent[] {
    if (!isRecord(value)) return [unknownEventDiagnostic()];
    const itemType = stringValue(value.type);
    if (itemType === 'agent_message') {
      if (phase !== 'completed') return [];
      const text = stringValue(value.text ?? value.message ?? value.content);
      return text ? [{ type: 'assistant.message', text: redactRuntimeText(text), ...(stringValue(value.id) ? { messageId: stringValue(value.id) } : {}) }] : [];
    }
    if (itemType === 'reasoning') {
      return [{ type: 'status', phase: 'thinking', label: '正在分析任务' }];
    }
    if (!isToolItem(itemType)) return [unknownEventDiagnostic()];
    const callId = stringValue(value.id ?? value.call_id ?? value.callId) || `codex-tool-${++this.generatedCallId}`;
    const toolName = stringValue(value.name ?? value.tool_name ?? value.toolName) || itemType;
    const summary = summarizeToolInput(toolName, toolInput(value));
    if (phase === 'started') {
      this.openTools.set(callId, toolName);
      return [{ type: 'tool.started', callId, toolName, summary, ...(summary ? { inputPreview: summary } : {}) }];
    }
    this.openTools.delete(callId);
    const exitCode = numberValue(value.exit_code ?? value.exitCode);
    const status = stringValue(value.status);
    const success = exitCode === undefined ? status !== 'failed' && status !== 'error' : exitCode === 0;
    const output = stringValue(value.aggregated_output ?? value.output ?? value.result ?? value.content);
    return [{
      type: 'tool.completed',
      callId,
      toolName,
      success,
      summary: output ? redactRuntimeText(`${toolName} 完成`) : summary,
      ...(output ? { outputPreview: redactRuntimeText(output) } : {}),
      ...(numberValue(value.duration_ms ?? value.durationMs) !== undefined ? { durationMs: numberValue(value.duration_ms ?? value.durationMs) } : {}),
    }];
  }
}

export class CodexAdapter implements AgentCliAdapter {
  readonly provider = 'codex' as const;

  matches(command: string): boolean {
    return /(?:^|[\\/])codex(?:\.(?:exe|cmd|bat))?$/i.test(command.trim());
  }

  supportsStructuredOutput(helpText: string): boolean {
    return /(?:^|\s)--json(?:\s|$)/m.test(helpText);
  }

  decorateArgs(args: readonly string[]): string[] {
    const decorated = [...args];
    if (decorated.includes('--json')) return decorated;
    const execIndex = decorated.indexOf('exec');
    if (execIndex >= 0) decorated.splice(execIndex + 1, 0, '--json');
    else decorated.push('--json');
    return decorated;
  }

  createParser(): CliEventParser {
    return new CodexJsonParser();
  }
}

function isToolItem(type: string): boolean {
  return new Set(['command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'file_edit', 'shell', 'tool_call']).has(type);
}

function toolInput(value: JsonRecord): unknown {
  return value.command ?? value.path ?? value.query ?? value.arguments ?? value.input ?? value.name ?? value.type;
}

function unknownEventDiagnostic(): NormalizedCliEvent {
  return { type: 'diagnostic', level: 'warning', code: 'adapter.unknown_event', message: 'Codex returned an unsupported event' };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
