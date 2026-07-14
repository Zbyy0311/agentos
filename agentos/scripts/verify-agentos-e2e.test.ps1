$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $PSScriptRoot 'verify-agentos-e2e.ps1')
$driver = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $PSScriptRoot 'verify-agentos-e2e.mjs')

foreach ($required in @(
  'AGENTOS_PROJECT_ROOT', 'AGENTOS_E2E_PHASE', 'e2e-failing-agent.mjs', 'e2e-waiting-agent.mjs',
  'REAL_EXTERNAL_AGENT', 'DETERMINISTIC_LIFECYCLE', 'RECOVERY', 'MEMORY_CANDIDATE', 'agentos.sqlite',
  '$workspace.rootPath = $workspaceRoot', 'git -C $workspaceRoot init', 'AGENTOS_RESUME_SCOPE', 'AGENTOS_CANDIDATE_SCOPE', 'AGENTOS_WAITING_REQUIRED'
)) {
  if ($script -notmatch [regex]::Escape($required) -and $driver -notmatch [regex]::Escape($required)) {
    throw "E2E contract is missing: $required"
  }
}

if ($driver -match 'AGENTOS_FORCE_MOCK') { throw 'E2E driver must not use mock mode.' }
if ($driver -match '(?i)(api[_-]?key|authorization)\s*[:=]') { throw 'E2E driver must not contain credential material.' }
foreach ($fixture in @('e2e-failing-agent.mjs', 'e2e-waiting-agent.mjs')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "fixtures\$fixture"))) { throw "Fixture is missing: $fixture" }
}
Write-Output 'E2E script contract passed.'
