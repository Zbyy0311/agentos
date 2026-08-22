# AgentOS M4-P5 Acceptance Matrix — Current Platform Scope

Status: CURRENT PRODUCTION PLATFORM = WINDOWS ONLY — POSIX REAL-OS EVIDENCE DEFERRED

## 1. E04 / P5B platform classification

| Evidence surface | Windows current production | POSIX current production | Evidence type |
|---|---|---|---|
| Owned process-tree termination | REQUIRED | DEFERRED / NON-BLOCKING | Windows real-platform proof; POSIX future gate |
| Survivor enumeration and empty re-enumeration | REQUIRED | DEFERRED / NON-BLOCKING | proof-aware platform evidence |
| Shared proof normalizer | REQUIRED | RETAINED | deterministic contract/unit coverage |
| Process-group/session implementation | N/A to Windows fallback | RETAINED / FUTURE / NON-PRODUCTION | architecture and deterministic tests |
| Real provider execution evidence | Windows required for current delivery | Not a current production gate | platform-scoped evidence |

Windows-only scope never means that parent-PID kill is enough. The E04 rules
remain mandatory on the required Windows platform: root exit is not proof,
known/unknown survivors fail or remain unproven, and owned-tree-enumeration
proof is required before successful cleanup is claimed.

## 2. Windows cases — required

| Case | Classification | Required result |
|---|---|---|
| Windows child/grandchild owned-tree cleanup | WINDOWS-SPECIFIC / REQUIRED | complete only after enumeration, force cleanup and empty survivor verification |
| Windows survivor and identity fencing | WINDOWS-SPECIFIC / REQUIRED | reused or unknown identity fails closed |
| Windows CI / real-platform validation | WINDOWS-SPECIFIC / REQUIRED | authoritative current M4 production evidence |

## 3. POSIX cases — retained, not current production proof

The following rows remain part of deterministic regression coverage and future
platform evidence. Synthetic tests do not count as real-OS acceptance:

| Case | Classification | Required interpretation |
|---|---|---|
| POSIX process-group creation | UNIT / CONTRACT / FUTURE PLATFORM EVIDENCE | retain ownership/session invariants; no current production claim |
| POSIX group TERM/KILL | UNIT / CONTRACT / FUTURE PLATFORM EVIDENCE | retain negative-PGID and fail-closed semantics |
| POSIX survivor detection | UNIT / CONTRACT / FUTURE PLATFORM EVIDENCE | retain survivor/unknown vocabulary |
| POSIX root-exit race | UNIT / CONTRACT / FUTURE PLATFORM EVIDENCE | root exit alone never proves cleanup |
| POSIX enumeration failure | UNIT / CONTRACT / FUTURE PLATFORM EVIDENCE | no proof on unknown/failure |
| POSIX real-OS environment absent | DEFERRED / NON-BLOCKING | must not produce a current Windows-only PLATFORM_GATE_BLOCKED release result |

No row above labels synthetic POSIX tests as real-OS proof. A future Linux,
POSIX or macOS production-support claim requires a new Owner Decision and
real-OS acceptance evidence on that platform.

## 4. P5B closeout

Current Windows-only closeout requires Windows real owned-tree proof, the
shared proof normalizer, green deterministic POSIX regression coverage where
present, and no Windows blocker/high. POSIX real-OS evidence is
DEFERRED / NON-BLOCKING FOR CURRENT WINDOWS-ONLY PRODUCT.
