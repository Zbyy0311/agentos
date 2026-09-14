/**
 * LITE S7 candidate evidence harness: explicit Markdown import.
 *
 * Every phase drives the production import path over a real file on disk, and each
 * assertion records its own actual/expected values so a reader can check clause coverage
 * instead of trusting a suite-level pass. Phases:
 *
 *   file      - a real UTF-8 Markdown file is previewed through the production parser
 *   service   - confirm writes Candidates, durable records and canonical Events
 *   owner     - the idempotency key is scoped to the owning Workspace
 *   refusals  - the size, encoding, emptiness and input rules, executed
 *   http      - the same rules through the mounted production router
 *
 * Usage (from apps/server, with tsx resolvable):
 *   node --import tsx ../../scripts/verify-lite-s7-candidate-evidence.mjs --out <dir>
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import { SqliteStore } from '../apps/server/src/store/SqliteStore.ts';
import {
  MemoryImportService,
  MemoryImportError,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_FRAGMENTS,
  IMPORT_MAX_FRAGMENT_CHARACTERS,
  IMPORT_PARSER_VERSION,
  proveWorkspaceImport,
} from '../apps/server/src/services/MemoryImportService.ts';
import { createMemoryImportRoutes } from '../apps/server/src/routes/memoryImport.ts';
import { WorkspaceManager } from '../apps/server/src/managers/WorkspaceManager.ts';
import { inTransaction } from '../apps/server/src/store/Transaction.ts';

// This harness lives outside the server package, so express resolves from the server's
// own node_modules.
const serverRequire = createRequire(new URL('../apps/server/package.json', import.meta.url));
const express = serverRequire('express');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const OUT = resolve(argValue('--out') ?? '.');
mkdirSync(OUT, { recursive: true });

const receipts = [];
let phase = 'setup';
const phases = {};

class ReceiptFailure extends Error {}

function expect(requirementId, id, step, actual, expected, ok = undefined) {
  let passed = true;
  let detail;
  try {
    if (ok === undefined) assert.deepEqual(actual, expected);
    else if (!ok) throw new Error('condition was false');
  } catch (error) {
    passed = false;
    detail = String(error.message).split('\n')[0];
  }
  receipts.push({
    id, requirementId, phase, step, actual, expected,
    outcome: passed ? 'passed' : 'failed',
    ...(detail === undefined ? {} : { detail }),
  });
  if (!passed) throw new ReceiptFailure(id);
  return actual;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function catchPhase(error) {
  if (!(error instanceof ReceiptFailure)) throw error;
  phases[phase] = { ...(phases[phase] ?? {}), failedReceipt: error.message };
}

const root = mkdtempSync(join(tmpdir(), 'agentos-s7-evidence-'));
const files = mkdtempSync(join(tmpdir(), 'agentos-s7-files-'));
const store = new SqliteStore(root);
const db = store.getDatabase();
const NOW = new Date().toISOString();
const WS = 'ws_s7_evidence';
const WS2 = 'ws_s7_other_owner';

db.prepare('INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run(WS, WS, root, root, NOW, NOW, NOW);
// The two owners are the same store, so the second Workspace needs its own root: the
// canonical root path is unique per Workspace.
const secondRoot = mkdtempSync(join(tmpdir(), 'agentos-s7-owner-'));
db.prepare('INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run(WS2, WS2, secondRoot, secondRoot, NOW, NOW, NOW);

const importer = new MemoryImportService(store);
const writer = store.workspaceEventWriter();

const countRows = () => ({
  candidates: Number(db.prepare('SELECT COUNT(*) AS n FROM memory_candidate_entries').get().n),
  records: Number(db.prepare('SELECT COUNT(*) AS n FROM memory_import_records').get().n),
  events: Number(db.prepare("SELECT COUNT(*) AS n FROM workspace_events WHERE type = 'memory.candidate_created'").get().n),
  entries: Number(db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n),
  runs: Number(db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n),
});

// ------------------------------------------------------------------- file phase
phase = 'file';
let markdownPath;
let markdownBytes;
let preview;
try {
markdownPath = join(files, 'handbook.md');
// The parser trims each section body, so the reference value is the trimmed body too.
const preface = 'Preface written before any heading.';
const alpha = 'Alpha body '.repeat(50).trim();
const beta = 'Beta line. '.repeat(1000).slice(0, 12000).trim();
const gamma = 'Gamma body.';
const authored = [
  preface,
  '',
  '## Alpha',
  alpha,
  '',
  '## Beta',
  beta,
  '',
  '## Gamma',
  gamma,
].join('\n');
writeFileSync(markdownPath, authored, 'utf8');
markdownBytes = readFileSync(markdownPath);
const hashOnDiskBefore = sha256(readFileSync(markdownPath));

preview = importer.preview({ fileName: 'handbook.md', bytes: markdownBytes });
expect('LITE-07-106', 'S7E-PREVIEW-01', 'the production preview segments the real file without persisting anything',
  { parserVersion: preview.parserVersion, byteSize: preview.byteSize, fileBytes: markdownBytes.byteLength,
    sourceHashMatchesFileBytes: preview.sourceHash === sha256(markdownBytes),
    fragmentCount: preview.fragmentCount,
    fragmentTitles: preview.fragments.map(fragment => fragment.title),
    skipped: preview.skipped.length,
    rowsWritten: countRows() },
  { parserVersion: IMPORT_PARSER_VERSION, byteSize: markdownBytes.byteLength, fileBytes: markdownBytes.byteLength,
    sourceHashMatchesFileBytes: true, fragmentCount: 5,
    fragmentTitles: ['handbook.md', 'Alpha', 'Beta', 'Beta (part 2)', 'Gamma'], skipped: 0,
    rowsWritten: { candidates: 0, records: 0, events: 0, entries: 0, runs: 0 } });
expect('LITE-07-106', 'S7E-PREVIEW-02', 'an oversized section is split further so every fragment stays bounded',
  { sectionCharacters: 12000, limit: IMPORT_MAX_FRAGMENT_CHARACTERS,
    fragmentLengths: preview.fragments.map(fragment => fragment.content.length),
    allWithinLimit: preview.fragments.every(fragment => fragment.content.length <= IMPORT_MAX_FRAGMENT_CHARACTERS),
    partTitles: preview.fragments.filter(fragment => fragment.title.includes('(part')).map(fragment => fragment.title),
    betaPartsReassemble: preview.fragments[2].content + preview.fragments[3].content === beta },
  { sectionCharacters: 12000, limit: IMPORT_MAX_FRAGMENT_CHARACTERS,
    fragmentLengths: [preface.length, alpha.length, IMPORT_MAX_FRAGMENT_CHARACTERS, beta.length - IMPORT_MAX_FRAGMENT_CHARACTERS, gamma.length],
    allWithinLimit: true, partTitles: ['Beta (part 2)'],
    betaPartsReassemble: true });
expect('LITE-07-106', 'S7E-PREVIEW-03', 'each fragment is content-addressed and the user file is left untouched',
  { fragmentHashesMatch: preview.fragments.every(fragment => fragment.fragmentHash === sha256(fragment.content)),
    hashOnDiskBefore, hashOnDiskAfter: sha256(readFileSync(markdownPath)),
    fileUnchanged: hashOnDiskBefore === sha256(readFileSync(markdownPath)),
    fileBytesOnDisk: readFileSync(markdownPath).byteLength },
  { fragmentHashesMatch: true, hashOnDiskBefore, hashOnDiskAfter: hashOnDiskBefore, fileUnchanged: true,
    fileBytesOnDisk: markdownBytes.byteLength });
} catch (error) { catchPhase(error); }

// ---------------------------------------------------------------- service phase
phase = 'service';
try {
const confirmed = importer.confirm({ workspaceId: WS, fileName: 'handbook.md', bytes: markdownBytes, createdAt: NOW });
const records = db.prepare(`SELECT id, source_hash AS sourceHash, fragment_index AS fragmentIndex,
  fragment_hash AS fragmentHash, parser_version AS parserVersion, title, fragment_count AS fragmentCount,
  byte_size AS byteSize, candidate_id AS candidateId FROM memory_import_records WHERE workspace_id = ?
  ORDER BY fragment_index ASC`).all(WS);
const candidateRows = db.prepare(`SELECT id, scope, category, authority, decision, confidence, owner_conversation_id AS owner
  FROM memory_candidate_entries WHERE workspace_id = ? ORDER BY id ASC`).all(WS);
const events = db.prepare(`SELECT type, correlation_id AS correlationId, causation_id AS causationId, payload_json AS payload
  FROM workspace_events WHERE workspace_id = ? ORDER BY sequence ASC`).all(WS);
expect('LITE-07-106', 'S7E-CONFIRM-01', 'a confirmed import writes review-required Candidates, durable records and canonical Events',
  { imported: confirmed.imported.length, converged: confirmed.converged.length, skipped: confirmed.skipped.length,
    recordCount: records.length, parserVersion: records[0]?.parserVersion,
    sourceHashMatchesPreview: records.every(record => record.sourceHash === preview.sourceHash),
    fragmentHashesMatchPreview: records.every(record => record.fragmentHash === preview.fragments[record.fragmentIndex].fragmentHash),
    fragmentIndexes: records.map(record => record.fragmentIndex),
    candidateIdsMatchRecords: records.every(record => candidateRows.some(candidate => candidate.id === record.candidateId)),
    scopes: [...new Set(candidateRows.map(candidate => candidate.scope))],
    categories: [...new Set(candidateRows.map(candidate => candidate.category))],
    authorities: [...new Set(candidateRows.map(candidate => candidate.authority))],
    decisions: [...new Set(candidateRows.map(candidate => candidate.decision))],
    owners: [...new Set(candidateRows.map(candidate => candidate.owner))],
    candidateCount: candidateRows.length },
  { imported: 5, converged: 0, skipped: 0, recordCount: 5, parserVersion: IMPORT_PARSER_VERSION,
    sourceHashMatchesPreview: true, fragmentHashesMatchPreview: true, fragmentIndexes: [0, 1, 2, 3, 4],
    candidateIdsMatchRecords: true, scopes: ['workspace'], categories: ['knowledge'], authorities: ['imported-verified'],
    decisions: ['review-required'], owners: [null], candidateCount: 5 });
expect('LITE-07-108', 'S7E-CONFIRM-02', 'the non-Run origin registers its own canonical causal Event without inventing a Run',
  { eventTypes: [...new Set(events.map(event => event.type))], eventCount: events.length,
    correlationNamesItsOwnRecord: events.every(event => event.correlationId === 'memory-import:' + event.causationId),
    causationMatchesRecordIds: events.every(event => records.some(record => record.id === event.causationId)),
    importIds: events.map(event => event.causationId),
    payloadCandidateMatches: events.every(event => {
      const record = records.find(candidate => candidate.id === event.causationId);
      return record !== undefined && JSON.parse(event.payload).candidateId === record.candidateId;
    }),
    runsFabricated: countRows().runs },
  { eventTypes: ['memory.candidate_created'], eventCount: 5, correlationNamesItsOwnRecord: true,
    causationMatchesRecordIds: true, importIds: records.map(record => record.id),
    payloadCandidateMatches: true, runsFabricated: 0 });
const proof = proveWorkspaceImport(db, WS, records[0].id);
expect('LITE-07-108', 'S7E-CONFIRM-03', 'the origin is proved against the durable record, and a borrowed origin is refused',
  { proof: { candidateId: proof?.candidateId === records[0].candidateId, scope: proof?.scope, category: proof?.category,
      authority: proof?.authority, decision: proof?.decision },
    provesOnlyOwnRecord: proveWorkspaceImport(db, WS, records[1].id)?.candidateId === records[1].candidateId,
    unknownRecordProved: proveWorkspaceImport(db, WS, 'import_does_not_exist') !== undefined,
    borrowedOriginRefusal: (() => {
      try {
        // A well-formed payload with a borrowed origin: the only thing wrong here is that the
        // candidate did not come from a published compaction.
        const borrowed = candidateRows.find(candidate => candidate.id === records[0].candidateId);
        // The writer owns the frozen one-transaction rule, so the probe runs inside one:
        // the only thing wrong with it is the borrowed origin.
        inTransaction(db, () => writer.appendWithinTransaction({
          type: 'memory.candidate_created', workspaceId: WS, timestamp: NOW,
          origin: { kind: 'memory.compaction', compactionId: records[0].id },
          context: { correlationId: 'memory-compaction:' + records[0].id, causationId: records[0].id },
          payload: { candidateId: records[0].candidateId, scope: borrowed.scope, category: borrowed.category,
            authority: borrowed.authority, decision: borrowed.decision },
        }));
        return 'accepted';
      } catch (error) { return error?.code ?? error?.name ?? 'threw'; }
    })(),
    eventsAfterRefusal: Number(db.prepare("SELECT COUNT(*) AS n FROM workspace_events WHERE type = 'memory.candidate_created'").get().n) },
  { proof: { candidateId: true, scope: 'workspace', category: 'knowledge', authority: 'imported-verified', decision: 'review-required' },
    provesOnlyOwnRecord: true, unknownRecordProved: false, borrowedOriginRefusal: 'WORKSPACE_EVENT_ORIGIN_UNPROVEN',
    eventsAfterRefusal: 5 });
const before = countRows();
const repeat = importer.confirm({ workspaceId: WS, fileName: 'handbook.md', bytes: markdownBytes, createdAt: NOW });
const after = countRows();
expect('LITE-07-107', 'S7E-IDEMPOTENT-01', 'a repeated import of the same bytes converges and writes nothing new',
  { imported: repeat.imported.length, converged: repeat.converged.length,
    sameCandidates: repeat.converged.every(item => confirmed.imported.some(first => first.candidateId === item.candidateId)),
    rows: { candidates: after.candidates - before.candidates, records: after.records - before.records,
      events: after.events - before.events } },
  { imported: 0, converged: 5, sameCandidates: true, rows: { candidates: 0, records: 0, events: 0 } });
const changedBeta = 'Revised beta line. '.repeat(600).slice(0, 12000);
const betaBody = 'Beta line. '.repeat(1000).slice(0, 12000).trim();
const revised = readFileSync(markdownPath, 'utf8').replace(betaBody, changedBeta);
markdownPath = join(files, 'handbook-v2.md');
writeFileSync(markdownPath, revised, 'utf8');
const revisedBytes = readFileSync(markdownPath);
const revisedPreview = importer.preview({ fileName: 'handbook.md', bytes: revisedBytes });
const revisedConfirm = importer.confirm({ workspaceId: WS, fileName: 'handbook.md', bytes: revisedBytes, createdAt: NOW });
const recordsAfter = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_import_records WHERE workspace_id = ?').get(WS).n);
const versions = db.prepare('SELECT COUNT(DISTINCT source_hash) AS n FROM memory_import_records WHERE workspace_id = ?').get(WS);
const firstVersionFragment = db.prepare('SELECT fragment_hash AS fragmentHash, candidate_id AS candidateId FROM memory_import_records WHERE workspace_id = ? AND source_hash = ? AND fragment_index = 2').get(WS, preview.sourceHash);
const revisedFragment = db.prepare('SELECT fragment_hash AS fragmentHash, candidate_id AS candidateId FROM memory_import_records WHERE workspace_id = ? AND source_hash = ? AND fragment_index = 2').get(WS, revisedPreview.sourceHash);
expect('LITE-07-107', 'S7E-IDEMPOTENT-02', 'a changed source becomes a traceable new version instead of overwriting the audit trail',
  { sourceHashChanged: revisedPreview.sourceHash !== preview.sourceHash,
    imported: revisedConfirm.imported.length, converged: revisedConfirm.converged.length,
    importedIndexes: revisedConfirm.imported.map(item => item.index),
    recordsAfter, distinctSourceVersions: Number(versions.n),
    oldVersionFragmentKept: firstVersionFragment !== undefined,
    oldAndNewFractionDiffer: firstVersionFragment?.fragmentHash !== revisedFragment?.fragmentHash,
    oldAndNewCandidatesDiffer: firstVersionFragment?.candidateId !== revisedFragment?.candidateId,
    scopesUnchanged: [...new Set(db.prepare('SELECT scope FROM memory_candidate_entries WHERE workspace_id = ?').all(WS).map(row => row.scope))],
    // Recorded, not claimed: the idempotency tuple is (source hash, fragment, parser version),
    // so a changed file is a NEW source version and its fragments are recorded again. Fragment
    // reuse across versions is not part of the frozen contract.
    fragmentReuseAcrossVersions: 'not-part-of-the-contract' },
  { sourceHashChanged: true, imported: 5, converged: 0, importedIndexes: [0, 1, 2, 3, 4],
    recordsAfter: 10, distinctSourceVersions: 2, oldVersionFragmentKept: true,
    oldAndNewFractionDiffer: true, oldAndNewCandidatesDiffer: true, scopesUnchanged: ['workspace'],
    fragmentReuseAcrossVersions: 'not-part-of-the-contract' });
phases.service = { importRecords: recordsAfter, sourceHash: preview.sourceHash, revisedSourceHash: revisedPreview.sourceHash };
} catch (error) { catchPhase(error); }

// ------------------------------------------------------------------ owner phase
phase = 'owner';
try {
const other = importer.confirm({ workspaceId: WS2, fileName: 'handbook.md', bytes: markdownBytes, createdAt: NOW });
const otherRecords = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_import_records WHERE workspace_id = ?').get(WS2).n);
const otherCandidates = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_candidate_entries WHERE workspace_id = ?').get(WS2).n);
const otherEvents = Number(db.prepare("SELECT COUNT(*) AS n FROM workspace_events WHERE workspace_id = ? AND type = 'memory.candidate_created'").get(WS2).n);
expect('LITE-07-107', 'S7E-OWNER-01', 'the same bytes in another Workspace are a new import, not a cross-owner convergence',
  { imported: other.imported.length, converged: other.converged.length,
    records: otherRecords, candidates: otherCandidates, events: otherEvents,
    sameSourceHashAsFirstWorkspace: other.sourceHash === preview.sourceHash,
    firstWorkspaceRecordsUnchanged: Number(db.prepare('SELECT COUNT(*) AS n FROM memory_import_records WHERE workspace_id = ?').get(WS).n) },
  { imported: 5, converged: 0, records: 5, candidates: 5, events: 5,
    sameSourceHashAsFirstWorkspace: true, firstWorkspaceRecordsUnchanged: 10 });
} catch (error) { catchPhase(error); }

// --------------------------------------------------------------- refusals phase
phase = 'refusals';
try {
const attempt = (input) => {
  try { importer.preview(input); return { code: null }; }
  catch (error) { return { code: error?.code ?? error?.name ?? 'threw', isImportError: error instanceof MemoryImportError }; }
};
const before = countRows();
const tooLarge = attempt({ fileName: 'big.md', bytes: Buffer.alloc(IMPORT_MAX_BYTES + 1, 0x61) });
const atLimit = attempt({ fileName: 'exact.md', bytes: Buffer.concat([Buffer.from('# T\n'), Buffer.alloc(IMPORT_MAX_BYTES - 4, 0x61)]) });
const notUtf8 = attempt({ fileName: 'binary.md', bytes: Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]) });
const empty = attempt({ fileName: 'empty.md', bytes: Buffer.alloc(0) });
const blankName = attempt({ fileName: '   ', bytes: Buffer.from('# T\nbody\n') });
expect('LITE-07-106', 'S7E-REFUSAL-01', 'the size, encoding, emptiness and input rules are executed, not assumed',
  { tooLarge: tooLarge.code, atLimit: atLimit.code,
    notUtf8: notUtf8.code, notUtf8IsImportError: notUtf8.isImportError,
    empty: empty.code, blankName: blankName.code, maxBytes: IMPORT_MAX_BYTES,
    rowsWrittenByRefusals: { candidates: countRows().candidates - before.candidates,
      records: countRows().records - before.records, events: countRows().events - before.events } },
  { tooLarge: 'IMPORT_TOO_LARGE', atLimit: null, notUtf8: 'IMPORT_NOT_UTF8', notUtf8IsImportError: true,
    empty: 'IMPORT_EMPTY', blankName: 'IMPORT_INPUT_INVALID', maxBytes: IMPORT_MAX_BYTES,
    rowsWrittenByRefusals: { candidates: 0, records: 0, events: 0 } });
const manySections = Array.from({ length: IMPORT_MAX_FRAGMENTS + 5 }, (_value, index) => '## Section ' + String(index) + '\nbody ' + String(index)).join('\n\n');
const capped = importer.preview({ fileName: 'many.md', bytes: Buffer.from(manySections, 'utf8') });
const cappedConfirm = importer.confirm({ workspaceId: WS, fileName: 'many.md', bytes: Buffer.from(manySections, 'utf8'), createdAt: NOW });
expect('LITE-07-106', 'S7E-REFUSAL-02', 'the fragment budget bounds one import instead of unbounded Candidate writes',
  { sections: IMPORT_MAX_FRAGMENTS + 5, fragmentCount: capped.fragmentCount, maxFragments: IMPORT_MAX_FRAGMENTS,
    skipped: capped.skipped.length, skipReasons: [...new Set(capped.skipped.map(item => item.reason))],
    confirmedImported: cappedConfirm.imported.length, confirmedSkipped: cappedConfirm.skipped.length },
  { sections: IMPORT_MAX_FRAGMENTS + 5, fragmentCount: IMPORT_MAX_FRAGMENTS, maxFragments: IMPORT_MAX_FRAGMENTS,
    skipped: 5, skipReasons: ['fragment-limit'], confirmedImported: IMPORT_MAX_FRAGMENTS, confirmedSkipped: 5 });
} catch (error) { catchPhase(error); }

// ------------------------------------------------------------------- http phase
phase = 'http';
try {
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use('/api/workspaces/:workspaceId', createMemoryImportRoutes(store, new WorkspaceManager(store)));
const server = app.listen(0, '127.0.0.1');
const sockets = new Set();
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.once('listening', resolve));
const port = server.address().port;
const base = 'http://127.0.0.1:' + String(port) + '/api/workspaces/' + WS;
const post = async (path, body) => {
  const response = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, json: await response.json() };
};
try {
  const authored = ['# Release notes', '', 'Shipped the bounded import path.', '', '## Follow-ups', '', 'Track the flaky Windows test.'].join('\n');
  const previewed = await post('/memory/import/preview', { fileName: 'notes.md', content: authored });
  const confirmed = await post('/memory/import/confirm', { fileName: 'notes.md', content: authored });
  const repeated = await post('/memory/import/confirm', { fileName: 'notes.md', content: authored });
  const listed = await (await fetch(base + '/memory/imports')).json();
  const tooLarge = await post('/memory/import/preview', { fileName: 'big.md', content: 'a'.repeat(IMPORT_MAX_BYTES + 1) });
  const missingField = await post('/memory/import/preview', { fileName: 'notes.md' });
  const unknownWorkspace = await fetch('http://127.0.0.1:' + String(port) + '/api/workspaces/ws_absent/memory/imports');
  expect('LITE-07-106', 'S7E-HTTP-01', 'the mounted router previews, confirms and converges over real HTTP',
    { previewStatus: previewed.status, previewFragments: previewed.json.preview?.fragmentCount,
      previewParser: previewed.json.preview?.parserVersion,
      confirmStatus: confirmed.status, confirmImported: confirmed.json.imported?.length,
      repeatStatus: repeated.status, repeatImported: repeated.json.imported?.length, repeatConverged: repeated.json.converged?.length,
      listedStatus: listed.imports?.length > 0,
      listedIds: listed.imports.filter(record => confirmed.json.imported.some(item => item.candidateId === record.candidateId)).length,
      tooLargeStatus: tooLarge.status, tooLargeError: tooLarge.json.error,
      missingFieldStatus: missingField.status, missingFieldError: missingField.json.error,
      unknownWorkspaceStatus: unknownWorkspace.status },
    { previewStatus: 200, previewFragments: 2, previewParser: IMPORT_PARSER_VERSION,
      confirmStatus: 201, confirmImported: 2, repeatStatus: 200, repeatImported: 0, repeatConverged: 2,
      listedStatus: true, listedIds: 2,
      tooLargeStatus: 413, tooLargeError: 'IMPORT_TOO_LARGE',
      missingFieldStatus: 400, missingFieldError: 'IMPORT_INPUT_INVALID',
      unknownWorkspaceStatus: 404 });
  phases.http = { importRecordsListed: listed.imports.length };
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(() => resolve()));
}
} catch (error) { catchPhase(error); }

store.close();
rmSync(root, { recursive: true, force: true });
rmSync(files, { recursive: true, force: true });
rmSync(secondRoot, { recursive: true, force: true });

const counts = { total: receipts.length, passed: 0, failed: 0, skipped: 0 };
for (const receipt of receipts) {
  if (receipt.outcome === 'passed') counts.passed += 1;
  else if (receipt.outcome === 'failed') counts.failed += 1;
  else counts.skipped += 1;
}

writeFileSync(join(OUT, 'receipts.json'), `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  parserVersion: IMPORT_PARSER_VERSION,
  phases,
  counts,
  receipts,
}, null, 2)}\n`, 'utf8');

console.log(`S7_CANDIDATE_EVIDENCE: ${counts.failed === 0 ? 'passed' : 'failed'}`);
console.log(`  receipts=${counts.total} passed=${counts.passed} failed=${counts.failed}`);
for (const receipt of receipts.filter(item => item.outcome !== 'passed')) {
  console.log(`  FAILED ${receipt.id} (${receipt.requirementId}): ${receipt.detail ?? ''}`);
}
await new Promise(resolve => setTimeout(resolve, 100));
process.exitCode = counts.failed === 0 ? 0 : 1;
