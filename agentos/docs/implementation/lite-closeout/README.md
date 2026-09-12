# Lite final closeout — S0 scope authority

Status: S0 SCOPE FROZEN (v1). Product acceptance remains OPEN.

Cross-document duplicates are intentional, not separate implementation tasks.
An acceptance row includes the detailed behavior in its source document, not
only the short acceptance bullet. Unproven behavior remains RUNTIME-VERIFY;
scope freeze does not assert that the product or the source audit is complete.
Before implementation, narrow the concrete counterexample and exit tests under
its existing ID in a slice record; a generic RUNTIME-VERIFY row cannot authorize
speculative implementation. Do not infer a completion percentage from counts.

Frozen inspection baseline: `b3c3a982d71f28ce236a9222b1a1041feeb36bf9` (main, PR #142).
Execution branch: `codex/lite-closeout`. The original checkout and uncommitted
Artifact draft remain untouched. Baseline migration ledger ends at `026`.

## Scope and change control

The user-approved tightened final plan governs execution. The matrix is the
only scope authority: only GAP and RUNTIME-VERIFY rows generate implementation
or verification work. PASS requires sufficient applicable evidence; DEFERRED
requires an explicit normative or user decision. Missing credentials, skipped
tests and unavailable infrastructure never imply PASS or DEFERRED.

IDs `LITE-XX-NNN` are permanent; never renumber or recycle them. Each document
retains its independent acceptance obligations, including cross-document
duplicates. A shared verification may satisfy several IDs, but each must link
to that evidence. Changes to classification require a versioned change record.
PASS can reopen only on concrete counterevidence. New requirements outside the
frozen scope require a separate user decision.

## Work packages

| Package | Boundary |
|---|---|
| S0 | Inventory all 00–13 clauses and explicit user decisions; freeze evidence matrix |
| S1 | Reuse MF-2/MF-5; fix demonstrated trigger inconsistencies, no Memory redesign |
| S2 | Real review/test work → final Artifact → completion → Candidate → Event → review → Entry |
| S3 | Runtime Authorization only: durable ASK_USER decision and original-Run continuation/rejection |
| S4 | Audit existing Codex/Kimi/OpenCode production chains, remediate gaps, obtain real invocation evidence |
| S5 | Execution-before-context/authority correctness for Conversation, preserving D1=B/D2=A/D3=off |
| S6 | Automatic bounded compaction, durable versioned policy, recovery and Inspector evidence |
| S7 | Explicit UTF-8 Markdown preview/confirm import; <=1 MiB; immutable source provenance |
| S8 | ID-linked product verification and defect remediation only |
| S9 | Final merged-main CI, evidence closure, report and goal completion |

## Fixed implementation decisions

- Existing correct terminal/save/approval paths are not rewritten for uniformity.
- New schemas/contracts require a design/authorization record before implementation;
  merged migration checksums remain unchanged. No destructive schema downgrade.
- No second Runtime, Provider framework, Event Store or Policy product.
- Compaction defaults are in `compaction-policy-lite-v1.json`; every execution
  freezes the effective policy and budget inputs. Native Provider compaction
  cannot prove canonical AgentOS compaction.
- Preserve original messages. Reuse existing canonical edits/revisions and
  visibility rules; no new Message editor or versioning subsystem.
- Compaction source changes invalidate use in new contexts, not past snapshots.
- Continue after failed compaction only within hard budget; never silently drop
  messages. Exceeding the budget blocks a new Provider call and permits retry.
- Import is user-selected Markdown only, no directory scan/network fetch, no
  source-file mutation, default Workspace scope and review-required Candidates.
- Real Artifact lifecycle evidence is mandatory; hand-posting completion alone
  proves only infrastructure.

## Evidence and operations

`evidence.json` records exact commands, base revisions, outcomes and limitations.
Matrix rows list production entrypoints and applicable test sources; their
existence alone does not prove completion. No global percentage is inferred from
row/PR counts. Real Provider and browser checks cannot be substituted with mocks.

`node scripts/verify-lite-scope.mjs` validates scope integrity; success means
only that the open matrix is consistent. Closure MUST use `--require-closed`,
which also requires final-main SHA/CI evidence. `--implement ID...` additionally
requires a mapped counterexample, not just a GAP label. The scope-lock hash is
anchored in the validator; modifying both requires explicit review, not a
self-declared authorization string. CI cannot independently prove human
authorization or the truth of manually recorded runtime evidence.

Baseline main CI: run `34674427378` succeeded at `b3c3a982`; this is not the
final closeout CI. The first broad delegate audits did not return recoverable
per-clause evidence and are NOT used to mark anything PASS. Subsequent delegate
work is bounded to named files/commands and must preserve evidence before returning.

Luna max is the user-authorized audit/CI delegate after DeepSeek Flash returned
402 insufficient balance. Delegates do not merge or rerun CI independently.
Unchanged CI state does not require repeated status messages. Preserve first-run
failures; classify Windows flakes from current evidence, never just their names.

Close the complete-Lite goal only after every required GAP/RUNTIME-VERIFY is
PASS, every DEFERRED has a valid basis, all fixes are merged and final main CI is
green. The older summary-only goal is not evidence of product completion.
