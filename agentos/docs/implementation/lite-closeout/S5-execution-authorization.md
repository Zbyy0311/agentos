# S5 conversation execution-boundary authorization (frozen v1)

Requirements: LITE-09-010, LITE-09-013, LITE-09-101, LITE-09-102. Authority:
user-approved tightened plan (D1=B, D2=A, D3=off) plus the S0 matrix. Base:
merged main `948b8008`. No migration is required for these four rows: the
existing `cr_turn_context_snapshots`, `cr_agent_turns` and Workspace admission
contracts already carry every field the exits need.

## Fixed boundaries

- A Message-only Turn never creates a Task or Run, and a chat reply never
  gains Workspace-modifying authority from serialization or prompt wording.
- D1=B: ordinary chat messages do not implicitly grant modification
  permission. D2=A: an action needing modification must go through the
  explicit Run path. D3 stays off; no new capability is enabled.
- Existing admission contracts are reused as-is; no second admission system
  and no new Policy product.

## LITE-09-101: pre-invocation frozen context

Before the Provider is invoked, the direct Turn must resolve and persist a
bounded, per-Agent context snapshot, and the Provider must receive exactly that
frozen selection:

- snapshot persisted first; a persistence failure must prevent the Provider
  call instead of silently falling back to unbounded history;
- bounded, deterministic message window plus the injected `TurnContextSelector`
  selection (memory entry identities, budget, truncation flag);
- the recorded Turn references the snapshot it actually used, so a later
  Inspector read can prove which selection produced the reply;
- no Message editing, no versioning subsystem, no SSE semantic change.

## LITE-09-102 / 010 / 013: no implicit modifying authority

A Direct or Group Provider call that can modify the Workspace must not proceed
on the strength of chat serialization alone:

- when verified enforced-read-only evidence exists for the Workspace, chat may
  proceed read-only;
- when that evidence is unavailable or unproven, the request fails closed with
  a stable code and a truthful message that an explicit Run is required;
- the refusal happens before any Provider invocation and before any durable
  mutating side effect, and never fabricates an admission result;
- per-Agent isolation is preserved: one Agent's frozen selection is never
  handed to another Agent's Provider call, and each Agent Turn keeps its own
  snapshot identity;
- tests must cover the refusal path, the read-only path, and the
  concurrent/interleaved case where two chat Turns target one Workspace.

## Evidence and gates

Each row keeps its GAP state until its exact exit is demonstrated with
reproducible evidence. Browser-disconnect semantics stay as they are: a
disconnect only ends the subscription. This authorization is not itself
implementation or acceptance evidence.
