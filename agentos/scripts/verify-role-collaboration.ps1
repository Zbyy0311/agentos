$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  node scripts/verify-role-collaboration.mjs
} finally {
  Pop-Location
}
