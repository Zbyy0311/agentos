param(
  [int] $ServerPort = 3201,
  [string] $AcceptanceRoot = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$node = (Get-Command node.exe).Source
$originalPort = $env:PORT
$originalProjectRoot = $env:AGENTOS_PROJECT_ROOT
$originalRuntimeDispatch = $env:AGENTOS_RUNTIME_DISPATCH_ENABLED
$originalKimiApiKey = $env:AGENTOS_KIMI_API_KEY
$originalKimiLegacyApiKey = $env:KIMI_API_KEY
$preExitCode = 1
$recoveryExitCode = 1
$prepareExitCode = 1
$assembleExitCode = 1
$server = $null

function Assert-PortFree([int] $Port) {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) { throw "Port $Port is already in use by PID $($listeners[0].OwningProcess)." }
}

function Assert-PortReleased([int] $Port) {
  $deadline = (Get-Date).AddSeconds(10)
  do {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "Port $Port remains occupied."
}

function Stop-ProcessTree([int] $ProcessId) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) { Stop-ProcessTree -ProcessId ([int] $child.ProcessId) }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Set-RoutedModel([object] $Agent, [string] $Flag, [string] $Model) {
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
    $result.Add([string] $current[$index])
  }
  if (-not $replaced) { $result.Add($Flag); $result.Add($Model) }
  $Agent.cliArgs = $result.ToArray()
  if ($Agent.PSObject.Properties['model']) { $Agent.model = $Model }
}

function Start-Server([string] $Root, [string] $LogLabel, [string] $EvidenceRoot) {
  $env:PORT = [string] $ServerPort
  $env:AGENTOS_PROJECT_ROOT = $Root
  $stdout = Join-Path $EvidenceRoot "server-$LogLabel.stdout.txt"
  $stderr = Join-Path $EvidenceRoot "server-$LogLabel.stderr.txt"
  $process = Start-Process -FilePath $node -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -ArgumentList @('apps/server/dist/index.js')
  Write-Host "Server started: label=$LogLabel pid=$($process.Id) port=$ServerPort"
  return $process
}

function Stop-Server([System.Diagnostics.Process] $Process) {
  if ($Process -and -not $Process.HasExited) {
    Start-Sleep -Milliseconds 500
    Stop-ProcessTree -ProcessId $Process.Id
  }
  Assert-PortReleased $ServerPort
}

function Wait-Health {
  $deadline = (Get-Date).AddSeconds(45)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ServerPort/api/health" -TimeoutSec 3
      if ($response.StatusCode -eq 200) { return }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)
  throw 'candidate evidence server did not become healthy within 45 seconds.'
}

function Invoke-Node([string[]] $Arguments, [string] $StdoutPath, [string] $StderrPath, [string] $WorkingDirectory = $repoRoot) {
  $process = Start-Process -FilePath $node -WorkingDirectory $WorkingDirectory -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -ArgumentList $Arguments
  $process.WaitForExit()
  Write-Host "Node command exit=$($process.ExitCode) stdout=$StdoutPath stderr=$StderrPath"
  return [int] $process.ExitCode
}

