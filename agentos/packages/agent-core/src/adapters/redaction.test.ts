import { describe, expect, it } from 'vitest';
import { redactRuntimeText, summarizeToolInput } from './redaction.js';

describe('runtime redaction', () => {
  it('redacts common credentials and env values', () => {
    const input = 'api_key=sk-test-123 Bearer secret-token https://example.test/?token=url-secret\nSECRET_VALUE=hidden';
    const result = redactRuntimeText(input);
    expect(result).not.toContain('sk-test-123');
    expect(result).not.toContain('secret-token');
    expect(result).not.toContain('url-secret');
    expect(result).not.toContain('hidden');
    expect(result).toContain('[REDACTED]');
  });

  it('truncates long content with an explicit marker', () => {
    expect(redactRuntimeText('x'.repeat(12), 8)).toBe('xxxxxxxx…[truncated]');
  });

  it('summarizes tool input without leaking a full object', () => {
    expect(summarizeToolInput('read_file', { path: 'src/secret.ts', token: 'hidden' })).toContain('src/secret.ts');
    expect(summarizeToolInput('read_file', { path: 'src/secret.ts', token: 'hidden' })).not.toContain('hidden');
  });
});
