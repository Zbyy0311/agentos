import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CodexAdapter } from './codexAdapter.js';

const fixture = readFileSync(new URL('./fixtures/codex-basic.jsonl', import.meta.url), 'utf8');

describe('CodexAdapter', () => {
  it('LITE-07-104 preserves only explicit bounded command/exit evidence, not status or display text', () => {
    const result = (overrides: Record<string, unknown>) => new CodexAdapter().createParser().push(JSON.stringify({
      type: 'item.completed', item: { id: 'test-1', type: 'command_execution', command: 'node --test proof.test.cjs', exit_code: 0, ...overrides },
    }) + '\n')[0];
    expect(result({})).toMatchObject({ commandResult: { command: 'node --test proof.test.cjs', exitCode: 0 }, success: true });
    expect(result({ exit_code: 1 })).toMatchObject({ commandResult: { exitCode: 1 }, success: false });
    for (const invalid of [{ exit_code: null, status: 'completed' }, { exit_code: 0.5 }, { id: null },
      { type: 'mcp_tool_call' }, { command: 'x'.repeat(513) }, { command: 'node --test token=secret-value' }]) {
      expect(result(invalid)).not.toHaveProperty('commandResult');
    }
  });
  it('maps structured fixture items to public events in order', () => {
    const parser = new CodexAdapter().createParser();
    const events = parser.push(fixture);
    expect(events.map(event => event.type)).toEqual([
      'status',
      'status',
      'tool.started',
      'tool.completed',
      'tool.completed',
      'assistant.message',
      'status',
      'status',
      'usage',
    ]);
    expect(events.find(event => event.type === 'assistant.message')).toEqual({ type: 'assistant.message', text: '已检查 executor.ts', messageId: 'msg-1' });
    expect(events.find(event => event.type === 'tool.started')).toMatchObject({ callId: 'cmd-1', toolName: 'command_execution' });
    expect(events.filter(event => event.type === 'diagnostic')).toEqual([]);
    expect(JSON.stringify(events)).not.toContain('private reasoning');
  });

  it('does not duplicate --json or move existing arguments', () => {
    const adapter = new CodexAdapter();
    const invoke = (baseArgs: string[]) => adapter.buildInvocation({ commandPath: 'codex', baseArgs, prompt: '', workspaceRoot: '.', workspaceWrite: true, imageArgs: [] }).args;
    expect(invoke(['exec', '--sandbox', 'workspace-write'])).toEqual(['exec', '--json', '--sandbox', 'workspace-write']);
    expect(invoke(['exec', '--json', '--sandbox', 'workspace-write'])).toEqual(['exec', '--json', '--sandbox', 'workspace-write']);
  });

  it('turns unknown structured events into a safe diagnostic', () => {
    const events = new CodexAdapter().createParser().push('{"type":"future.event","secret":"should not show"}\n');
    expect(events).toEqual([{ type: 'diagnostic', level: 'warning', code: 'adapter.unknown_event', message: 'Codex returned an unsupported event' }]);
    expect(JSON.stringify(events)).not.toContain('should not show');
  });

  it('closes an open tool as failed when the process ends early', () => {
    const parser = new CodexAdapter().createParser();
    parser.push('{"type":"item.started","item":{"id":"open-1","type":"command_execution","command":"long task"}}\n');
    expect(parser.finish()).toEqual([{ type: 'tool.completed', callId: 'open-1', toolName: 'command_execution', success: false, summary: 'Tool interrupted before completion' }]);
  });

  it('marks missing structured usage as unavailable instead of estimating tokens', () => {
    const events = new CodexAdapter().createParser().push('{"type":"turn.completed"}\n');
    expect(events).toContainEqual({ type: 'usage', source: 'unavailable', provider: 'codex', estimated: false });
  });
});
