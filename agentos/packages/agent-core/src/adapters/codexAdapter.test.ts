import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CodexAdapter } from './codexAdapter.js';

const fixture = readFileSync(new URL('./fixtures/codex-basic.jsonl', import.meta.url), 'utf8');

describe('CodexAdapter', () => {
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
    expect(adapter.decorateArgs(['exec', '--sandbox', 'workspace-write'])).toEqual(['exec', '--json', '--sandbox', 'workspace-write']);
    expect(adapter.decorateArgs(['exec', '--json', '--sandbox', 'workspace-write'])).toEqual(['exec', '--json', '--sandbox', 'workspace-write']);
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
});
