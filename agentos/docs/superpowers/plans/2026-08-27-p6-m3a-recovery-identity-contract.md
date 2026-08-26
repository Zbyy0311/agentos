# P6-M3a — Recovery Identity & Continuation Contract Closure

- **Status:** Contract closure (audit + freeze). No production behavior activation.
- **Base:** `main` @ `0daa77f5159287bcb2724808cb6c54e112d007a7` (P6-M2 merged via PR #64).
- **Branch:** `docs/p6-m3a-recovery-identity-contract`
- **Date:** 2026-08-27
- **Scope:** Determine and freeze the exact safety contract required before AgentOS may treat a post-restart native process as `same` / `reattachable` / `alive-uncontrollable` / `mismatch` (PID-reused) / `missing` / `unknown`, and make the next slice (P6-M3b) mechanically actionable.

> This document is an audit and contract artifact. It changes no production code, no schema, no API, and no lifecycle behavior. See §16 Non-goals and the Hard Safety Boundaries.

---

## 1. Executive decision

On current `main`, AgentOS can only **prove a process is gone** (`missing`) and otherwise stays **fail-safe uncertain** (`unknown`). It **cannot** prove a surviving process is the *same* original process, and therefore **cannot** safely reattach, resume, or even distinguish PID-reuse (`mismatch`).

**Identity evidence and process survivability are two separate dimensions**, and they do not block the two platforms in the same way:

- **POSIX (current detached process):** a detached managed process *may survive* a Server restart, but AgentOS cannot re-observe its identity. The only persisted "start time" (`nativeStartedAt`) is the **server wall-clock at spawn moment**, not an OS-native process-creation timestamp, so it cannot be re-observed after a Server restart to distinguish an original process from a PID-reuse successor. Here, **identity evidence is a real blocker** for `same`/`mismatch` — the process can outlive the Server, but cannot be safely named.
- **Windows (current owned production spawn path):** the managed provider process is placed in an AgentOS **kill-on-close Job Object** owned by the PowerShell helper (§2.3). When the Server/helper ownership chain is lost, kill-on-close **intentionally reaps** the owned provider tree. So the normal Windows production restart outcome is `missing` — a surviving managed provider process is **not normally present** to be classified `same`/`mismatch`. Here the blocker is **survivability-by-design**, not merely identity evidence.

Until a durable, independently re-observable identity signal exists, `same` and `mismatch` must remain production-unreachable, and every non-`missing` outcome must stay `unknown` (fail-safe). On Windows this is reinforced by the kill-on-close ownership model: even with perfect identity evidence, the normal production restart still yields `missing`.

**Recommended P6-M3b slice (§14):** *Durable OS-native process identity evidence* — capture and persist a real OS process-creation timestamp (and confirm the executable identity) at spawn, and extend the production verifier to read it back, so `same`/`mismatch` become **technically classifiable where a process can actually survive** (POSIX detached processes, and non-AgentOS-owned test primitives), **for classification only**. This preserves the current Windows owned-process restart semantics (kill-on-close → `missing`); it does **not** make Windows production restart reach `same`. Reattachment, resume, and ownership transfer remain explicitly out of scope and unauthorized.

---

## 2. Current-state evidence

All findings below are from the authoritative `main` tree at `0daa77f5`. File/function citations are exact.

### 2.1 Recovery classification chain (production)

- `packages/process-runtime/src/platform-recovery-verifier.ts` — `PlatformRecoveredProcessVerifier.verify(pid)`:
  - Windows: `#verifyWindows` → `verifyWindowsProcessAbsence(pid, probe)` using `process.kill(pid, 0)` (signal 0 = existence check only). Returns `not-found` **only** when the probe throws `code === 'ESRCH'`; a live PID returns `{ kind: 'unavailable', reason: 'pid-alive-identity-unprovable' }`; `EPERM`/unknown/argument errors → `unavailable`. **Never returns `alive`.**
  - POSIX: `#verifyPosix` — same `process.kill(pid, 0)`; `ESRCH` → `not-found`, otherwise `unavailable`. **Never returns `alive`.**
- `packages/process-runtime/src/recovery-classifier.ts` — `classifyRecoveredProcess(process, verifier)`:
  - `not-found` → `missing`.
  - `unavailable` → `unknown` (fail-safe).
  - `alive` → compares persisted `nativeStartedAt` against live `identity.startedAtMs`; equal → `same`, unequal → `mismatch`. **This branch is dead in production** because the production verifier never returns `alive`.
- `apps/server/src/processRecoveryPreflight.ts` — `preflightProcessRecoveryClassifications(...)` runs the classifier **asynchronously before** any recovery transaction; `createPreflightProcessRecoveryPort(...)` exposes a **synchronous** lookup inside the transaction. Unresolvable/unclassifiable Runs are omitted → reported as `unknown`.
- `apps/server/src/services/TaskRunRecoveryService.ts` — only `classification === 'missing'` reconciles a running Run to canonical terminal failure (`processMissingFailed`); every other value (`same`/`mismatch`/`unknown`/no-process/error) keeps historical fail-safe uncertainty (no resume, no re-adopt, no takeover).

### 2.2 Spawn-time identity persistence

- `packages/process-runtime/src/node-driver.ts:92` — `this.now = options.now ?? (() => Date.now())`.
- `packages/process-runtime/src/node-driver.ts:126` — at spawn, `const startedAtMs = this.now();` → `handle.identity.startedAtMs = startedAtMs` (wall-clock).
- `packages/process-runtime/src/durable-coordinator.ts:683-693` — `identityFromHandle(handle)`:
  - `nativeStartedAt: isoFromEpochMs(handle.identity.startedAtMs)` where `isoFromEpochMs = (ms) => new Date(ms).toISOString()` (line 86-88).
  - `recoveryToken: randomBytes(32).toString('hex')` — a fresh server-generated random value.
- `apps/server/src/store/ProcessRepository.ts` (`casBindNativeIdentity`, ~757-846) persists `native_pid`, `native_started_at`, `recovery_token_hash` (SHA-256 of the token), and `recovery_evidence_json` (schemaVersion 1: `nativePid`, `nativeStartedAt`, `recoveryTokenHash`, `platform`).

### 2.3 Process tree / ownership

- Windows: `packages/process-runtime/src/windows-process-tree.ts` builds an **unnamed** Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`CreateJobObject(IntPtr.Zero, null)`, `SetKillOnClose`, `AssignProcessToJobObject`). The ownership chain is layered, and the Job handle is **not** held directly by the Node Server:
  - The **Node Server** owns the helper `ChildProcess` and its `stdin` pipe, and listens on two per-session named pipes (control + data).
  - The **PowerShell helper** (`powershell.exe` running the embedded `AgentOsJobServer`) connects back over those pipes and owns the **native Job handle** as an in-memory `IntPtr` inside the helper process (`AgentOsJob.Create()`).
  - The **Job** owns the provider process tree (`AssignProcessToJobObject`).
  - The helper reads commands in a loop via `Console.In.ReadLine()` over its stdin pipe. When the Server disappears, the helper's stdin/transport disappears, the helper exits or fails, its native Job handle closes, and **kill-on-close reaps the owned provider members**. So the normal Windows production restart outcome for an owned provider is `missing`, not a surviving process.
