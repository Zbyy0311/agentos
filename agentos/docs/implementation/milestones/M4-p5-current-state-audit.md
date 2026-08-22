# AgentOS M4-P5 Current-State Audit — Windows-Only Scope Reconciliation

Status: DOCS-ONLY SCOPE RECONCILIATION — CURRENT PRODUCTION PLATFORM = WINDOWS ONLY

## 2026-08-22 scope reconciliation

The Owner selected Windows-only current production support under OD-M4-02.
The historical sequence is:

- P5B implementation merged through PR #55.
- Merge: b7580698ab5b081c910b61edbce75155c939e7f8.
- Windows real-platform evidence passed.
- PR exact-head CI passed.
- Post-merge Windows CI passed.
- A subsequent audit identified the old required POSIX real-OS gate.
- The local environment had no usable POSIX runtime.
- That gate was correctly classified PLATFORM_GATE_BLOCKED under the old
  contract.
- OD-M4-02 formally changed current production support to Windows-only.
- POSIX real-OS evidence is therefore deferred rather than falsely marked PASS.

## Current evidence classification

POSIX REAL-OS PROVEN: NO

POSIX REAL-OS REQUIRED FOR CURRENT PRODUCT: NO

Windows P5B production gate: PASS

POSIX real-OS gate: DEFERRED / NON-BLOCKING

The previous POSIX-required rule remains historical evidence and is explicitly
superseded only for current Windows-only platform-release scope by OD-M4-02 and
OD-M4-P5-36. This does not claim POSIX support is proven, delete POSIX code or
weaken deterministic POSIX tests.

## P5B status after reconciliation

M4-P5B Windows Production Gate = PASS

M4-P5B POSIX Real-OS Gate = DEFERRED / NON-BLOCKING

M4-P5B = ELIGIBLE TO BE CLASSIFIED COMPLETE / MERGED / CLOSED

M4-P5C = ELIGIBLE TO START ONLY AFTER THIS DOCS CHANGE IS ACCEPTED/MERGED

This document does not claim P5C has started and does not authorize P5C, P5D,
P5E or P6.
