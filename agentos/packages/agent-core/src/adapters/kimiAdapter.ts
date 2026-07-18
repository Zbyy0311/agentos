import { JsonLineDecoder, type DecodedJsonLine } from './jsonLineDecoder.js';
import { EMPTY_ADAPTER_CAPABILITIES, runProbeCommand, type ProbeCommand } from './capabilityProbe.js';
import { redactRuntimeText, summarizeToolInput } from './redaction.js';
import type { AgentCliAdapter, AdapterCapabilities, CliEventParser, NormalizedCliEvent, ProviderInvocation, ProviderInvocationInput, ProviderProbeResult } from './types.js';

type JsonRecord = Record<string, unknown>;

export interface KimiProbeOptions {
  timeoutMs?: number;
  run?: ProbeCommand;
}

const KIMI_CAPABILITIES: AdapterCapabilities = {
  structuredOutput: true,
  jsonSchemaOutput: false,
  assistantDelta: true,
  toolEvents: true,
  usage: true,
  workspaceReadOnly: true,
  approvalEvents: false,
};

export class KimiAdapter implements AgentCliAdapter {
  readonly provider = 'kimi' as const;

  constructor(private readonly probeOptions: KimiProbeOptions = {}) {}

  probe(commandPath: string): Promise<ProviderProbeResult> {
    return probeKimiCli(commandPath, this.probeOptions);
  }

  buildInvocation(input: ProviderInvocationInput): ProviderInvocation {
    const args = [...input.baseArgs, ...input.imageArgs];
    const outputIndex = args.indexOf('--output-format');
    if (outputIndex >= 0) {
      args.splice(outputIndex, 2);
    }
    const promptIndex = args.findIndex(arg => arg === '-p' || arg === '--prompt');
    args.splice(promptIndex >= 0 ? promptIndex : args.length, 0, '--output-format', 'stream-json');
    return { args, promptTransport: 'argument', env: {} };
  }

  createParser(): CliEventParser {
    return new KimiJsonParser();
  }
}

