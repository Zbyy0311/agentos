$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $projectRoot
try {
  function Invoke-Checked([string]$Label, [scriptblock]$Command) {
    Write-Host "== $Label =="
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
  }

  $backupIndex = Join-Path $projectRoot '.agentos/latest-provider-runtime-backup.txt'
  if (-not (Test-Path -LiteralPath $backupIndex -PathType Leaf)) { throw "A0 backup index missing: $backupIndex" }
  $backupRoot = (Get-Content -Raw -LiteralPath $backupIndex).Trim()
  $backupRootResolved = (Resolve-Path -LiteralPath $backupRoot).Path
  $backupParent = (Resolve-Path (Join-Path $projectRoot '.agentos/backups')).Path
  if (-not $backupRootResolved.StartsWith($backupParent, [StringComparison]::OrdinalIgnoreCase)) { throw 'A0 backup path escapes .agentos/backups' }
  foreach ($required in @('status.txt', 'head.txt', 'tracked.patch', 'database-verification.json', 'workspace-state')) {
    if (-not (Test-Path -LiteralPath (Join-Path $backupRootResolved $required))) { throw "A0 backup artifact missing: $required" }
  }

  Invoke-Checked 'Agent core tests' { pnpm.cmd --filter @agentos/agent-core test }
  Invoke-Checked 'Server tests' { pnpm.cmd --filter @agentos/server test }
  Invoke-Checked 'Web tests' { pnpm.cmd --filter @agentos/web test }
  Invoke-Checked 'Workspace builds' { pnpm.cmd -r run build }
  Invoke-Checked 'Git diff check' { git diff --check }

  $kimi = Get-Command kimi -ErrorAction SilentlyContinue
  if (-not $kimi) { throw 'Kimi CLI is required for Plan A4 Gate' }
  $kimiVersion = (& $kimi.Source --version 2>&1 | Out-String).Trim()
  if (-not $kimiVersion) { throw 'Kimi version probe returned no output' }
  $kimiHelp = (& $kimi.Source --help 2>&1 | Out-String)
  if ($kimiHelp -notmatch '(?s)--output-format.*stream-json|stream-json.*--output-format') { throw 'Kimi help does not advertise stream-json' }
  Write-Host "Kimi: PASS ($kimiVersion)"

  $openCode = Get-Command opencode -ErrorAction SilentlyContinue
  $openCodeStatus = if ($openCode) { 'PASS' } else { 'BLOCKED: command not found' }
  if (-not $openCode -and (Test-Path -LiteralPath (Join-Path $projectRoot 'packages/agent-core/src/adapters/openCodeAdapter.ts'))) {
    throw 'OpenCode adapter exists while the real OpenCode gate is blocked'
  }
  Write-Host "OpenCode: $openCodeStatus"
  Write-Host 'Provider runtime verification passed; OpenCode may remain explicitly BLOCKED.'
}
finally {
  Pop-Location
}
