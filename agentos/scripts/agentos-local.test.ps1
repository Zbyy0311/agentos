[CmdletBinding()]
param(
  [int] $TimeoutSeconds = 25
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True([bool] $Condition, [string] $Message) {
  if (-not $Condition) { throw $Message }
}

function Get-FreePort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}

function Write-Utf8NoBom([string] $Path, [string] $Value) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) { [void](New-Item -ItemType Directory -Path $parent -Force) }
  [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}

function Invoke-LauncherJson([string] $Path, [string[]] $ExtraArguments) {
  $callArguments = @{ Json = $true }
  for ($index = 0; $index -lt $ExtraArguments.Count; $index++) {
    $argument = [string]$ExtraArguments[$index]
    if (-not $argument.StartsWith('-')) { throw "Invalid launcher test argument: $argument" }
    $name = $argument.TrimStart('-')
    if (($index + 1) -lt $ExtraArguments.Count -and -not ([string]$ExtraArguments[$index + 1]).StartsWith('-')) {
      $index++
      $callArguments[$name] = [string]$ExtraArguments[$index]
    } else {
      $callArguments[$name] = $true
    }
  }
  $output = @(& $Path @callArguments 2>&1)
  if ($output.Count -ne 1) { throw "Expected one JSON line from the launcher; received $($output.Count) lines: $($output -join [Environment]::NewLine)" }
  try { return [pscustomobject]@{ text = [string]$output[0]; value = ([string]$output[0] | ConvertFrom-Json) } }
  catch { throw "Launcher did not return valid JSON: $($output -join [Environment]::NewLine)" }
}

function Wait-File([string] $Path, [int] $Timeout) {
  $deadline = (Get-Date).AddSeconds($Timeout)
  while (-not (Test-Path -LiteralPath $Path) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }
  return (Test-Path -LiteralPath $Path)
}

$launcher = Join-Path $PSScriptRoot 'agentos-local.ps1'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$testId = [guid]::NewGuid().ToString('N')
$tempParent = [System.IO.Path]::GetFullPath($env:TEMP)
$tempRoot = Join-Path $tempParent ('agentos local lifecycle ' + $testId)
$fixtureRoot = Join-Path $tempRoot 'fixture root with spaces'
$dataRoot = Join-Path $tempRoot 'isolated data'
$dryDataRoot = Join-Path $tempRoot 'dry run data'
$manifestPath = Join-Path $dataRoot '.agentos/local-runtime/manifest.json'
$unrelated = $null
$sleeper = $null
$savedManifest = $null
$ownedPids = @()
$originalFixtureEnv = [Environment]::GetEnvironmentVariable('AGENTOS_API_TOKEN', 'Process')
$originalReadinessEnv = [Environment]::GetEnvironmentVariable('AGENTOS_FIXTURE_READINESS', 'Process')
$originalFailWebEnv = [Environment]::GetEnvironmentVariable('AGENTOS_FIXTURE_FAIL_WEB', 'Process')
$temporaryWasCreated = $false
$testFailure = $null
$cleanupFailure = $null
$testErrors = [System.Collections.Generic.List[string]]::new()

try {
  [void](New-Item -ItemType Directory -Path $fixtureRoot -Force)
  $temporaryWasCreated = $true
  $serverScript = @'
const http = require('node:http');
const host = process.env.AGENTOS_SERVER_HOST || '127.0.0.1';
const port = Number(process.env.PORT);
const server = http.createServer((req, res) => {
  if (req.url === '/api/readiness' && process.env.AGENTOS_FIXTURE_READINESS === 'true') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ready: true }));
    return;
  }
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, projectRoot: process.env.AGENTOS_PROJECT_ROOT }));
    return;
  }
  if (req.url === '/api/secret-check') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(process.env.AGENTOS_API_TOKEN || '');
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, host, () => {
  const line = 'L'.repeat(32768) + '\n';
  for (let index = 0; index < 129; index += 1) process.stdout.write(line);
  process.stderr.write('authorization: Bearer ' + process.env.AGENTOS_API_TOKEN + '\n');
});
'@
  $nextScript = @'
