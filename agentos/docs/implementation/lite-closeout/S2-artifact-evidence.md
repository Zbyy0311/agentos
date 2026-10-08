# S2 Artifact implementation and evidence

Requirements: LITE-07-104 / LITE-07-108. Product commit:
`02a50947a82c692c61703f3d22f0b32c0b0a98ce`. The requirements remain GAP;
this is a bounded implementation slice, not full Lite or Provider acceptance.
Original checkout/drafts are untouched. Authorization precedes product changes:
e7ab1f68 (027/event contract), 62e8992a (explicit command-exit evidence).

## Implemented path

- Real Collector seam accepts a typed test completion only with an explicit,
  bounded command and integer exit code. Codex command_execution supplies this
  optional evidence; status fallback, Kimi tool success, truncated previews,
  package scripts and wrappers do not. The initial direct grammar is Node
  `--test` plus literal JS/CJS/MJS files; other observations stay reports.
- Canonical dispatcher uses the existing adapter's completed structured output
  contract. It never infers review approval from stage name or process exit.
  New finalization checks the current Run/Stage attempt again after file I/O;
  canonical sources remain separate from legacy Run identifiers.
- Artifact + immutable type-matched completion + review-required agent-derived
  Candidate + source + Event (and canonical Outbox) commit atomically. Exact
  replay converges; conflicting results fail. Workspace candidate-created is
  restricted to the source-specific Artifact completion origin and payload.
- Existing review queue opens Artifact content using encoded Workspace/source
  IDs. Accept uses the existing versioned review and preserves source in Entry.
- Migration 027 is additive. No merged 001-026 migration changed.

## Executed evidence

Windows / Node 24.18.0 / pnpm 11.11.0; local isolated worktree.

| Evidence | Result | Limit |
|---|---|---|
| 11 migration/registry/store acceptance files | 305 pass, 1 skip, 0 fail | AGENTOS_P3_SOURCE_ROOT real-copy rehearsal not configured |
| ArtifactCompletionService + Collector + 027 + shared Workspace types | 27 pass, 0 fail/skip | Actual Node subprocess + fixture observations, not live model |
| Artifact routes/service + Memory emitter + Workspace events + memory API | 66 pass, 0 fail/skip | Affected component/DB/HTTP regression |
| New Dispatcher LITE-07-104 tests | 2 pass, 0 fail/skip | Existing adapter/coordinator with fake process driver |
| Codex parser tests | 6 pass | Explicit exit proof including missing/redacted/overlong refusal |
| ReviewQueue component tests | 4 pass | URL encoding/body/SSR; no DOM |
| Server and Web typecheck; agent-core build | exit 0 | Focused server typecheck; agent-core full suite and full workspace build evidence below |

### Browser product flow

Playwright 1.55.0 / installed Chrome (Browser skill not available), isolated
API `http://127.0.0.1:3300`, web `http://127.0.0.1:3301/workspace/ws_s2_qa`,
desktop 1280x900 and mobile 440x900. Actual test subprocess -> explicit Codex
result parser -> Collector -> production server -> Workspace page -> review
queue -> source popup (actual TAP result) -> accept -> empty queue.

Final QA Candidate mcand_01M2AH8A41VHV9B40P29GC8ET7, Artifact
883afff0-8d54-46e6-87bf-a89c6ec12b71. Accepted candidates API returned 200 and
outcome=accept with the Artifact source. First QA DB inspection additionally
proved Entry and candidate_created/candidate_reviewed/entry_created events.
Page title AgentOS, no framework overlay or relevant console errors. Screenshots
and browser-result.json are local artifacts under
`C:/Users/Administrator/AppData/Local/Temp/agentos-lite-s2-qa-20260912/`.
QA servers were stopped after validation; no original project data was used.

This proves the real page/API/persistence/review loop with an actual test
subprocess, but the execution record and normalized provider observations were
seeded. It is explicitly NOT live Codex/Kimi/OpenCode production invocation.
Live invocation and canonical cancellation/restart windows remain to verify.

## First failures retained

- First complete Server suite on 97b5b885: 2687 pass / 53 fail / 3 skipped,
  exit 1. 49 failures came from the stale 016 replay helper; 4 separate
  ENOTEMPTY teardown failures remain preserved and are not ignored. Agent-core
  full suite: 159/159 pass. Full workspace build: exit 0.
- 016 diagnosis: `registryThrough015()` filtered only `id !== '016'`, so it
  accidentally applied 017-027 before replaying destructive 016. The 027 source
  trigger then followed SQLite's table rename and referenced the old table.
  `419b7a13` constrains the helper to the true 001-015 prefix. Focused 016
  replay after the correction: 56 pass / 0 fail / 0 skip. This was a test
  fixture correction; 027 product DDL is unchanged and no suite was rerun to
  seek green.
- Initial legacy Artifact test expected report after adding typed test; fixed
  the expectation only after verifying the explicit completion contract.
- Workspace allowlist test expected TYPE_NOT_ALLOWED; source-specific refusal
  now correctly returns ORIGIN_UNPROVEN. Shared forbidden-type case changed to
  a still-forbidden registered type, retaining the refusal assertion.
- Real subprocess test first failed (20 pass / 1 fail): inherited
  NODE_TEST_CONTEXT caused Node to skip its nested test. Child environment now
  removes that test-runner marker and asserts TAP test/pass/fail counts before
  treating execution as evidence. No product workaround.
- Tightened command test exposed `npm test` being accepted (29 pass / 1 fail).
  Product grammar now leaves package scripts as reports and requires explicit
  commandResult. This was a deterministic false-verdict defect, not a flake.
- Dispatcher test first read non-existent RunStage.artifactIds (1 pass / 1 fail;
  typecheck also caught it). Corrected to actual stage.completed Event payload.
- First browser report queried a non-existent Candidate GET-by-id (404); the
  UI accept succeeded and DB check proved Entry. Final QA uses the existing
  accepted-candidate list endpoint and asserts 200/persisted outcome.
- Temporary QA script launch errors (tsx resolution from workspace root,
  Windows ESM drive path) were corrected by package cwd and file URLs. They
  never count as runtime acceptance or product failures.

## Open gates

The complete Server suite must be re-evaluated at the corrected exact head;
retain first failures and skips. PR CI must be green before merge. Real model
invocation and the wider six-trigger source/event requirements remain open in
the matrix. No PASS, new deferral, goal closure, or name-based flake rerun is
implied.
