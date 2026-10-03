[CmdletBinding()]
param(
  [ValidateSet('start', 'status', 'stop')]
  [string] $Action = 'start',
  [switch] $Development,
  [switch] $Mock,
  [switch] $Stable,
  [switch] $Json,
  [switch] $DryRun,
  [string] $Root,
  [string] $DataPath,
  [string] $ServerHost,
  [int] $ServerPort = 0,
  [string] $WebHost,
  [int] $WebPort = 0,
  [ValidateRange(1, 300)]
  [int] $ReadyTimeoutSeconds = 45,
  [ValidateRange(1, 3600)]
  [int] $GracefulStopTimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:environmentBackup = @{}
$script:workerProcess = $null
$script:workerInstanceId = $null
$script:workerRoot = $null
$script:workerDataPath = $null
$script:workerNodePath = $null
$script:workerIdentity = $null
$script:workerExpectedManifest = $null
$script:startupCommitted = $false
$script:manifestPath = $null

function Set-ScopedEnvironment([string] $Name, [string] $Value) {
  if (-not $script:environmentBackup.ContainsKey($Name)) {
    $script:environmentBackup[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
  }
  [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

function Write-JsonResult($Value) {
  $jsonText = ConvertTo-Json -InputObject $Value -Depth 10 -Compress
  Write-Output $jsonText
}

function Import-LocalEnv([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  foreach ($originalLine in [System.IO.File]::ReadAllLines($Path)) {
    $line = $originalLine.TrimStart([char]0xFEFF)
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      $name = $matches[1]
      $value = $matches[2]
      if ($value.Length -ge 2) {
        $first = $value[0]
        $last = $value[$value.Length - 1]
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
          $value = $value.Substring(1, $value.Length - 2)
        }
      }
      if ($null -eq [Environment]::GetEnvironmentVariable($name, 'Process')) {
        Set-ScopedEnvironment $name $value
      }
    }
  }
}

function Resolve-AbsolutePath([string] $Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Get-HostValue([string] $CliValue, [string] $EnvValue, [string] $DefaultValue) {
  if (-not [string]::IsNullOrWhiteSpace($CliValue)) { return $CliValue.Trim() }
  if (-not [string]::IsNullOrWhiteSpace($EnvValue)) { return $EnvValue.Trim() }
  return $DefaultValue
}

function Get-PortValue([int] $CliValue, [string] $EnvValue, [int] $DefaultValue, [string] $Name) {
  $value = $DefaultValue
  if (-not [string]::IsNullOrWhiteSpace($EnvValue)) {
    $parsed = 0
    if (-not [int]::TryParse($EnvValue, [ref]$parsed)) { throw "$Name must be a number from 1 to 65535." }
    $value = $parsed
  }
  if ($CliValue -gt 0) { $value = $CliValue }
  if ($value -lt 1 -or $value -gt 65535) { throw "$Name must be a number from 1 to 65535." }
  return $value
}

function Get-AddressProbeHost([string] $Value) {
  $hostValue = $Value.Trim().Trim('[', ']')
  if ($hostValue -eq '0.0.0.0' -or $hostValue -eq '::') { return '127.0.0.1' }
  if ($hostValue -eq '::1') { return '::1' }
  return $hostValue
}

function Format-UrlHost([string] $Value) {
  $hostValue = Get-AddressProbeHost $Value
  if ($hostValue.Contains(':') -and -not $hostValue.StartsWith('[')) { return '[' + $hostValue + ']' }
  return $hostValue
}

function Get-ServiceUrl([string] $HostValue, [int] $Port, [string] $Path) {
  return 'http://' + (Format-UrlHost $HostValue) + ':' + $Port + $Path
}

function Get-ProcessMap {
  $all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate, ExecutablePath, CommandLine -ErrorAction Stop)
  $map = @{}
  foreach ($item in $all) { $map[[int]$item.ProcessId] = $item }
  return ,$map
}

function Convert-CreationTime($Value) {
  return ([datetime]$Value).ToUniversalTime().ToString('o')
}

function Get-ProcessRecord($Process, [string] $Role, [string] $RootValue, [int] $PortValue) {
  if ($null -eq $Process) { throw "Could not verify the $Role process after launch." }
  if ([string]::IsNullOrWhiteSpace([string]$Process.ExecutablePath) -or [string]::IsNullOrWhiteSpace([string]$Process.CommandLine)) {
    throw "Windows could not read the $Role process identity; no process was stopped."
  }
  return [pscustomobject][ordered]@{
    role = $Role
    pid = [int]$Process.ProcessId
    parentPid = [int]$Process.ParentProcessId
    createdAt = Convert-CreationTime $Process.CreationDate
    executable = [string]$Process.ExecutablePath
    command = [string]$Process.CommandLine
    root = $RootValue
    port = $PortValue
  }
}

function Test-ContainsText([string] $Text, [string] $Needle) {
  return $Text.IndexOf($Needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-ExpectedCommand($Manifest, $Record) {
  $command = [string]$Record.command
  $mode = [string]$Manifest.mode
  $rootValue = [string]$Manifest.root
  $role = [string]$Record.role
  if ([string]$Record.root -ne $rootValue) { return $false }
  $expectedPort = if ($role -eq 'supervisor') { [int]$Manifest.ports.server } elseif ($role -eq 'server') { [int]$Manifest.ports.server } elseif ($role -eq 'web') { [int]$Manifest.ports.web } elseif ($role -eq 'console-host') { 0 } else { -1 }
  if ([int]$Record.port -ne $expectedPort) { return $false }
  if ($role -eq 'console-host') {
    $consolePath = Resolve-AbsolutePath (Join-Path $env:SystemRoot 'System32/conhost.exe')
    $fragments = @($consolePath)
  } elseif ($role -eq 'supervisor') {
    $helperPath = Resolve-AbsolutePath (Join-Path $PSScriptRoot 'agentos-local-worker.mjs')
    $fragments = @($helperPath, 'worker', [string]$Manifest.instanceId, '--root', $rootValue, '--data-path', [string]$Manifest.dataPath, '--server-port', [string]$Manifest.ports.server, '--web-port', [string]$Manifest.ports.web)
  } elseif ($role -eq 'server') {
    if ($mode -eq 'production') {
      $fragments = @((Resolve-AbsolutePath (Join-Path $rootValue 'apps/server/dist/index.js')))
    } else {
      $devScript = if ($Manifest.stable) { 'dev:stable' } else { 'dev' }
      $fragments = @('pnpm.cmd', '@agentos/server', 'run', $devScript)
    }
  } elseif ($role -eq 'web') {
    $nextPath = Resolve-AbsolutePath (Join-Path $rootValue 'apps/web/node_modules/next/dist/bin/next')
    $verb = if ($mode -eq 'production') { 'start' } else { 'dev' }
    $fragments = @($nextPath, $verb, [string]$Manifest.ports.web, [string]$Manifest.webHost)
  } else { return $false }
  foreach ($fragment in $fragments) {
    if (-not (Test-ContainsText $command ([string]$fragment))) { return $false }
  }
  return $true
}

function Test-RecordIdentity($Manifest, $Record, $Snapshot) {
  $pidValue = [int]$Record.pid
  if (-not $Snapshot.ContainsKey($pidValue)) {
    return [pscustomobject]@{ state = 'missing'; match = $true; process = $null; reason = $null }
  }
  $actual = $Snapshot[$pidValue]
  $reasons = [System.Collections.Generic.List[string]]::new()
  try {
    if ((Convert-CreationTime $actual.CreationDate) -ne (Convert-CreationTime $Record.createdAt)) { $reasons.Add('creation-time') }
  } catch { $reasons.Add('creation-time') }
  if ([int]$actual.ParentProcessId -ne [int]$Record.parentPid) { $reasons.Add('parent-pid') }
  if (-not [string]::Equals([string]$actual.ExecutablePath, [string]$Record.executable, [System.StringComparison]::OrdinalIgnoreCase)) { $reasons.Add('executable') }
  if (-not [string]::Equals([string]$actual.CommandLine, [string]$Record.command, [System.StringComparison]::Ordinal)) { $reasons.Add('command') }
  if (-not (Test-ExpectedCommand $Manifest $Record)) { $reasons.Add('launcher-identity') }
  $reasonText = if ($reasons.Count -eq 0) { $null } else { $reasons -join ',' }
  return [pscustomobject]@{ state = 'running'; match = ($reasons.Count -eq 0); process = $actual; reason = $reasonText }
}

function Get-ManifestAssessment($Manifest) {
  $snapshot = Get-ProcessMap
  $results = @{}
  $mismatches = [System.Collections.Generic.List[string]]::new()
  foreach ($role in @('supervisor', 'server', 'web')) {
    $record = $Manifest.processes | Where-Object { $_.role -eq $role } | Select-Object -First 1
    if ($null -eq $record) {
      $mismatches.Add($role + ':missing-manifest-record')
      continue
    }
    $result = Test-RecordIdentity $Manifest $record $snapshot
    $results[$role] = $result
    if (-not $result.match) { $mismatches.Add($role + ':identity-mismatch') }
  }
  return [pscustomobject]@{ snapshot = $snapshot; results = $results; mismatches = @($mismatches.ToArray()) }
}

function Read-Manifest([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $manifest = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ([int]$manifest.schemaVersion -ne 1 -or $null -eq $manifest.processes -or $null -eq $manifest.ports) {
      throw 'Unsupported or incomplete launcher manifest.'
    }
    return $manifest
  } catch {
    throw "The local launcher manifest is unreadable or unsupported at $Path. Preserve it and inspect the file before starting or stopping."
  }
}

function Write-Manifest([string] $Path, $Manifest) {
  $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  $jsonText = ConvertTo-Json -InputObject $Manifest -Depth 10
  [System.IO.File]::WriteAllText($temporary, $jsonText, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-Sha256Hex([byte[]] $Bytes) {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}

function Get-CurrentProcessName([int] $ProcessId) {
  try { return (Get-Process -Id $ProcessId -ErrorAction Stop).ProcessName } catch { return 'unknown process' }
}

function Get-ListeningConnections([int] $PortValue) {
  try {
    Get-NetTCPConnection -State Listen -LocalPort $PortValue -ErrorAction Stop
  } catch {
    if ($_.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound) { return }
    throw
  }
}

function Assert-PortFree([string] $Name, [int] $PortValue) {
  try { $listeners = @(Get-ListeningConnections $PortValue) }
  catch { throw "Cannot inspect TCP port $PortValue before starting $Name. No process was started." }
  if ($listeners.Count -gt 0) {
    $owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    $details = foreach ($owner in $owners) { [string]$owner + ' (' + (Get-CurrentProcessName ([int]$owner)) + ')' }
    throw "$Name port $PortValue is already listening: $($details -join ', '). Choose another port or stop that application yourself."
  }
}

function Test-Endpoint([string] $Uri) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 2 -MaximumRedirection 3
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
  } catch { return $false }
}

function Get-EndpointStatus([string] $Uri) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 2 -MaximumRedirection 3
    return [int]$response.StatusCode
  } catch {
    try { return [int]$_.Exception.Response.StatusCode } catch { return 0 }
  }
}

function Get-ServerReadinessPath([string] $HostValue, [int] $PortValue) {
  foreach ($readinessPath in @('/api/health/ready', '/api/maintenance/readiness', '/api/readiness')) {
    $readinessStatus = Get-EndpointStatus (Get-ServiceUrl $HostValue $PortValue $readinessPath)
    if ($readinessStatus -eq 404) { continue }
    return $readinessPath
  }
  return '/api/health'
}

function Test-PortOwnedByProcessTree($Snapshot, [int] $RootPid, [int] $PortValue) {
  return (Get-PortOwnership $Snapshot $RootPid $PortValue).owned
}

function Get-PortOwnership($Snapshot, [int] $RootPid, [int] $PortValue) {
  try { $listeners = @(Get-ListeningConnections $PortValue) }
  catch { return [pscustomobject]@{ owned = $false; owners = @() } }
  $ownedPids = @([int]$RootPid) + @(Get-TreePids $Snapshot $RootPid)
  $ownerPids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { [int]$_ })
  $owners = [System.Collections.Generic.List[object]]::new()
  foreach ($ownerPid in $ownerPids) {
    if ($ownerPid -notin $ownedPids -or -not $Snapshot.ContainsKey($ownerPid)) {
      return [pscustomobject]@{ owned = $false; owners = @($owners.ToArray()) }
    }
    $process = $Snapshot[$ownerPid]
    if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
      return [pscustomobject]@{ owned = $false; owners = @($owners.ToArray()) }
    }
    $owners.Add([pscustomobject][ordered]@{
      pid = $ownerPid
      createdAt = Convert-CreationTime $process.CreationDate
      executable = [string]$process.ExecutablePath
    })
  }
  return [pscustomobject]@{ owned = ($ownerPids.Count -gt 0); owners = @($owners.ToArray()) }
}

function Test-PortOwnershipRecord($Snapshot, [int] $RootPid, [int] $PortValue, $ProcessRecord) {
  $actual = Get-PortOwnership $Snapshot $RootPid $PortValue
  if (-not $actual.owned) { return [pscustomobject]@{ owned = $false; owners = $actual.owners } }
  if (-not ($ProcessRecord.PSObject.Properties.Name -contains 'portOwners')) {
    return [pscustomobject]@{ owned = $true; owners = $actual.owners }
  }
  $expected = @($ProcessRecord.portOwners)
  if ($expected.Count -ne $actual.owners.Count) { return [pscustomobject]@{ owned = $false; owners = $actual.owners } }
  foreach ($owner in $actual.owners) {
    $recorded = $expected | Where-Object { [int]$_.pid -eq [int]$owner.pid } | Select-Object -First 1
    if ($null -eq $recorded -or [string]$recorded.createdAt -ne [string]$owner.createdAt -or -not [string]::Equals([string]$recorded.executable, [string]$owner.executable, [System.StringComparison]::OrdinalIgnoreCase)) {
      return [pscustomobject]@{ owned = $false; owners = $actual.owners }
    }
  }
  return [pscustomobject]@{ owned = $true; owners = $actual.owners }
}

function Send-LocalShutdownRequest($RuntimeIdentity, [string] $PipeKey) {
  $pipeName = [string]$RuntimeIdentity.$PipeKey
  $instanceId = [string]$RuntimeIdentity.instanceId
  $nonce = [string]$RuntimeIdentity.shutdownNonce
  $expectedPipe = '\\.\pipe\agentos-local-' + $instanceId + '-' + ($PipeKey -replace 'Pipe$', '')
  if ($instanceId -notmatch '^[a-f0-9]{32}$' -or $nonce -notmatch '^[a-f0-9]{64}$' -or $pipeName -ne $expectedPipe) {
    throw 'The local shutdown control identity is missing or invalid; no process was touched.'
  }
  $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipeName.Substring('\\.\pipe\'.Length), [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::None)
  try {
    try { $client.Connect(5000) } catch { throw 'The verified local shutdown control channel is unavailable; no process was touched.' }
    $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false), 1024, $true)
    $reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false), $false, 1024, $true)
    try {
      $writer.WriteLine((ConvertTo-Json -InputObject ([ordered]@{ operation = 'shutdown'; instanceId = $instanceId; nonce = $nonce }) -Compress))
      $writer.Flush()
      $readTask = $reader.ReadLineAsync()
      if (-not $readTask.Wait(5000)) { throw 'The local shutdown control response timed out; no process was force-stopped.' }
      $line = $readTask.GetAwaiter().GetResult()
      if ([string]::IsNullOrWhiteSpace($line)) { throw 'The local shutdown control channel closed without a result; no process was touched.' }
      $response = $line | ConvertFrom-Json
      if (-not $response.ok) { throw 'The local shutdown control identity was rejected; no process was touched.' }
      return $response
    } finally { $writer.Dispose(); $reader.Dispose() }
  } finally { $client.Dispose() }
}

