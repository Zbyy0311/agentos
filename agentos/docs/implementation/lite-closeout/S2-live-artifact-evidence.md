# LITE-07-104 live artifact evidence

Requirement: LITE-07-104 (`完成的真实review/test Artifact触发`). The row was still
GAP because every earlier run used a seeded execution record and a fixture provider
observation. This closes it with a real Provider invocation through the canonical
production composition root.

## The gate

`apps/server/src/services/run-engine/CanonicalArtifactResult.liveGate.test.ts`,
environment-gated on `M4_P4_REAL_ARTIFACT_GATE=1`:

```
cd apps/server
M4_P4_REAL_ARTIFACT_GATE=1
AGENTOS_OPENCODE_CLI=<opencode executable>
AGENTOS_OPENCODE_MODEL=deepseek/deepseek-v4-flash
  node --import tsx --test src/services/run-engine/CanonicalArtifactResult.liveGate.test.ts

  LITE-07-104 ... (65017.9388ms)  1 pass / 0 fail
```

It seeds a Workspace, Provider Configuration, Agent, Task, Run, `run.start`
Operation, the frozen legacy-pipeline v2 snapshot and its four Stages, then drives
`createProviderExecutionChain` - the same composition root the server builds - with a
real OpenCode CLI. The Workspace holds a real `port-parser.mjs` with a real
reviewable defect, so a truthful conclusion requires the model to actually read it.

## What it asserts, in the plan's fixed order

`真实 review/test 工作 -> Artifact -> 最终完成 -> ArtifactCompletion -> Memory Candidate
-> 规范事件 -> Review Queue -> 接受 -> Memory Entry`

1. Real work reached a terminal Run: all four Stages complete and the Run is
   `completed` (a Stage failure prints the provider failure code and message).
2. Artifacts are canonical: every row is `provenance_kind = 'CANONICAL'`, bound to
   this Run, attributed to a seeded Stage, and carries non-empty bounded evidence,
   so the Artifact came from the real review rather than a hand-made record.
3. Completions are type-matched and came from the canonical seam: every Artifact has
   exactly one completion, `review` conclusions are in `{approved,
   changes_requested}` and `test` conclusions in `{pass, fail}`, and every
   `source_key` starts with `canonical-result:` — which is what proves the completion
   was produced by `CanonicalArtifactResultService.capture()` rather than by a direct
   `POST /artifact-completions`. That distinction is exactly what the plan calls out:
   a directly posted completion only proves the infrastructure is reachable.
4. Candidates cite the actual Artifact: each completion's Candidate is
   `review-required`, does not claim `user-explicit` authority, and lists an
   `artifact` source whose id is that Artifact (an additional `run` source is
   truthful and allowed).
5. The fact is durable and canonical: each Candidate has a
   `memory.candidate_created` Runtime Event whose payload names it — run-scoped
   Artifact facts belong to the Run stream, while the Workspace Event vocabulary is
   for artifacts that carry no Run — and the Run's Event stream has exactly one
   Outbox row per Runtime Event.
6. The review queue closed the loop: accepting one Candidate through the production
   store API (`MemoryCandidateRepository.reviewCandidate`, the same call the review
   route makes, with the workspace event writer) promoted a Memory Entry, and that
   Entry keeps the Artifact as a source in `memory_entry_sources`.

## Two things this gate found

- A production defect, fixed in PR #154: `MemoryRuntimeEventEmitter` forwarded a
  caller `stageId` into the Event envelope although every memory Event definition
  sets `forbidsStageId: true`, so a stage-scoped memory resolve failed closed and the
  Stage was never dispatched. Without that fix this gate cannot get past the first
  Stage.
- Provider output variance is real: with a broad prompt one run exited without a
  final assistant message (`PROVIDER_OUTPUT_INVALID`). The gate now asks for one
  small file and a single JSON answer, so it measures the AgentOS chain instead of
  how a model improvises; two consecutive runs then completed the whole chain.

## Boundary

The gate is skipped in CI, which has no provider CLI: this is real-invocation
evidence produced on the operator machine, not a CI-reproducible result. It is
recorded as executed local evidence for LITE-07-104, and the matrix row should carry
exactly that, not a claim that CI re-runs it. The branch is stacked on the branches
carrying the OpenCode adapter fix (#150) and the memory envelope fix (#154).
