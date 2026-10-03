import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { memoryLexicalTerms } = await import(pathToFileURL(resolve(process.cwd(), 'agentos/apps/server/src/services/MemoryLexicalIndex.ts')).href);
assert.deepEqual(memoryLexicalTerms('C++ C# .NET'), ['cpp', 'csharp', 'dotnet'], 'LEXICAL_LANGUAGE_TERMS_MUST_REMAIN_DISTINCT');
process.stdout.write('P4_MEMORY_PROBE_PASS:language-terms\n');
