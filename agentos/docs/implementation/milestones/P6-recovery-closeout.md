# P6 Windows Recovery — Closeout

Status: P6 WINDOWS RECOVERY CORRECTNESS COMPLETE — P6-M2a/M2b/M3a/M3b MERGED — P6-L1 (A–E) MERGED — RECOVERY EXIT GATE SATISFIED — NO REATTACH/ADOPTION/RESPAWN AUTHORIZED — MEMORY FOUNDATION NOT STARTED

## 1. Closure Verdict

```text
P6 WINDOWS RECOVERY CORRECTNESS:
COMPLETE

P6 RECOVERY CLOSEOUT:
COMPLETE UPON THIS RECORD MERGE

RECOVERY EXIT GATE:
SATISFIED (evidence below)

NEXT FAST-TRACK STEP:
Memory Foundation (not started)
```

This record does not claim production cutover, provider reattachment, session
adoption, ownership transfer, or any recovery behavior beyond fail-closed
classification.

## 2. Baseline

```text
Closeout base:      origin-https/main @ 165b9cd3
                    (Merge PR #76, runtime/p6-l1e-startup-admission-reconciliation)
Preceding merge:    9af24569 (PR #75, L1D admission authority)
Ledger:             migrations 001–016 present
                    migration 017 absent
Recovery scope:     Windows only
```

The closeout base tree is byte-identical to the verified L1E branch tree
(`573713b3305e6d3e001b5f1f1dcea2ef33090847`), verified with
`git rev-parse <ref>^{tree}` before this record.

## 3. Scope Delivered

P6 recovery correctness was delivered as four merged slices plus the P6-L1
Workspace single-writer chain that depends on the same fail-closed discipline.