function Get-TreePids($Snapshot, [int] $RootPid) {
  $children = @{}
  foreach ($process in $Snapshot.Values) {
    $parent = [int]$process.ParentProcessId
    if (-not $children.ContainsKey($parent)) { $children[$parent] = [System.Collections.Generic.List[int]]::new() }
    $children[$parent].Add([int]$process.ProcessId)
  }
  $found = [System.Collections.Generic.List[int]]::new()
  $parents = [System.Collections.Generic.Queue[int]]::new()
  $parents.Enqueue($RootPid)
  while ($parents.Count -gt 0) {
    $parentId = $parents.Dequeue()
    if (-not $children.ContainsKey($parentId)) { continue }
    foreach ($childId in $children[$parentId]) {
      if ($found.Contains($childId)) { continue }
      $found.Add($childId)
      $parents.Enqueue($childId)
    }
  }
  return @($found.ToArray())
}

function Test-OwnedTree($Manifest, $Snapshot, [int] $RootPid, [int[]] $TreePids) {
  $recordedRoots = @{}
  foreach ($record in $Manifest.processes) { $recordedRoots[[int]$record.pid] = $record }
  $allowedDescendants = @{}
  foreach ($pidValue in $TreePids) {
    $process = $Snapshot[[int]$pidValue]
    if ($null -eq $process -or [string]::IsNullOrWhiteSpace([string]$process.ExecutablePath) -or [string]::IsNullOrWhiteSpace([string]$process.CommandLine)) {
      return 'A process in the owned tree no longer has a verifiable identity.'
    }
    $parentId = [int]$process.ParentProcessId
    if ($parentId -eq $RootPid) {
      if (-not $recordedRoots.ContainsKey([int]$pidValue)) { return 'The supervisor has an unrecorded direct child; no process was stopped.' }
      $recordIdentity = Test-RecordIdentity $Manifest $recordedRoots[[int]$pidValue] $Snapshot
      if (-not $recordIdentity.match) { return 'A recorded child PID no longer matches its creation time or process identity; no process was stopped.' }
      $allowedDescendants[[int]$pidValue] = $true
      continue
    }
    if (-not $allowedDescendants.ContainsKey($parentId)) { return 'A process tree link could not be verified; no process was stopped.' }
    try {
      $created = [datetime]$process.CreationDate
      $parentCreated = [datetime]$Snapshot[$parentId].CreationDate
      if ($created -lt $parentCreated) { return 'A process tree creation order could not be verified; no process was stopped.' }
    } catch { return 'A process creation time could not be verified; no process was stopped.' }
    $allowedDescendants[[int]$pidValue] = $true
  }
  return $null
}

