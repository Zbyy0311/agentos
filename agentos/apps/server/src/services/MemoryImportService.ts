import { createHash } from 'node:crypto';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { createEntityId } from '../store/Identity.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { deriveWorkspaceEventContext } from '../store/WorkspaceEventWriter.js';
import { hashMemoryText, normalizeMemoryText } from './MemoryCandidateGenerationService.js';

/**
 * S7 explicit Markdown import (authorization: S7-import-authorization.md).
 *
 * User-selected UTF-8 Markdown only. The preview is read-only; confirm writes
 * bounded review-required Candidates, immutable import records and one
 * canonical Workspace Event per new fragment. Re-importing the same file
 * converges on the existing records and emits nothing.
 */

export const IMPORT_PARSER_VERSION = 'lite-v1-markdown-heading';
export const IMPORT_MAX_BYTES = 1024 * 1024;
export const IMPORT_MAX_FRAGMENTS = 200;
export const IMPORT_MAX_FRAGMENT_CHARACTERS = 8000;

export interface ImportedFragment {
  readonly index: number;
  readonly title: string;
  readonly content: string;
  readonly fragmentHash: string;
}

export interface ImportPreview {
  readonly fileName: string;
  readonly sourceHash: string;
  readonly byteSize: number;
  readonly parserVersion: string;
  readonly fragmentCount: number;
  readonly fragments: readonly ImportedFragment[];
  readonly skipped: readonly { readonly index: number; readonly title: string; readonly reason: string }[];
}

export class MemoryImportError extends Error {
  constructor(readonly code:
    | 'IMPORT_INPUT_INVALID'
    | 'IMPORT_TOO_LARGE'
    | 'IMPORT_NOT_UTF8'
    | 'IMPORT_EMPTY') {
    super(code);
    this.name = 'MemoryImportError';
  }
}

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeUtf8(bytes: Buffer): string {
  // A lossy decode proves non-UTF-8 bytes; a valid UTF-8 buffer round-trips.
  const text = bytes.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') !== bytes.byteLength) throw new MemoryImportError('IMPORT_NOT_UTF8');
  return text;
}

export function parseMarkdownFragments(fileName: string, content: string): ImportPreview {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const sections: { title: string; body: string[] }[] = [];
  let current: { title: string; body: string[] } | undefined;
  const preface: string[] = [];
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      current = { title: heading[2]!.trim(), body: [] };
      sections.push(current);
      continue;
    }
    if (current === undefined) preface.push(line);
    else current.body.push(line);
  }
  const chunks: { title: string; content: string }[] = [];
  if (preface.join('\n').trim()) chunks.push({ title: fileName, content: preface.join('\n').trim() });
  for (const section of sections) {
    const body = section.body.join('\n').trim();
    if (!body) continue;
    // Oversized sections are split further so one Fragment stays bounded.
    for (let offset = 0; offset < body.length; offset += IMPORT_MAX_FRAGMENT_CHARACTERS) {
      const part = body.slice(offset, offset + IMPORT_MAX_FRAGMENT_CHARACTERS);
      chunks.push({
        title: offset === 0 ? section.title : section.title + ' (part ' + (offset / IMPORT_MAX_FRAGMENT_CHARACTERS + 1) + ')',
        content: part,
      });
    }
  }
  const fragments: ImportedFragment[] = [];
  const skipped: { index: number; title: string; reason: string }[] = [];
  chunks.forEach((chunk, index) => {
    if (fragments.length >= IMPORT_MAX_FRAGMENTS) {
      skipped.push({ index, title: chunk.title, reason: 'fragment-limit' });
      return;
    }
    fragments.push({ index, title: chunk.title.slice(0, 200), content: chunk.content, fragmentHash: sha256(chunk.content) });
  });
  return {
    fileName,
    sourceHash: sha256(normalized),
    byteSize: Buffer.byteLength(content, 'utf8'),
    parserVersion: IMPORT_PARSER_VERSION,
    fragmentCount: fragments.length,
    fragments,
    skipped,
  };
}

/** Read-only preview over user-supplied bytes; nothing is persisted here. */
export function previewImport(input: { fileName: string; bytes: Buffer }): ImportPreview {
  const fileName = input.fileName?.trim();
  if (!fileName) throw new MemoryImportError('IMPORT_INPUT_INVALID');
  if (input.bytes.byteLength > IMPORT_MAX_BYTES) throw new MemoryImportError('IMPORT_TOO_LARGE');
  if (input.bytes.byteLength === 0) throw new MemoryImportError('IMPORT_EMPTY');
  return parseMarkdownFragments(fileName, decodeUtf8(input.bytes));
}

export interface ImportConfirmResult {
  readonly sourceHash: string;
  readonly imported: readonly { readonly index: number; readonly candidateId: string; readonly title: string }[];
  readonly converged: readonly { readonly index: number; readonly candidateId: string; readonly title: string }[];
  readonly skipped: readonly { readonly index: number; readonly title: string; readonly reason: string }[];
}

