# AgentOS local readiness and diagnostics (Windows)

The local server exposes `/api/health` as a liveness probe and `/api/readiness` as the launcher readiness contract. `/api/health/ready` is an alias to the same readiness handler; neither alias can turn a failed database or migration check into a ready result.

Readiness reports SQLite integrity and foreign-key checks, registered migration checksums and pending/mismatched migrations, active runtime/recovery state, maintenance lease state, and Provider status. Provider entries include authentication state, CLI version, declared capabilities, and stable error codes. Provider degradation remains visible separately from database readiness. Credential values, raw probe messages, executable paths, workspace/data-root paths, and private configuration are omitted from the diagnostics export at `/api/diagnostics/export`.

For packaged builds without Git metadata, set `AGENTOS_BUILD_VERSION`, `AGENTOS_BUILD_COMMIT`, and `AGENTOS_BUILD_ID`. A checkout defaults to its package version and current Git commit. The Windows launcher's `AGENTOS_PROJECT_ROOT` selects the server data root; `AGENTOS_DATA_ROOT` is retained as a fallback. `AGENTOS_SERVER_INSTANCE_ID` can identify a supervised local instance and is generated when unset or invalid.

Server diagnostic logs are written below `.agentos/logs/diagnostics` in the data root. Each instance log rotates at 8 MiB and retains four numbered files in addition to the active file. Rotation only renames regular files and refuses symlink/reparse-point entries.
