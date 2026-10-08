# S5 first-run CI failure (preserved evidence)

PR #148, head `7aedc907`, run `34700551814`, job `server`, step `Server tests`.

```
not ok 345 - bounded group respond: the runtime selects speakers, streams the walk, and records replies
  location: apps/server/src/routes/conversationRuntime.group.test.ts:162
  Expected values to be strictly equal: 4 !== 2
```

Step results for that run: `Server tests` failed; every later step was skipped.
R35 (oversized JSON payload) passed in the same run, so this was not the known
Windows flake. The failure reproduced locally in one run of the file, so it was
treated as a real regression rather than a flake and was not re-run for green.

## Cause

`cr_turn_context_snapshots` now receives two rows per speaker Turn, and they are
distinct records with different owners:

| Row | Owner | Scope | When |
|---|---|---|---|
| per-Agent Memory selection | CR-5 `BoundedGroupService.recordReply` | `interaction_id` set | as the reply is recorded |
| bounded conversation history freeze | LITE-09-101 `ConversationTurnDriver.replyWithTurn` | `interaction_id` null, `turn_id` set | BEFORE the Provider call |

The pre-existing assertion counted 2 rows for 2 speakers, which was correct
before this slice. The CR-5 row is written while recording the reply, so it
cannot satisfy the LITE-09-101 requirement to persist the bounded context BEFORE
the Provider call; the additional Turn-scoped freeze row is the requirement,
not a duplicate.

## Remediation

The assertion no longer compares a bare total. It groups the rows by Turn and
requires, for each of the two speaker Turns:

- exactly one Turn-scoped row (`interaction_id` null) whose `budget_json`
  records `maxFrozenHistoryMessages` and the frozen message ids, and
- exactly one `interaction_id`-scoped CR-5 row.

That way a missing freeze cannot hide behind the CR-5 row, and a duplicated
freeze still fails. After the fix the full file passes: 5 tests, 5 passed.
