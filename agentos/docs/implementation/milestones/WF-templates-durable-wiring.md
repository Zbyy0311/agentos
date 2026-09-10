# Workflow Templates — Durable Task/Run/Stage Wiring — Frozen Design

Status: FROZEN DESIGN — WIRING NOT IMPLEMENTED — AWAITING OWNER AUTHORIZATION (touches the canonical Run startup path)

## 1. Basis

| Field | Value |
|---|---|
| Base | PR #116 stack (Conversation Runtime + UI) |
| Merged | Workflow Template catalog + instantiation contracts (PR #99, PR #103): `wf-templates.ts`, `wf-template-instantiation.ts` |
| Product authority | docs/Runtime-Specification lite/09-Conversation-Runtime.md section 12; 01-Core-Concepts.md section 9 |
| Package kind | schema-free design + integration audit; no source change |

## 2. What exists today (read-only audit, exact lines)

| Fact | Evidence |
|---|---|
| A template compiles to a `WorkflowDefinitionPayloadV2` with explicit role→AgentRole bindings | `packages/shared/src/types/wf-template-instantiation.ts` `instantiateWorkflowTemplate` |
| The compiler is pure and produces no persistence/API/execution | `wf-template-instantiation.ts` header comment |
| Workflow definitions are global immutable built-ins; the repository has NO insert | `apps/server/src/store/WorkflowDefinitionRepository.ts` (only findById / findByKeyVersion / findLatestAvailableByKey) |
| The canonical Run startup resolves a hardcoded definition and binds its Stages to Agents+Providers | `services/SnapshotService.ts` `resolveUnbound` (:357) and `resolveLegacy` (:371-449) |
| Stage binding requires a workspace Agent matching the Stage's AgentRole and an enabled Provider | `services/SnapshotService.ts:389-432` |
| Snapshot + Stages are persisted from a resolved configuration | `services/SnapshotService.ts:452` `persistResolvedRun` |
| A canonical Run requires a Task (runs.task_id NOT NULL) | migrations 006 |

## 3. The wiring decision (REQUIRES OWNER AUTHORIZATION)

To instantiate a template into durable Task/Run/Stage primitives:

- **(A) Persist the compiled definition as a new Workflow Definition row, then resolve and bind it.** This makes a template a first-class durable definition. It requires a NEW insert capability on `WorkflowDefinitionRepository` (today definitions are immutable built-ins) and a generalized resolver that resolves an arbitrary V2 definition (not the hardcoded legacy/unbound keys). Largest, most faithful.
- **(B) Resolve the compiled template in-memory into a ResolvedRunConfiguration without persisting the definition, and reference the template by key on the Snapshot.** No new repository write; the Snapshot records the definition identity but the definition itself is not a durable row. Smaller, but the definition is then not a first-class record.

Recommendation: **(A)** — the Lite contract says templates *instantiate durable primitives*, and a persisted definition is auditable and re-runnable. But (A) adds a write capability to a repository that today holds only immutable built-ins, so it needs the owner.

## 4. Frozen design (option A)

```text
WorkflowTemplateService.instantiateTemplateRun({ workspaceId, template, roleBindings, createdBy })
  -> compile (instantiateWorkflowTemplate) — pure, deterministic
  -> persist the compiled WorkflowDefinition (NEW insert capability)
  -> resolve+bind each Stage to a workspace Agent + enabled Provider (generalize the resolveLegacy binding)
  -> create the Task (TaskRepository)
  -> create the Run + persist Snapshot + Stages (persistResolvedRun path)
```

Frozen rules:

- a template never hard-codes an Agent or Provider; unbound roles fail closed (compiler);
- Stage keys/dependencies come from the template; modifying Stages stay serialized by their dependency chain;
- the Run goes through admission like any canonical Run (no bypass);
- no edit to the legacy pipeline or the unbound definition, and no change to the existing resolve paths;
- a new definition row is additive and never mutates a built-in.

## 5. Acceptance matrix

| Gate | Requirement |
|---|---|
| WF-A1 | A compiled template persists as a durable Workflow Definition. |
| WF-A2 | Instantiating a template creates exactly one Task and one Run. |
| WF-A3 | Each template Stage becomes a Run Stage with the template's key/sequence/dependencies. |
| WF-A4 | An unbound role fails closed before anything is persisted. |
| WF-A5 | The Run passes through admission like any canonical Run. |
| WF-A6 | The legacy pipeline and unbound definitions still resolve unchanged (no regression). |
| WF-A7 | No secret values in the definition, snapshot, or stages. |

## 6. Open decisions requiring owner authorization

1. **Definition persistence** (option A vs B, above).
2. **Agent/Provider binding for arbitrary stages**: reuse the resolveLegacy binding
   (role→workspace agent→enabled provider) generalized, or a new binding policy.
3. **Where instantiation lives**: a new `WorkflowTemplateService` (recommended) versus
   extending `SnapshotService`/`TaskRunService`.

## 7. Explicit prohibitions

- No edit to the canonical Run startup's existing resolve paths; the wiring adds, it does not rewrite.
- No admission bypass; no second workflow authority.
- No route/UI in this slice; the durable wiring is a service seam.
- No mutation of the immutable built-in definitions.

