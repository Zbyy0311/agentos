import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { MemoryRecord, MemorySearchInput } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';

export interface RetrievedMemory {
  memory: MemoryRecord;
  content: string;
  score: number;
  ftsRank: number | null;
}

export class MemoryRetriever {
  constructor(private readonly store: SqliteStore) {}

  async search(workspaceRoot: string, input: MemorySearchInput): Promise<RetrievedMemory[]> {
    const queriedRecords = this.store.searchMemories(input.workspaceId, { query: input.query, status: 'active', type: input.types?.length === 1 ? input.types[0] : undefined, limit: 100 });
    const records = (queriedRecords.length > 0 || !input.query.trim()
      ? queriedRecords
      : this.store.searchMemories(input.workspaceId, { status: 'active', limit: 100 }))
      .filter(item => !input.types?.length || input.types.includes(item.memory.type));
    const queryTokens = tokenize(input.query);
    const relatedFiles = new Set((input.relatedFiles ?? []).map(file => file.replaceAll('\\', '/')));
    const results: RetrievedMemory[] = [];
    for (const item of records) {
      const memory = item.memory;
      const contentPath = resolve(workspaceRoot, memory.contentPath);
      const relativePath = relative(resolve(workspaceRoot), contentPath);
      if (!relativePath || relativePath === '..' || relativePath.startsWith('..') || isAbsolute(relativePath)) continue;
      let content: string;
      try { content = await readFile(contentPath, 'utf8'); } catch { continue; }
      const haystack = `${memory.title} ${memory.summary} ${memory.tags.join(' ')} ${memory.relatedFiles.join(' ')} ${content}`.toLocaleLowerCase();
      const keywordScore = queryTokens.reduce((score, token) => score + (haystack.includes(token) ? 10 : 0), 0);
      const fileScore = memory.relatedFiles.reduce((score, file) => score + (relatedFiles.has(file.replaceAll('\\', '/')) ? 1 : 0), 0);
      if (queryTokens.length > 0 && keywordScore === 0 && fileScore === 0) continue;
      results.push({ memory, content, score: keywordScore + fileScore + memory.importance / 100, ftsRank: item.ftsRank });
    }
    return results.sort((left, right) => {
      const leftHasFts = left.ftsRank !== null;
      const rightHasFts = right.ftsRank !== null;
      if (leftHasFts !== rightHasFts) return leftHasFts ? -1 : 1;
      if (leftHasFts && rightHasFts && left.ftsRank !== right.ftsRank) return left.ftsRank! - right.ftsRank!;
      const leftFileMatches = left.memory.relatedFiles.filter(file => relatedFiles.has(file.replaceAll('\\', '/'))).length;
      const rightFileMatches = right.memory.relatedFiles.filter(file => relatedFiles.has(file.replaceAll('\\', '/'))).length;
      return rightFileMatches - leftFileMatches
        || right.memory.importance - left.memory.importance
        || right.memory.updatedAt.localeCompare(left.memory.updatedAt)
        || left.memory.id.localeCompare(right.memory.id);
    }).slice(0, input.limit);
  }
}

function tokenize(value: string): string[] {
  const normalized = value.toLocaleLowerCase().trim();
  if (!normalized) return [];
  const tokens = normalized.split(/\s+/).map(token => token.trim()).filter(Boolean);
  if (tokens.length > 1 || !/[\u3400-\u9fff]/u.test(normalized)) return tokens;
  return Array.from({ length: Math.max(0, normalized.length - 1) }, (_, index) => normalized.slice(index, index + 2));
}
