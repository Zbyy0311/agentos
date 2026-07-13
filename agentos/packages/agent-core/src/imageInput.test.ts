import { describe, expect, it } from 'vitest';
import { resolveImageInput, type AgentImageAttachment } from './imageInput.js';

const attachments: AgentImageAttachment[] = [{
  name: 'screen.png', mimeType: 'image/png', absolutePath: 'C:\\workspace with spaces\\screen.png',
}];

describe('resolveImageInput', () => {
it('passes Codex images as separate image arguments', () => {
  const plan = resolveImageInput({ role: 'codex_manager', cliCommand: 'codex' }, attachments);
  expect(plan.transport).toBe('cli-flag');
  expect(plan.cliArgs).toEqual(['--image', 'C:\\workspace with spaces\\screen.png']);
  expect(plan.promptSuffix).toBeUndefined();
});

it('gives KimiCode and OpenCode workspace image paths in a prompt section', () => {
  for (const cli of ['kimi', 'opencode']) {
    const plan = resolveImageInput({ role: cli === 'kimi' ? 'kimi_worker' : 'opencode_reviewer', cliCommand: cli }, attachments);
    expect(plan.transport).toBe('workspace-path');
    expect(plan.cliArgs).toEqual([]);
    expect(plan.promptSuffix).toMatch(/screen\.png/);
    expect(plan.promptSuffix).toMatch(/workspace with spaces/);
  }
});

it('returns an explicit unsupported plan for an unknown CLI', () => {
  const plan = resolveImageInput({ role: 'codex_manager', cliCommand: 'custom-agent' }, attachments);
  expect(plan.transport).toBe('unsupported');
  expect(plan.error).toMatch(/不支持图片输入/);
});

it('returns a no-op plan when no attachments are present', () => {
  const plan = resolveImageInput({ role: 'codex_manager', cliCommand: 'codex' }, []);
  expect(plan.transport).toBe('none');
  expect(plan.cliArgs).toEqual([]);
});

it('normalizes workspace Agent roles before selecting a transport', () => {
  expect(resolveImageInput({ role: 'codex', cliCommand: 'codex' }, attachments).transport).toBe('cli-flag');
  expect(resolveImageInput({ role: 'mimo', cliCommand: 'custom-mimo' }, attachments).transport).toBe('workspace-path');
});
});
