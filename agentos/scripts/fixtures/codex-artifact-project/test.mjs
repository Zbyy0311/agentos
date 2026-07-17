import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('./executor.ts', import.meta.url), 'utf8');
assert.match(source, /DEFAULT_TIMEOUT_MS\s*=\s*2000/);
console.log('1 passed');
