import { describe, expect, it } from 'vitest';
import { assertRuntimePolicySupported, resolveRuntimePolicy } from './runtimePolicy.js';

const codex = { permissions: ['read', 'write'] as Array<'read' | 'write' | 'review'>, cliCommand: 'codex' };
const opencode = { permissions: ['read'] as Array<'read' | 'write' | 'review'>, cliCommand: 'opencode' };

describe('runtime policy', () => {
it('ask and review are read-only and codex exposes cli enforcement', () => {
  const ask = resolveRuntimePolicy('ask', codex);
  const review = resolveRuntimePolicy('review', codex);
  expect(ask.workspaceWrite).toBe(false);
  expect(ask.toolPolicy).toBe('read-only');
  expect(ask.enforcement).toBe('cli-flag');
  expect(review.promptPrefix).toMatch(/Review mode/);
});

it('execute follows agent write permission', () => {
  expect(resolveRuntimePolicy('execute', codex).workspaceWrite).toBe(true);
  expect(resolveRuntimePolicy('execute', opencode).workspaceWrite).toBe(false);
});

it('unsupported read-only provider is rejected unless mock is forced', () => {
  const policy = resolveRuntimePolicy('ask', opencode);
  expect(policy.enforcement).toBe('unsupported');
  expect(() => assertRuntimePolicySupported(policy)).toThrow(/read-only/);
  expect(() => assertRuntimePolicySupported(policy, true)).not.toThrow();
});
});