function Stop-Manifest($Manifest, $Assessment) {
  if ($Assessment.mismatches.Count -gt 0) {
    throw "Process identity mismatch ($($Assessment.mismatches -join ', ')); no process was stopped. Preserve the manifest and inspect it."
  }
  $supervisor = $Manifest.processes | Where-Object { $_.role -eq 'supervisor' } | Select-Object -First 1
  $supervisorResult = $Assessment.results.supervisor
  if ($null -ne $supervisorResult -and $supervisorResult.state -eq 'running') {
    $pidsPath = Join-Path ([string]$Manifest.dataPath) '.agentos/local-runtime/worker-pids.json'
    if (-not (Test-Path -LiteralPath $pidsPath -PathType Leaf)) { throw 'The verified local shutdown identity is unavailable; no process was touched.' }
    try { $runtimeIdentity = Get-Content -LiteralPath $pidsPath -Raw | ConvertFrom-Json }
    catch { throw 'The verified local shutdown identity is unreadable; no process was touched.' }
    if (([string]$runtimeIdentity.instanceId -ne [string]$Manifest.instanceId) -or ([int]$runtimeIdentity.supervisorPid -ne [int]$supervisor.pid)) {
      throw 'The local shutdown identity does not match the verified launcher manifest; no process was touched.'
    }
    if (($null -eq $Manifest.shutdownControl) -or ([string]$runtimeIdentity.supervisorPipe -ne [string]$Manifest.shutdownControl.supervisorPipe) -or ([string]$runtimeIdentity.serverPipe -ne [string]$Manifest.shutdownControl.serverPipe)) {
      throw 'This running instance has no manifest-bound graceful shutdown channel; no process was touched.'
    }
    $nonceHash = Get-Sha256Hex ([System.Text.Encoding]::UTF8.GetBytes([string]$runtimeIdentity.shutdownNonce))
    if ($nonceHash -ne [string]$Manifest.shutdownControl.nonceSha256) {
      throw 'The local shutdown nonce does not match the launcher manifest; no process was touched.'
    }
    $fresh = Get-ProcessMap
    $freshSupervisor = Test-RecordIdentity $Manifest $supervisor $fresh
    if (-not $freshSupervisor.match) { throw 'The supervisor identity changed before graceful shutdown; no process was touched.' }
    $freshTree = @(Get-TreePids $fresh ([int]$supervisor.pid))
    $treeError = Test-OwnedTree $Manifest $fresh ([int]$supervisor.pid) $freshTree
    if ($null -ne $treeError) { throw $treeError }
    $trackedPids = @([int]$supervisor.pid)
    $trackedPids += $freshTree
    $trackedPids = @($trackedPids | Sort-Object -Unique)
    $tracked = foreach ($pidValue in $trackedPids) {
      $process = $fresh[[int]$pidValue]
      [pscustomobject]@{
        pid = [int]$pidValue
        createdAt = Convert-CreationTime $process.CreationDate
        parentPid = [int]$process.ParentProcessId
        executable = [string]$process.ExecutablePath
        command = [string]$process.CommandLine
      }
    }
    $null = Send-LocalShutdownRequest $runtimeIdentity 'supervisorPipe'
    $deadline = (Get-Date).AddSeconds($GracefulStopTimeoutSeconds)
    do {
      Start-Sleep -Milliseconds 200
      $after = Get-ProcessMap
      $remaining = @()
      foreach ($record in $tracked) {
        $pidValue = [int]$record.pid
        if (-not $after.ContainsKey($pidValue)) { continue }
        $current = $after[$pidValue]
        $sameIdentity = (
          (Convert-CreationTime $current.CreationDate) -eq [string]$record.createdAt -and
          [int]$current.ParentProcessId -eq [int]$record.parentPid -and
          [string]::Equals([string]$current.ExecutablePath, [string]$record.executable, [System.StringComparison]::OrdinalIgnoreCase) -and
          [string]::Equals([string]$current.CommandLine, [string]$record.command, [System.StringComparison]::Ordinal)
        )
        if ($sameIdentity) { $remaining += $pidValue }
      }
      if ($remaining.Count -eq 0) { break }
    } while ((Get-Date) -lt $deadline)
    if ($remaining.Count -gt 0) {
      throw "STOP_DEFERRED: graceful shutdown is still draining or timed out (PIDs $($remaining -join ', ')); no process was force-stopped. Preserve the manifest and runtime evidence, then inspect maintenance state."
    }
  } else {
    foreach ($role in @('server', 'web')) {
      $result = $Assessment.results[$role]
      if ($null -ne $result -and $result.state -eq 'running') {
        throw "The supervisor is unavailable while the $role child remains. No process was touched because graceful shutdown cannot be verified."
      }
    }
  }
  $Manifest.state = 'stopped'
  $Manifest | Add-Member -NotePropertyName stoppedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
  Write-Manifest $script:manifestPath $Manifest
}