- POSIX: `packages/process-runtime/src/posix-process-tree.ts` spawns `detached` and enumerates the session via `ps -eo pid=,pgid=,sid=`; termination is `process.kill(-groupId, 'SIGKILL')`.
- Spec `05-Process-Runtime.md` §40.2 states the native Job handle is memory-only and the DB-stored `platformHandleId` is **for diagnostics, not for recovering the native handle after restart**.

### 2.4 Provider capability model

- `packages/shared/src/types/index.ts:834` — `ProviderCapabilitiesV1` includes `sessionResume: boolean` (plus structuredEvents, cancellation, etc.).
- `packages/agent-core/src/providers/kimiCodeAdapter.ts:49-65` — `KIMICODE_CAPABILITIES = { sessionResume: false, ... }`. Kimi Code is the only production runtime provider adapter exported by `packages/agent-core/src/providers/index.ts`.
- `packages/agent-core/src/adapters/{codexAdapter,kimiAdapter,plainTextAdapter}.ts` are **output parsers** in a separate legacy adapter registry, not runtime providers with resume capability.
- Spec vocabulary already exists: `m3-runtime-registry.ts` `RunRecoveredPayload.recoveryMode = 'process-reattach' | 'provider-session-resume' | 'queue-restore' | 'approval-restore'`; `RunResumedPayload.resumeMode = 'native-session' | 'process-restart' | 'scheduler'`. These are contract types only — no current adapter or runtime path produces them.

---

## 3. Reachability analysis

Production-reachable classifications on current `main`, per `Run`:

| Classification | Production-reachable? | Why |
|---|---|---|
| `missing` | **Yes** | Verifier `not-found` (exact `ESRCH`) → classifier `missing` → recovery reconciles to canonical failure. |
| `unknown` | **Yes** | Verifier `unavailable`, or unresolvable/unclassifiable, or evidence missing/inconsistent → fail-safe uncertainty. |
| `same` | **No** | Requires verifier `alive`; production verifier never returns `alive`. |
| `mismatch` | **No** | Requires verifier `alive` + start-time inequality; production verifier never returns `alive`. |

The classifier's `same`/`mismatch` logic is implemented and unit-tested, but **unreachable in production** by deliberate P6-M2 fail-safe design. This is correct for P6-M2; P6-M3 is about making `same`/`mismatch` *safely* reachable, not about removing the fail-safe.

