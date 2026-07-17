$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Invoke-Check([string] $Name, [string] $Command, [string[]] $Arguments) {
  Write-Host "[preference-memory] $Name"
  & $Command @Arguments
  $exitCode = $LASTEXITCODE
  Write-Host "[preference-memory] exit=$exitCode"
  if ($exitCode -ne 0) { throw "$Name failed with exit code $exitCode" }
}

Invoke-Check 'acceptance' 'pnpm.cmd' @('--filter', '@agentos/server', 'test', '--', 'PreferenceAcceptance.test.ts')
Invoke-Check 'server tests' 'pnpm.cmd' @('--filter', '@agentos/server', 'test')
Invoke-Check 'agent-core tests' 'pnpm.cmd' @('--filter', '@agentos/agent-core', 'test')
Invoke-Check 'web build' 'pnpm.cmd' @('--filter', '@agentos/web', 'build')

git diff --check
if ($LASTEXITCODE -ne 0) { throw 'git diff --check failed' }
Write-Host '[preference-memory] all checks passed'
