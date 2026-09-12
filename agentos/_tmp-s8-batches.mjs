import { readFileSync } from 'node:fs';
const m = JSON.parse(readFileSync('docs/implementation/lite-closeout/matrix.json', 'utf8'));
const isTest = t => /\.test\.(ts|tsx|ps1|mjs)$/.test(t) && !t.includes('progress');
const rv = m.requirements.filter(r => r.state === 'RUNTIME-VERIFY');
const batches = new Map();
for (const row of rv) {
  const tests = (row.tests ?? []).filter(isTest);
  if (tests.length === 0) { console.log('NO-TEST-FILE ' + row.id + ' ' + row.document); continue; }
  const key = [...tests].sort().join('|');
  const batch = batches.get(key) ?? { tests: [...tests].sort(), ids: [] };
  batch.ids.push(row.id);
  batches.set(key, batch);
}
console.log('distinct batches=' + batches.size + ' covering=' + [...batches.values()].reduce((n, b) => n + b.ids.length, 0));
const bySize = [...batches.entries()].sort((a, b) => b[1].tests.length - a[1].tests.length);
for (const [, batch] of bySize.slice(0, 12)) {
  console.log('files=' + batch.tests.length + ' rows=' + batch.ids.length + '  first=' + batch.tests[0] + (batch.tests.length > 1 ? ' (+' + (batch.tests.length - 1) + ')' : ''));
}
// Cross-check: every referenced test file must exist.
import { existsSync } from 'node:fs';
const missing = new Set();
for (const [, batch] of batches) for (const file of batch.tests) if (!existsSync(file)) missing.add(file);
console.log('missing files=' + missing.size);
for (const file of [...missing].slice(0, 10)) console.log('  MISSING ' + file);
const allFiles = new Set();
for (const [, batch] of batches) for (const file of batch.tests) allFiles.add(file);
console.log('total distinct test files=' + allFiles.size);
