# Controlled Group — Speaker Orchestration Owner Decisions

Status: AWAITING OWNER DECISION — no implementation authorized by this document

Base: `origin-https/main @ d58c998c` (post MF-5 Workspace Event schema
authorization). The merged substrate and PR references below were re-verified
against this revision; see `CG-orchestration-entry-audit.md`.

## 1. Where this sits

The Lite Fast Track (00-Vision.md section 13) has one open step: Controlled
Group Conversation is PARTIAL — bounded routes, budgets, stop, and the
loop-guard view are merged (PR #107, #116), and the open behavior is the
`orchestrated` reply mode (09-Conversation-Runtime.md section 11.2):
"orchestrator or template selects speakers and order."

Merged substrate (CR-5): `BoundedGroupService` (createInteraction,
version-guarded recordReply with budget/stop/loop guard, stop/complete),
turn-scoped per-Agent context snapshots (migration 023), and the bounded
routes/UI. Speaker selection today is manual: the caller names the responder.

## 2. Decision D1 — who selects the next speaker in orchestrated mode

| Option | Mechanism | Tradeoffs |
|---|---|---|
| A. Orchestrator-role member | A member with the orchestrator role (09 section 4.2) names the next speaker via an in-band directive | Flexible; needs a directive contract, parsing, and abuse guards; least deterministic |
| B. Template-declared order (RECOMMENDED) | The Conversation's workflow/template declares a deterministic speaker order (or rule) resolved by the runtime | Deterministic, auditable, replayable; no new autonomy; composes the merged Workflow Templates step |
| C. Deterministic policy function | A pure function over group state (mentions, last speaker, reply counts) picks the next speaker | Predictable; but policy is an AgentOS-owned rule, harder to explain to users than a template |

Recommendation: B first. It reuses merged primitives (templates, admission,
CR-5 budgets), keeps speaker choice reviewable as data, and does not preclude
adding A later as a template-authored directive.

## 3. Frozen constraints (not decisions)

- Every orchestrated interaction remains bounded by CR-5 budgets
  (max Agents per Turn, max replies, max hops) and the loop guard; an
  orchestrator never overrides them.
- Orchestrated Turns execute sequentially in Lite;
  `parallel-read-only` requires tested `enforcedWorkspaceReadOnly` evidence
  per Turn (09 section 11.2), unchanged.
- No infinite autonomous group chat; stop must always be available.

## 4. Decision D2 — Turn execution channel

Orchestrated replies are Provider-backed Agent Turns. Confirm the channel:

| Option | Mechanism | Tradeoffs |
|---|---|---|
| A (RECOMMENDED) | Reuse the CR-3/CR-5 conversation reply stream; orchestration only selects the responder | Light; chat-native |
| B | Bridge each reply to a Task/Run via CR-4a | Heavier; gives full Run lifecycle evidence per reply |

Recommendation: A for chat-class replies; B remains available per reply when
the user explicitly asks for durable execution.

## 5. Next action after decision

Entry audit, then (only if a new persistence need appears) schema
authorization, then implementation and CI — the established sequence. No code
or schema change is authorized by this document.
