/**
 * LITE-09-106 / LITE-09-107 real evidence: run one Conversation compaction
 * through the production summarizer against the real Codex CLI.
 *
 * What this proves that unit tests cannot:
 *   - the summary text is produced by a real Provider process,
 *   - the process runs under the allowlisted CLI-level read-only sandbox,
 *   - no tool or approval event is emitted (the summarizer fails closed if one is),
 *   - the published summary, the review-required Candidate and the canonical
 *     Workspace Event are committed atomically,
 *   - a repeat over the same source converges without a second Provider call.
 *
 * Usage (from the repository root, with the server workspace resolvable):
 *   node --import tsx scripts/verify-compaction-real-summary.mjs
 * Optional env: AGENTOS_COMPACTION_MODEL (default gpt-5.6-luna),
 *                AGENTOS_COMPACTION_SCRATCH (default the OS temp dir)
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../apps/server/src/store/SqliteStore.ts';
import {
  ConversationCompactionService,
} from '../apps/server/src/services/ConversationCompactionService.ts';
import { ProviderCompactionSummarizer } from '../apps/server/src/services/ProviderCompactionSummarizer.ts';
import { SUMMARIZATION_CLI_PROFILES, summarizationIdentityFor } from '../apps/server/src/services/summarizationCliProfiles.ts';
import { CompactionRepository } from '../apps/server/src/store/CompactionRepository.ts';
import { MemoryCandidateRepository } from '../apps/server/src/store/MemoryCandidateRepository.ts';

const WS = 'ws_s6_real';
const CONV = 'conv_' + 'r'.repeat(26);
const NOW = new Date().toISOString();
const MODEL = process.env.AGENTOS_COMPACTION_MODEL ?? 'gpt-5.6-luna';
const SCRATCH = process.env.AGENTOS_COMPACTION_SCRATCH ?? join(tmpdir(), 'agentos-compaction-scratch');

const root = mkdtempSync(join(tmpdir(), 'agentos-s6-real-'));
const store = new SqliteStore(root);
const db = store.getDatabase();
db.prepare('INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run(WS, WS, root, root, NOW, NOW, NOW);
db.prepare(`INSERT INTO cr_conversations (id, workspace_id, kind, status, title, created_at, updated_at, version)
  VALUES (?, ?, 'direct', 'active', 'real compaction', ?, ?, 1)`).run(CONV, WS, NOW, NOW);

const agent = {
  id: 'agent_codex', name: 'Codex', role: 'codex', enabled: true,
  cliCommand: 'codex', cliArgs: [], model: MODEL, thinkingEffort: 'low',
  provider: 'codex',
  systemPrompt: 'runtime manager', workspaceId: WS,
};
const provider = summarizationIdentityFor(agent);
assert.ok(provider, 'the trigger must derive a frozen compaction identity for the Codex CLI');
assert.equal(provider.providerType, 'codex');
assert.equal(provider.adapterId, 'cli.codex');
assert.equal(provider.model, MODEL);
assert.ok(SUMMARIZATION_CLI_PROFILES.codex.cliArgs.includes('read-only'), 'the allowlist must declare the read-only sandbox');
assert.ok(SUMMARIZATION_CLI_PROFILES.codex.cliArgs.includes('--skip-git-repo-check'), 'the summary runs outside a trusted repository');

// 12 messages x 3000 chars = 9000 estimated tokens, above the 6966 trigger
// (0.70 x (12000 - 2048)), so exactly the old prefix is eligible.
const messages = Array.from({ length: 12 }, (_value, index) => ({
  id: 'msg_' + String(index).padStart(3, '0'),
  senderType: index % 2 === 0 ? 'user' : 'agent',
  content: `message ${index}: ` + 'The runtime keeps Tasks, Runs and Processes distinct. '.repeat(60),
  status: 'final',
  createdAt: NOW,
}));
const budget = { providerContextTokens: 12000, systemPromptTokens: 0, memoryContextTokens: 0, outputReserveTokens: 2048 };

const engine = new ConversationCompactionService({
  store,
  summarizer: new ProviderCompactionSummarizer({ scratchRoot: SCRATCH, profiles: SUMMARIZATION_CLI_PROFILES }),
});
const compactions = new CompactionRepository(db);
const candidates = new MemoryCandidateRepository(db);

const startedAt = Date.now();
const first = await engine.compact({
  workspaceId: WS, conversationId: CONV, policyVersion: 'lite-v1',
  messages, budget, provider, priorSummary: null,
});
const elapsedMs = Date.now() - startedAt;
if (first.outcome !== 'published') {
  console.error('REAL_COMPACTION_SUMMARY: failed');
  console.error(`  outcome=${first.outcome} failureCode=${first.task?.failureCode ?? 'none'}`);
  console.error(`  failureMessage=${first.task?.failureMessage ?? 'none'}`);
  store.close();
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}
const task = first.task;
assert.ok(task, 'a published compaction must return its durable task');
assert.equal(task.status, 'published');
assert.equal(task.adapterId, 'cli.codex');
assert.equal(task.model, MODEL);
assert.ok(typeof task.summary === 'string' && task.summary.trim().length > 0, 'the Provider must return a non-empty summary');
assert.ok(SUMMARIZATION_CLI_PROFILES.codex.promptTemplate !== undefined);
const policy = engine.policy('lite-v1');
assert.ok(policy, 'the lite-v1 policy row must exist');
assert.ok(task.summary.length <= policy.summaryMaxTokens * 4, 'the summary must stay inside the recorded budget');

const candidate = candidates.findCandidateById(WS, task.candidateId);
assert.ok(candidate, 'publishing must record the review Candidate on the durable task');
assert.equal(candidate.decision, 'review-required');
assert.equal(candidate.outcome, 'review-required');
assert.equal(candidate.authority, 'agent-derived');
// The canonical Event type stays `memory.candidate_created`; the compaction is
// its registered cause, carried by the derived correlation/causation ids.
const event = db.prepare("SELECT type, source, correlation_id, causation_id, payload_json FROM workspace_events WHERE workspace_id = ? AND type = 'memory.candidate_created'").get(WS);
assert.ok(event, 'publishing must record the canonical Workspace Event');
assert.equal(event.correlation_id, 'memory-compaction:' + task.id);
assert.equal(event.causation_id, task.id);
assert.equal(JSON.parse(event.payload_json).candidateId, candidate.id);

// Repeat over the same source: converge on the published row, no new Provider call.
const repeatStartedAt = Date.now();
const second = await engine.compact({
  workspaceId: WS, conversationId: CONV, policyVersion: 'lite-v1',
  messages, budget, provider, priorSummary: null,
});
const repeatElapsedMs = Date.now() - repeatStartedAt;
assert.equal(second.outcome, 'published');
assert.equal(second.task?.id, task.id, 'a repeat over the same source must converge on the published row');
assert.ok(repeatElapsedMs < elapsedMs, 'convergence must not repeat the Provider call');
const totalTasks = compactions.listForConversation(WS, CONV).length;
assert.equal(totalTasks, 1, `exactly one compaction task must exist, found ${totalTasks}`);

console.log('REAL_COMPACTION_SUMMARY: passed');
console.log(`  model=${MODEL} adapter=cli.codex@1.0.0 firstRunMs=${elapsedMs} repeatMs=${repeatElapsedMs}`);
console.log(`  summaryChars=${task.summary.length} sourceMessages=${task.sourceMessageCount} policy=${policy.policyVersion}`);
console.log(`  summaryHead=${JSON.stringify(task.summary.slice(0, 160))}`);

store.close();
rmSync(root, { recursive: true, force: true });