---

## 4. Identity evidence audit

Legend: **Spawn** = available at spawn; **Persist** = can persist safely; **Re-observe** = independently re-observable after a Server restart; **Win/POSIX** = platform support; **Reuse risk** = spoof/PID-reuse risk if used alone.

| Evidence | Spawn | Persist | Re-observe | Win | POSIX | Reuse risk | Verdict |
|---|---|---|---|---|---|---|---|
| Native PID | yes | yes | yes | yes | yes | **high** (reuse) | necessary, never sufficient |
| Wall-clock `nativeStartedAt` (`Date.now()`) | yes | yes | **no** | n/a | n/a | n/a | **not identity evidence** (see §5) |
| OS-native process creation time | yes* | yes | yes | yes (e.g. `GetProcessTimes` / WMI `CreationDate`) | yes (`/proc/<pid>/stat` field 22 starttime, or `ps -o lstart`) | low (with PID) | **required addition** |
| Executable resolved path / fingerprint | yes | yes | partial | yes | yes | medium | supporting signal |
| Recovery token hash | yes | yes (hash only) | **no** (OS process never carries it) | n/a | n/a | n/a | persistence-integrity only (§5) |
| Process group / Job identity | yes | yes | partial | Job handle not re-openable (unnamed, kill-on-close) | groupId via `ps` | medium | supporting signal |
| Provider session identity | partial | yes | provider-dependent | provider-dependent | provider-dependent | n/a | continuation, not native identity |

*"yes*" = obtainable at spawn, but **not currently captured**.

**Hard rules:**

- **PID alone MUST NOT prove identity.** PIDs are reused.
- **The current wall-clock `nativeStartedAt` MUST NOT be treated as OS-native creation-time evidence.** It is the Server's clock at the moment `spawn()` resolved, not the process's OS creation time, and it cannot be re-observed after restart.

---

## 5. Recovery-token analysis

`recoveryTokenHash` is the SHA-256 of a one-time random token generated **by the Server** at spawn (`durable-coordinator.ts:692`) and persisted only as a hash. The native OS process never receives, stores, or exposes this token (spec §64.1: the token must not be placed on the command line; it is not injected into the child at all in the current implementation).

**Conclusion:** the recovery token is **persistence-integrity evidence only**. Matching the persisted hash in two database fields proves the *row* is internally consistent; it does **not** prove that the live OS process is the original. It cannot be independently observed from the post-restart process. It must **not** be promoted to a live native identity proof.

---

## 6. Handle / stream survival analysis

When the AgentOS Server process dies or restarts while a Provider process might survive:

| Resource | Survives Server restart? | Evidence |
|---|---|---|
| `ChildProcess` handle | **No** | In-memory only (`node-driver.ts` backend). |
| original `stdout` pipe | **No** | OS pipe owned by the Server process; closed on Server death. |
| original `stderr` pipe | **No** | Same. |
| `stdin` | **No** | Same; Kimi launches with `stdinMode: 'none'` (kimiCodeAdapter.ts:339). |
| exit watcher | **No** | `backend.exit` promise lives in the Server process. |
| Windows Job Object ownership | **No** | Unnamed kill-on-close Job whose handle is owned by the **PowerShell helper** (not directly by the Server). When the Server disappears, the helper loses its stdin/named-pipe transport and exits, closing its in-memory Job handle; kill-on-close then terminates the members. An unnamed Job cannot be re-opened by a new process. Spec §40.2 confirms `platformHandleId` is diagnostics-only. |
| POSIX process group | process may survive (detached) | Group is enumerable via `ps`, but the group id alone does not prove identity or restore control/pipes. |

**Implication:** even if a native process is later proven `same`, the original control channel (pipes, handle, exit watcher, Job) is gone. Reattachment therefore cannot assume stream continuity from the original pipes; it must be reconstructed from a provider-native session or a durable AgentOS-owned output transport (see §8).

---

## 7. Process ownership analysis

**Identity proof ≠ control authority.** Proving a PID is the original process only establishes *that it is the same process*; it does not grant the new Server instance the right to control it.

Before a new Server instance may act on a recovered process, the following **distinct** proofs are required:

| Action | Required proof | Currently available? |
|---|---|---|
| Monitor (read-only observe) | `same` identity | No (identity not reachable) |
| Signal / cancel | `same` identity **and** a reconstructible, authorized control channel **and** ProcessCancelCoordinator-mediated ownership | No |
| Write stdin | above **and** a live stdin pipe (original pipe is gone) | No |
| Resume provider session | above **and** provider `sessionResume = true` with a resumable session id | No (Kimi `sessionResume:false`) |
| Claim ownership | above **and** durable claim-fence transfer (CAS on claimEpoch/owner) | No |

