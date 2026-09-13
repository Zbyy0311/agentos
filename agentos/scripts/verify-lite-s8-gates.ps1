<#
  Strict S8 gate over the AgentOS end-to-end acceptance harness.

  A PASS requires every known gate, including the real-provider gates, to have
  a final 'passed' verdict and requires the harness process to have returned
  raw exit code 0. External quota, account, or executable failures remain
  failures; this wrapper has no external-gate allowlist.

  When this script runs the harness, it captures the raw exit code itself:
    pwsh -File scripts/verify-lite-s8-gates.ps1

  When reviewing an already captured log, the raw exit must be supplied from
  the same invocation receipt. A gate log by itself cannot be promoted:
    pwsh -File scripts/verify-lite-s8-gates.ps1 -LogPath <captured harness log> -RawExitCode <raw exit>
#>
[CmdletBinding()]
param(
  [string] $LogPath = '',
  [Alias('HarnessExitCode')]
  [Nullable[int]] $RawExitCode = $null,
  [string] $EvidencePath = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$requiredGates = @(
  'REAL_DIRECT_CODEX', 'REAL_DIRECT_KIMI', 'REAL_DIRECT_OPENCODE', 'REAL_GROUP',
  'REAL_EXTERNAL_AGENT', 'REAL_MEMORY_INJECTION', 'REAL_MEMORY_CANDIDATE',
  'REAL_CLI_FAILURE', 'REAL_CLI_CANCEL', 'REAL_WAITING_USER',
  'DETERMINISTIC_LIFECYCLE', 'RECOVERY'
)
$knownGates = @($requiredGates + 'MEMORY_CANDIDATE') | Sort-Object -Unique

Push-Location $repo
try {
  $harnessWasRun = $false
  $rawHarnessExitCode = $RawExitCode
  if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $harnessWasRun = $true
    $LogPath = Join-Path ([System.IO.Path]::GetTempPath()) ('agentos-s8-gates-' + [guid]::NewGuid().ToString('N') + '.log')
    Write-Host "running the acceptance harness; log -> $LogPath"
    & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'verify-agentos-e2e.ps1') *>&1 |
      Tee-Object -FilePath $LogPath | Out-Null
    # Capture immediately. Do not replace a nonzero child result with the
    # verdict computed below.
    $rawHarnessExitCode = [int]$LASTEXITCODE
  }

  if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) {
    throw "log not found: $LogPath"
  }
  $resolvedLogPath = (Resolve-Path -LiteralPath $LogPath).Path
  $logSha256 = (Get-FileHash -LiteralPath $resolvedLogPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $lines = [System.IO.File]::ReadAllLines($resolvedLogPath)

  # A caller may preserve the raw exit in the log as a machine-readable line.
  # It is accepted only when every such line agrees; a missing receipt remains
  # an evidence failure even if the gate text looks green.
  $recordedRawExits = New-Object System.Collections.Generic.List[int]
  foreach ($line in $lines) {
    if ($line -match '^\s*S8_RAW_EXIT_CODE:\s*(-?\d+)\s*$') {
      $recordedRawExits.Add([int]$Matches[1])
    }
  }
  if ($null -eq $rawHarnessExitCode -and $recordedRawExits.Count -gt 0) {
    $rawHarnessExitCode = $recordedRawExits[0]
  }

  $escapedGates = $knownGates | ForEach-Object { [regex]::Escape($_) }
  $knownGatePattern = ($escapedGates -join '|')
  $verdictRegex = "^\s*(?:[-*]\s*)?(?<gate>$knownGatePattern):\s*(?<verdict>passed|failed|not_run|skipped|manual|planned)\b"
  $genericVerdictRegex = '^\s*(?:[-*]\s*)?(?<gate>[A-Z][A-Z0-9_]+):\s*(?<verdict>passed|failed|not_run|skipped|manual|planned)\b'
  $occurrences = @{}
  $unknownVerdicts = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    if ($line -match $verdictRegex) {
      $gate = $Matches['gate']
      if (-not $occurrences.ContainsKey($gate)) { $occurrences[$gate] = @() }
      $occurrences[$gate] = @($occurrences[$gate]) + $Matches['verdict']
    } elseif ($line -match $genericVerdictRegex -and $knownGates -notcontains $Matches['gate']) {
      $unknownVerdicts.Add("$($Matches['gate']) = $($Matches['verdict'])")
    }
  }
  if ($occurrences.Count -eq 0) { throw 'no recognized gate verdicts found in the log; the harness did not reach its summary' }

  $verdicts = [ordered]@{}
  foreach ($gate in ($occurrences.Keys | Sort-Object)) {
    $values = @($occurrences[$gate])
    $verdicts[$gate] = $values[$values.Count - 1]
  }

  $problems = New-Object System.Collections.Generic.List[string]
  if ($recordedRawExits.Count -gt 1 -and (@($recordedRawExits | Sort-Object -Unique).Count -ne 1)) {
    $problems.Add('conflicting S8_RAW_EXIT_CODE records in the log')
  }
  if ($null -ne $rawHarnessExitCode -and @($recordedRawExits | Where-Object { $_ -ne $rawHarnessExitCode }).Count -gt 0) {
    $problems.Add('raw exit argument disagrees with recorded harness exit')
  }
  if ($null -eq $rawHarnessExitCode) {
    $problems.Add('raw harness exit code is missing; gate text alone is not evidence of PASS')
  } elseif ([int]$rawHarnessExitCode -ne 0) {
    $problems.Add("raw harness exit code was $rawHarnessExitCode")
  }
  foreach ($unknown in $unknownVerdicts) {
    $problems.Add("unrecognized gate verdict in the log: $unknown")
  }

  foreach ($gate in $requiredGates) {
    if (-not $verdicts.Contains($gate)) {
      $problems.Add("required gate missing from the log: $gate")
      continue
    }
    if ($verdicts[$gate] -ne 'passed') {
      $problems.Add("required gate did not pass: $gate = $($verdicts[$gate])")
    }
  }

  # Preserve a failure observed in any occurrence. The only expected
  # multi-phase exception is RECOVERY's pre-recovery not_run followed by its
  # recovery passed result; it still must finish with passed.
  foreach ($gate in $occurrences.Keys) {
    $values = @($occurrences[$gate])
    if ($values -contains 'failed') {
      $problems.Add("raw gate failure observed: $gate = failed")
    }
    $allowRecoveryNotRun = ($gate -eq 'RECOVERY' -and $values.Count -gt 1 -and $values[$values.Count - 1] -eq 'passed' -and (@($values | Where-Object { $_ -notin @('not_run', 'passed') }).Count -eq 0))
    foreach ($value in $values) {
      if ($value -in @('skipped', 'manual', 'planned')) {
        $problems.Add("non-executed gate result cannot prove PASS: $gate = $value")
      } elseif ($value -eq 'not_run' -and -not $allowRecoveryNotRun) {
        $problems.Add("non-executed gate result cannot prove PASS: $gate = not_run")
      }
    }
  }

  $status = if ($problems.Count -eq 0) { 'passed' } else { 'failed' }
  $reportedOccurrences = [ordered]@{}
  foreach ($gate in ($occurrences.Keys | Sort-Object)) {
    $reportedOccurrences[$gate] = @($occurrences[$gate])
  }
  $report = [ordered]@{
    schemaVersion = 2
    status = $status
    logPath = $resolvedLogPath
    logSha256 = $logSha256
    rawHarnessExitCode = if ($null -eq $rawHarnessExitCode) { $null } else { [int]$rawHarnessExitCode }
    harnessWasRun = $harnessWasRun
    verdicts = $verdicts
    verdictOccurrences = $reportedOccurrences
    problems = @($problems)
  }
  if (-not [string]::IsNullOrWhiteSpace($EvidencePath)) {
    $evidenceParent = Split-Path -Parent $EvidencePath
    if ($evidenceParent) { New-Item -ItemType Directory -Force -Path $evidenceParent | Out-Null }
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $EvidencePath -Encoding utf8NoBOM
  }

  Write-Host "S8_GATES: $status"
  Write-Host "raw_harness_exit_code: $($report.rawHarnessExitCode)"
  Write-Host "log_sha256: $logSha256"
  Write-Host "log: $resolvedLogPath"
  foreach ($problem in $problems) { Write-Host "  - $problem" }
  if ($EvidencePath) { Write-Host "evidence: $EvidencePath" }
  if ($status -eq 'failed') { exit 1 }
  exit 0
} finally {
  Pop-Location
}
