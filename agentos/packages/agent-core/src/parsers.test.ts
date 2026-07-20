import { describe, expect, it } from 'vitest';
import {
  parseFinalDecision,
  parseReviewerDecision,
  parseWorkerEvidence,
} from './parsers.js';
import { buildStageOutputRequirements } from './prompts.js';

describe('parseWorkerEvidence', () => {
  it('detects required evidence sections in worker output', () => {
    const parsed = parseWorkerEvidence(`
## Checks Run
- pnpm test

## Findings by Severity
- High: none

## Evidence
- server started successfully
`);

    expect(parsed.hasChecksRun).toBe(true);
    expect(parsed.hasFindings).toBe(true);
    expect(parsed.hasEvidence).toBe(true);
    expect(parsed.legacyPlanOnly).toBe(false);
  });

  it('marks legacy plan-only output as invalid evidence', () => {
    const parsed = parseWorkerEvidence(`
## Implementation Plan
- inspect files

## Proposed Code Changes
- none
`);

    expect(parsed.hasChecksRun).toBe(false);
    expect(parsed.hasFindings).toBe(false);
    expect(parsed.hasEvidence).toBe(false);
    expect(parsed.legacyPlanOnly).toBe(true);
  });

  it('accepts the numbered headings required by the worker prompt', () => {
    const output = buildStageOutputRequirements('kimi_worker')
      .slice(0, 3)
      .map((heading) => `## ${heading}\n- evidence`)
      .join('\n\n');

    const parsed = parseWorkerEvidence(output);

    expect(parsed.hasChecksRun).toBe(true);
    expect(parsed.hasFindings).toBe(true);
    expect(parsed.hasEvidence).toBe(true);
  });
});

describe('decision parsers', () => {
  it('parses reviewer block decision', () => {
    expect(parseReviewerDecision('## Decision\nDecision: block')).toBe('block');
  });

  it('parses final reject decision', () => {
    expect(parseFinalDecision('## Final Decision\nFinal Decision: Reject')).toBe('reject');
  });

  it('returns unknown when no decision exists', () => {
    expect(parseReviewerDecision('no structured output')).toBe('unknown');
    expect(parseFinalDecision('no structured output')).toBe('unknown');
  });
});
