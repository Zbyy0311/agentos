[CmdletBinding()]
param(
  [int] $TimeoutSeconds = 25
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$null = Add-Type -AssemblyName System.Net.Http

function Assert-True([bool] $Condition, [string] $Message) {
  if (-not $Condition) { throw $Message }
}

function Get-FreePort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}

function Convert-ToUtcCreationTimestamp($Value) {
  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { throw 'Creation timestamp is missing.' }
  return ([datetime]$Value).ToUniversalTime().ToString('o')
}

function Get-ProcessRecordIdentityState($Record, $Process) {
  if ($null -eq $Process) { return 'missing' }
  try {
    if (($null -eq $Record -or [int]$Record.pid -le 0 -or [int]$Record.parentPid -le 0 -or
      [string]::IsNullOrWhiteSpace([string]$Record.executable) -or [string]::IsNullOrWhiteSpace([string]$Record.command) -or
      [string]::IsNullOrWhiteSpace([string]$Process.ExecutablePath) -or [string]::IsNullOrWhiteSpace([string]$Process.CommandLine) -or
      $null -eq $Process.ParentProcessId)) { return 'uncertain' }
    $expectedCreatedAt = Convert-ToUtcCreationTimestamp $Record.createdAt
    $actualCreatedAt = Convert-ToUtcCreationTimestamp $Process.CreationDate
  } catch { return 'uncertain' }
  $matches = ([int]$Process.ProcessId -eq [int]$Record.pid -and
    $actualCreatedAt -eq $expectedCreatedAt -and
    [int]$Process.ParentProcessId -eq [int]$Record.parentPid -and
    [string]::Equals([string]$Process.ExecutablePath, [string]$Record.executable, [System.StringComparison]::OrdinalIgnoreCase) -and
    [string]::Equals([string]$Process.CommandLine, [string]$Record.command, [System.StringComparison]::Ordinal))
  return $(if ($matches) { 'match' } else { 'different' })
}

function Get-RemainingOwnedProcessRecordsFromSnapshot($Records, $Snapshot) {
  $remaining = @()
  foreach ($record in @($Records)) {
    $process = $Snapshot[[int]$record.pid]
    $identityState = Get-ProcessRecordIdentityState $record $process
    if ($identityState -in @('match', 'uncertain')) { $remaining += $record }
  }
  return $remaining
}

function Get-RemainingOwnedProcessRecords($Records) {
  $snapshot = @{}
  foreach ($process in @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate, ExecutablePath, CommandLine -ErrorAction Stop)) {
    $snapshot[[int]$process.ProcessId] = $process
  }
  return Get-RemainingOwnedProcessRecordsFromSnapshot $Records $snapshot
}

function Get-ManifestProcessRecord($Manifest, [string] $Role) {
  return $Manifest.processes | Where-Object { $_.role -eq $Role } | Select-Object -First 1
}

function Register-FixtureStartAttempt {
  $script:fixtureStartState.attempts += 1
  $script:fixtureStartState.previousInstanceId = $null
  $script:fixtureStartState.previousManifestReadable = $true
  try {
    if (Test-Path -LiteralPath $script:manifestPath) {
      $previous = Get-Content -LiteralPath $script:manifestPath -Raw | ConvertFrom-Json
      if ([string]::IsNullOrWhiteSpace([string]$previous.instanceId)) { throw 'The previous instance identity is missing.' }
      $script:fixtureStartState.previousInstanceId = [string]$previous.instanceId
    }
  } catch { $script:fixtureStartState.previousManifestReadable = $false }
}

function Get-FixtureCleanupDisposition($StartState, $Manifest, $StopResult, $RemainingRecords, [bool] $HasRuntimeEvidence) {
  try {
    if ($StartState.attempts -eq 0 -and -not $HasRuntimeEvidence) { return 'never-started' }
    if ($StartState.attempts -le 0 -or -not $StartState.previousManifestReadable -or -not $HasRuntimeEvidence) { return 'preserve' }
    if ($null -eq $Manifest -or [string]::IsNullOrWhiteSpace([string]$Manifest.instanceId) -or
      [string]$Manifest.instanceId -eq [string]$StartState.previousInstanceId) { return 'preserve' }
    $records = @($Manifest.processes)
    foreach ($role in @('supervisor', 'server', 'web')) {
      if (@($records | Where-Object { $_.role -eq $role }).Count -ne 1) { return 'preserve' }
    }
    if (@($records | ForEach-Object { [int]$_.pid } | Sort-Object -Unique).Count -ne $records.Count) { return 'preserve' }
    foreach ($record in $records) {
      if ([int]$record.pid -le 0 -or [int]$record.parentPid -le 0 -or
        [string]::IsNullOrWhiteSpace([string]$record.executable) -or [string]::IsNullOrWhiteSpace([string]$record.command)) { return 'preserve' }
      $null = Convert-ToUtcCreationTimestamp $record.createdAt
    }
    if ($null -eq $StopResult -or $StopResult.ok -isnot [bool] -or -not $StopResult.ok -or
      $StopResult.state -ne 'stopped' -or [string]$StopResult.instanceId -ne [string]$Manifest.instanceId -or
      @($RemainingRecords).Count -ne 0) { return 'preserve' }
    return 'verified-stopped'
  } catch { return 'preserve' }
}

function Get-ProcessRecordIdentityEvidence($Records) {
  $snapshot = @{}
  foreach ($process in @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate, ExecutablePath, CommandLine -ErrorAction Stop)) {
    $snapshot[[int]$process.ProcessId] = $process
  }
  return @($Records | ForEach-Object {
    $record = $_
    $process = $snapshot[[int]$record.pid]
    $actualCreatedAt = $null
    if ($null -ne $process) { try { $actualCreatedAt = Convert-ToUtcCreationTimestamp $process.CreationDate } catch { } }
    $expectedCreatedAt = 'unreadable'
    try { $expectedCreatedAt = Convert-ToUtcCreationTimestamp $record.createdAt } catch { }
    [pscustomobject]@{
      pid = [int]$record.pid
      expectedCreatedAt = $expectedCreatedAt
      actualCreatedAt = $actualCreatedAt
      state = Get-ProcessRecordIdentityState $record $process
    }
  })
}

function Write-Utf8NoBom([string] $Path, [string] $Value) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) { [void](New-Item -ItemType Directory -Path $parent -Force) }
  [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}

function Clear-FixtureApiToken {
  [Environment]::SetEnvironmentVariable('AGENTOS_API_TOKEN', $null, 'Process')
  Remove-Item -LiteralPath 'Env:AGENTOS_API_TOKEN' -ErrorAction SilentlyContinue
}

function Invoke-LauncherJson([string] $Path, [string[]] $ExtraArguments) {
  Clear-FixtureApiToken
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
  if ($callArguments['Action'] -eq 'start' -and -not $callArguments.ContainsKey('DryRun')) {
    Register-FixtureStartAttempt
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

function Wait-Text([string] $Path, [string] $Text, [int] $Timeout) {
  $deadline = (Get-Date).AddSeconds($Timeout)
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path -LiteralPath $Path -PathType Leaf) -and [System.IO.File]::ReadAllText($Path).Contains($Text)) { return $true }
    Start-Sleep -Milliseconds 50
  }
  return $false
}

function Send-NamedPipeRequest([string] $PipePath, [string] $InstanceId, [string] $Nonce, [string] $Operation = 'shutdown') {
  $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipePath.Substring('\\.\pipe\'.Length), [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::None)
  try {
    $client.Connect(3000)
    $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false), 1024, $true)
    $reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false), $false, 1024, $true)
    try {
      $writer.WriteLine((ConvertTo-Json -InputObject ([ordered]@{ operation = $Operation; instanceId = $InstanceId; nonce = $Nonce }) -Compress))
      $writer.Flush()
      $readTask = $reader.ReadLineAsync()
      if (-not $readTask.Wait(3000)) { throw 'The named-pipe fixture response timed out.' }
      return ($readTask.GetAwaiter().GetResult() | ConvertFrom-Json)
    } finally { $writer.Dispose(); $reader.Dispose() }
  } finally { $client.Dispose() }
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
$cleanupManifest = $null
$cleanupRecords = @()
$fixtureStartState = @{ attempts = 0; previousInstanceId = $null; previousManifestReadable = $true }
$originalFixtureEnv = [Environment]::GetEnvironmentVariable('AGENTOS_API_TOKEN', 'Process')
$originalReadinessEnv = [Environment]::GetEnvironmentVariable('AGENTOS_FIXTURE_READINESS', 'Process')
$originalMaintenanceReadinessEnv = [Environment]::GetEnvironmentVariable('AGENTOS_FIXTURE_MAINTENANCE_READINESS', 'Process')
$originalReadiness503Env = [Environment]::GetEnvironmentVariable('AGENTOS_FIXTURE_READINESS_503', 'Process')
$originalFailWebEnv = [Environment]::GetEnvironmentVariable('AGENTOS_FIXTURE_FAIL_WEB', 'Process')
$originalRefuseShutdownEnv = [Environment]::GetEnvironmentVariable('AGENTOS_FIXTURE_REFUSE_SHUTDOWN', 'Process')
$originalEventFileEnv = [Environment]::GetEnvironmentVariable('AGENTOS_FIXTURE_EVENT_FILE', 'Process')
$temporaryWasCreated = $false
$testFailure = $null
$cleanupFailure = $null
$testErrors = [System.Collections.Generic.List[string]]::new()

