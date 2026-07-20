import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { all(...parameters: unknown[]): unknown[] };
    close(): void;
  };
};

export interface OpenCodeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  cacheWriteTokens: number;
}

export interface OpenCodeUsageSnapshot {
  sessions: Map<string, OpenCodeTokenUsage>;
}

export interface ReadOpenCodeUsageOptions {
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}

const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'cacheWriteTokens'] as const;

export function readOpenCodeUsageSnapshot(options: ReadOpenCodeUsageOptions): OpenCodeUsageSnapshot | undefined {
  const sessions = new Map<string, OpenCodeTokenUsage>();
  let readableDatabaseFound = false;
  for (const databasePath of options.databasePath ? [options.databasePath] : resolveOpenCodeDatabasePaths(options.workspaceRoot, options.env ?? process.env)) {
    if (!existsSync(databasePath)) continue;
    let database: InstanceType<typeof DatabaseSync> | undefined;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      readableDatabaseFound = true;
      const rows = database.prepare(`
        SELECT id, directory, tokens_input, tokens_output, tokens_reasoning,
               tokens_cache_read, tokens_cache_write
        FROM session
      `).all();
      for (const row of rows) {
        const record = asRecord(row);
        const id = stringValue(record.id);
        const directory = stringValue(record.directory);
        if (!id || !sameDirectory(directory, options.workspaceRoot)) continue;
        sessions.set(id, {
          inputTokens: integerValue(record.tokens_input),
          outputTokens: integerValue(record.tokens_output),
          cachedInputTokens: integerValue(record.tokens_cache_read),
          reasoningTokens: integerValue(record.tokens_reasoning),
          cacheWriteTokens: integerValue(record.tokens_cache_write),
        });
      }
    } catch {
      // A missing/locked/older OpenCode database must not fail the AgentOS run.
    } finally {
      try { database?.close(); } catch { /* best effort */ }
    }
  }
  return readableDatabaseFound ? { sessions } : undefined;
}

export function diffOpenCodeUsage(before: OpenCodeUsageSnapshot | undefined, after: OpenCodeUsageSnapshot | undefined): OpenCodeTokenUsage | undefined {
  if (!after) return undefined;
  const delta = emptyUsage();
  let hasPositiveDelta = false;
  for (const [sessionId, current] of after.sessions) {
    const previous = before?.sessions.get(sessionId);
    for (const field of USAGE_FIELDS) {
      const value = Math.max(0, current[field] - (previous?.[field] ?? 0));
      delta[field] += value;
      if (value > 0) hasPositiveDelta = true;
    }
  }
  return hasPositiveDelta ? delta : undefined;
}

export function resolveOpenCodeDatabasePaths(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const profile = env.USERPROFILE || env.HOME || homedir();
  const xdgDataHome = env.XDG_DATA_HOME || join(profile, '.local', 'share');
  const candidates = [
    env.AGENTOS_OPENCODE_DB,
    env.OPENCODE_DB,
    join(xdgDataHome, 'opencode', 'opencode.db'),
    join(profile, '.local', 'share', 'opencode', 'opencode.db'),
    env.APPDATA ? join(env.APPDATA, 'opencode', 'opencode.db') : undefined,
    env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.db') : undefined,
    join(workspaceRoot, '.agentos', 'opencode-home', 'opencode', 'opencode.db'),
    join(workspaceRoot, '.agentos', 'opencode', 'opencode', 'opencode.db'),
  ];
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
}

function emptyUsage(): OpenCodeTokenUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 };
}

function sameDirectory(left: string, right: string): boolean {
  return normalizeDirectory(left) === normalizeDirectory(right);
}

function normalizeDirectory(value: string): string {
  const normalized = value.trim().replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function integerValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
