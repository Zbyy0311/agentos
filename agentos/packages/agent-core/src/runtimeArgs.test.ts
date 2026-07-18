import { describe, expect, it } from 'vitest';
import { removeArgPair, replaceConfigArg, replaceOrAppendArg } from './runtimeArgs.js';

describe('runtime argument helpers', () => {
  it('replaces the first flag value, removes duplicate pairs, and appends when absent', () => {
    expect(replaceOrAppendArg(['run', '--model', 'old', '--model', 'duplicate'], '--model', 'new'))
      .toEqual(['run', '--model', 'new']);
    expect(replaceOrAppendArg(['run'], '--model', 'new')).toEqual(['run', '--model', 'new']);
  });

  it('removes flag pairs and replaces matching config assignments', () => {
    expect(removeArgPair(['run', '-m', 'model', '--pure'], '-m')).toEqual(['run', '--pure']);
    expect(replaceConfigArg(['exec', '-c', 'model_reasoning_effort=low', '-c', 'other=value'], 'model_reasoning_effort', 'high'))
      .toEqual(['exec', '-c', 'model_reasoning_effort=high', '-c', 'other=value']);
    expect(replaceConfigArg(['exec'], 'model_reasoning_effort', 'high'))
      .toEqual(['exec', '-c', 'model_reasoning_effort=high']);
  });
});
