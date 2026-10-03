import assert from 'node:assert/strict';
import test from 'node:test';
import {
  memoryLexicalTerms, memoryQueryTerms, memoryEntryTerms, MEMORY_LEXICAL_VERSION,
  MAX_MEMORY_LEXICAL_INPUT_CODE_POINTS,
} from './MemoryLexicalIndex.js';

test('prototype names remain safe string terms alongside aliases', () => {
  assert.deepEqual(memoryLexicalTerms('constructor constructor API __proto__ toString valueOf full-text'),
    ['constructor', 'api', 'proto', 'tostring', 'valueof', 'fts']);
  assert.ok(memoryLexicalTerms('constructor fulltext job-object').every(term => typeof term === 'string'));
});

test('programming terms preserve case, full-width and mixed-language distinctions', () => {
  assert.deepEqual(memoryLexicalTerms('C++ c++ Ｃ＋＋ C# Ｃ＃ .nEt ．ＮＥＴ net'), ['cpp', 'csharp', 'dotnet', 'net']);
  assert.deepEqual(memoryQueryTerms('使用C++和C#构建.NET服务'), ['使用', 'cpp', 'csharp', '构建', 'dotnet', '服务']);
  assert.deepEqual(memoryEntryTerms({ title: 'C++', summary: 'C#', content: '.NET', tags: [] } as never),
    ['cpp', 'csharp', 'dotnet']);
  assert.deepEqual(memoryLexicalTerms('C#-service .NET-runtime C++-native'),
    ['csharp', 'service', 'dotnet', 'runtime', 'cpp', 'native']);
  assert.equal(MEMORY_LEXICAL_VERSION, 'nfkc-han-bigrams.v3-bounded-16384');
});

test('programming terms do not convert embedded identifier segments', () => {
  const terms = memoryLexicalTerms('XC++ C++17 C++_version XC# C#2 foo.NETbar foo.NET foo_.NET _C# .NETish (C++)');
  assert.deepEqual(terms, ['xc', '17', 'version', 'foo.netbar', 'foo.net', 'foo', 'net', 'netish', 'cpp']);
  assert.ok(!terms.includes('csharp') && !terms.includes('dotnet'));
});

test('tokenization remains deduplicated, bounded and free of FTS operators', () => {
  assert.deepEqual(memoryLexicalTerms('C++ C++ fulltext full-text job-object job_object'), ['cpp', 'fts', 'jobobject']);
  const terms = memoryLexicalTerms(Array.from({ length: 1200 }, (_, index) => `term${index}`).join(' '));
  assert.equal(terms.length, 1024);
  assert.equal(terms.at(-1), 'term1023');
  const han = Array.from({ length: 1100 }, (_, index) => String.fromCodePoint(0x4e00 + index));
  const hanTerms = memoryLexicalTerms(han.join(''));
  assert.equal(hanTerms.length, 1024);
  assert.equal(hanTerms.at(-1), han[1023]! + han[1024]!);
  assert.deepEqual(memoryLexicalTerms('" OR *** ^ - ( )'), []);
});

test('long repeated ASCII and Han inputs stop at the code-point bound', () => {
  const longAscii = `tag ${'alpha '.repeat((MAX_MEMORY_LEXICAL_INPUT_CODE_POINTS - 4) / 6)}tailmarker`;
  assert.deepEqual(memoryLexicalTerms(longAscii), ['tag', 'alpha']);
  assert.deepEqual(memoryQueryTerms(longAscii), ['tag', 'alpha']);

  const longHan = `${'汉'.repeat(MAX_MEMORY_LEXICAL_INPUT_CODE_POINTS + 100)}尾标记`;
  assert.deepEqual(memoryLexicalTerms(longHan), ['汉汉']);
  assert.deepEqual(memoryEntryTerms({ title: 'known', summary: '', content: longHan, tags: [] } as never),
    ['known', '汉汉']);
});

test('supplementary-plane Han bigrams stream by code point without splitting surrogates', () => {
  assert.deepEqual(memoryLexicalTerms('\u{20000}\u{20001}\u{20002}'), [
    '\u{20000}\u{20001}', '\u{20001}\u{20002}',
  ]);
  assert.deepEqual(memoryLexicalTerms(`${'\u{20000}'.repeat(MAX_MEMORY_LEXICAL_INPUT_CODE_POINTS + 10)}tailmarker`), [
    '\u{20000}\u{20000}',
  ]);
});
