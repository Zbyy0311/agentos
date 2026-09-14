# S6 / LITE-09-110 authorization and evidence: the provider-native compaction boundary

Requirement: LITE-09-110 (09-Conversation-Runtime.md, user clarification; 01 section 7).
Exit: only the AgentOS-persisted summary/source/policy/budget/snapshot may be used; a
provider-native event must not publish a canonical summary or candidate.

## Baseline, counterevidence and the gate

Audited baseline: main `07c1773ad108c066262753492ba2767bb3fc62d8` (matrix v15, PASS frozen).
Counterevidence `S6-NATIVE-COMPACTION-BOUNDARY` (evidence.json) records the source audit.
`node scripts/verify-lite-scope.mjs --implement LITE-09-110` exits 0; the plain scope
verifier exits 0 with v15 frozen. Raw receipts in `evidence/s6-110-native-boundary-20260914/`.

Process deviation, disclosed: the audit preceded the code, but the evidence record and the
`--implement` gate ran after the draft existed, so implementation was not gated before
editing. The same deviation is recorded for the companion 13-101 slice.

## The actual defect

`ProviderCompactionSummarizer.readSummary` adopted the CLI log verbatim:

```
const summary = stdout || stderr;   // stdout/stderr as the canonical summary
```

Codex, Kimi and OpenCode all compact their own context, and a CLI that says so puts that
announcement on stdout. Under the old code that announcement was persisted as an AgentOS
summary, given a `lite-v1` policy id and a source range it might not describe, and turned
into a review Candidate plus a `memory.candidate_created` Workspace Event. The same text can
also reach an assistant Message, because the conversation runner falls back to
`streamedContent || log.stdout || log.stderr` when nothing was streamed.

No adapter currently emits a compaction event type, so nothing in the type system marked the
boundary; it was structural and therefore unenforced.

## The boundary now

Two layers, because each one alone leaves a hole:

| Layer | Behaviour |
|---|---|
| summary text | `stripNativeCompactionNotices` removes line-anchored provider compaction notices; if nothing usable remains the run fails with `COMPACTION_SUMMARY_INVALID` and reports how many notices were discarded |
| runtime events | a `diagnostic`/`status` event that reports native compaction aborts the run and is rejected as `provider.native_compaction`, exactly like an unsanctioned tool call |

The second layer exists because a provider that compacted mid-run may be summarizing a
narrower range than the frozen source we handed it: that summary would be canonical-looking
but untrue of our source range, so the run must fail closed rather than be trusted.

Patterns are conservative and line-anchored, so ordinary prose that merely discusses
compaction is not swallowed (asserted).

## Evidence

| Test | Proves |
|---|---|
| `ProviderCompactionSummarizer.test.ts` - strips notices | the surviving summary is the real content and contains no notice text |
| same - fails closed | a native-only log yields `COMPACTION_SUMMARY_INVALID` reporting 2 notices |
| same - prose | a sentence about compaction as a design topic passes through untouched |
| same - runtime event | a `diagnostic` announcing compaction rejects the run as `provider.native_compaction` |
| `ConversationCompactionService.test.ts` | end to end with the real summarizer: a native-only CLI produces no published task, no `summary`, no `candidateId`, zero `memory_candidate_entries` and zero `workspace_events` |

Local on this revision: 12/12 summarizer tests, 8/8 compaction-service tests, server
`tsc --noEmit` exit 0, scope verifier and `--implement` both exit 0.

## Still open

If a Provider CLI later adds a first-class native-compaction event type, it must be
registered against this same boundary rather than assumed covered. PASS promotion stays
frozen, so LITE-09-110 remains GAP with this evidence recorded.

