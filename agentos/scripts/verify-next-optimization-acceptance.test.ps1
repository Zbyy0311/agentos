$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$script = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'verify-next-optimization-acceptance.ps1')

foreach ($required in @(
  '3100',
  '3101',
  'AGENTOS_PROJECT_ROOT',
  'AGENTOS_NEXT_DIST_DIR',
  'AGENTOS_NEXT_TSCONFIG_PATH',
  'tsconfig.acceptance-',
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
if ($nextConfig -notmatch 'AGENTOS_NEXT_DIST_DIR' -or $nextConfig -notmatch 'tsconfigPath') {
  throw 'Next config must support isolated production dist and tsconfig paths.'
}

Write-Host 'Acceptance script lifecycle contract passed.'
