param(
  [int] $ServerPort = 3200,
  [string] $AcceptanceRoot = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$serverRoot = Join-Path $repoRoot 'apps/server'
$node = (Get-Command node.exe).Source
$startedProcesses = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$originalProjectRoot = $env:AGENTOS_PROJECT_ROOT
$originalE2EBase = $env:AGENTOS_E2E_BASE_URL
$originalE2EPhase = $env:AGENTOS_E2E_PHASE
$originalKimiApiKey = $env:AGENTOS_KIMI_API_KEY
$originalKimiLegacyApiKey = $env:KIMI_API_KEY
$createdAcceptanceRoot = $false
$preExitCode = 1
$recoveryExitCode = 1

function Assert-PortFree([int] $Port) {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) { throw "Port $Port is already in use by PID $($listeners[0].OwningProcess)." }
}

function Assert-PortReleased([int] $Port) {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) { throw "Port $Port remains occupied by PID $($listeners[0].OwningProcess)." }
}

function Stop-ProcessTree([int] $ProcessId) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) { Stop-ProcessTree -ProcessId ([int] $child.ProcessId) }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Start-Server([string] $Root, [string] $LogRoot) {
  $env:PORT = [string] $ServerPort
  $env:AGENTOS_PROJECT_ROOT = $Root
  $process = Start-Process -FilePath $node -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogRoot "server-$ServerPort.stdout.log") `
    -RedirectStandardError (Join-Path $LogRoot "server-$ServerPort.stderr.log") `
    -ArgumentList @('apps/server/dist/index.js')
  $startedProcesses.Add($process)
  Write-Host "Server started with PID $($process.Id) on port $ServerPort"
  return $process
}

function Stop-Server([System.Diagnostics.Process] $Process) {
  if ($Process -and -not $Process.HasExited) {
    Start-Sleep -Milliseconds 500
    Stop-ProcessTree -ProcessId $Process.Id
  }
  Start-Sleep -Milliseconds 500
  Assert-PortReleased $ServerPort
}

function Wait-Health {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ServerPort/api/health" -TimeoutSec 3
      if ($response.StatusCode -eq 200) { return }
    } catch { Start-Sleep -Seconds 1 }
  } while ((Get-Date) -lt $deadline)
  throw 'E2E server did not become healthy within 30 seconds.'
}

function Normalize-ProcessPath {
  $pathValue = [Environment]::GetEnvironmentVariable('Path', 'Process')
  Remove-Item Env:PATH -ErrorAction SilentlyContinue
  Remove-Item Env:Path -ErrorAction SilentlyContinue
  if ($pathValue) { $env:Path = $pathValue }
}

