$ErrorActionPreference = 'Continue'

$checks = @(
  @{ Name = 'Agent Core tests'; Command = { pnpm.cmd --filter @agentos/agent-core test } },
  @{ Name = 'Server tests'; Command = { pnpm.cmd --filter @agentos/server test } },
  @{ Name = 'Web build'; Command = { pnpm.cmd --filter @agentos/web build } },
  @{ Name = 'Monorepo build'; Command = { pnpm.cmd -r run build } }
)

$results = @()
$failed = $false

foreach ($check in $checks) {
  $startedAt = Get-Date
  Write-Host "=== $($check.Name) ==="
  Write-Host "Started: $($startedAt.ToString('o'))"

  & $check.Command
  $exitCode = $LASTEXITCODE
  $completedAt = Get-Date

  $results += [pscustomobject]@{
    Name = $check.Name
    StartedAt = $startedAt.ToString('o')
    CompletedAt = $completedAt.ToString('o')
    ExitCode = $exitCode
  }
  Write-Host "Exit code: $exitCode"

  if ($exitCode -ne 0) {
    $failed = $true
    Write-Error "Baseline check failed: $($check.Name)"
    break
  }
}

Write-Host '=== Baseline summary ==='
$results | Format-Table -AutoSize | Out-String | Write-Host

if ($failed) {
  exit 1
}

Write-Host 'All baseline checks passed: Agent Core tests, Server tests, Web build, Monorepo build.'
exit 0
