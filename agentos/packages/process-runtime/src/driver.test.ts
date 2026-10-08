import { describe, expect, it } from 'vitest';
import {
  cleanupVerdictFromVerification,
  type SurvivorVerification,
} from './driver.js';

describe('cleanupVerdictFromVerification', () => {
  it('accepts only an owned-tree proof for complete cleanup', () => {
    const verification: SurvivorVerification = {
      classification: 'complete',
      knownPids: [4100, 4101],
      proof: { kind: 'owned-tree-enumeration' },
    };

    expect(cleanupVerdictFromVerification(verification, false)).toEqual({
      classification: 'complete',
      cleanupResult: 'TERMINATED',
      proven: true,
    });
    expect(cleanupVerdictFromVerification(verification, true)).toEqual({
      classification: 'complete',
      cleanupResult: 'ALREADY_EXITED',
      proven: true,
    });
  });

  it('fails closed when a driver reports bare complete without proof', () => {
    expect(cleanupVerdictFromVerification({
      classification: 'complete',
      knownPids: [],
    }, false)).toEqual({
      classification: 'unknown',
      cleanupResult: 'UNKNOWN_PLATFORM_UNAVAILABLE',
      proven: false,
    });
  });

  it('preserves survivor and unknown evidence as unproven', () => {
    expect(cleanupVerdictFromVerification({
      classification: 'survivors',
      knownPids: [4200],
    }, false)).toEqual({
      classification: 'survivors',
      cleanupResult: 'SURVIVORS',
      proven: false,
    });
    expect(cleanupVerdictFromVerification({
      classification: 'unknown',
      knownPids: [],
    }, false)).toEqual({
      classification: 'unknown',
      cleanupResult: 'UNKNOWN_PLATFORM_UNAVAILABLE',
      proven: false,
    });
  });
});
