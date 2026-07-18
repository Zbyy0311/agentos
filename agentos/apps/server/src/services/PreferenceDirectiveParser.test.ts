import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePreferenceDirective } from './PreferenceDirectiveParser.js';

const cases = [
  ['回答简洁一点', 'concise'],
  ['不要太简洁', 'balanced'],
  ['请详细展开', 'detailed'],
  ['不要详细展开', 'concise'],
  ['先别直接执行，先给计划', 'plan_first'],
  ['不要先问我，直接执行', 'direct_execution'],
  ['既要简洁又要详细', undefined],
] as const;

for (const [text, expected] of cases) {
  test(`parses ${text}`, () => {
    assert.equal(parsePreferenceDirective(text, 'coding')?.candidateValue, expected);
  });
}
