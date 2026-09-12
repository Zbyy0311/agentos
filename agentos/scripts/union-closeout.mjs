/**
 * Union two Lite closeout snapshots (matrix.json and/or evidence.json).
 *
 * The S0 matrix is a shared contract, so a merge must never take one side
 * wholesale: a row promoted on either side stays promoted, and every executed
 * evidence entry survives. This makes that resolution deterministic and
 * reviewable instead of hand-editing JSON inside conflict markers.
 *
 * Usage:
 *   node scripts/union-closeout.mjs matrix <ours.json> <theirs.json> <out.json> [reason]
 *   node scripts/union-closeout.mjs evidence <ours.json> <theirs.json> <out.json>
 *
 * In a conflicted merge the two sides are the conflict stages:
 *   ours   = git show :2:<path>
 *   theirs = git show :3:<path>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , kind, oursPath, theirsPath, outPath, reason] = process.argv;
if (!kind || !oursPath || !theirsPath || !outPath) {
  throw new Error('usage: node scripts/union-closeout.mjs <matrix|evidence> <ours> <theirs> <out> [reason]');
}

const ours = JSON.parse(readFileSync(oursPath, 'utf8'));
const theirs = JSON.parse(readFileSync(theirsPath, 'utf8'));

function unionStrings(a, b) {
  return [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
}

if (kind === 'matrix') {
  // DEFERRED is an explicit, user-approved outcome, so it must not be treated as
  // "less advanced" than RUNTIME-VERIFY by accident; PASS always wins because it
  // is the only state backed by executed evidence.
  const rank = { GAP: 1, 'RUNTIME-VERIFY': 2, DEFERRED: 2, PASS: 3 };
  const byId = new Map();
  for (const row of ours.requirements) byId.set(row.id, { ours: row });
  for (const row of theirs.requirements) {
    const slot = byId.get(row.id) ?? {};
    slot.theirs = row;
    byId.set(row.id, slot);
  }

  const requirements = [];
  let conflicts = 0;
  for (const [id, slot] of byId) {
    if (!slot.theirs) { requirements.push(slot.ours); continue; }
    if (!slot.ours) { requirements.push(slot.theirs); continue; }
    const a = slot.ours;
    const b = slot.theirs;
    const winner = (rank[b.state] ?? 0) > (rank[a.state] ?? 0) ? b : a;
    const loser = winner === a ? b : a;
    if (a.state !== b.state) conflicts += 1;
    requirements.push({
      ...winner,
      tests: unionStrings(winner.tests, loser.tests),
      // Evidence is NOT unioned across sides when the winner is PASS: the
      // scope gate requires every cited entry to carry an executed result mapped
      // to this exact requirement, and the losing side's pointer is by definition
      // the pre-promotion pointer. Unioning there would re-introduce exactly the
      // defect the gate rejects. Non-PASS rows may union safely.
      evidence: winner.state === 'PASS'
        ? [...new Set(winner.evidence ?? [])]
        : unionStrings(winner.evidence, loser.evidence),
      implementation: unionStrings(winner.implementation, loser.implementation),
      finding: winner.finding ?? loser.finding,
      exit: winner.exit ?? loser.exit,
      ...((winner.evidenceBaseline ?? loser.evidenceBaseline)
        ? { evidenceBaseline: winner.evidenceBaseline ?? loser.evidenceBaseline } : {}),
      state: winner.state,
      id,
    });
  }

  const version = Math.max(Number(ours.matrixVersion) || 0, Number(theirs.matrixVersion) || 0);
  const seen = new Set();
  const changes = [];
  for (const change of [...(ours.changes ?? []), ...(theirs.changes ?? [])]) {
    const key = `${change.version}|${change.reason ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push(change);
  }
  changes.sort((left, right) => Number(left.version) - Number(right.version));

  const merged = {
    ...ours,
    matrixVersion: version + 1,
    requirements,
    changes: [...changes, {
      version: version + 1,
      baseline: ours.baseline,
      authority: 'Main-agent merge resolution (union of both branches)',
      reason: reason ?? 'Union merge of two closeout branches',
      requirementIds: requirements.filter(row => row.state !== 'DEFERRED').map(row => row.id),
    }],
  };
  writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n');
  const counts = {};
  for (const row of requirements) counts[row.state] = (counts[row.state] ?? 0) + 1;
  console.log(JSON.stringify({ kind, requirements: requirements.length, conflictsResolved: conflicts, matrixVersion: merged.matrixVersion, counts }));
} else {
  const byId = new Map();
  for (const entry of ours) byId.set(entry.id, entry);
  for (const entry of theirs) {
    const existing = byId.get(entry.id);
    if (existing === undefined) { byId.set(entry.id, entry); continue; }
    if (JSON.stringify(existing) !== JSON.stringify(entry)) {
      byId.set(entry.id, { ...entry, ...existing, id: entry.id });
    }
  }
  const merged = [...byId.values()];
  writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n');
  console.log(JSON.stringify({ kind, entries: merged.length }));
}