export interface ImportRecordView {
  readonly id: string;
  readonly sourceHash: string;
  readonly fragmentIndex: number;
  readonly fragmentHash: string;
  readonly parserVersion: string;
  readonly title: string;
  readonly fragmentCount: number;
  readonly byteSize: number;
  readonly candidateId: string;
  readonly createdAt: string;
}

export class MemoryImportService {
  private readonly candidates: MemoryCandidateRepository;
  constructor(private readonly store: SqliteStore) {
    this.candidates = new MemoryCandidateRepository(store.getDatabase());
  }

  preview(input: { fileName: string; bytes: Buffer }): ImportPreview {
    return previewImport(input);
  }

  /** Confirm writes the Candidates, immutable records and Workspace Events. */
  confirm(input: { workspaceId: string; fileName: string; bytes: Buffer; createdAt: string }): ImportConfirmResult {
    const preview = previewImport({ fileName: input.fileName, bytes: input.bytes });
    return inTransaction(this.store.getDatabase(), () => {
      const db = this.store.getDatabase();
      const imported: { index: number; candidateId: string; title: string }[] = [];
      const converged: { index: number; candidateId: string; title: string }[] = [];
      for (const fragment of preview.fragments) {
        const existing = db.prepare(`SELECT id, candidate_id AS candidateId, title FROM memory_import_records
          WHERE workspace_id = ? AND source_hash = ? AND fragment_index = ? AND parser_version = ?`)
          .get(input.workspaceId, preview.sourceHash, fragment.index, preview.parserVersion) as
          { id: string; candidateId: string; title: string } | undefined;
        if (existing !== undefined) {
          converged.push({ index: fragment.index, candidateId: existing.candidateId, title: existing.title });
          continue;
        }
        const content = '# ' + fragment.title + '\n\n' + fragment.content;
        const candidate = this.candidates.createCandidateWithinTransaction({
          id: createEntityId('memoryCandidate'), workspaceId: input.workspaceId, scope: 'workspace',
          category: 'knowledge', authority: 'imported-verified', confidence: 0.8, importance: 0.5,
          title: fragment.title, summary: content.slice(0, 400), content,
          exactContentHash: hashMemoryText(content), normalizedTextHash: hashMemoryText(normalizeMemoryText(content)),
          tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
          sources: [{ kind: 'import', id: fragment.fragmentHash }],
          createdAt: input.createdAt, minConfidence: 0.9, maxTokenEstimate: 4000,
        });
        const recordId = createEntityId('import');
        db.prepare(`INSERT INTO memory_import_records (
          id, workspace_id, source_hash, fragment_index, fragment_hash, parser_version, title,
          fragment_count, byte_size, candidate_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          recordId, input.workspaceId, preview.sourceHash, fragment.index, fragment.fragmentHash,
          preview.parserVersion, fragment.title, preview.fragmentCount, preview.byteSize,
          candidate.id, input.createdAt,
        );
        const origin = { kind: 'memory.import', importId: recordId } as const;
        this.store.workspaceEventWriter().appendWithinTransaction({
          type: 'memory.candidate_created', workspaceId: input.workspaceId, timestamp: input.createdAt,
          origin, context: deriveWorkspaceEventContext(origin),
          payload: { candidateId: candidate.id, scope: candidate.scope, category: candidate.category,
            authority: candidate.authority, decision: candidate.decision! },
        });
        imported.push({ index: fragment.index, candidateId: candidate.id, title: fragment.title });
      }
      return { sourceHash: preview.sourceHash, imported, converged, skipped: preview.skipped };
    });
  }

  list(workspaceId: string): ImportRecordView[] {
    return this.store.getDatabase().prepare(`SELECT id, source_hash AS sourceHash, fragment_index AS fragmentIndex,
      fragment_hash AS fragmentHash, parser_version AS parserVersion, title, fragment_count AS fragmentCount,
      byte_size AS byteSize, candidate_id AS candidateId, created_at AS createdAt
      FROM memory_import_records WHERE workspace_id = ? ORDER BY created_at ASC, id ASC`)
      .all(workspaceId) as unknown as ImportRecordView[];
  }
}

/**
 * S7 durable source proof reused by the Workspace event authority and writer:
 * the import record, its real Candidate and the matching import source must all
 * belong to the same Workspace.
 */
export function proveWorkspaceImport(db: TransactionDatabase, workspaceId: string, importId: string): {
  candidateId: string; scope: string; category: string; authority: string; decision: string;
} | undefined {
  return db.prepare(`SELECT c.id AS candidateId, c.scope, c.category, c.authority, c.decision
    FROM memory_import_records r
    JOIN memory_candidate_entries c ON c.id = r.candidate_id
    JOIN memory_candidate_sources s ON s.candidate_id = c.id
    WHERE r.workspace_id = ? AND r.id = ?
      AND c.workspace_id = r.workspace_id AND c.version = 1
      AND c.decision = 'review-required' AND c.authority = 'imported-verified'
      AND c.merged_into_entry_id IS NULL
      AND s.source_kind = 'import' AND s.source_id = r.fragment_hash`)
    .get(workspaceId, importId) as ReturnType<typeof proveWorkspaceImport>;
}