try {
  $identityProbe = [pscustomobject]@{
    pid = 424242; parentPid = 101; createdAt = '2026-10-03T00:00:00.0000000Z'
    executable = 'C:\fixture\node.exe'; command = 'node fixture.js'
  }
  $sameIdentityProbe = [pscustomobject]@{
    ProcessId = 424242; ParentProcessId = 101; CreationDate = [datetime]::Parse('2026-10-03T00:00:00.0000000Z').ToLocalTime()
    ExecutablePath = 'C:\fixture\node.exe'; CommandLine = 'node fixture.js'
  }
  $jsonManifestProbe = @{
    pid = 424242; parentPid = 101; createdAt = '2026-10-03T00:00:00.0000000Z'
    executable = 'C:\fixture\node.exe'; command = 'node fixture.js'
  } | ConvertTo-Json | ConvertFrom-Json
  $reusedPidProbe = [pscustomobject]@{
    ProcessId = 424242; ParentProcessId = 101; CreationDate = [datetime]::Parse('2026-10-03T00:00:01.0000000Z').ToLocalTime()
    ExecutablePath = 'C:\fixture\node.exe'; CommandLine = 'node fixture.js'
  }
  Assert-True ($identityProbe.createdAt -is [string] -and $jsonManifestProbe.createdAt -is [datetime]) 'The identity test did not reproduce the JSON ISO-date conversion.'
  Assert-True ((Get-ProcessRecordIdentityState $identityProbe $sameIdentityProbe) -eq 'match') 'Exact string/datetime timestamps were not normalized to the same live process identity.'
  Assert-True ((Get-ProcessRecordIdentityState $jsonManifestProbe $sameIdentityProbe) -eq 'match') 'ConvertFrom-Json DateTime timestamps were not recognized as the same live process identity.'
  Assert-True (@(Get-RemainingOwnedProcessRecordsFromSnapshot @($jsonManifestProbe) @{ 424242 = $sameIdentityProbe }).Count -eq 1) 'A matching live process from a JSON manifest was mistaken as exited.'
  Assert-True ((Get-ProcessRecordIdentityState $identityProbe $reusedPidProbe) -eq 'different') 'A reused PID was mistaken for the original process.'
  $unreadableProbe = [pscustomobject]@{ ProcessId = 424242; ParentProcessId = 101; CreationDate = $null; ExecutablePath = ''; CommandLine = '' }
  Assert-True ((Get-ProcessRecordIdentityState $identityProbe $unreadableProbe) -eq 'uncertain') 'An uninspectable live PID was not conservatively classified as uncertain.'
  Assert-True (@(Get-RemainingOwnedProcessRecordsFromSnapshot @($identityProbe) @{ 424242 = $unreadableProbe }).Count -eq 1) 'Uncertain live-process identity was treated as exited and eligible for cleanup.'
  $falseStoppedResponse = '{"ok":false,"state":"stopped","instanceId":"fixture-instance"}' | ConvertFrom-Json
  $falseStoppedAccepted = [bool]$falseStoppedResponse.ok -and $falseStoppedResponse.state -eq 'stopped' -and $falseStoppedResponse.instanceId -eq 'fixture-instance'
  Assert-True (-not $falseStoppedAccepted) 'A JSON stop response with ok=false was accepted as a verified stop.'

  # These are guard inputs, not runtime receipts: no process or ownership file is changed.
  $neverStartedProbe = @{ attempts = 0; previousInstanceId = $null; previousManifestReadable = $true }
  $attemptedProbe = @{ attempts = 1; previousInstanceId = $null; previousManifestReadable = $true }
  $cleanupManifestProbe = [pscustomobject]@{ instanceId = 'fixture-instance'; processes = @(
    foreach ($role in @('supervisor', 'server', 'web')) {
      [pscustomobject]@{ role = $role; pid = 424242 + @('supervisor', 'server', 'web').IndexOf($role); parentPid = 101
        createdAt = $identityProbe.createdAt; executable = $identityProbe.executable; command = $identityProbe.command }
    }
  ) }
  $cleanupStopProbe = [pscustomobject]@{ ok = $true; state = 'stopped'; instanceId = 'fixture-instance' }
  Assert-True ((Get-FixtureCleanupDisposition $neverStartedProbe $null $null @() $false) -eq 'never-started') 'A fixture that never attempted start cannot be cleaned.'
  Assert-True ((Get-FixtureCleanupDisposition $neverStartedProbe $null $null @() $true) -eq 'preserve') 'Unexpected runtime evidence was ignored before any start attempt.'
  Assert-True ((Get-FixtureCleanupDisposition $attemptedProbe $null $null @() $false) -eq 'preserve') 'All-missing runtime evidence after a start attempt was mistaken for proof of exit.'
  Assert-True ((Get-FixtureCleanupDisposition $attemptedProbe $cleanupManifestProbe $null @() $true) -eq 'preserve') 'Process identities without a matching stop result authorized cleanup.'
  Assert-True ((Get-FixtureCleanupDisposition $attemptedProbe $cleanupManifestProbe $falseStoppedResponse @() $true) -eq 'preserve') 'A refused stop authorized cleanup.'
  Assert-True ((Get-FixtureCleanupDisposition $attemptedProbe $cleanupManifestProbe $cleanupStopProbe @($identityProbe) $true) -eq 'preserve') 'A remaining or uncertain owned process authorized cleanup.'
  Assert-True ((Get-FixtureCleanupDisposition $attemptedProbe $cleanupManifestProbe $cleanupStopProbe @() $true) -eq 'verified-stopped') 'Complete stopped-instance evidence cannot authorize cleanup.'
  $emptyManifestProbe = [pscustomobject]@{ instanceId = 'fixture-instance'; processes = @() }
  Assert-True ((Get-FixtureCleanupDisposition $attemptedProbe $emptyManifestProbe $cleanupStopProbe @() $true) -eq 'preserve') 'Empty process records were accepted as stopped ownership.'
  $wrongStopProbe = [pscustomobject]@{ ok = $true; state = 'stopped'; instanceId = 'another-instance' }
  Assert-True ((Get-FixtureCleanupDisposition $attemptedProbe $cleanupManifestProbe $wrongStopProbe @() $true) -eq 'preserve') 'An unrelated instance stop authorized cleanup.'
  $nextAttemptProbe = @{ attempts = 2; previousInstanceId = 'fixture-instance'; previousManifestReadable = $true }
  Assert-True ((Get-FixtureCleanupDisposition $nextAttemptProbe $cleanupManifestProbe $cleanupStopProbe @() $true) -eq 'preserve') 'An earlier stopped instance authorized cleanup after a new start attempt.'
  $unknownPreviousProbe = @{ attempts = 1; previousInstanceId = $null; previousManifestReadable = $false }
  Assert-True ((Get-FixtureCleanupDisposition $unknownPreviousProbe $cleanupManifestProbe $cleanupStopProbe @() $true) -eq 'preserve') 'An unreadable previous identity authorized cleanup.'
  $incompleteManifestProbe = [pscustomobject]@{ instanceId = 'fixture-instance'; processes = @($cleanupManifestProbe.processes | Select-Object -First 2) }
  Assert-True ((Get-FixtureCleanupDisposition $attemptedProbe $incompleteManifestProbe $cleanupStopProbe @() $true) -eq 'preserve') 'Partial process identity records authorized cleanup.'
  Write-Output 'CLEANUP_GUARD_CLASSIFICATIONS: never-started, all-missing, unexpected evidence, missing/refused/mismatched stop, remaining identity, empty/partial records, stale attempt, unreadable previous identity, verified-stopped.'

  [void](New-Item -ItemType Directory -Path $fixtureRoot -Force)
  $temporaryWasCreated = $true
  $serverScript = @'
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const host = process.env.AGENTOS_SERVER_HOST || '127.0.0.1';
const port = Number(process.env.PORT);
const eventFile = process.env.AGENTOS_FIXTURE_EVENT_FILE;
const instanceId = process.env.AGENTOS_LOCAL_INSTANCE_ID;
const nonce = process.env.AGENTOS_LOCAL_SHUTDOWN_NONCE;
const pipePath = process.env.AGENTOS_LOCAL_SERVER_SHUTDOWN_PIPE;
let acceptingWrites = true;
let activeWrites = 0;
let activeRuntime = false;
let refuseShutdown = process.env.AGENTOS_FIXTURE_REFUSE_SHUTDOWN === 'true';
let shutdownRequested = false;
function event(name) { if (eventFile) fs.appendFileSync(eventFile, name + '\n'); }
  process.stderr.write(process.env.AGENTOS_SHORT_TOKEN + '\n');
const server = http.createServer((req, res) => {
  if (req.url === '/api/fixture-write' && req.method === 'POST') {
    if (!acceptingWrites) { res.writeHead(503); res.end('writes fenced'); return; }
    activeWrites += 1;
    event('write-start');
    setTimeout(() => {
      activeWrites -= 1;
      event('write-finished');
      res.writeHead(200); res.end('write completed');
      finishShutdown();
    }, 1800);
    return;
  }
  if (req.url === '/api/fixture-crash' && req.method === 'POST') {
    res.writeHead(200); res.end('crash requested', () => setTimeout(() => process.exit(37), 250));
    return;
  }
  if (req.url === '/api/health/ready') {
    if (process.env.AGENTOS_FIXTURE_READINESS_503 === 'true') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready: false }));
    } else if (process.env.AGENTOS_FIXTURE_READINESS === 'true') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready: true }));
    } else {
      res.writeHead(404);
      res.end();
    }
    return;
  }
  if (req.url === '/api/maintenance/readiness' && process.env.AGENTOS_FIXTURE_MAINTENANCE_READINESS === 'true') {
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
  if (req.url === '/api/secret-check-state') {
    const secret = process.env.AGENTOS_API_TOKEN || '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ length: secret.length, leadingSpaces: (secret.match(/^ */) || [''])[0].length, trailingSpaces: (secret.match(/ *$/) || [''])[0].length }));
    return;
  }
  res.writeHead(404);
  res.end();
});
function finishShutdown() {
  if (!shutdownRequested || activeWrites !== 0 || activeRuntime) return;
  server.close(() => { event('http-closed'); process.exit(0); });
}
const control = net.createServer(socket => {
  let raw = '';
  socket.on('data', chunk => {
    raw += chunk.toString('utf8');
    if (raw.length > 2048) { socket.destroy(); return; }
    const newline = raw.indexOf('\n');
    if (newline < 0) return;
    let message;
    try { message = JSON.parse(raw.slice(0, newline)); } catch { socket.end('{"ok":false}\n'); return; }
    if (message.operation !== 'shutdown' || message.instanceId !== instanceId || message.nonce !== nonce) {
      if (message.operation === 'fixture-allow-shutdown'
        && message.instanceId === instanceId && message.nonce === nonce) {
        refuseShutdown = false;
        event('shutdown-control-restored');
        socket.end('{"ok":true,"state":"fixture-updated"}\n');
        return;
      }
      if ((message.operation === 'fixture-active-runtime' || message.operation === 'fixture-runtime-idle')
        && message.instanceId === instanceId && message.nonce === nonce) {
        activeRuntime = message.operation === 'fixture-active-runtime';
        event(activeRuntime ? 'provider-runtime-active' : 'provider-runtime-idle');
        if (activeRuntime) setTimeout(() => { activeRuntime = false; event('provider-runtime-completed'); finishShutdown(); }, 4500);
        else finishShutdown();
        socket.end('{"ok":true,"state":"fixture-updated"}\n');
        return;
      }
      socket.end('{"ok":false,"code":"CONTROL_IDENTITY_MISMATCH"}\n'); return;
    }
    if (refuseShutdown) {
      event('shutdown-refused');
      socket.end('{"ok":false,"code":"FIXTURE_SHUTDOWN_REFUSED"}\n');
      return;
    }
    acceptingWrites = false;
    shutdownRequested = true;
    event('shutdown-requested');
    socket.end('{"ok":true,"state":"shutdown-accepted"}\n', finishShutdown);
  });
});
control.listen(pipePath, () => server.listen(port, host, () => {
  const line = 'L'.repeat(32768) + '\n';
  for (let index = 0; index < 129; index += 1) process.stdout.write(line);
  process.stderr.write(process.env.AGENTOS_SHORT_TOKEN + '\n');
  const diagnosticChunks = [
    'Authori',
    'zation: Bearer ' + process.env.AGENTOS_API_TOKEN + '\n',
    '-----BEGIN RSA ',
    'PRIVATE KEY-----\nworker-fixture-private-key-',
    'material\n-----END RSA PRIVATE',
    ' KEY-----\n',
  ];
  diagnosticChunks.forEach((chunk, index) => setTimeout(() => process.stderr.write(chunk), index * 20));
}));
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
  $shortFixtureSecret = 'x9Q'
  Write-Utf8NoBom (Join-Path $fixtureRoot '.env') ('AGENTOS_API_TOKEN="' + $fixtureSecret + '"' + [Environment]::NewLine + 'AGENTOS_SHORT_TOKEN=' + $shortFixtureSecret + [Environment]::NewLine)
  $eventFile = Join-Path $tempRoot 'fixture-events.log'
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_EVENT_FILE', $eventFile, 'Process')

  # Dry-run validates production inputs and configuration without creating runtime state.
  $dryServerPort = Get-FreePort
  $dryWebPort = Get-FreePort
  while ($dryWebPort -eq $dryServerPort) { $dryWebPort = Get-FreePort }
  $dry = Invoke-LauncherJson $launcher @('-Action', 'start', '-DryRun', '-Root', $fixtureRoot, '-DataPath', $dryDataRoot, '-ServerHost', '127.0.0.1', '-WebHost', '127.0.0.1', '-ServerPort', [string]$dryServerPort, '-WebPort', [string]$dryWebPort)
  Assert-True ($dry.value.ok -and $dry.value.state -eq 'dry-run' -and -not $dry.value.secretsIncluded) ("Dry-run did not return the expected safe JSON status: " + $dry.text)
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $dryDataRoot '.agentos/local-runtime'))) 'Dry-run created runtime state.'
  Assert-True ($fixtureStartState.attempts -eq 0) 'Dry-run was counted as a real start attempt.'

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
    Register-FixtureStartAttempt
    & $launcher -Action start -Root $fixtureRoot -DataPath $dataRoot -ServerHost '127.0.0.1' -WebHost '127.0.0.1' -ServerPort $conflictPort -WebPort $webPort
  } catch {
    $conflictRejected = $_.Exception.Message -match 'already listening' -and $_.Exception.Message -match [string]$conflictPort
  }
  Assert-True $conflictRejected 'Starting on an occupied port did not return an actionable conflict.'
  Assert-True ($fixtureStartState.attempts -eq 1) 'The rejected occupied-port start attempt was not recorded.'
  $conflictStop = Invoke-LauncherJson $launcher @('-Action', 'stop', '-DataPath', $dataRoot)
  Assert-True ($conflictStop.value.ok -and $conflictStop.value.state -eq 'stopped') ('Failed-start cleanup stop was not a verified no-op: ' + $conflictStop.text)
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
  $statusEvidence = $status.value | Select-Object state, processPids, endpoints, message | ConvertTo-Json -Compress -Depth 5
  Assert-True ($status.value.state -eq 'running' -and $status.value.endpoints.server -and $status.value.endpoints.web) ("Status did not report both ready endpoints for the owned instance. Status evidence: " + $statusEvidence)
  Assert-True ($status.value.endpoints.serverReadinessPath -eq '/api/health') 'Legacy liveness fallback was not selected when every readiness route returned 404.'
  Assert-True ($status.value.endpoints.serverPortOwned -and $status.value.endpoints.webPortOwned) ("Status did not verify that the owned process trees hold both ports. Status evidence: " + $statusEvidence)
  Assert-True (-not $status.text.Contains($fixtureSecret)) 'Machine-readable status exposed a .env value.'
  $manifestText = Get-Content -LiteralPath $manifestPath -Raw
  Assert-True (-not $manifestText.Contains($fixtureSecret)) 'The process manifest exposed a .env value.'
  $manifestObject = $manifestText | ConvertFrom-Json
  $liveCleanupRecords = @(Get-RemainingOwnedProcessRecords $manifestObject.processes)
  Assert-True ($liveCleanupRecords.Count -ge 3) 'The cleanup guard regression did not observe a real owned process tree.'
  Assert-True ((Get-FixtureCleanupDisposition $fixtureStartState $manifestObject $null $liveCleanupRecords $true) -eq 'preserve') 'The cleanup guard allowed removal while the real owned fixture was running.'
  Assert-True ($manifestObject.instanceId -eq $started.value.instanceId -and -not [string]::IsNullOrWhiteSpace([string]$manifestObject.instanceId)) 'The manifest did not persist the returned instance ID.'
  Assert-True ($manifestObject.shutdownControl.serverPipe -match ([regex]::Escape($manifestObject.instanceId) + '-server$') -and $manifestObject.shutdownControl.supervisorPipe -match ([regex]::Escape($manifestObject.instanceId) + '-supervisor$')) 'The manifest did not bind both private shutdown pipes to its instance ID.'
  $workerIdentity = Get-Content -LiteralPath (Join-Path $dataRoot '.agentos/local-runtime/worker-pids.json') -Raw | ConvertFrom-Json
  Assert-True ($workerIdentity.shutdownNonce -match '^[a-f0-9]{64}$') 'The runtime identity did not persist a local random shutdown nonce.'
  $badSupervisorControl = Send-NamedPipeRequest $workerIdentity.supervisorPipe $workerIdentity.instanceId ('0' * 64)
  $badServerControl = Send-NamedPipeRequest $workerIdentity.serverPipe $workerIdentity.instanceId ('0' * 64)
  Assert-True (-not $badSupervisorControl.ok -and -not $badServerControl.ok) 'A shutdown request with a wrong local nonce was accepted.'
  foreach ($rawControlMessage in @('null', '[]', '"invalid"', '17')) {
    $rawPipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $workerIdentity.supervisorPipe.Substring('\\.\pipe\'.Length), [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::None)
    try {
      $rawPipe.Connect(3000)
      $rawWriter = [System.IO.StreamWriter]::new($rawPipe, [System.Text.UTF8Encoding]::new($false), 1024, $true)
      $rawReader = [System.IO.StreamReader]::new($rawPipe, [System.Text.UTF8Encoding]::new($false), $false, 1024, $true)
      try {
        $rawWriter.WriteLine($rawControlMessage)
        $rawWriter.Flush()
        $rawReadTask = $rawReader.ReadLineAsync()
        Assert-True ($rawReadTask.Wait(3000)) ('The supervisor did not reject raw malformed shutdown JSON: ' + $rawControlMessage)
        $rawResponse = $rawReadTask.GetAwaiter().GetResult() | ConvertFrom-Json
        Assert-True (-not $rawResponse.ok -and $rawResponse.code -eq 'INVALID_REQUEST') ('The supervisor accepted malformed shutdown JSON: ' + $rawControlMessage)
      } finally { $rawWriter.Dispose(); $rawReader.Dispose() }
    } finally { $rawPipe.Dispose() }
  }
  $ownedAfterMalformedControls = @(Get-ProcessRecordIdentityEvidence $manifestObject.processes)
  $nonMatchingAfterMalformedControls = @($ownedAfterMalformedControls | Where-Object { $_.state -ne 'match' })
  Assert-True ($nonMatchingAfterMalformedControls.Count -eq 0) ('Malformed shutdown requests altered process ownership: ' + ($ownedAfterMalformedControls | ConvertTo-Json -Compress))
  $identityServerRecord = Get-ManifestProcessRecord $manifestObject 'server'
  Assert-True (@(Get-RemainingOwnedProcessRecords @($identityServerRecord)).Count -eq 1) 'Rejected local control altered the verified server process identity.'
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
  $secretContentStream = $secretResponse.RawContentStream
  if ($secretContentStream.CanSeek) { $secretContentStream.Position = 0 }
  $secretBuffer = [System.IO.MemoryStream]::new()
  $secretContentStream.CopyTo($secretBuffer)
  $actualSecretBytes = $secretBuffer.ToArray()
  $secretBuffer.Dispose()
  $secretStateResponse = Invoke-RestMethod -Method Get -Uri ('http://127.0.0.1:' + $serverPort + '/api/secret-check-state') -TimeoutSec 3
  $expectedSecretBytes = [System.Text.Encoding]::UTF8.GetBytes($fixtureSecret)
  $secretMatches = $actualSecretBytes.Length -eq $expectedSecretBytes.Length
  if ($secretMatches) {
    for ($byteIndex = 0; $byteIndex -lt $expectedSecretBytes.Length; $byteIndex++) {
      if ($actualSecretBytes[$byteIndex] -ne $expectedSecretBytes[$byteIndex]) { $secretMatches = $false; break }
    }
  }
  $secretEvidence = [pscustomobject]@{
    expectedLength = $expectedSecretBytes.Length
    responseLength = $actualSecretBytes.Length
    serverReceivedLength = $secretStateResponse.length
  } | ConvertTo-Json -Compress
  Assert-True ($secretMatches -and $secretStateResponse.length -eq $fixtureSecret.Length -and $secretStateResponse.leadingSpaces -eq [regex]::Match($fixtureSecret, '^ *').Length -and $secretStateResponse.trailingSpaces -eq [regex]::Match($fixtureSecret, ' *$').Length) ('.env fixture response did not preserve its expected byte length or surrounding whitespace. Safe evidence: ' + $secretEvidence)

  $stdoutLog = Join-Path $dataRoot '.agentos/local-runtime/server.stdout.log'
  $stderrLog = Join-Path $dataRoot '.agentos/local-runtime/server.stderr.log'
  $rotatedLog = $stdoutLog + '.1'
  Assert-True ((Test-Path -LiteralPath $rotatedLog) -and (Get-Item -LiteralPath $rotatedLog).Length -le 4MB -and (Get-Item -LiteralPath $stdoutLog).Length -le 4MB) 'Owned server logs did not rotate at the configured size bound.'
  $diagnosticText = Get-Content -LiteralPath $stderrLog -Raw
  Assert-True (-not $diagnosticText.Contains($fixtureSecret) -and -not $diagnosticText.Contains($shortFixtureSecret) -and $diagnosticText.Contains('[REDACTED]')) 'Sensitive environment values, including short bare values, were not removed from persistent diagnostics.'
  Assert-True (-not $diagnosticText.Contains('worker-fixture-private-key-material') -and $diagnosticText.Contains('[REDACTED_PRIVATE_KEY]')) 'Chunk-split private-key material was not removed from persistent diagnostics.'
  Assert-True (-not $diagnosticText.Contains('authorization: Bearer')) 'A chunk-split authorization header was persisted.'

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
  $stopRefused = Invoke-LauncherJson $launcher @('-Action', 'stop', '-Root', $fixtureRoot, '-DataPath', $dataRoot)
  Write-Output ('RAW_STOP_REFUSED_JSON=' + $stopRefused.text)
  Assert-True (-not $stopRefused.value.ok -and $stopRefused.value.state -eq 'error' -and $stopRefused.value.error -match 'identity mismatch') ('Stop did not refuse the stale manifest PID: ' + $stopRefused.text)
  Assert-True (-not $sleeper.HasExited) 'Stop killed the unrelated process referenced by the stale PID.'
  $stillOwnedAfterRefusal = @(Get-ProcessRecordIdentityEvidence $manifestObject.processes)
  $nonMatchingAfterRefusal = @($stillOwnedAfterRefusal | Where-Object { $_.state -ne 'match' })
  Assert-True ($nonMatchingAfterRefusal.Count -eq 0) ("Stop touched a verified process after identity mismatch: " + ($stillOwnedAfterRefusal | ConvertTo-Json -Compress))

  # Restore the authentic manifest, then stop only its verified process tree.
  Write-Utf8NoBom $manifestPath $savedManifest
  $verifiedStop = Invoke-LauncherJson $launcher @('-Action', 'stop', '-Root', $fixtureRoot, '-DataPath', $dataRoot, '-Json')
  Write-Output ('RAW_STOP_VERIFIED_JSON=' + $verifiedStop.text)
  Assert-True ($verifiedStop.value.ok -and $verifiedStop.value.state -eq 'stopped' -and $verifiedStop.value.instanceId -eq $manifestObject.instanceId) ('Verified stop did not accept the expected instance: ' + $verifiedStop.text)
  $deadline = (Get-Date).AddSeconds(10)
  do {
    $remainingRecords = @(Get-RemainingOwnedProcessRecords $manifestObject.processes)
    if ($remainingRecords.Count -eq 0) { break }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $deadline)
  $stopIdentityEvidence = @(Get-ProcessRecordIdentityEvidence $manifestObject.processes)
  Assert-True ($remainingRecords.Count -eq 0) ('Verified stop left part of the owned process tree alive: ' + (@($remainingRecords | ForEach-Object { [int]$_.pid }) -join ', ') + '; raw stop JSON: ' + $verifiedStop.text + '; PID identity evidence: ' + ($stopIdentityEvidence | ConvertTo-Json -Compress))
  Assert-True ((Get-FixtureCleanupDisposition $fixtureStartState $manifestObject $verifiedStop.value $remainingRecords $true) -eq 'verified-stopped') 'The cleanup guard rejected the real verified stopped fixture.'
  Assert-True ((Get-FixtureCleanupDisposition $fixtureStartState $null $verifiedStop.value @() $false) -eq 'preserve') 'A prior real stop result authorized cleanup without process identity evidence.'
  Write-Output 'CLEANUP_GUARD_REAL_FIXTURE: running=preserve, verified-stop=verified-stopped, missing-identities=preserve; no ownership files removed.'
  Assert-True (-not $sleeper.HasExited) 'Owned stop affected the unrelated sleeper process.'
  $stopped = Invoke-LauncherJson $launcher @('-Action', 'status', '-Root', $fixtureRoot, '-DataPath', $dataRoot)
  Assert-True ($stopped.value.state -eq 'stopped' -and $stopped.value.ok) 'Status did not report stopped after verified cleanup.'
  $sleeper.Kill()
  [void]$sleeper.WaitForExit(5000)
  $sleeper = $null

  # A disconnected in-flight write remains owned until it finishes; stop fences new writes and does not force-kill the server.
  $drainServerPort = Get-FreePort
  $drainWebPort = Get-FreePort
  while ($drainWebPort -eq $drainServerPort) { $drainWebPort = Get-FreePort }
  Remove-Item -LiteralPath $eventFile -Force -ErrorAction SilentlyContinue
  $drainStart = Invoke-LauncherJson $launcher @('-Action', 'start', '-Root', $fixtureRoot, '-DataPath', $dataRoot, '-ServerHost', '127.0.0.1', '-WebHost', '127.0.0.1', '-ServerPort', [string]$drainServerPort, '-WebPort', [string]$drainWebPort, '-ReadyTimeoutSeconds', [string]$TimeoutSeconds)
  Assert-True ($drainStart.value.ok -and $drainStart.value.state -eq 'running') 'The drain fixture did not start.'
  $drainIdentity = Get-Content -LiteralPath (Join-Path $dataRoot '.agentos/local-runtime/worker-pids.json') -Raw | ConvertFrom-Json
  $httpClient = [System.Net.Http.HttpClient]::new()
  $cancelSource = [System.Threading.CancellationTokenSource]::new()
  $writeRequest = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, ('http://127.0.0.1:' + $drainServerPort + '/api/fixture-write'))
  $writeTask = $httpClient.SendAsync($writeRequest, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancelSource.Token)
  Assert-True (Wait-Text $eventFile 'write-start' 5) 'The long-lived fixture write did not enter its critical section.'
  $cancelSource.Cancel()
  try { $null = $writeTask.GetAwaiter().GetResult() } catch { }
  $stopJob = Start-Job -ArgumentList $launcher, $fixtureRoot, $dataRoot -ScriptBlock {
    param($LauncherPath, $RepositoryRoot, $DataRoot)
    & $LauncherPath -Action stop -Root $RepositoryRoot -DataPath $DataRoot -Json
  }
  Assert-True (Wait-Text $eventFile 'shutdown-requested' 8) 'The authenticated local shutdown request did not reach the server.'
  $drainManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $drainServerRecord = Get-ManifestProcessRecord $drainManifest 'server'
  Assert-True (@(Get-RemainingOwnedProcessRecords @($drainServerRecord)).Count -eq 1) 'The verified server was killed before its in-flight write drained.'
  $blockedResponse = $httpClient.PostAsync(('http://127.0.0.1:' + $drainServerPort + '/api/fixture-write'), [System.Net.Http.StringContent]::new('')).GetAwaiter().GetResult()
  Assert-True ([int]$blockedResponse.StatusCode -eq 503) 'The server accepted a new write after graceful shutdown closed admission.'
  Assert-True (-not [System.IO.File]::ReadAllText($eventFile).Contains('http-closed')) 'HTTP closed before the owned write reached its completion boundary.'
  $stopWait = Wait-Job -Job $stopJob -Timeout 12
  Assert-True ($null -ne $stopWait) 'local:stop did not complete after the owned write drained.'
  $stopOutput = @(Receive-Job -Job $stopJob)
  Remove-Job -Job $stopJob -Force
  Assert-True ($stopOutput.Count -eq 1 -and ([string]$stopOutput[0] | ConvertFrom-Json).ok) 'Graceful local:stop did not return success.'
  $events = [System.IO.File]::ReadAllLines($eventFile)
  Assert-True ([Array]::IndexOf($events, 'shutdown-requested') -lt [Array]::IndexOf($events, 'write-finished') -and [Array]::IndexOf($events, 'write-finished') -lt [Array]::IndexOf($events, 'http-closed')) 'Shutdown event ordering did not retain the active write through HTTP close.'
  $httpClient.Dispose(); $writeRequest.Dispose(); $cancelSource.Dispose(); if ($null -ne $blockedResponse) { $blockedResponse.Dispose() }

  # A runtime/provider owner can outlive HTTP and is not represented by an
  # open request. A bounded local:stop must report STOP_DEFERRED, retain its
  # identity evidence and let the owner finish before the process tree exits.
  $runtimeServerPort = Get-FreePort
  $runtimeWebPort = Get-FreePort
  while ($runtimeWebPort -eq $runtimeServerPort) { $runtimeWebPort = Get-FreePort }
  Remove-Item -LiteralPath $eventFile -Force -ErrorAction SilentlyContinue
  $runtimeStart = Invoke-LauncherJson $launcher @('-Action', 'start', '-Root', $fixtureRoot, '-DataPath', $dataRoot, '-ServerHost', '127.0.0.1', '-WebHost', '127.0.0.1', '-ServerPort', [string]$runtimeServerPort, '-WebPort', [string]$runtimeWebPort, '-ReadyTimeoutSeconds', [string]$TimeoutSeconds)
  Assert-True ($runtimeStart.value.ok -and $runtimeStart.value.state -eq 'running') 'The active-runtime drain fixture did not start.'
  $runtimeIdentityPath = Join-Path $dataRoot '.agentos/local-runtime/worker-pids.json'
  $runtimeIdentity = Get-Content -LiteralPath $runtimeIdentityPath -Raw | ConvertFrom-Json
  $runtimeActivated = Send-NamedPipeRequest $runtimeIdentity.serverPipe $runtimeIdentity.instanceId $runtimeIdentity.shutdownNonce 'fixture-active-runtime'
  Assert-True $runtimeActivated.ok 'The fixture did not admit its simulated active provider runtime.'
  Assert-True (Wait-Text $eventFile 'provider-runtime-active' 3) 'The provider runtime activity boundary was not recorded.'
  $runtimeManifestBefore = Get-Content -LiteralPath $manifestPath -Raw
  $runtimeStopJob = Start-Job -ArgumentList $launcher, $fixtureRoot, $dataRoot -ScriptBlock {
    param($LauncherPath, $RepositoryRoot, $DataRoot)
    try { & $LauncherPath -Action stop -Root $RepositoryRoot -DataPath $DataRoot -GracefulStopTimeoutSeconds 2 -Json }
    catch { 'STOP_ERROR: ' + $_.Exception.Message }
  }
  $runtimeStopWait = Wait-Job -Job $runtimeStopJob -Timeout 6
  Assert-True ($null -ne $runtimeStopWait) 'local:stop did not return its bounded STOP_DEFERRED result.'
  $runtimeStopOutput = @(Receive-Job -Job $runtimeStopJob)
  Remove-Job -Job $runtimeStopJob -Force
  Assert-True (($runtimeStopOutput -join "`n") -match 'STOP_DEFERRED') ("The active runtime stop did not preserve an explicit deferred result: " + ($runtimeStopOutput -join ' '))
  $runtimeManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $runtimeServerRecord = Get-ManifestProcessRecord $runtimeManifest 'server'
  Assert-True (@(Get-RemainingOwnedProcessRecords @($runtimeServerRecord)).Count -eq 1) 'The verified server was stopped while its provider runtime was still active.'
  Assert-True (Test-Path -LiteralPath $runtimeIdentityPath -PathType Leaf) 'Deferred stop removed runtime ownership evidence.'
  Assert-True ([System.IO.File]::ReadAllText($manifestPath) -ceq $runtimeManifestBefore) 'Deferred stop rewrote the manifest as stopped before runtime completion.'
  $runtimeHttpClient = [System.Net.Http.HttpClient]::new()
  try {
    $fencedWrite = $runtimeHttpClient.PostAsync(('http://127.0.0.1:' + $runtimeServerPort + '/api/fixture-write'), [System.Net.Http.StringContent]::new('')).GetAwaiter().GetResult()
    Assert-True ([int]$fencedWrite.StatusCode -eq 503) 'The server accepted a new write after shutdown was deferred.'
    $fencedWrite.Dispose()
  } finally { $runtimeHttpClient.Dispose() }
  Assert-True (-not [System.IO.File]::ReadAllText($eventFile).Contains('provider-runtime-completed')) 'The provider runtime completed before the deferred stop was observed.'
  $runtimeDeadline = (Get-Date).AddSeconds(12)
  do {
    $runtimeRemainingRecords = @(Get-RemainingOwnedProcessRecords $runtimeManifest.processes)
    if ($runtimeRemainingRecords.Count -eq 0) { break }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $runtimeDeadline)
  Assert-True ($runtimeRemainingRecords.Count -eq 0) ('The deferred owned process identities did not exit after runtime completion: ' + (@($runtimeRemainingRecords | ForEach-Object { [int]$_.pid }) -join ', '))
  $finalizeDeferredStop = Invoke-LauncherJson $launcher @('-Action', 'stop', '-Root', $fixtureRoot, '-DataPath', $dataRoot)
  Assert-True ($finalizeDeferredStop.value.ok -and $finalizeDeferredStop.value.state -eq 'stopped') 'A subsequent verified stop did not finalize the drained instance manifest.'
  $runtimeEvents = [System.IO.File]::ReadAllLines($eventFile)
  Assert-True ([Array]::IndexOf($runtimeEvents, 'provider-runtime-active') -lt [Array]::IndexOf($runtimeEvents, 'shutdown-requested') -and [Array]::IndexOf($runtimeEvents, 'shutdown-requested') -lt [Array]::IndexOf($runtimeEvents, 'provider-runtime-completed') -and [Array]::IndexOf($runtimeEvents, 'provider-runtime-completed') -lt [Array]::IndexOf($runtimeEvents, 'http-closed')) 'The runtime owner did not finish before HTTP/process shutdown completed.'

  # An unexpected server process exit closes its private pipe. The supervisor
  # must use the proven child exit and clean only its owned web sibling.
  $crashPort = Get-FreePort
  $crashWebPort = Get-FreePort
  while ($crashWebPort -eq $crashPort) { $crashWebPort = Get-FreePort }
  $crashStart = Invoke-LauncherJson $launcher @('-Action', 'start', '-Root', $fixtureRoot, '-DataPath', $dataRoot, '-ServerHost', '127.0.0.1', '-WebHost', '127.0.0.1', '-ServerPort', [string]$crashPort, '-WebPort', [string]$crashWebPort, '-ReadyTimeoutSeconds', [string]$TimeoutSeconds)
  Assert-True ($crashStart.value.ok -and $crashStart.value.state -eq 'running') 'The natural server-exit fixture did not start.'
  $crashIdentity = Get-Content -LiteralPath (Join-Path $dataRoot '.agentos/local-runtime/worker-pids.json') -Raw | ConvertFrom-Json
  $crashResponse = Invoke-WebRequest -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:' + $crashPort + '/api/fixture-crash') -TimeoutSec 5
  $crashBody = if ($crashResponse.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($crashResponse.Content) } else { [string]$crashResponse.Content }
  Assert-True ($crashResponse.StatusCode -eq 200 -and $crashBody -eq 'crash requested') ("The natural server-exit fixture did not trigger (HTTP " + $crashResponse.StatusCode + ", body='" + $crashBody + "').")
  $crashManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $crashDeadline = (Get-Date).AddSeconds(12)
  do {
    $crashRemainingRecords = @(Get-RemainingOwnedProcessRecords $crashManifest.processes)
    if ($crashRemainingRecords.Count -eq 0) { break }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $crashDeadline)
  Assert-True ($crashRemainingRecords.Count -eq 0) ('A proven server process exit left owned process identities running: ' + (@($crashRemainingRecords | ForEach-Object { [int]$_.pid }) -join ', '))
  Assert-True ((Get-Content -LiteralPath $stdoutLog -Raw).Contains('exit code=37')) 'The fixture server exit code was not retained in its bounded process log.'

  # Prefer the new readiness contract while retaining the health endpoint fallback.
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_READINESS', 'true', 'Process')
  $readinessServerPort = Get-FreePort
  $readinessWebPort = Get-FreePort
  while ($readinessWebPort -eq $readinessServerPort) { $readinessWebPort = Get-FreePort }
  $readinessStart = Invoke-LauncherJson $launcher @('-Action', 'start', '-Root', $fixtureRoot, '-DataPath', $dataRoot, '-ServerHost', '127.0.0.1', '-WebHost', '127.0.0.1', '-ServerPort', [string]$readinessServerPort, '-WebPort', [string]$readinessWebPort, '-ReadyTimeoutSeconds', [string]$TimeoutSeconds)
  Assert-True ($readinessStart.value.ok -and $readinessStart.value.state -eq 'running') ("Startup using /api/readiness failed: " + $readinessStart.text)
  $readinessManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $legacyManifestObject = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $legacyManifestObject.readinessPath = '/api/health'
  Write-Utf8NoBom $manifestPath (ConvertTo-Json -InputObject $legacyManifestObject -Depth 10)
  $readinessStatus = Invoke-LauncherJson $launcher @('-Action', 'status', '-Root', $fixtureRoot, '-DataPath', $dataRoot)
  Assert-True ($readinessStatus.value.endpoints.serverReadinessPath -eq '/api/health/ready') 'Status did not prefer the actual readiness route over a legacy liveness manifest value.'
  $pidsDirectory = Join-Path $dataRoot '.agentos/local-runtime'
  $archivedPidRecords = @(Get-ChildItem -Path (Join-Path $pidsDirectory 'worker-pids.json.*.previous') -File -ErrorAction SilentlyContinue)
  Assert-True ($archivedPidRecords.Count -ge 1) 'Restart discarded the previous runtime process record instead of archiving it.'
  $readinessStop = Invoke-LauncherJson $launcher @('-Action', 'stop', '-Root', $fixtureRoot, '-DataPath', $dataRoot)
  Assert-True ($readinessStop.value.ok -and $readinessStop.value.instanceId -eq $readinessManifest.instanceId) ('Readiness stop failed: ' + $readinessStop.text)
  $readinessDeadline = (Get-Date).AddSeconds(10)
  do {
    $readinessRemainingRecords = @(Get-RemainingOwnedProcessRecords $readinessManifest.processes)
    if ($readinessRemainingRecords.Count -eq 0) { break }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $readinessDeadline)
  Assert-True ($readinessRemainingRecords.Count -eq 0) ('Readiness-contract process identities did not stop: ' + (@($readinessRemainingRecords | ForEach-Object { [int]$_.pid }) -join ', '))

  # A route alias is supported when the preferred health readiness route returns 404.
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_READINESS', $null, 'Process')
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_MAINTENANCE_READINESS', 'true', 'Process')
  $maintenanceServerPort = Get-FreePort
  $maintenanceWebPort = Get-FreePort
  while ($maintenanceWebPort -eq $maintenanceServerPort) { $maintenanceWebPort = Get-FreePort }
  $maintenanceStart = Invoke-LauncherJson $launcher @('-Action', 'start', '-Root', $fixtureRoot, '-DataPath', $dataRoot, '-ServerHost', '127.0.0.1', '-WebHost', '127.0.0.1', '-ServerPort', [string]$maintenanceServerPort, '-WebPort', [string]$maintenanceWebPort, '-ReadyTimeoutSeconds', [string]$TimeoutSeconds)
  Assert-True ($maintenanceStart.value.ok -and $maintenanceStart.value.state -eq 'running') ("Startup using /api/maintenance/readiness failed: " + $maintenanceStart.text)
  $maintenanceStatus = Invoke-LauncherJson $launcher @('-Action', 'status', '-Root', $fixtureRoot, '-DataPath', $dataRoot)
  Assert-True ($maintenanceStatus.value.endpoints.serverReadinessPath -eq '/api/maintenance/readiness') 'Launcher did not follow the readiness alias after a 404 from the preferred route.'
  $maintenanceManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $maintenanceStop = Invoke-LauncherJson $launcher @('-Action', 'stop', '-Root', $fixtureRoot, '-DataPath', $dataRoot)
  Assert-True ($maintenanceStop.value.ok -and $maintenanceStop.value.instanceId -eq $maintenanceManifest.instanceId) ('Maintenance stop failed: ' + $maintenanceStop.text)
  $maintenanceDeadline = (Get-Date).AddSeconds(10)
  do {
    $maintenanceRemainingRecords = @(Get-RemainingOwnedProcessRecords $maintenanceManifest.processes)
    if ($maintenanceRemainingRecords.Count -eq 0) { break }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $maintenanceDeadline)
  Assert-True ($maintenanceRemainingRecords.Count -eq 0) ('Maintenance process identities did not stop: ' + (@($maintenanceRemainingRecords | ForEach-Object { [int]$_.pid }) -join ', '))

  # A readiness 503 must remain unready even though the legacy liveness route returns 200.
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_MAINTENANCE_READINESS', $null, 'Process')
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_READINESS_503', 'true', 'Process')
  $notReadyServerPort = Get-FreePort
  $notReadyWebPort = Get-FreePort
  while ($notReadyWebPort -eq $notReadyServerPort) { $notReadyWebPort = Get-FreePort }
  $notReadyStart = Invoke-LauncherJson $launcher @('-Action', 'start', '-Root', $fixtureRoot, '-DataPath', $dataRoot, '-ServerHost', '127.0.0.1', '-WebHost', '127.0.0.1', '-ServerPort', [string]$notReadyServerPort, '-WebPort', [string]$notReadyWebPort, '-ReadyTimeoutSeconds', '1')
  Assert-True (-not $notReadyStart.value.ok -and $notReadyStart.value.error -match '(?i)Readiness timed out.*server=False, web=True') ("A readiness 503 was incorrectly treated as ready or did not time out: " + $notReadyStart.text)
  $notReadyManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  Assert-True ($notReadyManifest.state -eq 'stopped') 'Readiness 503 did not leave an auditable stopped manifest.'
  $notReadyDeadline = (Get-Date).AddSeconds(10)
  do {
    $notReadyRemainingRecords = @(Get-RemainingOwnedProcessRecords $notReadyManifest.processes)
    if ($notReadyRemainingRecords.Count -eq 0) { break }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $notReadyDeadline)
  Assert-True ($notReadyRemainingRecords.Count -eq 0) ('Readiness 503 cleanup left owned process identities alive: ' + (@($notReadyRemainingRecords | ForEach-Object { [int]$_.pid }) -join ', '))

  # A service that never opens its port must time out and leave no owned process tree.
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_READINESS_503', $null, 'Process')
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_FAIL_WEB', 'true', 'Process')
  $failureServerPort = Get-FreePort
  $failureWebPort = Get-FreePort
  while ($failureWebPort -eq $failureServerPort) { $failureWebPort = Get-FreePort }
  $failureTimer = [System.Diagnostics.Stopwatch]::StartNew()
  $failedStart = Invoke-LauncherJson $launcher @('-Action', 'start', '-Root', $fixtureRoot, '-DataPath', $dataRoot, '-ServerHost', '127.0.0.1', '-WebHost', '127.0.0.1', '-ServerPort', [string]$failureServerPort, '-WebPort', [string]$failureWebPort, '-ReadyTimeoutSeconds', '1')
  $failureTimer.Stop()
  Assert-True (-not $failedStart.value.ok -and $failedStart.value.error -match 'Readiness timed out') ("A failed readiness probe did not report bounded startup failure: " + $failedStart.text)
  Assert-True ($failedStart.value.error -match '(?i)server=True, web=False') 'The web timeout scenario did not isolate the expected failing service.'
  Assert-True ($failureTimer.Elapsed.TotalSeconds -lt 12) 'A failed readiness probe exceeded the bounded startup and cleanup time.'
  $failedManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  Assert-True ($failedManifest.state -eq 'stopped') 'Failed startup did not preserve a stopped diagnostic manifest.'
  $failureDeadline = (Get-Date).AddSeconds(10)
  do {
    $failedRemainingRecords = @(Get-RemainingOwnedProcessRecords $failedManifest.processes)
    if ($failedRemainingRecords.Count -eq 0) { break }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $failureDeadline)
  Assert-True ($failedRemainingRecords.Count -eq 0) ('Readiness timeout leaked owned process identities: ' + (@($failedRemainingRecords | ForEach-Object { [int]$_.pid }) -join ', '))

  # If a startup cleanup cannot authenticate/drain its live server, retain the
  # launcher lock as well as runtime identity. A later verified stop can drain
  # the instance; only then may the test remove its stale lock file.
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_FAIL_WEB', 'true', 'Process')
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_REFUSE_SHUTDOWN', 'true', 'Process')
  $refusedServerPort = Get-FreePort
  $refusedWebPort = Get-FreePort
  while ($refusedWebPort -eq $refusedServerPort) { $refusedWebPort = Get-FreePort }
  Register-FixtureStartAttempt
  $refusedStartLines = @(& $launcher -Action start -Root $fixtureRoot -DataPath $dataRoot -ServerHost '127.0.0.1' -WebHost '127.0.0.1' -ServerPort $refusedServerPort -WebPort $refusedWebPort -ReadyTimeoutSeconds 1 -Json -WarningAction SilentlyContinue)
  Assert-True ($refusedStartLines.Count -eq 1) ("The refused-cleanup start did not return one JSON result: " + ($refusedStartLines -join ' '))
  $refusedStart = [string]$refusedStartLines[0] | ConvertFrom-Json
  Assert-True (-not $refusedStart.ok -and $refusedStart.state -eq 'error') 'The fixture did not report startup failure when server cleanup was refused.'
  Assert-True ([System.IO.File]::ReadAllText($eventFile).Contains('shutdown-refused')) 'The live server did not record the intentional cleanup refusal.'
  $refusedManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $refusedIdentity = Get-Content -LiteralPath (Join-Path $dataRoot '.agentos/local-runtime/worker-pids.json') -Raw | ConvertFrom-Json
  $launcherLock = Join-Path $dataRoot '.agentos/local-runtime/launcher.lock'
  Assert-True (Test-Path -LiteralPath $launcherLock -PathType Leaf) 'Startup failure removed launcher.lock while the server could still be alive.'
  $refusedServerRecord = $refusedManifest.processes | Where-Object { $_.role -eq 'server' } | Select-Object -First 1
  Assert-True (@(Get-RemainingOwnedProcessRecords @($refusedServerRecord)).Count -eq 1) 'The verified server identity was not still live when the launcher lock was retained.'
  $restoreShutdown = Send-NamedPipeRequest $refusedIdentity.serverPipe $refusedIdentity.instanceId $refusedIdentity.shutdownNonce 'fixture-allow-shutdown'
  Assert-True $restoreShutdown.ok 'The fixture could not restore authenticated server shutdown.'
  $recoveredStartStop = Invoke-LauncherJson $launcher @('-Action', 'stop', '-Root', $fixtureRoot, '-DataPath', $dataRoot)
  Assert-True ($recoveredStartStop.value.ok -and $recoveredStartStop.value.state -eq 'stopped') 'Verified stop did not drain the server retained after startup cleanup failure.'
  $refusedManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $refusedStop = Invoke-LauncherJson $launcher @('-Action', 'stop', '-Root', $fixtureRoot, '-DataPath', $dataRoot)
  Assert-True ($refusedStop.value.ok -and $refusedStop.value.instanceId -eq $refusedManifest.instanceId) ('Verified refused-start recovery stop failed: ' + $refusedStop.text)
  $refusedDeadline = (Get-Date).AddSeconds(10)
  do {
    $refusedRemainingRecords = @(Get-RemainingOwnedProcessRecords $refusedManifest.processes)
    if ($refusedRemainingRecords.Count -eq 0) { break }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $refusedDeadline)
  Assert-True ($refusedRemainingRecords.Count -eq 0) ('The recovered startup-failure process identities did not stop: ' + (@($refusedRemainingRecords | ForEach-Object { [int]$_.pid }) -join ', '))
  $resolvedTestLock = [System.IO.Path]::GetFullPath($launcherLock)
  $testLockPrefix = [System.IO.Path]::GetFullPath((Join-Path $dataRoot '.agentos/local-runtime')) + [System.IO.Path]::DirectorySeparatorChar
  Assert-True ($resolvedTestLock.StartsWith($testLockPrefix, [System.StringComparison]::OrdinalIgnoreCase)) 'Refusing to remove a stale lock outside the isolated fixture runtime directory.'
  Remove-Item -LiteralPath $resolvedTestLock -Force
  Assert-True (-not (Test-Path -LiteralPath $launcherLock)) 'The test-owned stale launcher lock was not removed after all verified processes exited.'
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_FAIL_WEB', $null, 'Process')
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_REFUSE_SHUTDOWN', $null, 'Process')

} catch {
  $testFailure = $_.Exception
} finally {
  [Environment]::SetEnvironmentVariable('AGENTOS_API_TOKEN', $originalFixtureEnv, 'Process')
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_READINESS', $originalReadinessEnv, 'Process')
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_MAINTENANCE_READINESS', $originalMaintenanceReadinessEnv, 'Process')
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_READINESS_503', $originalReadiness503Env, 'Process')
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_FAIL_WEB', $originalFailWebEnv, 'Process')
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_REFUSE_SHUTDOWN', $originalRefuseShutdownEnv, 'Process')
  [Environment]::SetEnvironmentVariable('AGENTOS_FIXTURE_EVENT_FILE', $originalEventFileEnv, 'Process')
  if ($null -ne $unrelated -and -not $unrelated.HasExited) {
    try { $unrelated.Kill(); [void]$unrelated.WaitForExit(5000) } catch {}
  }
  if ($null -ne $sleeper -and -not $sleeper.HasExited) {
    try { $sleeper.Kill(); [void]$sleeper.WaitForExit(5000) } catch {}
  }
  if ($temporaryWasCreated -and (Test-Path -LiteralPath $tempRoot)) {
    $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
    $expectedPrefix = [System.IO.Path]::GetFullPath((Join-Path $tempParent 'agentos local lifecycle '))
    if (-not $resolvedTemp.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or $resolvedTemp -eq $tempParent) {
      $cleanupFailure = 'Refusing test cleanup because the resolved temporary path is outside its dedicated test prefix.'
    } else {
      $pidsPath = Join-Path $dataRoot '.agentos/local-runtime/worker-pids.json'
      $lockPath = Join-Path $dataRoot '.agentos/local-runtime/launcher.lock'
      $cleanupManifest = $null
      $cleanupRecords = @()
      $cleanupOwnershipValidated = $false
      $cleanupStopVerified = $false
      $cleanupStopResult = $null
      $hasRuntimeEvidence = (Test-Path -LiteralPath $manifestPath) -or (Test-Path -LiteralPath $pidsPath) -or (Test-Path -LiteralPath $lockPath)
      if (Test-Path -LiteralPath $manifestPath) {
        try {
          $cleanupManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
          $cleanupRecords = @($cleanupManifest.processes)
          $cleanupStop = Invoke-LauncherJson $launcher @('-Action', 'stop', '-Root', $fixtureRoot, '-DataPath', $dataRoot)
          if (-not $cleanupStop.value.ok -or $cleanupStop.value.state -ne 'stopped' -or
            $cleanupStop.value.instanceId -ne $cleanupManifest.instanceId) {
            throw ('The fixture stop did not verify the owned instance: ' + $cleanupStop.text)
          }
          $cleanupStopVerified = $true
          $cleanupStopResult = $cleanupStop.value
          Write-Output ('RAW_CLEANUP_STOP_JSON=' + $cleanupStop.text)
        } catch {
          $cleanupFailure = 'The launcher could not safely stop the fixture instance: ' + $_.Exception.Message
        }
      }
      if (Test-Path -LiteralPath $pidsPath) {
        try {
          $workerIds = Get-Content -LiteralPath $pidsPath -Raw | ConvertFrom-Json
          if ($null -eq $cleanupManifest -or [string]$workerIds.instanceId -ne [string]$cleanupManifest.instanceId) {
            throw 'The fixture worker state has no matching launcher manifest; preserving its evidence.'
          }
          foreach ($role in @('supervisor', 'server', 'web')) {
            $workerPidProperty = $role + 'Pid'
            $record = $cleanupRecords | Where-Object { $_.role -eq $role } | Select-Object -First 1
            if ($null -eq $record -or [int]$workerIds.$workerPidProperty -ne [int]$record.pid) {
              throw 'The fixture worker PID record does not match its manifest process identity.'
            }
          }
          $cleanupOwnershipValidated = $cleanupRecords.Count -ge 3
          $liveSupervisor = @(Get-RemainingOwnedProcessRecords @($cleanupRecords | Where-Object { $_.role -eq 'supervisor' }))
          if ($liveSupervisor.Count -gt 0) {
            $cleanupFailure = 'The fixture supervisor remains after graceful stop; refusing force termination and preserving its evidence.'
          }
        } catch {
          if ($null -eq $cleanupFailure) { $cleanupFailure = 'The fixture worker state could not be safely checked: ' + $_.Exception.Message }
        }
      }
      $deadline = (Get-Date).AddSeconds(10)
      do {
        $remainingRecords = @(Get-RemainingOwnedProcessRecords $cleanupRecords)
        if ($remainingRecords.Count -eq 0) { break }
        Start-Sleep -Milliseconds 150
      } while ((Get-Date) -lt $deadline)
      if ($remainingRecords.Count -gt 0) {
        $remainingPids = @($remainingRecords | ForEach-Object { [int]$_.pid } | Sort-Object -Unique)
        $cleanupFailure = 'The verified fixture process identities are still active (' + ($remainingPids -join ', ') + '); its temporary directory was preserved.'
      }
      $cleanupDisposition = Get-FixtureCleanupDisposition $fixtureStartState $cleanupManifest $cleanupStopResult $remainingRecords $hasRuntimeEvidence
      if ($cleanupDisposition -eq 'preserve' -and $null -eq $cleanupFailure) {
        $cleanupFailure = 'Fixture cleanup lacks complete identity and matching stop/exit evidence for the latest start attempt (' + $fixtureStartState.attempts + '); preserving ' + $resolvedTemp
      }
      Write-Output ('CLEANUP_EVIDENCE_JSON=' + ([ordered]@{ startAttempts = $fixtureStartState.attempts; disposition = $cleanupDisposition
        runtimeEvidencePresent = $hasRuntimeEvidence; processRecords = $cleanupRecords.Count; remainingRecords = $remainingRecords.Count; path = $resolvedTemp } | ConvertTo-Json -Compress))
      if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
        if (-not $cleanupStopVerified -or -not $cleanupOwnershipValidated -or $remainingRecords.Count -gt 0 -or $null -ne $cleanupFailure) {
          if ($null -eq $cleanupFailure) { $cleanupFailure = 'A launcher.lock remains without verified stopped ownership; preserving the fixture evidence.' }
        } else {
          $resolvedLock = [System.IO.Path]::GetFullPath($lockPath)
          $expectedLockPrefix = [System.IO.Path]::GetFullPath((Join-Path $dataRoot '.agentos/local-runtime')) + [System.IO.Path]::DirectorySeparatorChar
          if (-not $resolvedLock.StartsWith($expectedLockPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            $cleanupFailure = 'Refusing to remove a launcher lock outside the isolated fixture runtime directory.'
          } else {
            Remove-Item -LiteralPath $resolvedLock -Force
          }
        }
      }
      if ($null -eq $cleanupFailure -and $cleanupDisposition -in @('never-started', 'verified-stopped')) {
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
Write-Output 'PASS: cleanup evidence guard classification and real owned fixture, dry-run isolation, occupied-port conflict preserves unrelated child, safe reused-PID refusal, owned status/stop, disconnected write drain, active runtime STOP_DEFERRED drain, proven server-exit cleanup, startup cleanup refusal retains launcher lock and live identity, readiness aliases and 503 semantics, legacy liveness fallback, failed-start cleanup, archived runtime records, dotenv preservation, sensitive-log filtering, and bounded logs.'
