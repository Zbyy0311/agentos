export type DecodedJsonLine =
  | { ok: true; value: unknown }
  | { ok: false; raw: string; error: 'invalid_json' | 'line_too_large' };

export class JsonLineDecoder {
  private buffer = '';
  private started = false;
  private oversized = false;

  constructor(private readonly maxLineBytes = 1024 * 1024) {}

  push(chunk: string): DecodedJsonLine[] {
    if (!chunk) return [];
    if (!this.started) {
      this.started = true;
      chunk = chunk.replace(/^\uFEFF/, '');
    }
    this.buffer += chunk;
    return this.drain(false);
  }

  finish(): DecodedJsonLine[] {
    const result = this.drain(true);
    this.buffer = '';
    this.oversized = false;
    return result;
  }

  private drain(final: boolean): DecodedJsonLine[] {
    const result: DecodedJsonLine[] = [];
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const raw = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      const decoded = this.oversized ? { ok: false as const, raw: '', error: 'line_too_large' as const } : this.decodeLine(raw);
      if (decoded) result.push(decoded);
      this.oversized = false;
    }
    if (this.byteLength(this.buffer) > this.maxLineBytes) {
      this.oversized = true;
      this.buffer = this.buffer.slice(-this.maxLineBytes - 1);
    }
    if (final && (this.buffer.length > 0 || this.oversized)) {
      const raw = this.buffer.replace(/\r$/, '');
      const decoded = this.oversized ? { ok: false as const, raw: '', error: 'line_too_large' as const } : this.decodeLine(raw);
      if (decoded) result.push(decoded);
    }
    return result;
  }

  private decodeLine(raw: string): DecodedJsonLine | undefined {
    if (this.byteLength(raw) > this.maxLineBytes) return { ok: false, raw: '', error: 'line_too_large' };
    if (!raw.trim()) return undefined;
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch {
      return { ok: false, raw, error: 'invalid_json' };
    }
  }

  private byteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength;
  }
}