const http = require('node:http');
const args = process.argv.slice(2);
function value(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
}
const host = value('--hostname', '127.0.0.1');
const port = Number(value('--port', '3001'));
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><body>fixture production web</body></html>');
});
if (process.env.AGENTOS_FIXTURE_FAIL_WEB === 'true') {
  process.stdout.write('fixture web listener intentionally disabled\n');
  setInterval(() => {}, 60000);
} else {
  server.listen(port, host);
}
'@
  $occupiedScript = @'
const http = require('node:http');
const port = Number(process.argv[2]);
const readyFile = process.argv[3];
http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('unrelated listener is alive');
}).listen(port, '127.0.0.1', () => require('node:fs').writeFileSync(readyFile, String(process.pid)));
'@
  $sleeperScript = 'setInterval(() => {}, 60000);'
  Write-Utf8NoBom (Join-Path $fixtureRoot 'apps/server/dist/index.js') $serverScript
  Write-Utf8NoBom (Join-Path $fixtureRoot 'apps/web/node_modules/next/dist/bin/next') $nextScript
  Write-Utf8NoBom (Join-Path $fixtureRoot 'apps/web/.next/BUILD_ID') 'fixture-build'
  Write-Utf8NoBom (Join-Path $fixtureRoot 'unrelated-listener.cjs') $occupiedScript
  Write-Utf8NoBom (Join-Path $fixtureRoot 'unrelated-sleeper.cjs') $sleeperScript
  $fixtureSecret = '  local launcher fixture = secret  '
  Write-Utf8NoBom (Join-Path $fixtureRoot '.env') ('AGENTOS_API_TOKEN="' + $fixtureSecret + '"' + [Environment]::NewLine)

  # Dry-run validates production inputs and configuration without creating runtime state.
  $dryServerPort = Get-FreePort
  $dryWebPort = Get-FreePort
  while ($dryWebPort -eq $dryServerPort) { $dryWebPort = Get-FreePort }
  $dry = Invoke-LauncherJson $launcher @('-Action', 'start', '-DryRun', '-Root', $fixtureRoot, '-DataPath', $dryDataRoot, '-ServerHost', '127.0.0.1', '-WebHost', '127.0.0.1', '-ServerPort', [string]$dryServerPort, '-WebPort', [string]$dryWebPort)
  Assert-True ($dry.value.ok -and $dry.value.state -eq 'dry-run' -and -not $dry.value.secretsIncluded) ("Dry-run did not return the expected safe JSON status: " + $dry.text)
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $dryDataRoot '.agentos/local-runtime'))) 'Dry-run created runtime state.'

  # An unrelated child owns a requested port. Failed start and stop must leave it running.
  $conflictPort = Get-FreePort
  $webPort = Get-FreePort
  while ($webPort -eq $conflictPort) { $webPort = Get-FreePort }
  $readyFile = Join-Path $tempRoot 'unrelated-ready.txt'
  $unrelatedArgs = '"' + (Join-Path $fixtureRoot 'unrelated-listener.cjs') + '" ' + $conflictPort + ' "' + $readyFile + '"'
  $unrelated = Start-Process -FilePath $nodePath -ArgumentList $unrelatedArgs -WorkingDirectory $fixtureRoot -WindowStyle Hidden -PassThru
  Assert-True (Wait-File $readyFile 8) 'The unrelated port-holder child did not become ready.'
  $conflictRejected = $false
  try {
    & $launcher -Action start -Root $fixtureRoot -DataPath $dataRoot -ServerHost '127.0.0.1' -WebHost '127.0.0.1' -ServerPort $conflictPort -WebPort $webPort
  } catch {
    $conflictRejected = $_.Exception.Message -match 'already listening' -and $_.Exception.Message -match [string]$conflictPort
  }
  Assert-True $conflictRejected 'Starting on an occupied port did not return an actionable conflict.'
  $null = & $launcher -Action stop -DataPath $dataRoot -Json
  Assert-True (-not $unrelated.HasExited) 'A failed start or stop killed the unrelated child process.'
  $unrelatedResponse = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $conflictPort + '/') -TimeoutSec 3
  Assert-True ($unrelatedResponse.Content -eq 'unrelated listener is alive') 'The unrelated listener stopped answering after conflict handling.'
  $unrelated.Kill()
  [void]$unrelated.WaitForExit(5000)
  $unrelated = $null

  # Start the two owned services using isolated data, then verify bounded readiness and status.
  $serverPort = Get-FreePort
  $webPort = Get-FreePort
  while ($webPort -eq $serverPort) { $webPort = Get-FreePort }
  $started = Invoke-LauncherJson $launcher @('-Action', 'start', '-Root', $fixtureRoot, '-DataPath', $dataRoot, '-ServerHost', '127.0.0.1', '-WebHost', '127.0.0.1', '-ServerPort', [string]$serverPort, '-WebPort', [string]$webPort, '-ReadyTimeoutSeconds', [string]$TimeoutSeconds)
  Assert-True ($started.value.ok -and $started.value.state -eq 'running') ("Owned production fixture did not reach ready state: " + $started.text)
  $ownedPids = @($started.value.processPids | ForEach-Object { [int]$_ })
  Assert-True ($ownedPids.Count -ge 3) 'The manifest did not record supervisor, server and web process IDs.'
  $status = Invoke-LauncherJson $launcher @('-Action', 'status', '-Root', $fixtureRoot, '-DataPath', $dataRoot)
  Assert-True ($status.value.state -eq 'running' -and $status.value.endpoints.server -and $status.value.endpoints.web) 'Status did not report the owned processes and both ready endpoints.'
  Assert-True ($status.value.endpoints.serverPortOwned -and $status.value.endpoints.webPortOwned) 'Status did not verify that the owned process trees hold both ports.'
  Assert-True (-not $status.text.Contains($fixtureSecret)) 'Machine-readable status exposed a .env value.'
  $manifestText = Get-Content -LiteralPath $manifestPath -Raw
  Assert-True (-not $manifestText.Contains($fixtureSecret)) 'The process manifest exposed a .env value.'
  $manifestObject = $manifestText | ConvertFrom-Json
  Assert-True ($manifestObject.instanceId -eq $started.value.instanceId -and -not [string]::IsNullOrWhiteSpace([string]$manifestObject.instanceId)) 'The manifest did not persist the returned instance ID.'
  foreach ($role in @('supervisor', 'server', 'web')) {
    $record = $manifestObject.processes | Where-Object { $_.role -eq $role } | Select-Object -First 1
    $expectedPort = if ($role -eq 'server') { $serverPort } elseif ($role -eq 'web') { $webPort } else { $serverPort }
    Assert-True ($record.pid -gt 0 -and -not [string]::IsNullOrWhiteSpace($record.createdAt) -and -not [string]::IsNullOrWhiteSpace($record.executable) -and -not [string]::IsNullOrWhiteSpace($record.command) -and $record.root -eq $fixtureRoot -and $record.port -eq $expectedPort) ("Manifest is missing process identity fields for " + $role + '.')
  }
  foreach ($role in @('server', 'web')) {
    $record = $manifestObject.processes | Where-Object { $_.role -eq $role } | Select-Object -First 1
    Assert-True (@($record.portOwners).Count -gt 0 -and @($record.portOwners | Where-Object { $_.pid -gt 0 -and -not [string]::IsNullOrWhiteSpace($_.createdAt) -and -not [string]::IsNullOrWhiteSpace($_.executable) }).Count -eq @($record.portOwners).Count) ("Manifest did not persist verified port-owner identity for " + $role + '.')
  }
  $secretResponse = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $serverPort + '/api/secret-check') -TimeoutSec 3
  Assert-True ($secretResponse.Content -ceq $fixtureSecret) '.env parsing changed a quoted value or truncated its equals/whitespace content.'

  $stdoutLog = Join-Path $dataRoot '.agentos/local-runtime/server.stdout.log'
  $stderrLog = Join-Path $dataRoot '.agentos/local-runtime/server.stderr.log'
  $rotatedLog = $stdoutLog + '.1'
  Assert-True ((Test-Path -LiteralPath $rotatedLog) -and (Get-Item -LiteralPath $rotatedLog).Length -le 4MB -and (Get-Item -LiteralPath $stdoutLog).Length -le 4MB) 'Owned server logs did not rotate at the configured size bound.'
  $diagnosticText = Get-Content -LiteralPath $stderrLog -Raw
  Assert-True (-not $diagnosticText.Contains($fixtureSecret) -and $diagnosticText.Contains('[REDACTED]')) 'Sensitive environment values were not removed from persistent diagnostics.'

  # Replace one recorded PID with a live unrelated PID. Status and stop must reject the mismatch without killing anything.
  $sleeper = Start-Process -FilePath $nodePath -ArgumentList ('"' + (Join-Path $fixtureRoot 'unrelated-sleeper.cjs') + '"') -WorkingDirectory $fixtureRoot -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 300
  $savedManifest = Get-Content -LiteralPath $manifestPath -Raw
  $tampered = $savedManifest | ConvertFrom-Json
  $serverRecord = $tampered.processes | Where-Object { $_.role -eq 'server' } | Select-Object -First 1
  $serverRecord.pid = [int]$sleeper.Id
  Write-Utf8NoBom $manifestPath (ConvertTo-Json -InputObject $tampered -Depth 10)
  $staleStatus = Invoke-LauncherJson $launcher @('-Action', 'status', '-Root', $fixtureRoot, '-DataPath', $dataRoot)
  Assert-True ($staleStatus.value.state -eq 'identity-mismatch' -and -not $staleStatus.value.ok) 'Status did not detect the stale/reused PID identity mismatch.'
  $stopRefused = $false
  try { & $launcher -Action stop -Root $fixtureRoot -DataPath $dataRoot } catch {
    $stopRefused = $_.Exception.Message -match 'identity mismatch'
  }
  Assert-True $stopRefused 'Stop did not refuse the stale manifest PID.'
  Assert-True (-not $sleeper.HasExited) 'Stop killed the unrelated process referenced by the stale PID.'
  foreach ($pidValue in $ownedPids) {
    Assert-True ($null -ne (Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$pidValue) -ErrorAction SilentlyContinue)) ("Stop touched an owned process after identity mismatch (PID " + $pidValue + ').')
  }

  # Restore the authentic manifest, then stop only its verified process tree.
  Write-Utf8NoBom $manifestPath $savedManifest
  $null = & $launcher -Action stop -Root $fixtureRoot -DataPath $dataRoot -Json
  $deadline = (Get-Date).AddSeconds(10)
  do {
    $remaining = @($ownedPids | Where-Object { $null -ne (Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$_) -ErrorAction SilentlyContinue) })
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $deadline)
  Assert-True ($remaining.Count -eq 0) 'Verified stop left part of the owned process tree alive.'
  Assert-True (-not $sleeper.HasExited) 'Owned stop affected the unrelated sleeper process.'
  $stopped = Invoke-LauncherJson $launcher @('-Action', 'status', '-Root', $fixtureRoot, '-DataPath', $dataRoot)
  Assert-True ($stopped.value.state -eq 'stopped' -and $stopped.value.ok) 'Status did not report stopped after verified cleanup.'
  $sleeper.Kill()
  [void]$sleeper.WaitForExit(5000)
  $sleeper = $null

  # Prefer the new readiness contract while retaining the health endpoint fallback.
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_READINESS', 'true', 'Process')
  $readinessServerPort = Get-FreePort
  $readinessWebPort = Get-FreePort
  while ($readinessWebPort -eq $readinessServerPort) { $readinessWebPort = Get-FreePort }
  $readinessStart = Invoke-LauncherJson $launcher @('-Action', 'start', '-Root', $fixtureRoot, '-DataPath', $dataRoot, '-ServerHost', '127.0.0.1', '-WebHost', '127.0.0.1', '-ServerPort', [string]$readinessServerPort, '-WebPort', [string]$readinessWebPort, '-ReadyTimeoutSeconds', [string]$TimeoutSeconds)
  Assert-True ($readinessStart.value.ok -and $readinessStart.value.state -eq 'running') ("Startup using /api/readiness failed: " + $readinessStart.text)
  $readinessStatus = Invoke-LauncherJson $launcher @('-Action', 'status', '-Root', $fixtureRoot, '-DataPath', $dataRoot)
  Assert-True ($readinessStatus.value.endpoints.serverReadinessPath -eq '/api/readiness') 'Status did not retain the successful /api/readiness path.'
  $pidsDirectory = Join-Path $dataRoot '.agentos/local-runtime'
  $archivedPidRecords = @(Get-ChildItem -Path (Join-Path $pidsDirectory 'worker-pids.json.*.previous') -File -ErrorAction SilentlyContinue)
  Assert-True ($archivedPidRecords.Count -ge 1) 'Restart discarded the previous runtime process record instead of archiving it.'
  $readinessPids = @($readinessStart.value.processPids | ForEach-Object { [int]$_ })
  $null = Invoke-LauncherJson $launcher @('-Action', 'stop', '-Root', $fixtureRoot, '-DataPath', $dataRoot)
  $readinessDeadline = (Get-Date).AddSeconds(10)
  do {
    $readinessRemaining = @($readinessPids | Where-Object { $null -ne (Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$_) -ErrorAction SilentlyContinue) })
    if ($readinessRemaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $readinessDeadline)
  Assert-True ($readinessRemaining.Count -eq 0) 'Readiness-contract fixture did not stop cleanly.'

  # A service that never opens its port must time out and leave no owned process tree.
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_FAIL_WEB', 'true', 'Process')
  $failureServerPort = Get-FreePort
  $failureWebPort = Get-FreePort
  while ($failureWebPort -eq $failureServerPort) { $failureWebPort = Get-FreePort }
  $failureTimer = [System.Diagnostics.Stopwatch]::StartNew()
  $failedStart = Invoke-LauncherJson $launcher @('-Action', 'start', '-Root', $fixtureRoot, '-DataPath', $dataRoot, '-ServerHost', '127.0.0.1', '-WebHost', '127.0.0.1', '-ServerPort', [string]$failureServerPort, '-WebPort', [string]$failureWebPort, '-ReadyTimeoutSeconds', '1')
  $failureTimer.Stop()
  Assert-True (-not $failedStart.value.ok -and $failedStart.value.error -match 'Readiness timed out') ("A failed readiness probe did not report bounded startup failure: " + $failedStart.text)
  Assert-True ($failureTimer.Elapsed.TotalSeconds -lt 12) 'A failed readiness probe exceeded the bounded startup and cleanup time.'
  $failedManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  Assert-True ($failedManifest.state -eq 'stopped') 'Failed startup did not preserve a stopped diagnostic manifest.'
  $failedPids = @($failedManifest.processes | ForEach-Object { [int]$_.pid })
  $failureDeadline = (Get-Date).AddSeconds(10)
  do {
    $failedRemaining = @($failedPids | Where-Object { $null -ne (Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$_) -ErrorAction SilentlyContinue) })
    if ($failedRemaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $failureDeadline)
  Assert-True ($failedRemaining.Count -eq 0) 'Readiness timeout leaked one or more owned child processes.'

  Write-Output 'PASS: dry-run isolation, occupied-port conflict preserves unrelated child, safe reused-PID refusal, owned status/stop, health/readiness probes, failed-start cleanup, archived runtime records, dotenv preservation, sensitive-log filtering, and bounded logs.'
} catch {
  $testFailure = $_.Exception
} finally {
  [Environment]::SetEnvironmentVariable('AGENTOS_API_TOKEN', $originalFixtureEnv, 'Process')
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_READINESS', $originalReadinessEnv, 'Process')
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_FAIL_WEB', $originalFailWebEnv, 'Process')
  if ($null -ne $unrelated -and -not $unrelated.HasExited) {
    try { $unrelated.Kill(); [void]$unrelated.WaitForExit(5000) } catch {}
  }
  if ($null -ne $sleeper -and -not $sleeper.HasExited) {
    try { $sleeper.Kill(); [void]$sleeper.WaitForExit(5000) } catch {}
  }
  if ($savedManifest -and (Test-Path -LiteralPath $manifestPath)) {
    try { Write-Utf8NoBom $manifestPath $savedManifest } catch {}
  }
  if ($temporaryWasCreated -and (Test-Path -LiteralPath $tempRoot)) {
    $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
    $expectedPrefix = [System.IO.Path]::GetFullPath((Join-Path $tempParent 'agentos local lifecycle '))
    if (-not $resolvedTemp.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or $resolvedTemp -eq $tempParent) {
      $cleanupFailure = 'Refusing test cleanup because the resolved temporary path is outside its dedicated test prefix.'
    } else {
      $pidsPath = Join-Path $dataRoot '.agentos/local-runtime/worker-pids.json'
      $cleanupPids = @()
      if (Test-Path -LiteralPath $manifestPath) {
        try {
          $cleanupManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
          $cleanupPids = @($cleanupManifest.processes | ForEach-Object { [int]$_.pid })
          & $launcher -Action stop -Root $fixtureRoot -DataPath $dataRoot -Json | Out-Null
        } catch {
          $cleanupFailure = 'The launcher could not safely stop the fixture instance: ' + $_.Exception.Message
        }
      }
      if (Test-Path -LiteralPath $pidsPath) {
        try {
          $workerIds = Get-Content -LiteralPath $pidsPath -Raw | ConvertFrom-Json
          $cleanupPids += @([int]$workerIds.supervisorPid, [int]$workerIds.serverPid, [int]$workerIds.webPid)
          $workerProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$workerIds.supervisorPid) -ErrorAction SilentlyContinue
          if ($null -ne $workerProcess) {
            $workerCommand = [string]$workerProcess.CommandLine
            $ownsWorker = [string]::Equals([string]$workerProcess.ExecutablePath, $nodePath, [System.StringComparison]::OrdinalIgnoreCase) -and
              $workerCommand.Contains('agentos-local-worker.mjs') -and
              $workerCommand.Contains([string]$workerIds.instanceId) -and
              $workerCommand.Contains($fixtureRoot) -and
              $workerCommand.Contains($dataRoot)
            $children = @(Get-CimInstance Win32_Process | Where-Object { [int]$_.ParentProcessId -eq [int]$workerIds.supervisorPid })
            $validChildren = @($children | Where-Object {
              ([string]::Equals([string]$_.ExecutablePath, $nodePath, [System.StringComparison]::OrdinalIgnoreCase) -and [string]$_.CommandLine.Contains($fixtureRoot)) -or
              [string]::Equals([string]$_.ExecutablePath, (Join-Path $env:SystemRoot 'System32/conhost.exe'), [System.StringComparison]::OrdinalIgnoreCase)
            })
            if (-not $ownsWorker -or $validChildren.Count -ne $children.Count) {
              $cleanupFailure = 'The temporary worker identity did not match the unique fixture; its directory was preserved.'
            } else {
              & (Join-Path $env:SystemRoot 'System32/taskkill.exe') /PID ([int]$workerIds.supervisorPid) /T /F 2>$null | Out-Null
            }
          }
        } catch {
          if ($null -eq $cleanupFailure) { $cleanupFailure = 'The fixture worker required fallback cleanup: ' + $_.Exception.Message }
        }
      }
      $deadline = (Get-Date).AddSeconds(10)
      do {
        $remainingPids = @($cleanupPids | Sort-Object -Unique | Where-Object {
          $null -ne (Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$_) -ErrorAction SilentlyContinue)
        })
        if ($remainingPids.Count -eq 0) { break }
        Start-Sleep -Milliseconds 150
      } while ((Get-Date) -lt $deadline)
      if ($remainingPids.Count -gt 0) {
        $cleanupFailure = 'The fixture process IDs are still active (' + ($remainingPids -join ', ') + '); its temporary directory was preserved.'
      }
      if ($null -eq $cleanupFailure -and $remainingPids.Count -eq 0) {
        Get-ChildItem -LiteralPath $resolvedTemp -File -Recurse -Force | Remove-Item -Force
        $directories = @(Get-ChildItem -LiteralPath $resolvedTemp -Directory -Recurse -Force | Sort-Object { $_.FullName.Length } -Descending)
        foreach ($directory in $directories) { Remove-Item -LiteralPath $directory.FullName -Force }
        Remove-Item -LiteralPath $resolvedTemp -Force
      }
    }
  }
}

if ($null -ne $testFailure -and $null -ne $cleanupFailure) { throw ('Test failed: ' + $testFailure.Message + ' Cleanup also failed: ' + $cleanupFailure) }
if ($null -ne $testFailure) { throw $testFailure }
if ($null -ne $cleanupFailure) { throw $cleanupFailure }
