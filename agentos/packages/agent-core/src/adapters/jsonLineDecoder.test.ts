import { describe, expect, it } from 'vitest';
import { JsonLineDecoder } from './jsonLineDecoder.js';

describe('JsonLineDecoder', () => {
  it('frames BOM, CRLF, split chunks, blank lines, and a final unterminated line', () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push('\uFEFF{"id":1}\r\n\r')).toEqual([{ ok: true, value: { id: 1 } }]);
    expect(decoder.push('\n{"id":')).toEqual([]);
    expect(decoder.push('2}\n{"id":3}')).toEqual([{ ok: true, value: { id: 2 } }]);
    expect(decoder.finish()).toEqual([{ ok: true, value: { id: 3 } }]);
    expect(decoder.finish()).toEqual([]);
  });

  it('returns a stable diagnostic for invalid JSON without stopping later lines', () => {
    const decoder = new JsonLineDecoder();
    const result = decoder.push('{bad}\n{"ok":true}\n');
    expect(result[0]).toMatchObject({ ok: false, raw: '{bad}', error: 'invalid_json' });
    expect(result[1]).toEqual({ ok: true, value: { ok: true } });
  });

  it('rejects a single line over the configured byte limit and continues framing', () => {
    const decoder = new JsonLineDecoder(8);
    const result = decoder.push('{"long":"123456789"}\n{"ok":1}\n');
    expect(result[0]).toMatchObject({ ok: false, error: 'line_too_large' });
    expect(result[1]).toEqual({ ok: true, value: { ok: 1 } });
  });
});