| Slice | PR | Merge | Contribution |
|---|---|---|---|
| P6-M1 production dispatch activation | #63 | `792242b3` | One accepted canonical Run drives exactly one provider chain; `RunEngineProviderDispatcher` claim fence; replay never re-spawns. |
| P6-M2a process recovery evidence classifier | (in #64 lineage) | `c8696418` | Durable process evidence classifier (`MISSING`/`MISMATCH`/`UNKNOWN`/`SAME` vocabulary), fail-closed. |
| P6-M2b process-aware restart recovery | #64 | `0daa77f5` | Production fail-closed Windows recovery probe; only `MISSING` positively provable, otherwise `UNKNOWN`; async classification before any SQLite write transaction. |
| P6-M3a recovery identity contract | #65 | `5e4a574b` | Frozen contract: Windows-only scope; lossless Windows creation FILETIME required; `SAME` production-unreachable under kill-on-close; v1/v2 evidence compatibility with no backfill; classification-only. |
| P6-M3b Windows native birth identity | #66 | `6fc8f21e` | Canonical `win32:filetime:<unsigned-decimal>` validator; helper capture of the full 64-bit creation FILETIME; read-only `probe-identity`; dual-version v1/v2 classifier; additive migration 015. |
| P6-L1A admission contracts | #68 | `224d33ac` | Frozen Workspace Admission subject/mutation/evidence contracts. |
| P6-L1B admission persistence | #69 | `2b2f1937` | Additive migration 016: `workspace_admissions`, `workspace_git_observations`. |
| P6-L1C-M1–M4 Git observation | #70–#74 | `a65e0afe`…`5d1ab3da` | Read-only Git observation contracts, collector, durable persistence, on-demand service. |
| P6-L1D admission authority | #75 | `9af24569` | Single durable Workspace admission authority; one MODIFYING writer per Workspace; READ_ONLY capacity 2. |
| P6-L1E startup admission reconciliation | #76 | `165b9cd3` | Reconstructs pre-016 active-state admissions fail-closed on startup, after recovery and before listen. |

## 4. Recovery Exit Gate

The P6 recovery exit gate is satisfied when, on the exact closeout base,
independent evidence proves all of the following.

### 4.1 Classification correctness

- `MISSING` is produced only from positive OS absence evidence (exact `ESRCH`).
- `MISMATCH` requires PID presence plus a positive lossless birth-identity
  difference; PID reuse is never classified `SAME`.
- `UNKNOWN` is the fail-closed default for absent, ambiguous, inaccessible, or
  inconsistent evidence.
- `SAME` is identity evidence only and grants no continuation authority.
- PID alone never proves identity.

### 4.2 Evidence-version compatibility

- Legacy `schemaVersion=1` rows keep `MISSING`/`UNKNOWN` behavior (no backfill,
  no fabricated v2 evidence).
- v2 rows reach `SAME`/`MISMATCH`/`UNKNOWN` from a lossless creation FILETIME.
- Column-vs-mirror disagreement fails closed to `UNKNOWN`.

### 4.3 Control safety

- Only `MISSING` reconciles a running Run to canonical terminal failure.
- Classification activates no reattach, adoption, ownership transfer, takeover,
  resume, respawn, or kill.
- `ProcessCancelCoordinator` remains the sole cleanup authority.
- Recovery never constructs a second execution authority for an interrupted Run.

### 4.4 Atomicity and ordering

- OS process inspection occurs before the SQLite write transaction; the
  transaction consumes a precomputed classification.
- Startup admission reconciliation runs strictly after existing recovery and
  before services/routes/listen, and rolls back as one sweep on conflict.

## 5. Acceptance Evidence

### 5.1 Real Windows platform gates (P6-M3b)

`packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` — 10/10 PASS,
including the real-process gates:

| Gate | Result |
|---|---|
| W1 — kill-on-close ownership loss reaps the owned provider; recovery sees `MISSING` | PASS |
| W2 — spawn capture and live probe carry the same canonical FILETIME; classifier `SAME` (primitive-only) | PASS |
| W2 oracle — production helper FILETIME equals an independent `.NET StartTime.ToFileTimeUtc` oracle; real value exceeds 2^53 (BigInt test-only) | PASS |
| W2 primitive — a live self PID reads a stable, repeatable canonical FILETIME | PASS |
| W3 — invalid PID / probe failure / unreadable identity fails closed to `UNKNOWN` (never `MISSING`) | PASS |
| W4 — persisted FILETIME A vs observed B (B ≠ A) → `MISMATCH`, classification-only | PASS |
| W4 — PID reuse is never classified `SAME` | PASS |

### 5.2 Classifier and verifier gates

`packages/process-runtime/src/recovery-classifier.test.ts` (39),
`platform-recovery-verifier.test.ts` (13), and `native-birth-identity.test.ts` (6)
— 58/58 PASS. Covered directly: V1-A/B/C, V2-A/B/C/D, column-vs-mirror
consistency, `>2^53` FILETIME precision, wall-clock non-participation, and
"never returns a recoverable result for `unknown`".

### 5.3 Server recovery integration

`apps/server/src/runRecovery.test.ts`, `taskRecovery.test.ts`, and
`services/TaskRunRecoveryService.test.ts` — 97/97 PASS, including
"restart recovery source never constructs AgentRunner or invokes Provider
execution" and canonical recovery requiring one persisted Outbox per Event.

### 5.4 Full package and workspace

| Suite | Result |
|---|---|
| `@agentos/process-runtime` full (`vitest run`) | 240/240 PASS (19 files) |
| P6-L1E reconciler unit + startup integration | 21/21 + 4/4 PASS |
| P6-L1D admission authority | 43/43 PASS |
| P6-L1A/L1B regressions | 35/35 PASS |
| Server `tsc --noEmit` | PASS |
| Server full first run | 2301 total, 2296 passed, 2 failed, 3 skipped |

The 2 server failures are pre-existing Windows `tar` environment issues in
`WorktreeArtifactService` (`tar: Cannot connect to C: resolve failed` under Git
Bash), unrelated to recovery — recovery slices touch no `WorktreeArtifactService`
code. The first run is preserved; no rerun-to-green was used.

### 5.5 CI

- PR #76 (`server` job): SUCCESS, 29m42s.
- Post-merge `main` CI for `165b9cd3`: see run `34266632303`.
- Prior P6 recovery merges (#63–#75) each carry a successful `main` CI run.

## 6. Safety Invariants Preserved

Verified in source on the closeout base:

- No `reattach`, `adopt`, `ownership transfer`, `respawn`, or `takeover` code
  exists in `packages/process-runtime/src` (only unrelated `ProcessOutputReadOptions`
  matches).
- `TaskRunRecoveryService` reconciles only `classification === 'missing'`
  (`processMissingFailed`); every other classification preserves uncertainty.
- Migration 016 admits no `ADOPTED`/`RESUMED`/`REATTACHED`/`TRANSFERRED`
  admission states.
- Secrets remain references; no secret values enter evidence, events, or snapshots.

## 7. Explicit Non-Goals (Unchanged)

The following remain **DEFERRED FULL-SCOPE** and are not authorized by this
closeout:

- provider process reattachment, session adoption, ownership transfer, or
  arbitrary process takeover;
- surviving-process continuation, orphan takeover, or automatic respawn;
- non-Windows recovery identity expansion;
- a second execution authority for an interrupted Run;
- any change to kill-on-close ownership or Job lifetime;
- P6-M3c adoption/resume states.

When continuation cannot be proven safe, the user may create a new retry Run.

## 8. Boundary and Next Step

The Lite Fast Track sequence is:

```text
CURRENT P6 / Windows recovery correctness      -> COMPLETE (this record)
Minimal Git Observation + single-writer rule   -> COMPLETE (PR #70–#76)
Recovery closeout                              -> THIS RECORD
Memory Foundation                              -> not started
Conversation Runtime                           -> not started
```

Memory Foundation is the next active step. It is not started by this record.

## 9. Evidence Index

| Claim | Evidence |
|---|---|
| Real Windows W1/W2/W3/W4 gates | `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` — 10/10 |
| v1/v2 classifier compatibility | `packages/process-runtime/src/recovery-classifier.test.ts` — 39/39 |
| Fail-closed verifier | `packages/process-runtime/src/platform-recovery-verifier.test.ts` — 13/13 |
| Lossless FILETIME primitive | `packages/process-runtime/src/native-birth-identity.test.ts` — 6/6 |
| Only `MISSING` reconciles | `apps/server/src/services/TaskRunRecoveryService.ts:283` |
| No reattach/adoption source | `packages/process-runtime/src` (grep) |
| Startup reconciliation ordering | `apps/server/src/index.ts:194-207` |
| Migration ledger 001–016, 017 absent | `apps/server/src/migrations/migrations/` |
| Merge SHAs | PR #63–#76 (table in §3) |
