# S6 conversation compaction authorization (frozen v1)

Requirements: LITE-07-105, LITE-09-104, LITE-09-105, LITE-09-106, LITE-09-107,
LITE-09-108, LITE-09-109, LITE-09-110. Authority: user-approved tightened plan
plus `compaction-policy-lite-v1.json`. Base: S5 head `7aedc907` (stacked until
PR148 merges). Migration `029` is the next free number; 001–028 stay unchanged.

## Fixed boundaries

- Compaction is an AgentOS-owned task over ONE Conversation. It never edits or
  deletes original Messages, never invents a Run, and never treats Provider
  native compaction as canonical evidence (LITE-09-110).
- `lite-v1` defaults are implementation policy, not a normative Provider limit:
  triggerRatio 0.70, targetRatio 0.50, minRecentMessages 8, summaryMaxTokens
  2048, timeoutMs 120000, maxAutomaticRetries 1, fallback application budget
  16384 tokens with an explicit estimator version.
- Every compaction persists the immutable effective policy version, the actual
  parameters, the budget composition, the bound Provider configuration snapshot,
  the source range/hashes, attempts and status (LITE-09-104/105/107).
- Only a bounded old prefix is eligible: at least `minRecentMessages` most
  recent completed Messages and the current input always stay uncompressed. If
  the source is longer than one batch, older batches compact first; the new
  summary is published against the previous summary, so the effective context
  is `prior summary + uncompressed tail` (LITE-09-105).
- Summary execution uses the Provider configuration frozen at the triggering
  Turn; it may not silently switch model. Tool use and Workspace writes are
  forbidden for the summary call; when they cannot be excluded, the compaction
  fails instead of running (LITE-09-106).
- A Conversation has exactly one compaction task holder at a time: durable
  status + lease + commit check. Restart classifies the previous execution
  before resuming; an expired lease may never publish; automatic retries stop
  at `maxAutomaticRetries` (LITE-09-107).
- Publish is atomic: summary record, durable completion fact, review-required
  Memory Candidate, and the canonical Workspace Event commit in one
  transaction. The Candidate is the established "Conversation compaction"
  source trigger; it is never auto-accepted (LITE-07-105).
- Failure semantics: while `prior summary + uncompressed tail` still fits the
  hard budget, the Turn proceeds and the compaction enters bounded
  `retry pending`; otherwise no new Provider call is made, the input is
  preserved, and an explicit retry is offered. Messages are never silently
  truncated (LITE-09-108).
- Source validity reuses existing Message revisions and visibility: a changed
  or now-invisible source Message makes the old summary ineligible for new
  contexts; historical published summaries and snapshots are not rewritten
  (LITE-09-109).

## Migration 029 contract (draft for review)

`conversation_compaction_policies`: immutable policy versions (`policy_version`,
parameters JSON, checksum, created_at). `conversation_compactions`: durable task
and summary rows (`id`, `workspace_id`, `conversation_id`, `status`,
`policy_id`, source range ids/count/hash, `prior_summary_id`, bounded `summary`,
`summary_hash`, `summary_token_estimate`, `budget_json`, provider snapshot
fields, `estimator_version`, `attempts`, lease fields, `candidate_id`,
`failure_code/message`, timestamps, `version`). Both tables are append-mostly:
policy rows and published summaries are immutable; only task status/lease/
attempt/candidate fields mutate under a version CAS.

The Workspace Event allowlist gains one source-specific origin
(`memory.compaction`) proven against the persisted compaction row + published
status + Candidate, exactly like the S2 Artifact origin. No Run is fabricated.

This authorization is not implementation evidence; every row keeps its GAP
state until its exit is demonstrated.

