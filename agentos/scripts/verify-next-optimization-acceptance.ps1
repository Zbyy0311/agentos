param(
  [int] $ServerPort = 3100,
  [int] $WebPort = 3101,
  [string] $AcceptanceRoot = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$serverRoot = Join-Path $repoRoot 'apps/server'
$webRoot = Join-Path $repoRoot 'apps/web'
$node = (Get-Command node.exe).Source
$powershell = (Get-Command powershell.exe).Source
$startedProcesses = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$originalApiBase = $env:NEXT_PUBLIC_API_URL
$originalProjectRoot = $env:AGENTOS_PROJECT_ROOT
$originalNextDistDir = $env:AGENTOS_NEXT_DIST_DIR
$originalNextTsConfigPath = $env:AGENTOS_NEXT_TSCONFIG_PATH
$isolatedNextDistDirName = ".next-acceptance-$([guid]::NewGuid().ToString('N'))"
$isolatedNextTsConfigName = "tsconfig.acceptance-$([guid]::NewGuid().ToString('N')).json"
$isolatedNextTsConfigPath = Join-Path $webRoot $isolatedNextTsConfigName
$originalWebTsConfigBytes = [System.IO.File]::ReadAllBytes((Join-Path $webRoot 'tsconfig.json'))
$createdAcceptanceRoot = $false

function Invoke-Check([string] $Name, [scriptblock] $Command) {
  $started = Get-Date
  Write-Host "=== $Name ($($started.ToString('s'))) ==="
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
  Write-Host "=== $Name passed ($((Get-Date).ToString('s'))) ==="
}

function Assert-PortFree([int] $Port) {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) {
    throw "Port $Port is already in use by PID $($listeners[0].OwningProcess); acceptance will not take over an existing process."
  }
}

function Assert-PortReleased([int] $Port) {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) {
    throw "Port $Port remains occupied after acceptance cleanup by PID $($listeners[0].OwningProcess)."
  }
}

function Wait-Http([string] $Name, [string] $Uri, [int] $TimeoutSeconds = 30) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 3
      if ($response.StatusCode -eq 200) {
        Write-Host "$Name is healthy: HTTP 200"
        return $response
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  } while ((Get-Date) -lt $deadline)
  throw "$Name did not become healthy within $TimeoutSeconds seconds: $Uri"
}

function Stop-ProcessTree([int] $ProcessId) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) { Stop-ProcessTree -ProcessId ([int] $child.ProcessId) }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Start-TrackedProcess([string] $Name, [string] $Command, [string] $WorkingDirectory, [string] $Stdout, [string] $Stderr) {
  $process = Start-Process -FilePath $powershell -WorkingDirectory $WorkingDirectory -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $Command)
  $startedProcesses.Add($process)
  Write-Host "$Name started with PID $($process.Id)"
  return $process
}

function Start-TrackedServer([string] $Root, [string] $Stdout, [string] $Stderr) {
  $env:PORT = [string] $ServerPort
  $env:AGENTOS_PROJECT_ROOT = $Root
  $process = Start-Process -FilePath $node -WorkingDirectory $serverRoot -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr -ArgumentList @('dist/index.js')
  $startedProcesses.Add($process)
  Write-Host "Server started with PID $($process.Id)"
  return $process
}

function Normalize-ProcessPath {
  $pathValue = [Environment]::GetEnvironmentVariable('Path', 'Process')
  Remove-Item Env:PATH -ErrorAction SilentlyContinue
  Remove-Item Env:Path -ErrorAction SilentlyContinue
  if ($pathValue) { $env:Path = $pathValue }
}

function Remove-IsolatedWebTsConfig {
  if (Test-Path -LiteralPath $isolatedNextTsConfigPath) {
    Remove-Item -LiteralPath $isolatedNextTsConfigPath -Force -ErrorAction SilentlyContinue
  }
}