try {
  Assert-PortFree $ServerPort
  if (-not $AcceptanceRoot) {
    throw '-AcceptanceRoot is required so raw evidence remains reviewable.'
  }
  $AcceptanceRoot = [IO.Path]::GetFullPath($AcceptanceRoot)
  $workspaceRoot = Join-Path $AcceptanceRoot 'workspace'
  $evidenceRoot = Join-Path $AcceptanceRoot 'candidate-evidence'
  New-Item -ItemType Directory -Force -Path $workspaceRoot, $evidenceRoot | Out-Null
  git -C $workspaceRoot init --quiet
  if ($LASTEXITCODE -ne 0) { throw "failed to initialize temporary candidate workspace: $workspaceRoot" }

  $config = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'workspace/workspaces.json') | ConvertFrom-Json
  foreach ($workspace in $config.workspaces) { $workspace.rootPath = $workspaceRoot }
  $primary = $config.workspaces | Select-Object -First 1
  if (-not $primary) { throw 'no workspace was available for candidate evidence.' }
  $routeModels = [ordered]@{
    codex = 'deepseek/deepseek-flash'
    kimi = 'opencodex/deepseek/deepseek-flash'
    opencode = 'deepseek/deepseek-v4-flash'
  }
  foreach ($agent in $primary.agents | Where-Object { $_.id -in @('codex', 'kimi', 'opencode') }) {
    if ($agent.id -eq 'kimi') { Set-RoutedModel $agent '-m' $routeModels.kimi }
    else { Set-RoutedModel $agent '--model' $routeModels[$agent.id] }
    Write-Host "Candidate route model: $($agent.id)=$($routeModels[$agent.id])"
  }
  $configJson = $config | ConvertTo-Json -Depth 30
  [IO.File]::WriteAllText((Join-Path $workspaceRoot 'workspaces.json'), $configJson, (New-Object Text.UTF8Encoding($false)))

  Remove-Item Env:AGENTOS_KIMI_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:KIMI_API_KEY -ErrorAction SilentlyContinue
  $env:AGENTOS_RUNTIME_DISPATCH_ENABLED = 'true'
  $env:AGENTOS_PROJECT_ROOT = $AcceptanceRoot

  # Start before creating the candidate Run. Startup recovery must see no
  # candidate Run; otherwise a deliberately queued test Run would be classified
  # as an interrupted legacy Run before the lifecycle test begins.
  $server = Start-Server $AcceptanceRoot 'pre' $evidenceRoot
  Wait-Health

  $setupJson = Join-Path $AcceptanceRoot 'candidate-setup.json'
  $prepareExitCode = Invoke-Node @(
    'scripts/prepare-lite-four-row-candidate-evidence.mjs',
    '--acceptance-root', $AcceptanceRoot,
    '--setup-json', $setupJson
  ) (Join-Path $evidenceRoot 'prepare.stdout.txt') (Join-Path $evidenceRoot 'prepare.stderr.txt')
  if ($prepareExitCode -ne 0) { throw "candidate Run preparation failed with exit $prepareExitCode" }

  $baseUrl = "http://127.0.0.1:$ServerPort"
  $preExitCode = Invoke-Node @(
    'scripts/verify-lite-four-row-candidate-evidence.mjs',
    '--phase', 'pre',
    '--base-url', $baseUrl,
    '--root', $AcceptanceRoot,
    '--setup-json', $setupJson,
    '--output', (Join-Path $evidenceRoot 'pre.json')
  ) (Join-Path $evidenceRoot 'pre.stdout.txt') (Join-Path $evidenceRoot 'pre.stderr.txt')
  Write-Host "Candidate pre phase raw exit code: $preExitCode"
  Stop-Server $server
  $server = $null

  $server = Start-Server $AcceptanceRoot 'recovery' $evidenceRoot
  Wait-Health
  $recoveryExitCode = Invoke-Node @(
    'scripts/verify-lite-four-row-candidate-evidence.mjs',
    '--phase', 'recovery',
    '--base-url', $baseUrl,
    '--root', $AcceptanceRoot,
    '--setup-json', $setupJson,
    '--pre-json', (Join-Path $evidenceRoot 'pre.json'),
    '--output', (Join-Path $evidenceRoot 'recovery.json')
  ) (Join-Path $evidenceRoot 'recovery.stdout.txt') (Join-Path $evidenceRoot 'recovery.stderr.txt')
  Write-Host "Candidate recovery phase raw exit code: $recoveryExitCode"
  Stop-Server $server
  $server = $null

  $command = "pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-lite-four-row-candidate-evidence.ps1 -ServerPort $ServerPort -AcceptanceRoot `"$AcceptanceRoot`""
  $runMetadata = [ordered]@{
    schemaVersion = 1
    command = $command
    baselineSha = '31020c9ba0cab64aa1706a48126c4681c12e562f'
    preRawExitCode = $preExitCode
    recoveryRawExitCode = $recoveryExitCode
    prepareRawExitCode = $prepareExitCode
    routeModels = $routeModels
    modelScopeStatement = '此证据验证的是指定路由模型下的 AgentOS Provider/Runtime canonical chain，不证明机器默认模型或额度受限模型可用。'
    serverLifecycle = @('pre server started', 'pre candidate phase completed', 'pre server stopped', 'recovery server started', 'recovery phase completed', 'recovery server stopped')
  }
  $metadataPath = Join-Path $evidenceRoot 'run-metadata.json'
  [IO.File]::WriteAllText($metadataPath, ($runMetadata | ConvertTo-Json -Depth 20) + "`n", (New-Object Text.UTF8Encoding($false)))

  $assembleExitCode = Invoke-Node @(
    'scripts/assemble-lite-four-row-candidate-evidence.mjs',
    '--repo-root', $repoRoot,
    '--evidence-root', $evidenceRoot,
    '--setup-json', $setupJson,
    '--metadata-json', $metadataPath,
    '--pre-json', (Join-Path $evidenceRoot 'pre.json'),
    '--recovery-json', (Join-Path $evidenceRoot 'recovery.json'),
    '--output', (Join-Path $repoRoot 'docs/implementation/lite-closeout/S8-four-row-candidate-evidence.json')
  ) (Join-Path $evidenceRoot 'assemble.stdout.txt') (Join-Path $evidenceRoot 'assemble.stderr.txt')
} finally {
  if ($server) {
    try { Stop-Server $server } catch { Write-Host "server cleanup warning: $($_.Exception.Message)" }
  }
  if ($null -eq $originalPort) { Remove-Item Env:PORT -ErrorAction SilentlyContinue } else { $env:PORT = $originalPort }
  if ($null -eq $originalProjectRoot) { Remove-Item Env:AGENTOS_PROJECT_ROOT -ErrorAction SilentlyContinue } else { $env:AGENTOS_PROJECT_ROOT = $originalProjectRoot }
  if ($null -eq $originalRuntimeDispatch) { Remove-Item Env:AGENTOS_RUNTIME_DISPATCH_ENABLED -ErrorAction SilentlyContinue } else { $env:AGENTOS_RUNTIME_DISPATCH_ENABLED = $originalRuntimeDispatch }
  if ($null -eq $originalKimiApiKey) { Remove-Item Env:AGENTOS_KIMI_API_KEY -ErrorAction SilentlyContinue } else { $env:AGENTOS_KIMI_API_KEY = $originalKimiApiKey }
  if ($null -eq $originalKimiLegacyApiKey) { Remove-Item Env:KIMI_API_KEY -ErrorAction SilentlyContinue } else { $env:KIMI_API_KEY = $originalKimiLegacyApiKey }
}

if ($prepareExitCode -ne 0 -or $preExitCode -ne 0 -or $recoveryExitCode -ne 0 -or $assembleExitCode -ne 0) {
  exit 1
}
exit 0
