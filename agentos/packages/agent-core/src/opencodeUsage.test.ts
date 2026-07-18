import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffOpenCodeUsage, readOpenCodeUsageSnapshot } from './opencodeUsage.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...parameters: unknown[]): void }; close(): void } };

describe('OpenCode usage reader', () => {
it('reads OpenCode session usage and returns only the delta for the workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-opencode-usage-'));
  const databasePath = join(root, 'opencode.db');
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY,
    directory TEXT NOT NULL,
    tokens_input INTEGER NOT NULL DEFAULT 0,
    tokens_output INTEGER NOT NULL DEFAULT 0,
    tokens_reasoning INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read INTEGER NOT NULL DEFAULT 0,
    tokens_cache_write INTEGER NOT NULL DEFAULT 0
  )`);
  database.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)').run('session-a', 'C:/workspace/agentos', 100, 20, 3, 40, 2);
  database.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)').run('session-other', 'C:/workspace/other', 999, 999, 999, 999, 999);

  const before = readOpenCodeUsageSnapshot({ workspaceRoot: 'c:\\workspace\\agentos', databasePath });
  database.prepare('UPDATE session SET tokens_input = 130, tokens_output = 28, tokens_reasoning = 5, tokens_cache_read = 60, tokens_cache_write = 4 WHERE id = ?').run('session-a');
  database.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)').run('session-new', 'C:/workspace/agentos', 7, 2, 1, 3, 0);
  const after = readOpenCodeUsageSnapshot({ workspaceRoot: 'c:\\workspace\\agentos', databasePath });
  database.close();
  rmSync(root, { recursive: true, force: true });

  expect(diffOpenCodeUsage(before, after)).toEqual({
    inputTokens: 37,
    outputTokens: 10,
    cachedInputTokens: 23,
    reasoningTokens: 3,
    cacheWriteTokens: 2,
  });
});

it('returns undefined when OpenCode has no readable database or no positive delta', () => {
  expect(readOpenCodeUsageSnapshot({ workspaceRoot: 'C:\\workspace\\agentos', databasePath: 'C:\\missing\\opencode.db' })).toBeUndefined();
  expect(diffOpenCodeUsage(undefined, undefined)).toBeUndefined();
});
});