function Resolve-ConfiguredCommand([string] $Command) {
  if ([System.IO.Path]::IsPathRooted($Command)) { return Test-Path -LiteralPath $Command }
  return $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

function Set-RoutedModel([object] $Agent, [string] $Flag, [string] $Model) {
  # Replace the model in place so the harness never depends on the machine's
  # quota-limited default models. Appending at the end would break CLIs whose
  # positional pairing matters: AgentOS appends the prompt after the configured
  # args, so kimi's '-p <prompt>' must keep its position.
  $current = @($Agent.cliArgs)
  $result = New-Object System.Collections.Generic.List[string]
  $replaced = $false
  for ($index = 0; $index -lt $current.Count; $index++) {
    if ($current[$index] -eq $Flag) {
      $result.Add($Flag)
      $result.Add($Model)
      $replaced = $true
      if ($index + 1 -lt $current.Count) { $index++ }
      continue
    }
    $result.Add($current[$index])
  }
  if (-not $replaced) { $result.Add($Flag); $result.Add($Model) }
  $Agent.cliArgs = $result.ToArray()
  if ($Agent.PSObject.Properties['model']) { $Agent.model = $Model }
}

try {
  Assert-PortFree $ServerPort
  Normalize-ProcessPath
  if (-not $AcceptanceRoot) {
    $AcceptanceRoot = Join-Path $env:TEMP "agentos-e2e-$([guid]::NewGuid().ToString('N'))"
    $createdAcceptanceRoot = $true
  }
  $workspaceRoot = Join-Path $AcceptanceRoot 'workspace'
  $logRoot = Join-Path $AcceptanceRoot 'logs'
  New-Item -ItemType Directory -Force -Path $workspaceRoot, $logRoot | Out-Null
  git -C $workspaceRoot init --quiet
  if ($LASTEXITCODE -ne 0) { throw "Failed to initialize temporary E2E Git workspace: $workspaceRoot" }

  $config = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'workspace/workspaces.json') | ConvertFrom-Json
  foreach ($workspace in $config.workspaces) { $workspace.rootPath = $workspaceRoot }
  $primary = $config.workspaces | Select-Object -First 1
  if (-not $primary) { throw 'No workspace was available for E2E verification.' }
  $fixtureRoot = Join-Path $repoRoot 'scripts/fixtures'
  $fixtureAgents = @(
    [pscustomobject]@{
      id = 'e2e-failing'; name = 'E2E Failing Fixture'; role = 'kimi'; enabled = $true
      cliCommand = $node; cliArgs = @((Join-Path $fixtureRoot 'e2e-failing-agent.mjs')); thinkingEffort = 'auto'
    },
    [pscustomobject]@{
      id = 'e2e-waiting'; name = 'E2E Waiting Fixture'; role = 'kimi'; enabled = $true
      cliCommand = $node; cliArgs = @((Join-Path $fixtureRoot 'e2e-waiting-agent.mjs')); thinkingEffort = 'auto'
    }
  )
  $primary.agents = @($primary.agents | Where-Object { $_.id -notin @('e2e-failing', 'e2e-waiting', 'codex-failure') }) + $fixtureAgents
  $codex = $primary.agents | Where-Object { $_.id -eq 'codex' } | Select-Object -First 1

  # Acceptance must not depend on ambient credentials or quota-limited default
  # models. AgentOS switches the Kimi CLI to the official endpoint whenever
  # AGENTOS_KIMI_API_KEY is present and drops the configured '-m' routing, so an
  # ambient key silently changes which provider answers; the keys are removed
  # for this run and every real agent is routed through the reviewed loopback
  # models instead. Both facts are printed so the evidence names the models.
  Remove-Item Env:AGENTOS_KIMI_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:KIMI_API_KEY -ErrorAction SilentlyContinue
  $routedModels = [ordered]@{
    codex    = if ($env:AGENTOS_E2E_CODEX_MODEL) { $env:AGENTOS_E2E_CODEX_MODEL } else { 'deepseek/deepseek-flash' }
    kimi     = if ($env:AGENTOS_E2E_KIMI_MODEL) { $env:AGENTOS_E2E_KIMI_MODEL } else { 'opencodex/deepseek/deepseek-flash' }
    opencode = if ($env:AGENTOS_E2E_OPENCODE_MODEL) { $env:AGENTOS_E2E_OPENCODE_MODEL } else { 'deepseek/deepseek-v4-flash' }
  }
  foreach ($realAgent in $primary.agents | Where-Object { $_.id -in @('codex', 'kimi', 'opencode') }) {
    if ($realAgent.id -eq 'kimi') { Set-RoutedModel $realAgent '-m' $routedModels['kimi'] }
    else { Set-RoutedModel $realAgent '--model' $routedModels[$realAgent.id] }
    Write-Host "E2E model routing: $($realAgent.id)=$($routedModels[$realAgent.id])"
  }
  if ($codex) {
    $failureArgs = @($codex.cliArgs) + @('--model', '__agentos_invalid_model_for_e2e__')
    $primary.agents += [pscustomobject]@{
      id = 'codex-failure'; name = 'E2E Real Failure'; role = 'codex'; enabled = $true
      cliCommand = $codex.cliCommand; cliArgs = $failureArgs; thinkingEffort = 'auto'
    }
  }
  $configJson = $config | ConvertTo-Json -Depth 30
  [System.IO.File]::WriteAllText((Join-Path $workspaceRoot 'workspaces.json'), $configJson, (New-Object System.Text.UTF8Encoding($false)))

  foreach ($agent in $primary.agents | Where-Object { $_.id -in @('codex', 'kimi', 'opencode') }) {
    $available = Resolve-ConfiguredCommand ([string] $agent.cliCommand)
    $availabilityLabel = if ($available) { 'available' } else { 'missing' }
    Write-Host "REAL CLI $($agent.id): $availabilityLabel"
  }

  $env:AGENTOS_PROJECT_ROOT = $AcceptanceRoot
  $env:AGENTOS_E2E_BASE_URL = "http://127.0.0.1:$ServerPort"
  $env:AGENTOS_E2E_EXPECT_REAL = 'true'

  $server = Start-Server $AcceptanceRoot $logRoot
  Wait-Health
  $env:AGENTOS_E2E_PHASE = 'pre-recovery'
  $preOutput = @(& $node (Join-Path $repoRoot 'scripts/verify-agentos-e2e.mjs') 2>&1)
  $preExitCode = $LASTEXITCODE
  $preOutput | ForEach-Object { Write-Host $_ }
  Write-Host "E2E pre-recovery phase exit code: $preExitCode"
  Stop-Server $server

  $server = Start-Server $AcceptanceRoot $logRoot
  Wait-Health
  $env:AGENTOS_E2E_PHASE = 'recovery'
  $recoveryOutput = @(& $node (Join-Path $repoRoot 'scripts/verify-agentos-e2e.mjs') 2>&1)
  $recoveryExitCode = $LASTEXITCODE
  $recoveryOutput | ForEach-Object { Write-Host $_ }
  Write-Host "E2E recovery phase exit code: $recoveryExitCode"
  Stop-Server $server

  $preLabel = if ($preExitCode -eq 0) { 'passed' } else { 'failed' }
  $deterministicLabel = if ($preOutput -match '^DETERMINISTIC_LIFECYCLE: passed$') { 'passed' } else { 'failed' }
  $memoryLabel = if ($preOutput -match '^MEMORY_CANDIDATE: passed$') { 'passed' } else { 'failed' }
  $recoveryGateLabel = if ($recoveryOutput -match '^RECOVERY: passed$') { 'passed' } else { 'failed' }
  Write-Host "REAL_EXTERNAL_AGENT: $preLabel"
  Write-Host "DETERMINISTIC_LIFECYCLE: $deterministicLabel"
  Write-Host "RECOVERY: $recoveryGateLabel"
  Write-Host "MEMORY_CANDIDATE: $memoryLabel"
  if ($preExitCode -ne 0 -or $recoveryExitCode -ne 0) { exit 1 }
} finally {
  foreach ($process in @($startedProcesses)) {
    if ($process -and -not $process.HasExited) { Stop-ProcessTree -ProcessId $process.Id }
  }
  if ($originalProjectRoot) { $env:AGENTOS_PROJECT_ROOT = $originalProjectRoot } else { Remove-Item Env:AGENTOS_PROJECT_ROOT -ErrorAction SilentlyContinue }
  if ($originalE2EBase) { $env:AGENTOS_E2E_BASE_URL = $originalE2EBase } else { Remove-Item Env:AGENTOS_E2E_BASE_URL -ErrorAction SilentlyContinue }
  if ($originalE2EPhase) { $env:AGENTOS_E2E_PHASE = $originalE2EPhase } else { Remove-Item Env:AGENTOS_E2E_PHASE -ErrorAction SilentlyContinue }
  if ($originalKimiApiKey) { $env:AGENTOS_KIMI_API_KEY = $originalKimiApiKey } else { Remove-Item Env:AGENTOS_KIMI_API_KEY -ErrorAction SilentlyContinue }
  if ($originalKimiLegacyApiKey) { $env:KIMI_API_KEY = $originalKimiLegacyApiKey } else { Remove-Item Env:KIMI_API_KEY -ErrorAction SilentlyContinue }
  if ($AcceptanceRoot) {
    Assert-PortReleased $ServerPort
    if ($createdAcceptanceRoot -and (Test-Path -LiteralPath $AcceptanceRoot)) {
      $removed = $false
      for ($attempt = 1; $attempt -le 20 -and -not $removed; $attempt++) {
        try {
          Remove-Item -LiteralPath $AcceptanceRoot -Recurse -Force -ErrorAction Stop
          $removed = $true
        } catch {
          Start-Sleep -Seconds 1
        }
      }
      if ($removed) {
        Write-Host "E2E temporary root removed: $AcceptanceRoot"
      } else {
        Write-Warning "E2E temporary root is retained because Windows still holds a file handle: $AcceptanceRoot"
      }
    } else {
      Write-Host "E2E artifacts retained at caller-provided root: $AcceptanceRoot"
    }
  }
}
