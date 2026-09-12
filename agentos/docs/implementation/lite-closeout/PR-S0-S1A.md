## Requirements and scope

- S0: freeze permanent acceptance IDs and classify the 00–13 Lite specification
  plus the approved final-plan obligations; preserve compatibility/deferred scope.
- `LITE-07-003`, `LITE-07-107`: S1-A terminal candidate deduplication only.
  Existing IDs remain GAP after this slice; explicit-save and review-promotion
  paths still need their own bounded repairs. This PR does not close Lite.

## Demonstrated gap and repair

Exact terminal-content matches could converge onto another Task/category/Scope
or an inactive Entry. A valid hit also discarded new Run provenance. Restrict
matching; merge actual sources with one version + existing dedup Event + Outbox
transaction, with no Event on same-source replay. A match archived between
lookup and write falls through to candidate generation.

No migrations, new event types, authorization changes, or terminal eligibility
changes. Original uncommitted Artifact drafts remain untouched in the user's
original checkout. The next Workspace candidate contract is design-only.

## Exit evidence

- Baseline main: `b3c3a982`; CI run `34674427378` success.
- Red-before-fix: 7 pass / 6 deterministic failures, recorded in `S1A-RED`.
- Generator/emitter/Entry/Candidate targeted regression: 85 pass / 0 fail / 0 skip.
- Server `pnpm exec tsc --noEmit`: passed.
- Scope validator: 8 pass; closure gate deliberately rejects 219 open rows.
- Source/Event/Outbox rollback; cross-Run causal rejection; replay and archive
  race covered with real SQLite collaborators.

Full local Server run (pre archive-race remediation): 2705 pass / 4 fail /
3 skip (2712 total). All four failures are `ENOTEMPTY` at temporary-directory
teardown in unchanged worktree route, Conversation compatibility and legacy
import tests; the first failure evidence is preserved in S1-terminal-dedup.md.
Do not count this local suite as PASS. Workspace build passed; the final
archive-race remediation passed the 85-test targeted set and fresh typecheck.

This PR's exact-head CI must pass before merge. No CI rerun or admin bypass
is requested. First CI run: `34683702991` at `8e4cc3ae`.

## Scope gate meaning

The ordinary CI scope gate checks integrity, not product completion. Only
`--require-closed` can validate closure, and it requires zero open acceptance
rows plus final-main SHA and successful CI evidence. Manual runtime evidence
still requires human/agent review; a green script is not proof of live Provider
or UI behavior.
