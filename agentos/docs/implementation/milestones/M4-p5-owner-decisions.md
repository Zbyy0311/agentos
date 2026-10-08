# AgentOS M4-P5 Owner Decisions

Status: DOCS-ONLY SCOPE RECONCILIATION — CURRENT PRODUCTION PLATFORM = WINDOWS ONLY

## Historical frozen rule

The previous frozen P5B rule required POSIX real-OS process-group/session and
survivor evidence. A Windows-only CI result could not satisfy that
cross-platform planning gate. That historical rule remains recorded here; it
is not erased or falsely reported as having passed.

### OD-M4-P5-36 — Production platform gate after OD-M4-02

Previous frozen rule:

POSIX real-OS evidence was REQUIRED for P5B.

Owner scope reconciliation:

OD-M4-02 selects Windows-only current production support.

New P5 rule:

WINDOWS real-platform tree proof: REQUIRED

POSIX deterministic/unit coverage: RETAINED

POSIX implementation: RETAINED / FUTURE / NON-PRODUCTION

POSIX real-OS evidence: DEFERRED / NON-BLOCKING

PLATFORM_GATE_BLOCKED due solely to absence of POSIX environment:
NOT APPLICABLE to current Windows-only production acceptance

OD-M4-P5-36 supersedes the old POSIX-required P5B acceptance condition only
with respect to current platform-release scope. It does not alter process-tree
safety semantics:

- parent-only kill is invalid;
- root exit is not proof of tree cleanup;
- known or unknown survivors fail or remain unproven;
- owned-tree-enumeration proof is required wherever successful cleanup is
  claimed;
- deterministic POSIX tests remain maintained and synthetic tests are never
  labeled as real-OS proof.

Under OD-M4-02, P5B may close when the Windows real owned-tree proof passes,
the shared proof normalizer remains correct, deterministic POSIX contract/unit
regressions remain green, and no Windows blocker/high remains. This document
does not start P5C.
