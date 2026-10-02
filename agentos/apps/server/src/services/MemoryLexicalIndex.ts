import { createHash } from 'node:crypto';
import type { MemoryEntryRecord } from '../store/MemoryEntryRepository.js';
import { inTransaction, isTransactionActive, type TransactionDatabase } from '../store/Transaction.js';

export const MEMORY_RELEVANCE_POLICY = 'memory-relevance.v2' as const;
export const MEMORY_LEXICAL_VERSION = 'nfkc-han-bigrams.v2';
const STOP_WORDS = new Set('a an and are as at be by for from has have how i in is it of on or that the this to was we what when which with you your'.split(' '));
const ALIASES = new Map([
  ['fulltext', 'fts'], ['full-text', 'fts'], ['job-object', 'jobobject'], ['job_object', 'jobobject'],
  ['embeddings', 'embedding'], ['migrations', 'migration'], ['providers', 'provider'],
  ['memories', 'memory'], ['retries', 'retry'],
]);
const LANGUAGE_TERMS = new Map([['c++', 'cpp'], ['c#', 'csharp'], ['.net', 'dotnet']]);

/** Neutral terms, never FTS operators. Han bigrams make unspaced Chinese searchable. */
export function memoryLexicalTerms(value: string): string[] {
  const terms = new Set<string>();
  const normalized = value.normalize('NFKC').toLowerCase().replace(
    /(?<![a-z0-9_])(?:c\+\+|c#)(?![a-z0-9_])|(?<![a-z0-9_.])\.net(?![a-z0-9_])/gu,
    term => ` ${LANGUAGE_TERMS.get(term)!} `,
  );
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|[a-z0-9]+(?:[._-][a-z0-9]+)*/gu)) {
    const token = match[0];
    if (/^\p{Script=Han}+$/u.test(token)) {
      const chars = Array.from(token);
      for (let i = 0; i + 1 < chars.length && terms.size < 1024; i += 1) {
        terms.add(chars[i]! + chars[i + 1]!);
      }
    } else if (token.length > 1 && !STOP_WORDS.has(token)) {
      terms.add(ALIASES.get(token) ?? token);
    }
    if (terms.size >= 1024) break;
  }
  return [...terms].slice(0, 1024);
}

export function memoryEntryTerms(entry: MemoryEntryRecord): string[] {
  return memoryLexicalTerms([entry.title, entry.summary, entry.content, ...entry.tags].join('\n'));
}

/** Labels are audit framing, not words from the user's objective. */
export function memoryQueryText(query: string): string {
  // Stage/role labels describe the execution, not the user's knowledge need.
  // Keep them in the frozen query hash without letting "review" or "reply"
  // make an otherwise unmatched request select unrelated entries.
  return query
    .replace(/^Group role instructions:[\s\S]*$/mu, '')
    .replace(/^(?:Turn stage|Group role|Stage key):[^\r\n]*(?:\r?\n|$)/gmu, '')
    .replace(/^(?:Current request|Task objective|Prior failure code for this stage):\s*/gmu, '');
}

export function memoryQueryTerms(query: string): string[] {
  return memoryLexicalTerms(memoryQueryText(query));
}

/** Derived cache only. Missing/damaged index falls back to the same bounded terms. */
export function readMemoryLexicalRanks(
  db: TransactionDatabase, entries: readonly MemoryEntryRecord[], query: string,
): { ranks: Map<string, number>; degraded: boolean } {
  const queryTerms = memoryQueryTerms(query).slice(0, 128);
  if (!queryTerms.length || !entries.length) return { ranks: new Map(), degraded: false };
  try {
    const sync = () => {
      for (const entry of entries) {
        const text = [entry.title, entry.summary, entry.content, ...entry.tags].join('\n');
        const contentHash = createHash('sha256').update(text).digest('hex');
        const current = db.prepare('SELECT entry_version,content_hash,tokenizer_version FROM memory_lexical_entries WHERE entry_id = ?').get(entry.id) as {entry_version: number; content_hash: string; tokenizer_version: string} | undefined;
        if (current?.entry_version === entry.version && current.content_hash === contentHash && current.tokenizer_version === MEMORY_LEXICAL_VERSION
          && db.prepare('SELECT 1 FROM memory_lexical_fts WHERE entry_id = ?').get(entry.id)) continue;
        db.prepare('DELETE FROM memory_lexical_fts WHERE entry_id = ?').run(entry.id);
        db.prepare('INSERT INTO memory_lexical_fts(entry_id,terms) VALUES (?,?)').run(entry.id, memoryEntryTerms(entry).join(' '));
        db.prepare('INSERT INTO memory_lexical_entries(entry_id,entry_version,content_hash,tokenizer_version) VALUES (?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET entry_version=excluded.entry_version,content_hash=excluded.content_hash,tokenizer_version=excluded.tokenizer_version').run(entry.id, entry.version, contentHash, MEMORY_LEXICAL_VERSION);
      }
    };
    if (isTransactionActive(db)) sync(); else inTransaction(db, sync);
    const ranks = new Map<string, number>();
    // Chunk ids to stay below SQLite's bind ceiling with large workspaces.
    for (let i = 0; i < entries.length; i += 500) {
      const ids = entries.slice(i, i + 500).map(entry => entry.id);
      const rows = db.prepare(`SELECT entry_id,bm25(memory_lexical_fts) AS rank FROM memory_lexical_fts WHERE entry_id IN (${ids.map(() => '?').join(',')}) AND memory_lexical_fts MATCH ? ORDER BY rank,entry_id`).all(...ids, queryTerms.map(term => `"${term}"`).join(' OR ')) as {entry_id: string; rank: number}[];
      for (const row of rows) ranks.set(row.entry_id, row.rank);
    }
    return { ranks, degraded: false };
  } catch {
    const terms = new Set(queryTerms);
    const ranks = new Map<string, number>();
    for (const entry of entries) {
      const overlap = memoryEntryTerms(entry).filter(term => terms.has(term)).length;
      if (overlap) ranks.set(entry.id, -overlap);
    }
    return { ranks, degraded: true };
  }
}
