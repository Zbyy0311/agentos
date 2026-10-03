import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { memoryLexicalTerms } = await import(pathToFileURL(resolve(process.cwd(), 'agentos/apps/server/src/services/MemoryLexicalIndex.ts')).href);
assert.deepEqual(memoryLexicalTerms('constructor constructor API'), ['constructor', 'api'], 'LEXICAL_CONSTRUCTOR_TERM_MUST_REMAIN_TEXT');
process.stdout.write('P4_MEMORY_PROBE_PASS:constructor-term\n');
