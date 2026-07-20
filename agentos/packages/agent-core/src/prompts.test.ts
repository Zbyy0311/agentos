import { describe, expect, it } from 'vitest';
import { buildStageInstructions, buildStageOutputRequirements } from './prompts.js';

describe('stage prompt contracts', () => {
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