**Invariant:** `ProcessCancelCoordinator` remains the **sole** cleanup authority. No production ownership transfer, reattach, adopt, resume, respawn, or kill is introduced by this slice. Any future control authority requires a separately reviewed contract and explicit ProcessCancelCoordinator integration.

---

## 8. Output / stream continuity contract

Because the original stdout/stderr/stdin pipes and the exit watcher do not survive a Server restart (§6), recovery after restart must choose exactly one of these explicit outcomes:

- **A. Provider-native session replay makes old pipes irrelevant.** Only possible if the provider supports durable session resume/replay (`sessionResume`) and AgentOS can re-attach to that session. Currently **no** production provider supports this (Kimi `sessionResume:false`).
- **B. Provider writes to a durable AgentOS-owned transport/artifact.** Output is teed to an AgentOS-owned durable artifact at runtime, so post-restart recovery reads the artifact rather than the dead pipe. This is a **new transport** and is **not implemented in M3a** (explicitly out of scope).
- **C. Live native process can be monitored but not reattached.** Identity proven `same`, but no control/output channel → `alive-uncontrollable` (monitor only; user-directed).
- **D. Continuation is unsafe → uncertainty / user-directed retry.** Default fail-safe when none of A–C can be established.

**Contract rule:** recovery may **not** treat a process as continuable if its streams are gone **unless** outcome A or B is positively established. Otherwise it is `alive-uncontrollable` (C) or `unknown` (D), both fail-safe.

---

## 9. Provider continuation capability matrix

Classifications: **SUPPORTED** (adapter + provider both implement), **PARTIAL** (one side only), **UNSUPPORTED** (explicitly not supported), **UNKNOWN** (insufficient repo evidence).

| Provider (current repo) | Durable session id? | New AgentOS process can reconnect/resume? | Replay output produced while offline? | Resume in current adapter code? | Resume only in provider CLI (not AgentOS)? | Continuation needs original pipes? | Exit state independently observable? | Classification |
|---|---|---|---|---|---|---|---|---|
| Kimi Code (`KimiCodeProviderAdapter`) | partial (native session id field exists; runtime uses one-shot run) | **No** | **No** | **No** (`sessionResume:false`, kimiCodeAdapter.ts:50) | Unknown — requires real-provider CLI investigation | Yes (current model: stdout/stderr pipes; `stdinMode:none`) | No (exit watcher dies with Server) | **UNSUPPORTED** (in current adapter) |
| Codex (`codexAdapter`) | Unknown | Unknown | Unknown | **No** (output parser, not a runtime provider) | Unknown — `codex` CLI has resume/thread concepts; not wired into AgentOS | Yes (parser over stdout) | No | **UNKNOWN** |
| OpenCode (`packages/agent-core/src/opencodeUsage.ts`) | Unknown | Unknown | Unknown | **No** (usage/stats parsing only) | Unknown — not an integrated runtime provider | Unknown | No | **UNKNOWN** |
| Claude Code / other CLI adapters | n/a | n/a | n/a | **No adapter present** | n/a | n/a | n/a | **UNKNOWN** (no adapter in repo) |

**Specific real-provider investigations needed later (before any M3b+ continuation work):**

1. **Kimi Code CLI:** does the CLI support a `--resume`/`--continue`/session-id mode that re-attaches to a prior session and replays its events? (Current adapter hard-codes `sessionResume:false`.)
2. **Codex CLI:** does `codex` expose a durable thread/rollout id and a resume/replay mode usable non-interactively by AgentOS?
3. **OpenCode:** does it expose a session id + resume, and is output replayable?
4. For each: is exit state observable without the original pipes, and can a *new* parent process safely signal/cancel the resumed session?

These require live provider CLI verification; they are explicitly **not** claimed from repo evidence.

---

## 10. Target classification model (frozen)

These are **distinct** concepts and must never be conflated:

- **SAME IDENTITY** — AgentOS can *prove* the native PID belongs to the exact previously persisted Process (requires a durable, re-observable identity signal, e.g. PID + OS creation time). **Same identity alone does NOT imply reattachment is safe.**
- **REATTACHABLE** — same identity **AND** control can be safely reconstructed **AND** output/event continuity can be reconstructed **AND** the provider explicitly supports the continuation model (`sessionResume`).
- **ALIVE-UNCONTROLLABLE** — the native Process is proven to be the original, **but** one or more of: controllable handle unavailable; output continuity unavailable; provider continuation unsupported; ownership cannot safely be reconstructed.
- **MISSING** — positive native absence proof (exact `ESRCH`).
- **MISMATCH / PID-REUSED** — PID exists but positively does **not** match persisted identity (e.g. creation time differs).
- **UNKNOWN** — anything that cannot be positively established. **UNKNOWN remains fail-safe** (no resume, no takeover, no terminal failure driven by uncertainty).

