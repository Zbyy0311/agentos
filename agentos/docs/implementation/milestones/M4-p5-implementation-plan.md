# AgentOS M4-P5 Implementation Plan — Current Platform Scope

Status: CURRENT PRODUCTION PLATFORM SCOPE RECONCILED BY OD-M4-02 — DOCS ONLY

## 1. Platform support matrix

CURRENT M4 PRODUCTION PLATFORM: WINDOWS ONLY

Windows: REQUIRED CURRENT PRODUCTION PLATFORM GATE

Linux / POSIX / macOS: FUTURE / NON-PRODUCTION / NON-BLOCKING REAL-OS GATE

The POSIX process-group/session implementation and its deterministic
unit/contract coverage remain documented and retained. They do not create a
current production-support promise. POSIX real-OS validation is deferred and
non-blocking for current Windows-only M4 delivery.

## 2. E04 safety semantics remain unchanged

E04 still requires complete owned Process Tree cleanup and survivor proof.
Windows-only production scope does not make parent-PID termination sufficient.

- parent-only kill is invalid;
- root exit is not tree proof;
- known and unknown survivors are failure or unproven;
- successful cleanup requires owned-tree-enumeration proof after the required
  enumeration and re-enumeration;
- failure or enumeration uncertainty remains fail-closed.

## 3. P5B closeout under OD-M4-02

P5B may close when all current production gates are satisfied:

1. Windows real owned-tree proof passes;
2. the shared proof normalizer remains correct;
3. deterministic POSIX contract/unit regressions remain green;
4. no Windows blocker or high-severity issue remains.

Real POSIX OS proof is not required for current Windows-only P5B closeout.
This is a platform-scope reconciliation, not a claim that POSIX real-OS proof
exists or that the POSIX implementation is defective.

## 4. Acceptance classification

| Platform/evidence | Current classification |
|---|---|
| Windows process ownership, termination and survivor proof | REQUIRED / production gate |
| Windows CI and real-platform validation | REQUIRED / authoritative |
| POSIX implementation architecture | RETAINED / future capability |
| POSIX deterministic unit and contract coverage | REQUIRED regression coverage where present |
| POSIX real-OS process-group/session proof | DEFERRED / NON-BLOCKING |
| Missing WSL2/Linux/Docker/Podman | Not a current Windows-only production blocker |

Historical documents and commits that described a POSIX-required P5B gate
remain historical evidence. OD-M4-02 and OD-M4-P5-36 explicitly supersede that
condition only for current production platform acceptance. No P5C/P5D/P5E/P6
work is authorized by this docs-only reconciliation.
