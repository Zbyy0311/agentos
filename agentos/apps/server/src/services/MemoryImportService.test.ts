import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import {
  IMPORT_MAX_BYTES,
  MemoryImportError,
  MemoryImportService,
} from './MemoryImportService.js';

const WS = 'ws_import';
const NOW = '2026-09-12T18:00:00.000Z';
const MARKDOWN = [
  '# Project notes',
  'Intro paragraph.',
  '',
  '## Decisions',
  'We chose SQLite.',
  '',
  '## Risks',
  'Port contention.',
].join('\n');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-import-'));
  const store = new SqliteStore(root);
  store.getDatabase().prepare(
    'INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(WS, WS, root, root, NOW, NOW, NOW);
  const service = new MemoryImportService(store);
  const candidates = new MemoryCandidateRepository(store.getDatabase());
  return {
    root, store, service, candidates,
    rows: () => store.getDatabase().prepare('SELECT * FROM memory_import_records WHERE workspace_id = ?').all(WS) as Array<Record<string, unknown>>,
    events: () => store.getDatabase().prepare('SELECT type, payload_json FROM workspace_events WHERE workspace_id = ?').all(WS) as Array<{ type: string; payload_json: string }>,
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('S7: preview splits by heading, is read-only, and reports the source hash', () => {
  const fx = fixture();
  try {
    const preview = fx.service.preview({ fileName: 'notes.md', bytes: Buffer.from(MARKDOWN, 'utf8') });
    assert.deepEqual(preview.fragments.map(fragment => fragment.title), ['Project notes', 'Decisions', 'Risks']);
    assert.equal(preview.fragmentCount, 3);
    assert.equal(preview.parserVersion, 'lite-v1-markdown-heading');
    assert.equal(preview.byteSize, Buffer.byteLength(MARKDOWN, 'utf8'));
    assert.equal(preview.sourceHash.length, 64);
    // nothing is persisted by a preview
    assert.equal(fx.rows().length, 0);
    assert.equal(fx.events().length, 0);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM memory_candidate_entries').get() as { n: number }).n, 0);
  } finally { fx.close(); }
});

test('S7: oversized sections are split into bounded fragments', () => {
  const fx = fixture();
  try {
    const body = 'x'.repeat(20_000);
    const preview = fx.service.preview({ fileName: 'big.md', bytes: Buffer.from('# Big\n' + body, 'utf8') });
    assert.ok(preview.fragments.length >= 3);
    for (const fragment of preview.fragments) {
      assert.ok(fragment.content.length <= 8000);
      assert.equal(fragment.fragmentHash.length, 64);
    }
  } finally { fx.close(); }
});

test('S7: size, encoding, and empty input are refused before any write', () => {
  const fx = fixture();
  try {
    assert.throws(() => fx.service.preview({ fileName: 'big.md', bytes: Buffer.alloc(IMPORT_MAX_BYTES + 1, 0x61) }), /IMPORT_TOO_LARGE/);
    assert.throws(() => fx.service.preview({ fileName: 'empty.md', bytes: Buffer.alloc(0) }), /IMPORT_EMPTY/);
    assert.throws(() => fx.service.preview({ fileName: '', bytes: Buffer.from('x', 'utf8') }), /IMPORT_INPUT_INVALID/);
    // 0xFF is never valid UTF-8
    assert.throws(() => fx.service.preview({ fileName: 'bad.md', bytes: Buffer.from([0x23, 0xff, 0xfe]) }), /IMPORT_NOT_UTF8/);
    assert.equal(fx.rows().length, 0);
  } finally { fx.close(); }
});

test('S7: confirm creates review-required Candidates, immutable records and one Event per fragment', () => {
  const fx = fixture();
  try {
    const bytes = Buffer.from(MARKDOWN, 'utf8');
    const result = fx.service.confirm({ workspaceId: WS, fileName: 'notes.md', bytes, createdAt: NOW });
    assert.equal(result.imported.length, 3);
    assert.equal(result.converged.length, 0);
    assert.equal(fx.rows().length, 3);
    assert.equal(fx.events().length, 3);
    for (const item of result.imported) {
      const candidate = fx.candidates.findCandidateById(WS, item.candidateId)!;
      assert.equal(candidate.decision, 'review-required');
      assert.equal(candidate.outcome, 'review-required');
      assert.equal(candidate.authority, 'imported-verified');
      assert.equal(candidate.scope, 'workspace');
      assert.equal(candidate.category, 'knowledge');
      assert.deepEqual(candidate.sources.map((source: { kind: string }) => source.kind), ['import']);
    }
    const payloads = fx.events().map(event => JSON.parse(event.payload_json) as { candidateId: string; decision: string });
    assert.equal(payloads.length, result.imported.length);
    for (const payload of payloads) {
      assert.equal(payload.decision, 'review-required');
      assert.ok(result.imported.some(item => item.candidateId === payload.candidateId));
    }
    // records are immutable
    assert.throws(() => fx.store.getDatabase().prepare('UPDATE memory_import_records SET title = ? WHERE workspace_id = ?').run('tampered', WS), /MEMORY_IMPORT_IMMUTABLE/);
  } finally { fx.close(); }
});

test('S7: re-importing the same file converges with no second Candidate or Event', () => {
  const fx = fixture();
  try {
    const bytes = Buffer.from(MARKDOWN, 'utf8');
    const first = fx.service.confirm({ workspaceId: WS, fileName: 'notes.md', bytes, createdAt: NOW });
    const second = fx.service.confirm({ workspaceId: WS, fileName: 'notes.md', bytes, createdAt: NOW });
    assert.equal(second.imported.length, 0);
    assert.equal(second.converged.length, first.imported.length);
    assert.deepEqual(second.converged.map(item => item.candidateId).sort(), first.imported.map(item => item.candidateId).sort());
    assert.equal(fx.rows().length, 3);
    assert.equal(fx.events().length, 3);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM memory_candidate_entries').get() as { n: number }).n, 3);
  } finally { fx.close(); }
});

test('S7: a changed source is a new traceable version, and the source file on disk is untouched', () => {
  const fx = fixture();
  try {
    const filePath = join(fx.root, 'notes.md');
    const originalBytes = Buffer.from(MARKDOWN, 'utf8');
    writeFileSync(filePath, originalBytes);
    const before = readFileSync(filePath);
    const first = fx.service.confirm({ workspaceId: WS, fileName: 'notes.md', bytes: originalBytes, createdAt: NOW });
    const changed = Buffer.from(MARKDOWN + '\n\n## Added\nNew section.', 'utf8');
    const second = fx.service.confirm({ workspaceId: WS, fileName: 'notes.md', bytes: changed, createdAt: NOW });
    assert.equal(second.imported.length, 4);
    assert.equal(second.converged.length, 0);
    assert.notEqual(second.sourceHash, first.sourceHash);
    assert.equal(new Set(fx.rows().map(row => row.source_hash)).size, 2);
    assert.equal(fx.rows().length, 7);
    // the source file keeps its original bytes: import never mutates it
    assert.deepEqual(readFileSync(filePath), before);
  } finally { fx.close(); }
});

test('S7: an Event failure rolls back the Candidate and the import record together', () => {
  const fx = fixture();
  try {
    fx.store.getDatabase().exec("CREATE TRIGGER fail_import_event BEFORE INSERT ON workspace_events BEGIN SELECT RAISE(ABORT, 'injected import event failure'); END");
    assert.throws(() => fx.service.confirm({ workspaceId: WS, fileName: 'notes.md', bytes: Buffer.from(MARKDOWN, 'utf8'), createdAt: NOW }));
    assert.equal(fx.rows().length, 0);
    assert.equal(fx.events().length, 0);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM memory_candidate_entries').get() as { n: number }).n, 0);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM memory_candidate_sources').get() as { n: number }).n, 0);
  } finally { fx.close(); }
});
