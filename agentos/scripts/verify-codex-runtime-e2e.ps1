param([string] $CodexCli = '')
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$old = $env:AGENTOS_CODEX_CLI
try {
  if ($CodexCli) { $env:AGENTOS_CODEX_CLI = $CodexCli }
  & node (Join-Path $repoRoot 'scripts/verify-codex-runtime-e2e.mjs')
  if ($LASTEXITCODE -ne 0) { throw "Codex runtime fixture gate failed with exit code $LASTEXITCODE" }
} finally {
  if ($old) { $env:AGENTOS_CODEX_CLI = $old } else { Remove-Item Env:AGENTOS_CODEX_CLI -ErrorAction SilentlyContinue }
}
