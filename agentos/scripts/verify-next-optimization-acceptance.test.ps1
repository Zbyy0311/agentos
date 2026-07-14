$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$script = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'verify-next-optimization-acceptance.ps1')

foreach ($required in @(
  '3100',
  '3101',
  'AGENTOS_PROJECT_ROOT',
  'AGENTOS_NEXT_DIST_DIR',
  'Get-NetTCPConnection',
  'next start',
  'try {',
  'finally {'
)) {
  if (-not $script.Contains($required)) {
    throw "Acceptance script is missing required lifecycle contract: $required"
  }
}

$nextConfig = Get-Content -Raw -LiteralPath (Join-Path $root 'apps/web/next.config.js')
if ($nextConfig -notmatch 'AGENTOS_NEXT_DIST_DIR') {
  throw 'Next config must support an isolated production dist directory.'
}

Write-Host 'Acceptance script lifecycle contract passed.'
