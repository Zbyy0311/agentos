# M4-P3 Provider Registry and Kimi Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a versioned, fail-closed Provider Registry, side-effect-light Provider validation, and a direct KimiCode adapter contract without schema or RunEngine changes.

**Architecture:** Keep the existing `@agentos/agent-core` adapter compatibility seam, and add provider-runtime contracts beside it. The registry resolves exact `(adapterId, adapterVersion)` identities; validation uses injected discovery/probe/auth runners; the Kimi adapter only produces launch plans, parses bounded JSONL, and returns normalized outcomes. The existing Provider Configuration repository remains the persistence authority, and the API adds only a validation seam.

**Tech Stack:** TypeScript, Node.js 22, pnpm workspaces, Vitest, Node test runner, existing `@agentos/shared` and `@agentos/agent-core` packages.

## Global Constraints

- Canonical persisted/public Provider Type is `kimicode`; legacy agent-core token `kimi` is compatibility-only.
- Built-in Adapter ID is `builtin.kimicode`; execution lookup requires an exact adapter version.
- Stable provider errors include `PROVIDER_NOT_FOUND`, `PROVIDER_EXECUTABLE_NOT_ACCESSIBLE`, `PROVIDER_CONFIG_INVALID`, `PROVIDER_AUTH_REQUIRED`, `PROVIDER_VERSION_UNSUPPORTED`, `PROVIDER_CAPABILITY_UNAVAILABLE`, `PROVIDER_INTERNAL_ERROR`, and `PROVIDER_ADAPTER_NOT_FOUND`.
- `PROVIDER_VALIDATION_FAILED` is forbidden unless a separate specification reconciliation authorizes it.
- Adapter code must not import `child_process`, mutate Run/Stage/Process state, publish canonical Events directly, persist raw secrets, or fall back silently from configured structured Kimi output.
- Do not add migrations, durable validation/session history, RunEngine integration, real Kimi execution, Codex/OpenCode adapters, or production cutover.

### Task 1: Provider contract types and registry

**Files:**
- Create: `packages/agent-core/src/providers/types.ts`
- Create: `packages/agent-core/src/providers/errors.ts`
- Create: `packages/agent-core/src/providers/registry.ts`
- Test: `packages/agent-core/src/providers/registry.test.ts`
- Modify: `packages/agent-core/src/index.ts`

**Interfaces:**
- `ProviderAdapterManifest`, `RuntimeProviderAdapter`, `ProviderConfigurationInput`, `ProviderLaunchPlan`, `ProviderValidationResult`, and stable error types are defined in `types.ts`.
- `ProviderRegistry.register`, `get`, `findByType`, `resolve`, and `list` are exact-version operations; duplicate keys and built-in replacement throw stable `ProviderRegistryError`.

- [ ] Write tests for exact lookup, duplicate/version conflict, deterministic provider-type lookup, `kimicode` canonical mapping, and missing adapter error.
- [ ] Run the provider registry test and verify the new tests fail because the contract is absent.
- [ ] Implement the smallest immutable manifest/registry/error surface.
- [ ] Run the provider registry test and verify it passes.

### Task 2: KimiCode adapter contract

**Files:**
- Create: `packages/agent-core/src/providers/kimiCodeAdapter.ts`
- Create: `packages/agent-core/src/providers/fixtures/kimi-validation-success.txt`
- Create: `packages/agent-core/src/providers/fixtures/kimi-auth-required.txt`
- Create: `packages/agent-core/src/providers/fixtures/kimi-session-complete.jsonl`
- Test: `packages/agent-core/src/providers/kimiCodeAdapter.test.ts`
- Modify: `packages/agent-core/src/index.ts`

**Interfaces:**
- `KimiCodeProviderAdapter` exposes `manifest`, `getDefaultCapabilities`, `discover`, `validate`, `buildLaunchPlan`, `parseChunk`, `finalize`, `cancel`, and `normalizeError`.
- Launch plans contain executable, separated args, cwd, safe environment metadata, `shell: false`, prompt transport, and structured JSONL output.

- [ ] Write tests for configuration normalization, canonical executable precedence, argument construction, secret-negative output, parser golden/malformed/unknown/usage cases, finalization, and cancel requests.
- [ ] Run the adapter tests and verify the expected missing-contract failures.
- [ ] Implement adapter parsing/normalization and port-only start/cancel request objects; do not add a spawn call.
- [ ] Run the adapter tests and verify they pass.
- [ ] Run an architecture-negative search proving the adapter has no `child_process` import or spawn/exec call.

### Task 3: Provider validation service and API seam

**Files:**
- Create: `packages/agent-core/src/providers/validation.ts`
- Test: `packages/agent-core/src/providers/validation.test.ts`
- Modify: `apps/server/src/routes/providerConfigs.ts`
- Test: `apps/server/src/routes/providerConfigs.test.ts`

**Interfaces:**
- `ProviderValidationService.validate` accepts a repository configuration and injected probe/discovery/auth runners and returns a sanitized, bounded validation DTO.
- `POST /api/workspaces/:workspaceId/provider-configs/:providerConfigId/validate` validates workspace ownership, calls the service, and maps stable provider errors without raw stderr/token/environment leakage.

- [ ] Write tests for disabled/archived/invalid configs, executable found/missing, supported/unsupported version, auth states, capability/output mismatch, and stable response statuses.
- [ ] Run targeted validation/API tests and verify they fail for the missing service/route.
- [ ] Implement validation with explicit error mapping and no persistence beyond the existing configuration.
- [ ] Run targeted validation/API tests and verify they pass.

### Task 4: Verification and handoff

**Files:**
- No additional production files unless a test exposes a scoped defect.

- [ ] Run targeted P3 tests, process-runtime full tests, agent-core full tests, server full tests with the observed baseline timeout recorded, shared M3 contract harness, workspace build, and `git diff --check`.
- [ ] Review the diff for schema/migration/RunEngine/cutover leakage and secret/child-process violations.
- [ ] Commit the authorized files with `feat: add M4 provider registry and Kimi adapter contract`.
- [ ] Push `runtime/m4-p3-provider-kimi` and report base/head/parent, changed files, test evidence, architecture-negative evidence, and explicit P4/cutover boundaries.
