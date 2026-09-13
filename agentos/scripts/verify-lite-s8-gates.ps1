<#
  S8 gate over the AgentOS end-to-end acceptance harness.

  The harness (scripts/verify-agentos-e2e.ps1) exits 1 whenever ANY gate fails,
  including the gates that can only fail because an external account is out of
  quota. This wrapper asserts the exact required composition instead of the
  bare exit code, so a green result here means: every AgentOS-owned gate passed
  and the only failures are the named external-account gates.

  Usage:
    pwsh -File scripts/verify-lite-s8-gates.ps1 -LogPath <captured harness log>
    pwsh -File scripts/verify-lite-s8-gates.ps1            # runs the harness first
#>
param(
  [string] $LogPath = '',
  [string[]] $ExternalGates = @('REAL_DIRECT_KIMI', 'REAL_GROUP', 'REAL_EXTERNAL_AGENT'),
  [string[]] $RequiredGates = @(
    'REAL_DIRECT_CODEX', 'REAL_DIRECT_OPENCODE', 'REAL_MEMORY_INJECTION', 'REAL_MEMORY_CANDIDATE',
    'REAL_CLI_FAILURE', 'REAL_CLI_CANCEL', 'REAL_WAITING_USER', 'DETERMINISTIC_LIFECYCLE', 'RECOVERY'
  )
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
  if (-not $LogPath) {
    $LogPath = Join-Path ([System.IO.Path]::GetTempPath()) ('agentos-s8-gates-' + [guid]::NewGuid().ToString('N') + '.log')
    Write-Host "running the acceptance harness; log -> $LogPath"
    pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'verify-agentos-e2e.ps1') *>&1 |
      Tee-Object -FilePath $LogPath | Out-Null
  }
  if (-not (Test-Path -LiteralPath $LogPath)) { throw "log not found: $LogPath" }
  $lines = Get-Content -LiteralPath $LogPath

  # The harness prints each gate in its final summary block.
  $verdicts = @{}
  foreach ($line in $lines) {
    # A gate may print a trailing reason after the verdict (`GATE: failed - ...`).
    if ($line -match '^-?\s*(?<gate>[A-Z][A-Z0-9_]+):\s*(?<verdict>passed|failed|not_run)\b') {
      $verdicts[$Matches['gate']] = $Matches['verdict']
    }
  }
  if ($verdicts.Count -eq 0) { throw 'no gate verdicts found in the log; the harness did not reach its summary' }

  $problems = New-Object System.Collections.Generic.List[string]
  foreach ($gate in $RequiredGates) {
    if (-not $verdicts.ContainsKey($gate)) { $problems.Add("required gate missing from the log: $gate"); continue }
    if ($verdicts[$gate] -ne 'passed') { $problems.Add("required gate did not pass: $gate = $($verdicts[$gate])") }
  }
  if ($verdicts.ContainsKey('RECOVERY') -and $verdicts['RECOVERY'] -eq 'failed') { $problems.Add('required gate did not pass: RECOVERY = failed') }

  # Any failure outside the named external-account gates is an AgentOS problem.
  foreach ($entry in $verdicts.GetEnumerator()) {
    if ($entry.Value -ne 'failed') { continue }
    if ($ExternalGates -contains $entry.Key) { continue }
    $problems.Add("unexpected failure outside the external-account gates: $($entry.Key) = failed")
  }

  $passedCount = ($RequiredGates | Where-Object { $verdicts.ContainsKey($_) -and $verdicts[$_] -eq 'passed' }).Count
  if ($problems.Count -gt 0) {
    Write-Host 'S8_GATES: failed'
    foreach ($problem in $problems) { Write-Host "  - $problem" }
    Write-Host "log: $LogPath"
    exit 1
  }
  Write-Host 'S8_GATES: passed'
  Write-Host "  required gates passed: $passedCount/$($RequiredGates.Count)"
  foreach ($gate in $ExternalGates) {
    if ($verdicts.ContainsKey($gate) -and $verdicts[$gate] -eq 'failed') { Write-Host "  external-account gate failed (allowed): $gate" }
  }
  Write-Host "log: $LogPath"
} finally {
  Pop-Location
}
