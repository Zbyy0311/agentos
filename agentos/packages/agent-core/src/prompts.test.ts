import { describe, expect, it } from 'vitest';
import { buildStageInstructions, buildStageOutputRequirements, buildStagePrompt } from './prompts.js';

describe('stage prompt contracts', () => {
  it('keeps stage prompts domain-neutral while retaining the collaboration role', () => {
    const prompt = buildStagePrompt('kimi_worker', '## User request\nCompare two rollout options.');
    expect(prompt).toContain('general-purpose AgentOS collaborator');
    expect(prompt).toContain('Do not treat every request as a coding, repository, or file-modification task.');
    expect(prompt).toContain('The current stage defines your collaboration responsibility, not the task domain.');
    expect(prompt).toContain('Compare two rollout options.');
  });

  it('worker instructions no longer forbid tool use', () => {
    const instructions = buildStageInstructions('kimi_worker').join('\n');
    expect(instructions).not.toContain('Do not use tools or interactive workflows.');
    expect(instructions).toContain('Execute the required checks and report actual results.');
  });

  it('worker output requirements ask for execution evidence', () => {
    expect(buildStageOutputRequirements('kimi_worker')).toEqual([
      '1. Checks Run',
      '2. Findings by Severity',
      '3. Evidence',
      '4. Files Modified',
      '5. Notes for Reviewer',
    ]);
  });

  it('final review output requirements include explicit final decision', () => {
    expect(buildStageOutputRequirements('codex_final_review')).toEqual([
      '1. Summary',
      '2. Final Decision',
      '3. Blocking Issues',
      '4. Next Steps',
    ]);
  });
});