This maps onto the existing spec model (05 §66): `reattachable | alive-uncontrollable | missing | pid-reused | orphaned | already-exited | unknown`. `orphaned` (process alive with no owning Run) and `already-exited` (durable terminal state) are complementary dispositions layered on top of the identity classification.

---

## 11. Decision matrix

| Observed identity | Control | Provider resume | Output continuity | Result | Run disposition | Stage disposition | recoveryRequired | User action | Cleanup allowed | Auto-continuation |
|---|---|---|---|---|---|---|---|---|---|---|
| absent (ESRCH) | n/a | n/a | n/a | **MISSING** | failed (canonical) | failed (canonical) | no | no | yes (record-only) | no |
| same | reconstructed | supported | reconstructed | **REATTACHABLE** | resume candidate | resume candidate | no | no | no | yes (gated, future) |
| same | none/lost | any | none/lost | **ALIVE_UNCONTROLLABLE** | stays running (monitored) | stays running | yes | yes | no | no |
| same | reconstructed | **not** supported | any | **ALIVE_UNCONTROLLABLE** | stays running (monitored) | stays running | yes | yes | no | no |
| same | reconstructed | supported | **lost** | **ALIVE_UNCONTROLLABLE** | stays running (monitored) | stays running | yes | yes | no | no |
| PID exists, creation-time differs | n/a | n/a | n/a | **MISMATCH** | failed (canonical) | failed (canonical) | no | no | no (foreign process) | no |
| ambiguous / unverifiable / error | n/a | n/a | n/a | **UNKNOWN** | stays running (uncertain) | stays running | yes | yes | no | no |

**Notes:**

- The matrix above describes **target semantics**. Reachability of each row under the CURRENT runtime is platform-specific (see §13a Platform restart matrix):
  - **Windows owned production runtime:** only the MISSING and UNKNOWN rows are reachable. SAME / REATTACHABLE / ALIVE_UNCONTROLLABLE / MISMATCH are **not** normally reachable, because kill-on-close reaps the owned provider tree on Server loss, so no surviving AgentOS-owned provider is present to classify.
  - **POSIX detached runtime:** today only MISSING and UNKNOWN are reachable; after native identity evidence (P6-M3b) a surviving detached process may additionally become SAME or MISMATCH. REATTACHABLE / ALIVE_UNCONTROLLABLE remain frozen targets requiring further, separately-authorized slices.
  - The REATTACHABLE / ALIVE_UNCONTROLLABLE / MISMATCH rows are the frozen **target** semantics unlocked by later slices; they are not enabled behavior.
- "Cleanup allowed" for MISSING means reconciling durable records only; it never means killing a foreign process. For MISMATCH, the foreign process belongs to someone else — **no cleanup** of it is permitted.
- "Auto-continuation" for REATTACHABLE is a **future, separately-authorized** behavior; it is not enabled by this slice.

---

## 12. Safety invariants (carried forward, unchanged)

1. Production verifier never returns `alive` without a re-observable identity proof.
2. Absence proof is exact-`ESRCH` only; every non-`ESRCH` outcome fails closed to `unavailable` → `unknown`.
3. `unknown` is never treated as recoverable and never drives a terminal failure by itself.
4. No async OS verification inside the SQLite recovery transaction; the transaction only reads precomputed classifications.
5. PID alone never proves identity; wall-clock `nativeStartedAt` is never treated as OS creation time.
6. The recovery token is persistence-integrity evidence only, never a live identity proof.
7. Identity proof does not grant control authority; ProcessCancelCoordinator remains the sole cleanup authority.
8. No reattach / adopt / resume / respawn / ownership-transfer / kill is introduced by M3a.

---

## 13. Windows / POSIX considerations

**Windows.** Process creation time is obtainable via `GetProcessTimes` (`lpCreationTime`) or WMI `Win32_Process.CreationDate`, and is stable + re-observable while the process lives. Combined with the PID it distinguishes a PID-reuse successor. The current **unnamed kill-on-close Job Object**, whose handle is owned by the **PowerShell helper** (§2.3), means the controlled provider tree is intentionally reaped when the Server/helper ownership chain is lost; the tree does **not** survive a normal Server restart by design. Making such a tree survive is an ownership-lifecycle change, not an identity-evidence change, and merely *naming* the Job does **not** by itself make cross-restart survival safe or possible (§16a). A read-only creation-time probe (e.g. via `GetProcessTimes` on a handle opened with `PROCESS_QUERY_LIMITED_INFORMATION`, or WMI) is sufficient for identity classification of a process that is already alive and does not require owning the job.

