# S8 final runtime verification: the last eight RUNTIME-VERIFY rows

Requirements: LITE-00-002, LITE-00-003, LITE-00-006, LITE-00-009, LITE-08-003,
LITE-08-004, LITE-12-016, LITE-13-002.

## Why these eight were still open

The S8 acceptance pass re-pointed 17 rows at the file that actually asserts their
clause and promoted them on executed counts. Eight stayed RUNTIME-VERIFY because
their named evidence could not carry the clause:

- four rows (`LITE-00-002`, `LITE-00-003`, `LITE-00-006`, `LITE-00-009`) still
  named `docs/implementation/milestones/Lite-FastTrack-progress.md`, a document,
  as their "test";
- four rows (`LITE-08-003`, `LITE-08-004`, `LITE-12-016`, `LITE-13-002`) named a
  file that executed and passed but asserted a different subject.

A document, and a passing-but-unrelated file, are both zero evidence for the
clause, so the rows stayed open rather than being promoted on proximity.

## What closes each row

| Row | Clause | Files that assert it |
|---|---|---|
| LITE-00-002 | Conversation and Message survive reconnect and restart | `SqliteStore.test.ts` (createConversation/createMessage, `store.close()`, `new SqliteStore(root)`, read back) and `canonicalRunStream.test.ts` P5C-R06 (a browser disconnect ends the subscription only) |
| LITE-00-003 | Task, Run, Process and Event stay distinct and traceable | `m3-p6-integrated-verification.test.ts` P6D-A1 (one Task -> one Run -> one Snapshot -> four Stages -> one Start, Event graph by sequence), `m4-p2-migration-014.test.ts` (Provider Session and root Process uniquely bound per Stage attempt by DDL), `RuntimeInspector.test.ts` INSP-12 |
| LITE-00-006 | Windows cancellation handles the owned process tree | `packages/process-runtime/src/node-driver.test.ts` (real spawn, `verifySurvivors` -> `terminateTree` -> complete with `proof: owned-tree-enumeration`) |
| LITE-00-009 | concurrent read-only Runs cannot mutate because admission requires tested enforcement evidence | `packages/shared/p6-l1a-admission.test.ts` L1A-05..L1A-12 and `WorkspaceAdmissionAuthority.test.ts` |
| LITE-08-003 | DENY blocks Provider-native merge/push only behind a verified enforceable pre-action bridge | the same admission classifier: only a verified technical write denial can yield READ_ONLY, provider assertions and native-sandbox labels are downgraded to MODIFYING |
| LITE-08-004 | un-interceptable native actions are never reported as blocked, and unavailable enforcement is visible | the same classifier plus `runtimeInspector.test.ts`, which exposes `readOnlyEnforcement` in `{proven, unavailable, not-applicable, unknown}` (`unknown` for a Run with no admission row, a different statement from `unavailable`) |
| LITE-12-016 | no Worktree manager, full Policy editor or Provider Comparison UI | `apps/web/src/liteScopeBoundary.test.ts`, which asserts over the real module set and the workspace shells |
| LITE-13-002 | Run, Stage, Provider, Process and duration stay distinct | `RuntimeInspector.test.ts` INSP-12 and `runtimeInspector.test.ts` |

`LITE-13-002` and `LITE-12-016` needed product work first, not just a re-point:
the Inspector had no Provider surface at all, and the deferred-product-surface
boundary had no executable assertion. Both landed in the S8 acceptance branch
(`ab87321a`), which is why their promotion is in this follow-up rather than in
the earlier batch.

## Executed evidence

All four commands were run at this head; every file passed with zero failures and
zero skips:

```
apps/server  node --import tsx --test src/store/SqliteStore.test.ts \
  src/routes/canonicalRunStream.test.ts src/services/RuntimeInspector.test.ts \
  src/routes/runtimeInspector.test.ts                                  68 pass / 0 fail

apps/server  node --import tsx --test src/services/m3-p6-integrated-verification.test.ts \
  src/migrations/__tests__/m4-p2-migration-014.test.ts \
  src/services/WorkspaceAdmissionAuthority.test.ts \
  ../../packages/shared/p6-l1a-admission.test.ts                     109 pass / 0 fail

packages/process-runtime  pnpm exec vitest run src/node-driver.test.ts  16 pass / 0 fail

apps/web  node --import tsx --test src/liteScopeBoundary.test.ts         3 pass / 0 fail
```

`apply-s8-final-rv.mjs <baseline>` applies the promotion to `matrix.json` and
`evidence.json` as `S8-FINAL-RV-BATCH`, so the edit is reproducible and reviewable
rather than hand-written.

## Boundary

This is local executed evidence, not a CI run; final-head CI stays the closure
gate. The two guarantees that describe user-visible behaviour are asserted through
the Inspector projection and the admission classifier, not through a live browser
session, and the evidence entry records that limitation explicitly.

The branch must be rebased onto a main that contains the S8 acceptance branch:
`apps/web/src/liteScopeBoundary.test.ts` is introduced there, so the row is only
truthful once that file exists on the target revision.
