import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkResponseBlocks, getResponseLineCount, type ResponseBlock } from './responseRendering.ts';

const textBlock = (lines: string[]): ResponseBlock => ({ type: 'text', lines });

test('counts response lines across text and code blocks', () => {
  assert.equal(getResponseLineCount([textBlock(['one', 'two']), { type: 'code', lines: ['three'] }]), 3);
});

test('splits long responses into ordered chunks without changing block types', () => {
  const blocks: ResponseBlock[] = [
    textBlock(['1', '2', '3']),
    { type: 'code', lines: ['4', '5', '6'] },
    textBlock(['7']),
  ];

  assert.deepEqual(chunkResponseBlocks(blocks, 4), [
    [textBlock(['1', '2', '3']), { type: 'code', lines: ['4'] }],
    [{ type: 'code', lines: ['5', '6'] }, textBlock(['7'])],
  ]);
});

test('keeps an empty code block in the response order', () => {
  const blocks: ResponseBlock[] = [
    { type: 'code', lines: [] },
    textBlock(['after']),
  ];

  assert.deepEqual(chunkResponseBlocks(blocks, 2), [blocks]);
});