function New-ProcessRecordFromMap($Snapshot, [int] $ProcessId, [string] $Role, [string] $RootValue, [int] $PortValue) {
  if (-not $Snapshot.ContainsKey($ProcessId)) { throw "The $Role PID $ProcessId exited before its identity could be recorded." }
  return Get-ProcessRecord $Snapshot[$ProcessId] $Role $RootValue $PortValue
}

function Test-Ready([string] $ServerHostValue, [int] $ServerPortValue, [string] $WebUrl, [int] $TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $serverReady = $false
  $webReady = $false
  $serverPath = '/api/readiness'
  do {
    if (-not $serverReady) {
      $serverPath = Get-ServerReadinessPath $ServerHostValue $ServerPortValue
      $serverReady = Test-Endpoint (Get-ServiceUrl $ServerHostValue $ServerPortValue $serverPath)
    }
    if (-not $webReady) { $webReady = Test-Endpoint $WebUrl }
    if ($serverReady -and $webReady) { return [pscustomobject]@{ server = $true; web = $true; serverPath = $serverPath } }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return [pscustomobject]@{ server = $serverReady; web = $webReady; serverPath = $serverPath }
}

function Move-PreviousManifest([string] $Path) {
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
  Move-Item -LiteralPath $Path -Destination ($Path + '.' + $stamp + '.previous')
}

function Get-StatusResult($Manifest, $Assessment) {
  if ($null -eq $Manifest) {
    return [pscustomobject][ordered]@{ ok = $true; state = 'stopped'; message = 'No local instance manifest exists.' }
  }
  if ($Assessment.mismatches.Count -gt 0) {
    return [pscustomobject][ordered]@{
      ok = $false; state = 'identity-mismatch'; instanceId = $Manifest.instanceId
      root = $Manifest.root; dataPath = $Manifest.dataPath; mode = $Manifest.mode
      ports = $Manifest.ports; processPids = @($Manifest.processes | ForEach-Object { [int]$_.pid })
      message = 'A recorded PID no longer matches its creation time or process identity. No process was touched.'
    }
  }
  $active = @($Assessment.results.Values | Where-Object { $_.state -eq 'running' }).Count -gt 0
  if (-not $active) {
    return [pscustomobject][ordered]@{
      ok = $true; state = 'stopped'; instanceId = $Manifest.instanceId; root = $Manifest.root
      dataPath = $Manifest.dataPath; mode = $Manifest.mode; ports = $Manifest.ports
      processPids = @($Manifest.processes | ForEach-Object { [int]$_.pid })
    }
  }
  $readinessPath = Get-ServerReadinessPath ([string]$Manifest.serverHost) ([int]$Manifest.ports.server)
  $knownReadinessPaths = @('/api/health/ready', '/api/maintenance/readiness', '/api/readiness')
  if (($Manifest.PSObject.Properties.Name -contains 'readinessPath') -and [string]$Manifest.readinessPath -in $knownReadinessPaths) {
    $persistedReadinessPath = [string]$Manifest.readinessPath
    $persistedStatus = Get-EndpointStatus (Get-ServiceUrl ([string]$Manifest.serverHost) ([int]$Manifest.ports.server) $persistedReadinessPath)
    if ($persistedStatus -ne 404) { $readinessPath = $persistedReadinessPath }
  }
  $serverUrl = Get-ServiceUrl ([string]$Manifest.serverHost) ([int]$Manifest.ports.server) $readinessPath
  $webUrl = Get-ServiceUrl ([string]$Manifest.webHost) ([int]$Manifest.ports.web) '/'
  $serverReady = Test-Endpoint $serverUrl
  $webReady = Test-Endpoint $webUrl
  $serverRecord = $Manifest.processes | Where-Object { $_.role -eq 'server' } | Select-Object -First 1
  $webRecord = $Manifest.processes | Where-Object { $_.role -eq 'web' } | Select-Object -First 1
  $serverOwnership = Test-PortOwnershipRecord $Assessment.snapshot ([int]$serverRecord.pid) ([int]$Manifest.ports.server) $serverRecord
  $webOwnership = Test-PortOwnershipRecord $Assessment.snapshot ([int]$webRecord.pid) ([int]$Manifest.ports.web) $webRecord
  $serverPortOwned = $Assessment.results.server.state -eq 'running' -and $serverOwnership.owned
  $webPortOwned = $Assessment.results.web.state -eq 'running' -and $webOwnership.owned
  $missingRoots = @(@('server', 'web') | Where-Object { $Assessment.results[$_].state -ne 'running' })
  $healthy = $serverReady -and $webReady -and $serverPortOwned -and $webPortOwned -and $missingRoots.Count -eq 0
  return [pscustomobject][ordered]@{
    ok = $healthy; state = $(if ($healthy) { 'running' } else { 'degraded' })
    instanceId = $Manifest.instanceId; root = $Manifest.root; dataPath = $Manifest.dataPath
    mode = $Manifest.mode; ports = $Manifest.ports
    processPids = @($Manifest.processes | ForEach-Object { [int]$_.pid })
    endpoints = [pscustomobject]@{
      server = $serverReady; web = $webReady
      serverPortOwned = $serverPortOwned; webPortOwned = $webPortOwned
      serverPortOwners = @($serverOwnership.owners | ForEach-Object { [int]$_.pid })
      webPortOwners = @($webOwnership.owners | ForEach-Object { [int]$_.pid })
      serverReadinessPath = $readinessPath
    }
    urls = [pscustomobject]@{
      server = Get-ServiceUrl ([string]$Manifest.serverHost) ([int]$Manifest.ports.server) '/'
      web = Get-ServiceUrl ([string]$Manifest.webHost) ([int]$Manifest.ports.web) '/'
    }
  }
}

try {
  if ($Mock -and -not $Development) { throw '-Mock is available only with -Development.' }
  if ($Stable -and -not $Development) { throw '-Stable is available only with -Development.' }
  if ($DryRun -and $Action -ne 'start') { throw '-DryRun is available only with -Action start.' }

  $repoRoot = if ([string]::IsNullOrWhiteSpace($Root)) { Resolve-AbsolutePath (Join-Path $PSScriptRoot '..') } else { Resolve-AbsolutePath $Root }
  if (-not (Test-Path -LiteralPath $repoRoot -PathType Container)) { throw "Repository root does not exist: $repoRoot" }
  Import-LocalEnv (Join-Path $repoRoot '.env')

  $dataRoot = if (-not [string]::IsNullOrWhiteSpace($DataPath)) { Resolve-AbsolutePath $DataPath } elseif (-not [string]::IsNullOrWhiteSpace($env:AGENTOS_PROJECT_ROOT)) { Resolve-AbsolutePath $env:AGENTOS_PROJECT_ROOT } else { $repoRoot }
  $serverHostValue = Get-HostValue $ServerHost $env:AGENTOS_SERVER_HOST '127.0.0.1'
  $webHostValue = Get-HostValue $WebHost $env:AGENTOS_WEB_HOST '127.0.0.1'
  $serverPortValue = Get-PortValue $ServerPort $env:PORT 3000 'ServerPort'
  $webPortValue = Get-PortValue $WebPort $env:AGENTOS_WEB_PORT 3001 'WebPort'
  if ($serverPortValue -eq $webPortValue) { throw 'ServerPort and WebPort must be different.' }
  if ([string]::IsNullOrWhiteSpace($env:AGENTOS_ALLOW_REMOTE)) { Set-ScopedEnvironment 'AGENTOS_ALLOW_REMOTE' 'false' }
  if ([string]::IsNullOrWhiteSpace($env:AGENTOS_WEB_ORIGINS)) {
    $origins = @('http://localhost:' + $webPortValue, 'http://127.0.0.1:' + $webPortValue)
    $originHost = Get-AddressProbeHost $webHostValue
    if ($originHost -notin @('127.0.0.1', 'localhost', '::1')) { $origins += 'http://' + (Format-UrlHost $originHost) + ':' + $webPortValue }
    Set-ScopedEnvironment 'AGENTOS_WEB_ORIGINS' ($origins -join ',')
  }
  if ($Mock) { Set-ScopedEnvironment 'AGENTOS_FORCE_MOCK' 'true' }
  Set-ScopedEnvironment 'AGENTOS_SERVER_HOST' $serverHostValue
  Set-ScopedEnvironment 'AGENTOS_PROJECT_ROOT' $dataRoot
  Set-ScopedEnvironment 'PORT' ([string]$serverPortValue)

  $stateDir = Join-Path $dataRoot '.agentos/local-runtime'
  $manifestPath = Join-Path $stateDir 'manifest.json'
  $pidsPath = Join-Path $stateDir 'worker-pids.json'
  $script:manifestPath = $manifestPath
  $manifest = Read-Manifest $manifestPath

  if ($Action -eq 'status') {
    if ($null -eq $manifest -and (Test-Path -LiteralPath $pidsPath -PathType Leaf)) {
      try {
        $orphanedPids = Get-Content -LiteralPath $pidsPath -Raw | ConvertFrom-Json
        $result = [pscustomobject][ordered]@{
          ok = $false; state = 'unmanaged'; instanceId = [string]$orphanedPids.instanceId
          processPids = @([int]$orphanedPids.supervisorPid, [int]$orphanedPids.serverPid, [int]$orphanedPids.webPid)
          message = 'A worker PID record exists without a verified manifest. No process was touched; preserve the record and inspect the listed PIDs.'
        }
      } catch {
        $result = [pscustomobject][ordered]@{ ok = $false; state = 'unmanaged'; message = 'A worker PID record is unreadable without a verified manifest. No process was touched; preserve the file and inspect it.' }
      }
    } else {
      $assessment = if ($null -eq $manifest) { $null } else { Get-ManifestAssessment $manifest }
      $result = Get-StatusResult $manifest $assessment
    }
    if ($Json) { Write-JsonResult $result } else {
      Write-Output ('AgentOS local status: ' + $result.state)
      if ($result.PSObject.Properties.Name -contains 'urls') {
        Write-Output ('Server ' + $result.urls.server + ' (healthy=' + $result.endpoints.server + ')')
        Write-Output ('Web    ' + $result.urls.web + ' (healthy=' + $result.endpoints.web + ')')
      }
      if ($result.PSObject.Properties.Name -contains 'message') { Write-Output $result.message }
    }
    return
  }

  if ($Action -eq 'stop') {
    if ($null -eq $manifest) {
      if (Test-Path -LiteralPath $pidsPath -PathType Leaf) {
        throw "A worker PID record exists without a verified manifest at $pidsPath. No process was touched; inspect the record and process identities first."
      }
      $result = [pscustomobject]@{ ok = $true; state = 'stopped'; message = 'No local instance manifest exists.' }
    } else {
      $assessment = Get-ManifestAssessment $manifest
      Stop-Manifest $manifest $assessment
      $result = [pscustomobject]@{ ok = $true; state = 'stopped'; instanceId = $manifest.instanceId; processPids = @($manifest.processes | ForEach-Object { [int]$_.pid }) }
    }
    if ($Json) { Write-JsonResult $result } else { Write-Output 'AgentOS local process tree stopped.' }
    return
  }

  if (-not $Development) {
    $serverEntryPath = Join-Path $repoRoot 'apps/server/dist/index.js'
    $webBuildIdPath = Join-Path $repoRoot 'apps/web/.next/BUILD_ID'
    $nextEntryPath = Join-Path $repoRoot 'apps/web/node_modules/next/dist/bin/next'
    $missing = @()
    if (-not (Test-Path -LiteralPath $serverEntryPath -PathType Leaf)) { $missing += 'apps/server/dist/index.js' }
    if (-not (Test-Path -LiteralPath $webBuildIdPath -PathType Leaf)) { $missing += 'apps/web/.next/BUILD_ID' }
    if (-not (Test-Path -LiteralPath $nextEntryPath -PathType Leaf)) { $missing += 'apps/web/node_modules/next/dist/bin/next' }
    if ($missing.Count -gt 0) { throw "Production build files are missing: $($missing -join ', '). Build with 'pnpm --filter @agentos/server run build' and 'pnpm --filter @agentos/web run build'." }
  } else {
    $nextEntryPath = Join-Path $repoRoot 'apps/web/node_modules/next/dist/bin/next'
    if (-not (Test-Path -LiteralPath $nextEntryPath -PathType Leaf)) { throw 'The Web runtime is missing. Restore frozen workspace dependencies with pnpm install --frozen-lockfile.' }
  }

  if ($null -ne $manifest) {
    $assessment = Get-ManifestAssessment $manifest
    if ($assessment.mismatches.Count -gt 0) {
      $aliveMismatch = @($assessment.mismatches | Where-Object { $_ -notmatch ':missing-manifest-record' })
      if ($aliveMismatch.Count -gt 0) { throw "Existing manifest identity mismatch ($($aliveMismatch -join ', ')); no process was started or stopped. Inspect $manifestPath." }
    }
    $active = @($assessment.results.Values | Where-Object { $_.state -eq 'running' }).Count -gt 0
    if ($active) {
      $requestedMode = if ($Development) { 'development' } else { 'production' }
      $same = ([string]$manifest.root -eq $repoRoot -and [string]$manifest.dataPath -eq $dataRoot -and [int]$manifest.ports.server -eq $serverPortValue -and [int]$manifest.ports.web -eq $webPortValue -and [string]$manifest.serverHost -eq $serverHostValue -and [string]$manifest.webHost -eq $webHostValue -and [string]$manifest.mode -eq $requestedMode -and [bool]$manifest.mock -eq [bool]$Mock -and [bool]$manifest.stable -eq [bool]$Stable)
      if (-not $same) { throw 'An AgentOS local process tree is already running with different settings. Stop it with the same -DataPath before starting another instance.' }
      $existing = Get-StatusResult $manifest $assessment
      if ($Json) { Write-JsonResult $existing } else { Write-Output ('AgentOS local instance is already ' + $existing.state + '.') }
      return
    }
    Move-PreviousManifest $manifestPath
  }

  Assert-PortFree 'Server' $serverPortValue
  Assert-PortFree 'Web' $webPortValue
  if ($DryRun) {
    $dry = [pscustomobject][ordered]@{
      ok = $true; state = 'dry-run'; mode = $(if ($Development) { 'development' } else { 'production' })
      mock = [bool]$Mock; stable = [bool]$Stable; root = $repoRoot; dataPath = $dataRoot
      server = [pscustomobject]@{ host = $serverHostValue; port = $serverPortValue }
      web = [pscustomobject]@{ host = $webHostValue; port = $webPortValue }
      manifestPath = $manifestPath; secretsIncluded = $false
    }
    if ($Json) { Write-JsonResult $dry } else { Write-Output ('Dry run validated AgentOS ' + $dry.mode + ' launcher for ' + $repoRoot + '.') }
    return
  }

  [void](New-Item -ItemType Directory -Path $stateDir -Force)
  $lockPath = Join-Path $stateDir 'launcher.lock'
  $lock = $null
  try {
    try { $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
    catch { throw 'Another local launcher operation is active, or a stale launcher.lock exists. Inspect the lock before retrying.' }

    $instanceId = [guid]::NewGuid().ToString('N')
    $nonceBytes = New-Object byte[] 32
    $nonceGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $nonceGenerator.GetBytes($nonceBytes) } finally { $nonceGenerator.Dispose() }
    $shutdownNonce = [BitConverter]::ToString($nonceBytes).Replace('-', '').ToLowerInvariant()
    $supervisorPipe = '\\.\pipe\agentos-local-' + $instanceId + '-supervisor'
    $serverPipe = '\\.\pipe\agentos-local-' + $instanceId + '-server'
    Set-ScopedEnvironment 'AGENTOS_LOCAL_INSTANCE_ID' $instanceId
    Set-ScopedEnvironment 'AGENTOS_LOCAL_SHUTDOWN_NONCE' $shutdownNonce
    Set-ScopedEnvironment 'AGENTOS_LOCAL_SUPERVISOR_SHUTDOWN_PIPE' $supervisorPipe
    Set-ScopedEnvironment 'AGENTOS_LOCAL_SERVER_SHUTDOWN_PIPE' $serverPipe
    Set-ScopedEnvironment 'AGENTOS_SERVER_INSTANCE_ID' $instanceId
    $script:workerInstanceId = $instanceId
    $script:workerRoot = $repoRoot
    $script:workerDataPath = $dataRoot
    if (Test-Path -LiteralPath $pidsPath) {
      if ($null -eq $manifest) { throw "An untracked worker PID record already exists at $pidsPath. Preserve it and inspect before starting." }
      Move-PreviousManifest $pidsPath
    }
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $script:workerNodePath = $nodePath
    $workerPath = Resolve-AbsolutePath (Join-Path $PSScriptRoot 'agentos-local-worker.mjs')
    $modeValue = if ($Development) { 'development' } else { 'production' }
    $stableValue = if ($Stable) { 'true' } else { 'false' }
    $workerArguments = @(
      $workerPath, 'worker',
      '--instance-id', $instanceId,
      '--root', $repoRoot,
      '--data-path', $dataRoot,
      '--state-dir', (Resolve-AbsolutePath $stateDir),
      '--pids-file', (Resolve-AbsolutePath $pidsPath),
      '--mode', $modeValue,
      '--stable', $stableValue,
      '--server-host', $serverHostValue,
      '--server-port', [string]$serverPortValue,
      '--web-host', $webHostValue,
      '--web-port', [string]$webPortValue
    )
    $script:workerExpectedManifest = [pscustomobject]@{
      instanceId = $instanceId; root = $repoRoot; dataPath = $dataRoot
      mode = $modeValue; stable = [bool]$Stable; webHost = $webHostValue
      ports = [pscustomobject]@{ server = $serverPortValue; web = $webPortValue }
    }
    $quotedArgs = foreach ($item in $workerArguments) { '"' + ([string]$item).Replace('"', '\"') + '"' }
    $argumentLine = $quotedArgs -join ' '
    $workerProcess = Start-Process -FilePath $nodePath -ArgumentList $argumentLine -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    $script:workerProcess = $workerProcess
    $workerSnapshot = Get-ProcessMap
    if ($workerSnapshot.ContainsKey([int]$workerProcess.Id)) {
      $script:workerIdentity = Get-ProcessRecord $workerSnapshot[[int]$workerProcess.Id] 'supervisor' $repoRoot $serverPortValue
    }

    $pidsDeadline = (Get-Date).AddSeconds(12)
    while (-not (Test-Path -LiteralPath $pidsPath -PathType Leaf) -and (Get-Date) -lt $pidsDeadline) {
      if ($workerProcess.HasExited) { throw "The local supervisor exited before startup. Inspect $stateDir for bounded service logs." }
      Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $pidsPath -PathType Leaf)) { throw "The local supervisor did not publish its process IDs within 12 seconds. Inspect $stateDir." }
    $pids = Get-Content -LiteralPath $pidsPath -Raw | ConvertFrom-Json
    if ([string]$pids.instanceId -ne $instanceId -or [int]$pids.supervisorPid -ne [int]$workerProcess.Id) { throw 'The local supervisor handshake did not match this start request.' }

    $snapshot = Get-ProcessMap
    $records = @(
      (New-ProcessRecordFromMap $snapshot ([int]$pids.supervisorPid) 'supervisor' $repoRoot $serverPortValue),
      (New-ProcessRecordFromMap $snapshot ([int]$pids.serverPid) 'server' $repoRoot $serverPortValue),
      (New-ProcessRecordFromMap $snapshot ([int]$pids.webPid) 'web' $repoRoot $webPortValue)
    )
    foreach ($child in @($snapshot.Values | Where-Object { [int]$_.ParentProcessId -eq [int]$pids.supervisorPid -and [int]$_.ProcessId -notin @($pids.serverPid, $pids.webPid) })) {
      $consolePath = Resolve-AbsolutePath (Join-Path $env:SystemRoot 'System32/conhost.exe')
      if (-not [string]::Equals([string]$child.ExecutablePath, $consolePath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The supervisor has an unrecognized direct child; startup stopped before the instance was accepted.'
      }
      $records += (Get-ProcessRecord $child 'console-host' $repoRoot 0)
    }
    $manifest = [pscustomobject][ordered]@{
      schemaVersion = 1
      instanceId = $instanceId
      state = 'starting'
      readinessPath = '/api/health/ready'
      createdAt = [DateTime]::UtcNow.ToString('o')
      mode = $modeValue
      mock = [bool]$Mock
      stable = [bool]$Stable
      root = $repoRoot
      dataPath = $dataRoot
      serverHost = $serverHostValue
      webHost = $webHostValue
      ports = [pscustomobject][ordered]@{ server = $serverPortValue; web = $webPortValue }
      shutdownControl = [pscustomobject][ordered]@{
        supervisorPipe = $supervisorPipe
        serverPipe = $serverPipe
        nonceSha256 = Get-Sha256Hex ([System.Text.Encoding]::UTF8.GetBytes($shutdownNonce))
      }
      processes = $records
      logDirectory = Resolve-AbsolutePath $stateDir
    }
    foreach ($role in @('server', 'web')) {
      $record = $manifest.processes | Where-Object { $_.role -eq $role } | Select-Object -First 1
      if ([int]$record.parentPid -ne [int]$pids.supervisorPid) { throw "The $role process is not a direct child of the recorded supervisor." }
      if (-not (Test-ExpectedCommand $manifest $record)) { throw "The $role command did not match the expected launcher entry." }
    }
    if (-not (Test-ExpectedCommand $manifest $manifest.processes[0])) { throw 'The supervisor command did not match the expected launcher identity.' }
    Write-Manifest $manifestPath $manifest

    $webUrl = Get-ServiceUrl $webHostValue $webPortValue '/'
    $ready = Test-Ready $serverHostValue $serverPortValue $webUrl $ReadyTimeoutSeconds
    if ($ready.server -and $ready.web) {
      $readyAssessment = Get-ManifestAssessment $manifest
      $serverRecord = $manifest.processes | Where-Object { $_.role -eq 'server' } | Select-Object -First 1
      $webRecord = $manifest.processes | Where-Object { $_.role -eq 'web' } | Select-Object -First 1
      $serverOwnership = Get-PortOwnership $readyAssessment.snapshot ([int]$serverRecord.pid) $serverPortValue
      $webOwnership = Get-PortOwnership $readyAssessment.snapshot ([int]$webRecord.pid) $webPortValue
      $serverRecord | Add-Member -NotePropertyName portOwners -NotePropertyValue @($serverOwnership.owners) -Force
      $webRecord | Add-Member -NotePropertyName portOwners -NotePropertyValue @($webOwnership.owners) -Force
      $ready.server = $readyAssessment.results.server.state -eq 'running' -and $serverOwnership.owned
      $ready.web = $readyAssessment.results.web.state -eq 'running' -and $webOwnership.owned
    }
    if (-not $ready.server -or -not $ready.web) {
      $details = 'server=' + $ready.server + ', web=' + $ready.web
      $assessment = Get-ManifestAssessment $manifest
      try { Stop-Manifest $manifest $assessment } catch { throw "Readiness timed out ($details). Safe owned-process cleanup could not complete: $($_.Exception.Message). Inspect $stateDir." }
      throw "Readiness timed out after $ReadyTimeoutSeconds seconds ($details). The verified owned process tree was stopped. Inspect $stateDir."
    }
    $manifest.state = 'running'
    $manifest.readinessPath = $ready.serverPath
    $manifest | Add-Member -NotePropertyName readyAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    Write-Manifest $manifestPath $manifest
    $script:startupCommitted = $true
    $result = [pscustomobject][ordered]@{
      ok = $true; state = 'running'; instanceId = $instanceId; mode = $modeValue
      root = $repoRoot; dataPath = $dataRoot; ports = $manifest.ports
      processPids = @($manifest.processes | ForEach-Object { [int]$_.pid })
      urls = [pscustomobject]@{ server = Get-ServiceUrl $serverHostValue $serverPortValue '/'; web = Get-ServiceUrl $webHostValue $webPortValue '/' }
      manifestPath = $manifestPath; secretsIncluded = $false
    }
    if ($Json) { Write-JsonResult $result } else { Write-Output ('AgentOS ' + $modeValue + ' started: Server ' + $result.urls.server + ', Web ' + $result.urls.web + '.') }
  } finally {
    if ($null -ne $lock) { $lock.Dispose() }
    if ($null -ne $lock -and (Test-Path -LiteralPath $lockPath -PathType Leaf)) { Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue }
  }
} catch {
  if ($Action -eq 'start' -and $null -ne $script:workerProcess -and -not $script:startupCommitted) {
    try {
      if (Test-Path -LiteralPath $script:manifestPath) {
        $partialManifest = Read-Manifest $script:manifestPath
        if ($null -ne $partialManifest) {
          $partialAssessment = Get-ManifestAssessment $partialManifest
          Stop-Manifest $partialManifest $partialAssessment
        }
      }
    } catch {
      Write-Warning ('Startup cleanup could not prove graceful ownership shutdown; no process was force-stopped. Preserve the manifest/runtime evidence. ' + $_.Exception.Message)
    }
  }
  if ($Json) {
    Write-JsonResult ([pscustomobject]@{ ok = $false; state = 'error'; error = $_.Exception.Message; secretsIncluded = $false })
    return
  }
  throw
} finally {
  foreach ($name in @($script:environmentBackup.Keys)) {
    [Environment]::SetEnvironmentVariable([string]$name, $script:environmentBackup[$name], 'Process')
  }
}
