# M4 optional semantic retrieval and maintenance

SQLite and FTS remain independently usable. Semantic mode defaults to `off`.
Explicit `local` mode accepts a loopback OpenAI-compatible embedding endpoint;
`remote` mode additionally requires `AGENTOS_MEMORY_SEMANTIC_REMOTE_ENABLED=true`.
Both require `AGENTOS_MEMORY_SEMANTIC_ENDPOINT`, `AGENTOS_MEMORY_SEMANTIC_MODEL_ID`
and `AGENTOS_MEMORY_SEMANTIC_MODEL_VERSION`; the API key is optional. HTTP is
accepted only for loopback endpoints. Provider errors expose safe reason codes.

Migration 048 stores rebuildable entry and query vectors in SQLite. Entry cache
keys include the Entry version, exact text hash and model identity/version. No
vector database or automatic transfer of legacy memory records is introduced.
Eligibility, scope, preference binding, safety, status and validity filters run
before embeddings. They run again after the asynchronous operation before
selection. Pins and exact FTS matches retain their baseline positions; semantic
scores order the remaining candidates. The ordinary production budget still
decides the frozen selection. Selection reasons include `semantic-relevance`.

Canonical Run, Stage, Turn and compatibility execution use async preparation for
new calls and persisted original text for replay. Snapshot failure blocks the
Provider. Cache, configuration and service failures preserve FTS results and
record their reason in the immutable retrieval strategy and diagnostics. The
history UI displays the recorded fallback, selected versions and actual body.
The old synchronous retrieval API remains available; it uses only fresh cached
vectors. `POST /memory/retrieve/prepare` validates durable owners before warming
the same filtered candidate set and returns status without exposing Entry text.

New direct and group chat selections honor the current workspace memory switch
before retrieval and after asynchronous preparation. A disabled workspace freezes
an empty payload with a `memory-disabled` strategy; replay retains its original
frozen payload. Disabling memory during preparation cannot inject a new selection.

The fixed corpus contains 80 Entries and 96 labeled queries: English, Chinese,
terminology, paraphrases and 16 no-match cases. The production quality evaluator
uses the configured model on actual corpus text, SQLite FTS and the production
budget. Activation requires a durable receipt for the current corpus bytes and
model identity/version: overall recall must not regress and paraphrase recall
must improve. No-match false positives are reported separately. Test vectors
exercise ranking/cache mechanics and cannot mint a production quality receipt.

To evaluate an explicitly configured real model, set the variables above and
`AGENTOS_PROJECT_ROOT` to the intended AgentOS data directory, then from
`apps/server` run:

```text
node --import tsx ../../scripts/verify-memory-semantic.mts
```

The command records the source Git revision and writes a receipt only if the
quality gate passes. A missing fixture, missing receipt or model/corpus change
fails closed to FTS. A dist-only package must ship the corpus fixture next to the
compiled service. No real embedding endpoint is assumed by tests or enabled by
default; synthetic quality numbers are not evidence of a real model's quality.

`GET /memory/maintenance` proposes revalidation or validity changes for expired
Entries and current-version outdated feedback, or archive review for old,
unpinned, low-importance/low-confidence ordinary Entries. Global memories and
preferences are excluded. Suggestions never change Entries, feedback or frozen
history; the UI opens the existing version-checked lifecycle controls.

Validation includes cache/version/content/model invalidation, scope and secrets,
remote opt-in, post-await archive/expiry/update races, async frozen replay,
fail-closed snapshots, maintenance purity, real-adapter activation gating and
the bilingual corpus. Full server, Web, shared-contract and workspace build
checks run in CI. Prompt capture and the environment-gated real Codex Provider
acceptance remain separate checks. New receipts bind the new commit; historical
Lite receipts and requirements stay unchanged.
