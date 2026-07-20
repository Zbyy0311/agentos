import { describe, expect, it } from 'vitest';
import { PlainTextAdapter } from './plainTextAdapter.js';

describe('PlainTextAdapter', () => {
  it('maps non-empty chunks to assistant messages and never invents tools', () => {
    const parser = new PlainTextAdapter().createParser();
    expect(parser.push('第一段')).toEqual([{ type: 'assistant.message', text: '第一段' }]);
    expect(parser.push('')).toEqual([]);
    expect(parser.finish()).toEqual([]);
  });
});
