# M1 runtime context

Baseline: merged PR #192, main `553aea5deaeebb7e3f90af3da9384090768859cb`.

Canonical Run stages select with a query capped at 2,000 characters, built from
the durable objective and stage key. A retry may include only the normalized
code of the same stage in a failed parent Run belonging to the same task and
workspace. Chat Turns use the current request and their role/stage information.
FTS treats all user tokens as literals and boosts a match on any query term;
eligibility and scope filtering still precede ranking and budgets.

Migration 042 adds immutable Turn payloads alongside the existing CR snapshot
headers. Migration 043 adds immutable compatibility execution contexts. Both
store the injected text, selected versions, reasons, exclusions and degradation
status. Compatibility executions retain their original UUIDs and ownership;
they cannot claim canonical task/Run scope. Existing metadata-only headers are
not backfilled. A payload write failure prevents Provider execution. Run-stage
replay and execution freeze use their original persisted payload.

`GET /api/workspaces/:workspaceId/memory/contexts` is a pure read projection,
bounded to the latest 100 records, optionally filtered by `kind` (`run`, `stage`,
`turn`, `legacy-execution`) and `ownerId`. Filtering occurs before the limit.
The project knowledge panel's 使用记录 tab displays these frozen records;
missing historical payloads are explicitly labeled and never reconstructed
from current Entries. Workspace changes discard stale HTTP responses.

Verification commands (run from `agentos` unless indicated):

- `pnpm --filter @agentos/server test`
- `pnpm --filter @agentos/web test`
- from `apps/server`: `node --import tsx --test ../../packages/shared/*test.ts`
- `pnpm build`
- `node scripts/verify-lite-scope.mjs`
- from `apps/server`, optional real Provider gate:
  `M1_REAL_MEMORY_GATE=1 AGENTOS_CODEX_CLI=<native executable> node --import tsx --test --test-name-pattern="M1 real Codex" src/services/run-engine/RunEngineProviderDispatcher.test.ts`

The real gate drives four canonical stages through the installed Codex CLI,
asserts versioned persisted memory for each, and checks the Provider output for
the checkpoint value. It is environment-gated in CI. HTTP prompt-capture tests
use a local fixture process and are distinct from this real model acceptance.
Rendered browser checks use Playwright because the Browser skill/plugin is not
available: desktop 1440x1000 and mobile 440x900, frozen body/version, degradation,
missing historical body, kind filtering, overflow and console checks. Browser
API fixtures make no model calls. New CI receipts are bound to the new commit;
historical Lite receipts and frozen requirements remain unchanged.

M2 adds lifecycle and preference confirmation; M3 adds evidence-controlled
automatic facts and version-linked feedback; M4 adds optional embeddings and
the fixed retrieval corpus. Those stages are not delivered by M1.