**POSIX.** Process start time is obtainable from `/proc/<pid>/stat` (field 22, `starttime`, in clock ticks since boot — combined with boot time and `sysconf(_SC_CLK_TCK)`) or `ps -o lstart= -p <pid>`. On Linux this is stable and re-observable. The detached process group id (`ps -eo pid=,pgid=,sid=`) is a supporting signal but not identity by itself. macOS/`ps` start-time formatting is locale/format-sensitive and must be normalized carefully (prefer a machine-readable source).

## 13a. Platform restart matrix (frozen)

This matrix states what the CURRENT runtime does on a Server restart/crash, and which classifications are reachable. It is the authoritative platform split referenced by §1, §10, and §14.

| Platform / process kind | Survivor after Server restart? | Expected recovery classification today | SAME reachable in normal production? | MISMATCH reachable in normal production? |
|---|---|---|---|---|
| **Windows — current owned production process** (provider inside the helper-owned kill-on-close Job) | **No** — helper loses stdin/named-pipe transport on Server loss, exits, closes the Job handle, kill-on-close reaps the tree | **MISSING** (the owned tree is reaped) | **No** | **No** |
| **POSIX — current detached process** | **May survive** (detached from the Server's session) | **UNKNOWN** today (alive but identity unprovable) | **No** today; **may become reachable after native identity evidence** (P6-M3b) | **No** today; **may become reachable after native identity evidence** (P6-M3b) |
| **Unmanaged / test-owned / escaped Windows process** (explicitly outside the production kill-on-close Job) | May survive independently | n/a — used only as a **platform primitive test** (§15 W2) | Reachable **only** in a primitive test, never as normal production | Reachable **only** in a primitive test, never as normal production |

**Hard rule:** an unmanaged, test-owned, or otherwise escaped Windows process that survives MUST NOT be used as evidence that a normal AgentOS-owned Windows production process survives a Server restart. The two are different process kinds with different ownership.

---

## 14. P6-M3b recommended scope

**Chosen slice: (A) Durable OS-native process identity evidence** — the smallest slice that unlocks the next dependency safely.

**Purpose:**
- introduce an independently re-observable OS-native creation identity;
- make SAME/MISMATCH **technically classifiable where a process can actually survive**;
- **preserve the CURRENT Windows owned-process restart semantics** (kill-on-close → `missing`).

**What it does:** capture a real OS process-creation timestamp (and confirm the resolved executable identity) at spawn, persist it durably, and extend the production verifier to read back the live creation time so the classifier's existing `same`/`mismatch` branch becomes production-reachable **for classification only**.

**Platform applicability (exact):** the new evidence may still be implemented cross-platform, but its consequences differ by platform. On POSIX, a surviving detached process may become SAME/MISMATCH. On Windows, **normal production restart MUST NOT claim SAME** — the owned provider tree is reaped by kill-on-close, so the normal Windows production outcome stays `missing`. Windows SAME/MISMATCH is reachable only in a clearly-labelled **platform primitive test** using a process outside the production Job (§15 W2), never as normal production behavior.

**Why first:** every later capability (alive-uncontrollable handling, reattachment, provider continuation) depends on being able to *prove* `same` vs `mismatch`. Without re-observable identity, those are all blocked. This slice is read-only at recovery time and does not activate any control or continuation behavior.

- **Files/packages likely affected:**
  - `packages/process-runtime/src/node-driver.ts` — capture OS creation time at spawn (in addition to, not replacing, the wall-clock `startedAtMs`).
  - `packages/process-runtime/src/platform-process-tree.ts` (the platform-controller seam) and/or a new native probe module — OS creation-time read per platform.
  - `packages/process-runtime/src/durable-coordinator.ts` (`identityFromHandle`) — include the OS creation time in `NativeSpawnIdentity`.
  - `packages/process-runtime/src/repository-port.ts` — extend `NativeSpawnIdentity` / evidence payload.
  - `packages/process-runtime/src/platform-recovery-verifier.ts` — add a live creation-time read so `alive` can carry a comparable identity.
  - `apps/server/src/store/ProcessRepository.ts` + `process-runtime-adapters.ts` — persist/read the new evidence field.
  - `packages/process-runtime/src/recovery-classifier.ts` — no semantic change expected (the `same`/`mismatch` logic already exists); only newly reachable.
- **Migrations needed:** **Yes** — a new additive column on the runtime Process table for the OS-native creation timestamp (e.g. `native_created_at`), plus inclusion in `recovery_evidence_json` (schemaVersion bump to 2). Additive only; no rewrite of existing rows.
- **API changes needed:** **No** public API change (internal durable evidence only).
- **Windows/POSIX scope:** both, but each behind a fail-closed probe. If a platform cannot supply a re-observable creation time, that platform stays `unknown` (fail-safe) rather than guessing. On Windows the evidence is used for **primitive-test classification and for future survivability design only**; it does not change the production restart outcome (still `missing`).
- **Tests required:** deterministic seam tests (creation-time match → `same`; mismatch → `mismatch`; unreadable → `unknown`; PID-reuse simulated by differing creation time → `mismatch`, never `same`), plus the platform gates in §15: a Windows **W2 primitive** gate (test-owned process outside the production Job: same PID + same creation identity → `same`; different creation identity → `mismatch`), a Windows **W1 reaper** gate (owned production restart → provider reaped → `missing`), and a **POSIX real restart** gate (detached survivor → `same`; mismatch → `mismatch`).
- **Rollback behavior:** additive column + fail-closed probe means rollback = stop reading the new field; existing `missing`/`unknown` behavior is preserved.
- **Forbidden behavior (unchanged):** no reattach, adopt, resume, respawn, ownership transfer, kill/taskkill/Stop-Process, orphan-cleanup changes, or lifecycle behavior changes. Classification only.
- **Acceptance gate:** the full, corrected gate set is enumerated in §15 (W1 reaper, W2 primitive, W3 fail-closed, POSIX real-restart). Summary: `same`/`mismatch` become reachable via OS-native creation-time evidence **only where a process can actually survive** (POSIX detached, and Windows primitive tests outside the production Job); **normal Windows production restart stays `missing`**; `unknown` remains the fail-safe default for any unverifiable case; full process-runtime + server suites green on the exact head; no schema/API/behavior regressions.

---

## 15. P6-M3b acceptance criteria

No acceptance gate below may require "real Windows production restart → `same`", because the current Windows owned-spawn path reaps the provider tree on Server loss (§13a). The gates are split by platform and process kind.

**Durable evidence (cross-cutting):**

1. A durable, OS-native process-creation timestamp is captured at spawn and persisted (Migration additive, evidence schemaVersion 2).
2. The production verifier returns a comparable live creation time for an existing PID, enabling the classifier to reach `same` when creation times match and `mismatch` when they differ.
3. PID reuse is positively detected as `mismatch` (never `same`).
4. Any platform/probe that cannot supply re-observable creation time fails closed to `unknown`.

**Windows gates (production semantics preserved):**

- **W1 — Production owned-spawn restart / reaper gate.** Using the REAL Windows owned-spawn path, the provider is atomically placed in the AgentOS kill-on-close Job. At the supported Server/helper ownership-loss boundary, prove the owned provider is reaped. Post-restart recovery expectation: **MISSING**. This preserves the current architecture.
- **W2 — Windows native identity primitive gate.** A **test-owned process explicitly OUTSIDE the production kill-on-close Job** may be used to validate the native creation-time probe itself: same PID + same native creation identity → verifier/classifier `same`; different creation identity → `mismatch`. This is a **PLATFORM PRIMITIVE TEST ONLY**: it MUST NOT be presented as proof that a normal Windows AgentOS-owned provider survives a Server restart.
- **W3 — Failure/permission/ambiguous probe → fail closed.** Any failure, permission denial, or ambiguous native identity probe yields `unknown` and fails closed.

**POSIX gate (where detached processes survive):**

- **POSIX real restart gate.** Spawn an AgentOS-owned detached process → record its native creation identity → lose the Server handle/registry → the process survives → the restart verifier reads the same native identity → `same`. A PID/creation-identity mismatch → `mismatch`. If the CI environment cannot execute a real POSIX gate, it is marked **environment-gated** explicitly; Windows primitive evidence MUST NOT be substituted for POSIX evidence.

**Safety / regression gates:**

5. No production control, reattach, resume, or ownership behavior is activated.
6. ProcessCancelCoordinator authority, the Run state machine, the public API, and P6-M2 `missing`/`unknown` behavior are unchanged.
7. Real-platform gates pass on the exact head for the supported platform(s), each labelled with its process kind per §13a.

---

## 16. Explicit non-goals

- Implementing process reattachment, adoption, resume, respawn, or native handle reconstruction.
- Any production ownership transfer or ProcessCancelCoordinator change.
- Any new output transport / durable artifact piping (§8 outcome B).
- Provider CLI resume integration or any provider behavior change.
- Named Windows Job Objects, or any Job Object / Job-lifecycle change (including any change to kill-on-close policy).
- Any ownership transfer, helper/broker lifetime change, or recovery-behavior change.
- Making a Windows AgentOS-owned provider survive a Server restart (that is a separately-authorized ownership-lifecycle design; see §16a).
- Database schema rewrite, public API change, Run state machine change, or runtime dispatch change.
- Rewriting Runtime Specification 00–14 (this document only *references* it).
- Activating the REATTACHABLE / ALIVE_UNCONTROLLABLE rows of the decision matrix (they are frozen targets, not enabled behavior).

---

## 16a. Future Windows survivability (separately authorized — do NOT design or implement now)

If AgentOS ever wants Windows provider processes to survive a Server restart, that is **not** merely an identity-evidence change. It requires a separately authorized **ownership-lifecycle design**. Areas that would need investigation include:

- Job lifetime across Server instances;
- broker/helper lifetime (who owns the Job handle, and for how long);
- named Job semantics;
- kill-on-close policy;
- durable ownership fencing;
- handle/control reconstruction;
- output continuity;
- cancellation authority.

This slice does **not** design or implement any of that. In particular, **merely naming the Job Object does not automatically make cross-restart survival safe or possible** — survival is only safe once ownership, control, output continuity, and cancellation authority are all reconstructed and fenced.

---

## 17. Remaining unknowns

1. **Provider resume reality (Kimi/Codex/OpenCode/Claude):** whether each provider CLI actually supports durable session resume + offline output replay, and whether exit state is observable without original pipes. Requires live provider CLI investigation (§9).
2. **Windows creation-time probe reliability under `PROCESS_QUERY_LIMITED_INFORMATION`** for processes owned by other sessions/elevated contexts (may yield access-denied → fail-closed `unknown`).
3. **POSIX clock-tick normalization** across Linux/macOS for `/proc`/`ps` start time (tick rate, boot-time reference, format locales).
4. **PID + creation-time collision window:** the theoretical residual risk that a PID is reused *and* creation times are indistinguishable at the stored precision; the evidence field must record sufficient precision (e.g. 100ns FILETIME on Windows, ticks on Linux) to keep this negligible.
5. Whether a future cross-restart tree-ownership model (named Job, broker/helper lifetime, kill-on-close policy, ownership fencing — §16a) is ever warranted. Naming the Job alone is explicitly **not** a sufficient answer.

---

## 18. Evidence index

| Finding | File | Symbol / line |
|---|---|---|
| Verifier never returns `alive`; ESRCH-only `not-found` | `packages/process-runtime/src/platform-recovery-verifier.ts` | `verifyWindowsProcessAbsence`, `#verifyPosix`, class doc |
| Classifier `same`/`mismatch`/`missing`/`unknown` logic | `packages/process-runtime/src/recovery-classifier.ts` | `classifyRecoveredProcess` |
| Async-before-transaction classification | `apps/server/src/processRecoveryPreflight.ts` | `preflightProcessRecoveryClassifications`, `createPreflightProcessRecoveryPort` |
| Only `missing` → terminal failure | `apps/server/src/services/TaskRunRecoveryService.ts` | `processMissingFailed`, classification handling (~269-294) |
| Wall-clock spawn time | `packages/process-runtime/src/node-driver.ts` | `now = () => Date.now()` (92), `startedAtMs = this.now()` (126) |
| `nativeStartedAt` = ISO(wall-clock); token = server random | `packages/process-runtime/src/durable-coordinator.ts` | `isoFromEpochMs` (86), `identityFromHandle` (683-693) |
| Persisted evidence columns | `apps/server/src/store/ProcessRepository.ts` | `casBindNativeIdentity` (~757-846); Migration 014 schema |
| Windows unnamed kill-on-close Job, helper-owned handle | `packages/process-runtime/src/windows-process-tree.ts` | `AgentOsJob.Create` → `CreateJobObject(0,null)` + `SetKillOnClose`; `AgentOsJobServer.Run` (697) reads commands via `Console.In.ReadLine()` (714); `AssignProcessToJobObject` |
| POSIX detached session/group | `packages/process-runtime/src/posix-process-tree.ts` | `ps -eo pid=,pgid=,sid=`, `process.kill(-groupId, 'SIGKILL')` |
| Job handle is memory-only; `platformHandleId` diagnostics-only | `docs/Runtime-Specification/05-Process-Runtime.md` | §40.2 |
| Identity evidence list + PID-reuse warning | `docs/Runtime-Specification/05-Process-Runtime.md` | §65.1 ("PID alone is insufficient, PIDs can be reused") |
| Target classification model | `docs/Runtime-Specification/05-Process-Runtime.md` | §66 |
| Server-restart recovery flow | `docs/Runtime-Specification/02-Runtime-Lifecycle.md` | §42.2 |
| `sessionResume` capability flag | `packages/shared/src/types/index.ts` | `ProviderCapabilitiesV1.sessionResume` (834) |
| Kimi `sessionResume:false`, `stdinMode:none` | `packages/agent-core/src/providers/kimiCodeAdapter.ts` | `KIMICODE_CAPABILITIES` (49-65), stdin (339) |
| Recovery/resume contract vocabulary | `packages/shared/src/types/m3-runtime-registry.ts` | `RunRecoveredPayload.recoveryMode`, `RunResumedPayload.resumeMode` (575-630) |

---

*End of P6-M3a contract closure. P6-M3b is not started by this document; it requires separate external authorization.*