export async function probeKimiCli(commandPath: string, options: KimiProbeOptions = {}): Promise<ProviderProbeResult> {
  const run = options.run ?? runProbeCommand;
  const timeoutMs = options.timeoutMs ?? 5000;
  try {
    const version = await run(commandPath, ['--version'], timeoutMs);
    const helpText = await run(commandPath, ['--help'], timeoutMs);
    const structured = /--output-format[\s\S]*stream-json|stream-json[\s\S]*--output-format/i.test(helpText);
    if (!structured) {
      return {
        status: 'UNAVAILABLE', configuredProvider: 'kimi', detectedProvider: 'kimi', version: version.trim(), helpText: helpText.trim(),
        capabilities: EMPTY_ADAPTER_CAPABILITIES, reason: 'Kimi help does not advertise --output-format stream-json',
      };
    }
    return {
      status: 'AVAILABLE', configuredProvider: 'kimi', detectedProvider: 'kimi', version: version.trim(), helpText: helpText.trim(), capabilities: KIMI_CAPABILITIES,
    };
  } catch (error) {
    return {
      status: 'UNAVAILABLE', configuredProvider: 'kimi', capabilities: EMPTY_ADAPTER_CAPABILITIES,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

class KimiJsonParser implements CliEventParser {
  private readonly decoder = new JsonLineDecoder();
  private readonly openTools = new Map<string, string>();
  private readonly usageIds = new Set<string>();
  private usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  private usageSeen = false;

  push(chunk: string): NormalizedCliEvent[] {
    return this.decoder.push(chunk).flatMap(line => this.mapDecoded(line));
  }

  finish(): NormalizedCliEvent[] {
    const events = this.decoder.finish().flatMap(line => this.mapDecoded(line));
    for (const [callId, toolName] of this.openTools) {
      events.push({ type: 'tool.completed', callId, toolName, success: false, summary: 'Tool interrupted before completion' });
    }
    this.openTools.clear();
    if (this.usageSeen) {
      events.push({
        type: 'usage', source: 'structured', provider: 'kimi', estimated: false,
        inputTokens: this.usage.inputTokens,
        cachedInputTokens: this.usage.cachedInputTokens,
        outputTokens: this.usage.outputTokens,
      });
    } else {
      events.push({ type: 'usage', source: 'unavailable', provider: 'kimi', estimated: false });
    }
    return events;
  }

  private mapDecoded(line: DecodedJsonLine): NormalizedCliEvent[] {
    if (!line.ok) return [{ type: 'diagnostic', level: 'warning', code: `adapter.${line.error}`, message: line.error === 'invalid_json' ? 'Kimi returned an invalid JSONL line' : 'Kimi returned an oversized JSONL line' }];
    if (!isRecord(line.value)) return [unknownEventDiagnostic()];
    return this.mapRecord(line.value);
  }

  private mapRecord(record: JsonRecord): NormalizedCliEvent[] {
    const type = stringValue(record.type ?? record.event);
    const role = stringValue(record.role);
    if (type === 'step.end' || type === 'step.completed' || type === 'usage' || isRecord(record.usage)) {
      this.collectUsage(record);
      if (type === 'step.end' || type === 'step.completed' || type === 'usage') return [];
    }
    if (role === 'assistant' || type === 'assistant') {
      const events: NormalizedCliEvent[] = [];
      const text = assistantText(record.content ?? record.text);
      if (text) events.push({ type: 'assistant.message', text: redactRuntimeText(text) });
      const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
      for (const toolCall of toolCalls) {
        const mapped = this.mapToolStart(toolCall);
        if (mapped) events.push(mapped);
      }
      return events.length > 0 ? events : type ? [] : [unknownEventDiagnostic()];
    }
    if (role === 'tool' || type === 'tool.result' || type === 'tool.completed') return this.mapToolResult(record);
    if (role === 'meta' || type === 'meta') return [];
    if (type === 'error') return [{ type: 'diagnostic', level: 'error', code: 'adapter.cli_error', message: 'Kimi CLI returned an error' }];
    return type ? [unknownEventDiagnostic()] : [];
  }

  private mapToolStart(value: unknown): NormalizedCliEvent | undefined {
    if (!isRecord(value)) return undefined;
    const fn = isRecord(value.function) ? value.function : value;
    const callId = stringValue(value.id ?? value.call_id ?? value.callId);
    const toolName = stringValue(fn.name ?? value.name) || 'tool';
    if (!callId) return { type: 'diagnostic', level: 'warning', code: 'adapter.tool_missing_id', message: 'Kimi tool call did not include a call id' };
    this.openTools.set(callId, toolName);
    const input = parseArguments(fn.arguments ?? value.arguments);
    const summary = summarizeToolInput(toolName, input);
    return { type: 'tool.started', callId, toolName, summary, ...(summary ? { inputPreview: summary } : {}) };
  }

  private mapToolResult(record: JsonRecord): NormalizedCliEvent[] {
    const callId = stringValue(record.tool_call_id ?? record.call_id ?? record.callId ?? record.id);
    if (!callId || !this.openTools.has(callId)) return [{ type: 'diagnostic', level: 'warning', code: 'adapter.unmatched_tool_result', message: 'Kimi returned an unmatched tool result' }];
    const toolName = this.openTools.get(callId)!;
    this.openTools.delete(callId);
    const content = assistantText(record.content ?? record.output ?? record.result);
    const failed = record.is_error === true || record.error !== undefined || stringValue(record.status).toLowerCase() === 'error' || stringValue(record.status).toLowerCase() === 'failed';
    return [{ type: 'tool.completed', callId, toolName, success: !failed, summary: content ? redactRuntimeText(`${toolName} completed`) : `${toolName} completed`, ...(content ? { outputPreview: redactRuntimeText(content) } : {}) }];
  }

  private collectUsage(record: JsonRecord): void {
    const usage = isRecord(record.usage) ? record.usage : record;
    const id = stringValue(record.uuid ?? record.id ?? record.step_id ?? record.stepId);
    if (id && this.usageIds.has(id)) return;
    if (id) this.usageIds.add(id);
    const input = numberValue(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens);
    const cached = numberValue(usage.cached_input_tokens ?? usage.cachedInputTokens ?? usage.cache_read_input_tokens);
    const output = numberValue(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens);
    if (input === undefined && cached === undefined && output === undefined) return;
    this.usageSeen = true;
    this.usage.inputTokens += input ?? 0;
    this.usage.cachedInputTokens += cached ?? 0;
    this.usage.outputTokens += output ?? 0;
  }
}

function assistantText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => isRecord(item) ? stringValue(item.text ?? item.content) : '').filter(Boolean).join('');
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function unknownEventDiagnostic(): NormalizedCliEvent {
  return { type: 'diagnostic', level: 'warning', code: 'adapter.unknown_event', message: 'Kimi returned an unsupported event' };
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