try {
  Assert-PortFree $ServerPort
  Assert-PortFree $WebPort

  if (-not $AcceptanceRoot) {
    $AcceptanceRoot = Join-Path $env:TEMP "agentos-acceptance-$([guid]::NewGuid().ToString('N'))"
    $createdAcceptanceRoot = $true
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $AcceptanceRoot 'workspace') | Out-Null
  $workspaceConfig = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'workspace/workspaces.json') | ConvertFrom-Json
  foreach ($workspace in $workspaceConfig.workspaces) { $workspace.rootPath = $AcceptanceRoot }
  $workspaceConfigJson = $workspaceConfig | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText((Join-Path $AcceptanceRoot 'workspace/workspaces.json'), $workspaceConfigJson, (New-Object System.Text.UTF8Encoding($false)))
  $logRoot = Join-Path $AcceptanceRoot 'acceptance-logs'
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

  $env:NEXT_PUBLIC_API_URL = "http://localhost:$ServerPort"
  $env:AGENTOS_NEXT_DIST_DIR = $isolatedNextDistDirName
  [System.IO.File]::WriteAllBytes($isolatedNextTsConfigPath, $originalWebTsConfigBytes)
  $env:AGENTOS_NEXT_TSCONFIG_PATH = $isolatedNextTsConfigName
  Invoke-Check 'Frozen install' { pnpm.cmd install --frozen-lockfile }
  Invoke-Check 'Shared build' { pnpm.cmd --filter @agentos/shared build }
  Invoke-Check 'Agent Core tests' { pnpm.cmd --filter @agentos/agent-core test }
  Invoke-Check 'Server tests' { pnpm.cmd --filter @agentos/server test }
  Invoke-Check 'Web build' { pnpm.cmd --filter @agentos/web build }
  Invoke-Check 'Monorepo build' { pnpm.cmd -r run build }
  Write-Host "Used isolated $isolatedNextTsConfigName for production builds; apps/web/tsconfig.json was not modified."

  # Production web process: next start, never next dev.
  Normalize-ProcessPath
  $webCommand = "`$env:PORT='$WebPort'; Set-Location '$webRoot'; & '.\node_modules\.bin\next.CMD' start -p $WebPort"
  Start-TrackedServer $AcceptanceRoot (Join-Path $logRoot 'server.stdout.log') (Join-Path $logRoot 'server.stderr.log') | Out-Null
  Start-TrackedProcess 'Web' $webCommand $repoRoot (Join-Path $logRoot 'web.stdout.log') (Join-Path $logRoot 'web.stderr.log') | Out-Null

  Wait-Http 'Server' "http://localhost:$ServerPort/api/health" | Out-Null
  $webResponse = Wait-Http 'Web' "http://localhost:$WebPort/"
  $workspaces = Invoke-RestMethod -UseBasicParsing "http://localhost:$ServerPort/api/workspaces"
  if (-not $workspaces.workspaces -or $workspaces.workspaces.Count -lt 1) { throw 'Workspace API returned no workspaces.' }
  if ($webResponse.Content -notmatch 'Workspace|workspace') { throw 'Web page did not contain a Workspace entry.' }

  Write-Host 'Acceptance checks passed: frozen install, builds, tests, isolated production services, health, API, and page response.'
} finally {
  foreach ($process in @($startedProcesses)) {
    if ($process -and -not $process.HasExited) { Stop-ProcessTree -ProcessId $process.Id }
  }
  Assert-PortReleased $ServerPort
  Assert-PortReleased $WebPort
  Write-Host "Acceptance cleanup passed: PID tree stopped and ports $ServerPort/$WebPort released."
  if ($originalApiBase) { $env:NEXT_PUBLIC_API_URL = $originalApiBase } else { Remove-Item Env:NEXT_PUBLIC_API_URL -ErrorAction SilentlyContinue }
  if ($originalProjectRoot) { $env:AGENTOS_PROJECT_ROOT = $originalProjectRoot } else { Remove-Item Env:AGENTOS_PROJECT_ROOT -ErrorAction SilentlyContinue }
  if ($originalNextDistDir) { $env:AGENTOS_NEXT_DIST_DIR = $originalNextDistDir } else { Remove-Item Env:AGENTOS_NEXT_DIST_DIR -ErrorAction SilentlyContinue }
  if ($originalNextTsConfigPath) { $env:AGENTOS_NEXT_TSCONFIG_PATH = $originalNextTsConfigPath } else { Remove-Item Env:AGENTOS_NEXT_TSCONFIG_PATH -ErrorAction SilentlyContinue }
  Remove-IsolatedWebTsConfig
  $nextDistPath = Join-Path $webRoot $isolatedNextDistDirName
  if (Test-Path -LiteralPath $nextDistPath) {
    try {
      Remove-Item -LiteralPath $nextDistPath -Recurse -Force -ErrorAction Stop
      Write-Host "Acceptance isolated Next dist removed: $nextDistPath"
    } catch {
      Write-Warning "Acceptance isolated Next dist retained because Windows still holds a file handle: $nextDistPath"
    }
  }
  if ($createdAcceptanceRoot -and $AcceptanceRoot -and (Test-Path -LiteralPath $AcceptanceRoot)) {
    $removed = $false
    for ($attempt = 1; $attempt -le 60 -and -not $removed; $attempt++) {
      try {
        Remove-Item -LiteralPath $AcceptanceRoot -Recurse -Force -ErrorAction Stop
        $removed = $true
      } catch {
        Start-Sleep -Seconds 1
      }
    }
    if ($removed) {
      Write-Host "Acceptance temporary root removed: $AcceptanceRoot"
    } else {
      Write-Warning "Acceptance temporary root is retained because Windows still holds a file handle: $AcceptanceRoot"
    }
  } elseif ($AcceptanceRoot) {
    Write-Host "Acceptance artifacts retained at caller-provided root: $AcceptanceRoot"
  }
}
