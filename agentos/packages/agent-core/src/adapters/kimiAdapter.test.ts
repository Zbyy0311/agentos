import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { KimiAdapter, probeKimiCli } from './kimiAdapter.js';

const fixture = readFileSync(new URL('./fixtures/kimi-0.23.5-basic.jsonl', import.meta.url), 'utf8');

describe('KimiAdapter', () => {
  it('probes version and stream-json support', async () => {
    const calls: string[][] = [];
    const result = await probeKimiCli('kimi-custom.cmd', {
      run: async (_command, args) => {
        calls.push([...args]);
        return args[0] === '--version' ? '0.23.5' : 'Usage: kimi --output-format <format> (choices: "text", "stream-json")';
      },
    });
    expect(result).toMatchObject({ status: 'AVAILABLE', configuredProvider: 'kimi', detectedProvider: 'kimi', version: '0.23.5', capabilities: { structuredOutput: true, toolEvents: true, usage: true } });
    expect(calls).toEqual([['--version'], ['--help']]);
  });

  it('marks Kimi unavailable when help lacks stream-json', async () => {
    const result = await probeKimiCli('kimi-custom.cmd', { run: async (_command, args) => args[0] === '--version' ? '0.23.5' : 'Usage: kimi --output-format text' });
    expect(result).toMatchObject({ status: 'UNAVAILABLE', configuredProvider: 'kimi', reason: expect.stringContaining('stream-json') });
  });

  it('adds or replaces stream-json without duplicating the output flag', () => {
    const adapter = new KimiAdapter();
    const invoke = (baseArgs: string[]) => adapter.buildInvocation({ commandPath: 'kimi', baseArgs, prompt: 'prompt', workspaceRoot: '.', workspaceWrite: false, imageArgs: [] }).args;
    expect(invoke(['-m', 'model', '-p'])).toEqual(['-m', 'model', '--output-format', 'stream-json', '-p']);
    expect(invoke(['-p', '--output-format', 'text'])).toEqual(['--output-format', 'stream-json', '-p']);
    expect(invoke(['-p', '--output-format', 'stream-json'])).toEqual(['--output-format', 'stream-json', '-p']);
  });

  it('maps assistant, tool, unknown and deduplicated usage events', () => {
    expect(fixture).not.toMatch(/credentials|api[_-]?key|token\s*:/i);
    const parser = new KimiAdapter().createParser();
    const events = [...parser.push(fixture), ...parser.finish()];
    expect(events.map(event => event.type)).toEqual(['tool.started', 'tool.completed', 'assistant.message', 'usage']);
    expect(events[0]).toMatchObject({ type: 'tool.started', callId: 'tool-1', toolName: 'Glob' });
    expect(events[1]).toMatchObject({ type: 'tool.completed', callId: 'tool-1', success: true });
    expect(events.at(-1)).toMatchObject({ type: 'usage', inputTokens: 13, cachedInputTokens: 3, outputTokens: 6 });
    expect(JSON.stringify(events)).not.toContain('redacted-session');
  });

  it('handles malformed JSON and unmatched tool results without inventing a start', () => {
    const parser = new KimiAdapter().createParser();
    const events = [...parser.push('{"role":"tool","tool_call_id":"missing","content":"no"}\nnot-json\n'), ...parser.finish()];
    expect(events).toEqual([
      { type: 'diagnostic', level: 'warning', code: 'adapter.unmatched_tool_result', message: 'Kimi returned an unmatched tool result' },
      { type: 'diagnostic', level: 'warning', code: 'adapter.invalid_json', message: 'Kimi returned an invalid JSONL line' },
      { type: 'usage', source: 'unavailable', provider: 'kimi', estimated: false },
    ]);
  });
});
