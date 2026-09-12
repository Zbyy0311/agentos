import { readFileSync, writeFileSync } from 'node:fs';
const path = 'docs/implementation/lite-closeout/evidence.json';
const entries = JSON.parse(readFileSync(path, 'utf8'));
if (!entries.some(e => e.id === 'S6-LOCAL')) {
  entries.push({
    id: 'S6-LOCAL',
    baseline: '69d12243c06b8bc9f20f04214ea81118d38cb2d0',
    kind: 'local-tests',
    command: 'node --import tsx --test --test-concurrency=1 src/services/ProviderCompactionSummarizer.test.ts src/services/ConversationCompactionTrigger.test.ts src/services/ConversationCompactionService.test.ts src/services/CompactionContextApplication.test.ts src/store/CompactionRepository.test.ts src/routes/conversationCompactionInspector.test.ts src/routes/conversationRuntime.compaction.test.ts src/migrations/__tests__/lite-migration-029.test.ts; pnpm exec tsc --noEmit',
    cwd: 'apps/server',
    environment: 'Windows Node24.18.0 pnpm11.11.0; S6 worktree on the S5 closeout branch',
    result: { passed: 31, failed: 0, skipped: 0, typecheckExitCode: 0 },
    requirementIds: ['LITE-07-105', 'LITE-09-104', 'LITE-09-105', 'LITE-09-106', 'LITE-09-107', 'LITE-09-108', 'LITE-09-109', 'LITE-09-110', 'LITE-13-101'],
    limitation: 'Deterministic local evidence: engine, repository/migration, summarizer fail-closed branches, context application, Inspector read surface and the real-HTTP Turn integration. No server restart, no over-budget real run, no real message edit.',
  });
}
writeFileSync(path, JSON.stringify(entries, null, 2).replace(/\r?\n/g, '\n'));
console.log('S6-LOCAL ensured; entries=' + entries.length);
