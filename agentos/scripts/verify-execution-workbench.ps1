$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
  pnpm.cmd --filter @agentos/agent-core test
  pnpm.cmd --filter @agentos/server test
  pnpm.cmd --filter @agentos/web test
  pnpm.cmd -r run build
  pnpm.cmd --filter @agentos/web exec node --import tsx ../../scripts/verify-execution-workbench.mjs
  git diff --check
} finally {
  Pop-Location
}
