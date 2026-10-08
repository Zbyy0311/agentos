# S3 runtime authorization: exact integration gap

Requirements: LITE-08-005/006/007 and LITE-07-103/108. Inspection base
97b5b885 (S2 PR145); no new scope, no PASS. Original checkout unchanged.

## Reuse, not replacement

- LifecycleTransactionService.requestApproval already writes approval.required
  and transitions the original Run/optional Stage to waiting_approval in one
  transaction. resolveApprovalToRunning/Failure/Cancellation already enforce
  matching unresolved approval history and optimistic versions. Reuse these
  frozen lifecycle contracts; do not add replacement Runs or a second lifecycle.
- TaskRunRecoveryService.recoverWaitingApproval already restores coherent
  unresolved approval Event history. It does not prove a new request snapshot's
  fingerprint or expiry; preserve its existing uncertainty handling.
- Runtime Event registry already defines approval.required/resolved and their
  safe payload shapes. Their causation is the actual original Run operation.
- Provider-native approval capability is false for current Kimi chain. A tool
  completion observation is not a stoppable pre-action bridge. Do not create an
  enforcement claim from such observations.

## Proven missing links

1. routes/approvals.ts creates a default in-memory ApprovalRegistry. Its request
   and decision maps have no persistence, version, expiry or execute/resume
   callback. Resolving this API cannot prove that an original canonical Run
   resumed or that an action was denied.
2. routes/approvalDecisions.ts independently accepts caller-provided agent,
   Provider, action fingerprint/request ID and dates, then creates a new decision
   ID on every POST. It is not bound to a real persisted Request Snapshot or an
   enforcing pre-action boundary. An accepted decision creates an unproven
   user-explicit Candidate without the candidate_created Event.
3. Canonical RunEngineProviderDispatcher.drive begins with engine.tick (the
   original start claim). A resolved approval needs a fenced continuation of the
   already-claimed original Run/Stage; simply re-posting run.start or calling a
   stale launch closure is not correct resume evidence.
4. StageExecutionCoordinator owns the actual launch plan and Process spawn.
   The authoritative gate must inspect the resolved executable/args/cwd and
   frozen Provider config before spawn. It must re-evaluate immediately before
   executing the same action, including Workspace admission and request expiry.
5. Existing lifecycle methods own inTransaction, which is not nestable. Request
   snapshot + decision + lifecycle Event/Outbox + accepted Candidate cannot be
   composed by calling them inside a second transaction. Introduce only the
   necessary caller-owned synchronous seam, preserving the public methods.

## Bounded next implementation

First freeze the exact additive persistence and original-Run continuation
contract, then implement it at an AgentOS-owned pre-spawn boundary. Migration
027 is reserved/implemented by PR145; recheck main and registry before assigning
028. Do not modify026 or reinterpret its historical unproven decisions as
authorization. New records must bind immutable redacted snapshot hash, original
Run/Stage/attempt, policy version, action fingerprint, expiry and decision CAS.

Use ordinary once-only approve/reject for Lite; existing grant maps remain
compatibility and cannot silently authorize this new path. A candidate is only
created from the committed accepted decision and keeps review-required authority
with real provenance. Register the approval-specific origin separately from
S2's Artifact origin. No generic caller-supplied source-kind bypass.

Exit: actual ASK_USER -> durable request/decision -> same Run/Stage execute or
reject, with concurrent choice/expiry/fingerprint drift/restart/no-respawn and
Event/Outbox/candidate rollback tests. Real missing Provider pre-action support
stays visibly unavailable. No Policy UI/DSL/grant engine/RBAC or unrelated safety
framework is part of this slice. This source audit alone does not authorize
unreviewed DDL and is not implementation evidence.
