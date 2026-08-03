# M3 P2 Post-Merge Closeout

## 1. Final disposition

```text
Milestone: M3 P2 — Transactional Run and Stage Lifecycle Core
Final status: MERGED TO MAIN
Local Formal Gate: PASS
Independent Review: PASS
Final Merge Verification: PASS
Remote Checks: UNAVAILABLE — NOT PASS
P3: NOT AUTHORIZED BY THIS CLOSEOUT
Production Cutover: NOT AUTHORIZED / NOT STARTED
```

Remote Checks were unavailable at closeout time. This is not a CI PASS claim.

## 2. Merge identity

| Field | Value |
| --- | --- |
| Repository | `Zbyy0311/agentos` |
| PR number | `#19` |
| PR title | `M3 P2 Transactional Run and Stage Lifecycle Core` |
| Previous main SHA | `417f5f9c329d32cf75d0ea5a7d797fdb355d3593` |
| Source branch | `runtime/m3-p2-transactional-lifecycle-core` |
| Source Head SHA | `14b722614c947c920915dccc5807e7469e604096` |
| Merge Commit SHA | `7a6c41710af5d4c58ef9acd6a9484b9deb341c6b` |
| Parent 1 SHA | `417f5f9c329d32cf75d0ea5a7d797fdb355d3593` |
| Parent 2 SHA | `14b722614c947c920915dccc5807e7469e604096` |
| mergedAt UTC | `2026-08-03T16:33:05Z` |
| mergedAt Beijing | `2026-08-04 00:33:05 +08:00` |
| Commits | `27` |
| Changed files | `57` |
| Merge method | ordinary two-parent merge commit |
| main / origin/main final SHA | `7a6c41710af5d4c58ef9acd6a9484b9deb341c6b` |
| Source branch final SHA | `14b722614c947c920915dccc5807e7469e604096` |

## 3. Delivered scope

The following M3 P2 scope is present on `main`:

- P2A Migration 012 Schema Foundation
- P2B Runtime Event、Sequence、Outbox、Dead Letter Persistence
- P2C-0 Lifecycle Event Specification
- P2C-1 Shared Lifecycle Event Contract
- P2C-2A Single-aggregate Lifecycle Transactions
- P2C-2B Composite Lifecycle Transactions
- P2C-2C Run Graph Creation Event Transaction
- Migration 013 Workflow Creation Metadata
- Run Graph Event Service fail-closed remediation
- V2 Run Cancel state-only bypass remediation
- Cancellation rollback evidence remediation

## 4. Transaction guarantees delivered

- Current State、Runtime Event 与 Outbox 同事务提交；
- sequence 使用 `RunSequenceAllocator`；
- 每个 durable Event 对应一个 Outbox；
- Run graph Event 顺序：`run.created → stage.created × N`；
- Cancellation Event 顺序：`stage.cancelled × N → run.cancelled`；
- keyed V2 cancellation 的 Lifecycle、Task reconciliation 与 Idempotency Success 同属一个外层事务；
- missing lifecycle/event service fail closed；
- rollback evidence 覆盖 Event append、第二个 Stage transition 和 Task reconciliation failure。

## 5. Verification evidence

```text
Shared lifecycle: 25/25
P2C-2A: 30/30
P2C-2B: 15/15
P2C-2C: 13/13
V2 Runs: 19/19
TaskRunService: 62/62
V2 Idempotency: 16/16
Migration 012/013: 19/19
Full Migration: 203 passed / 1 skipped
Full Server: 1,154 passed / 2 skipped
Agent-core: 123/123
Web tests: 86/86
Production Build: PASS
Server TypeScript: PASS
Web tsc --noEmit: BASELINE REPRODUCED — NOT PASS, 7 existing errors
git diff --check: PASS
Sensitive material / absolute path scan: PASS
```

These are the frozen pre-merge local verification results. This docs-only closeout did not rerun the full test suites.

## 6. Migration identity

```text
007 = 2bf9edb75204d05e
012 = 7b87c3538e4b9e83, destructive=true
013 = 1929824c419baa20, destructive=false
```

- The Registry is exactly 001–013.
- Migration 014 does not exist.
- No real database Migration, Copy, Restore, or Production Cutover was executed.

## 7. Review and remediation history

- After the initial P2 closeout, independent review found a V2 queued cancellation state-only bypass.
- Production remediation: `fb9a1e8f65f47abbea04a652b90ba1be1cee1f42`
- Final verification correction: `f83b1b6871dd2e84d59733da6c776064b727ebfc`
- Rollback evidence: `c61a794d683fd8d9c8b6c7bddbe2ed4e13ed71de`
- Remediation SHA record: `14b722614c947c920915dccc5807e7469e604096`

All remediation used forward-only commits; history was not rewritten.

## 8. Explicit exclusions and remaining authorization

The following were not delivered by M3 P2:

- P3 Run Engine；
- Operation API；
- canonical Start/Retry API；
- SSE / Replay；
- Provider / ProcessManager integration；
- Web default cutover；
- Production Migration / Restore / Cutover；
- Legacy Retirement。

M3 P2 is complete on main.

This closeout does not itself authorize P3 implementation or Production
Cutover. Those require a separate owner authorization and frozen baseline.
