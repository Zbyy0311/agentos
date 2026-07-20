import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

assert.match(readFileSync('executor.ts', 'utf8'), /DEFAULT_TIMEOUT_MS = 2000/);
assert.equal(existsSync('architecture.md'), true);
assert.equal(existsSync('artifacts/demo.png'), true);
console.log('1 passed');
