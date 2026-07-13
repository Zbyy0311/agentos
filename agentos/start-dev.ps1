param(
  [switch]$Mock,
  [switch]$Stable
)

# Load .env if present
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=]+)=(.*)\s*$') {
      $k = $matches[1].Trim()
      $v = $matches[2].Trim()
      if (-not [string]::IsNullOrEmpty($v)) { Set-Item "env:$k" $v }
    }
  }
}

# Use mock mode when -Mock flag is set
if ($Mock) { $env:AGENTOS_FORCE_MOCK = "true" }

$root = $PSScriptRoot
$serverScript = if ($Stable) { "dev:stable" } else { "dev" }

$p3000 = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($p3000) { Stop-Process -Id $p3000 -Force -ErrorAction SilentlyContinue }
$p3001 = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($p3001) { Stop-Process -Id $p3001 -Force -ErrorAction SilentlyContinue }

Start-Process -NoNewWindow -FilePath "cmd.exe" -ArgumentList "/c cd /d $root && pnpm --filter @agentos/server run $serverScript"
Start-Sleep -Seconds 3
Start-Process -NoNewWindow -FilePath "cmd.exe" -ArgumentList "/c cd /d $root && pnpm --filter @agentos/web run dev"

if ($Mock) {
  Write-Host "AgentOS started (MOCK MODE): backend http://localhost:3000, frontend http://localhost:3001"
} elseif ($Stable) {
  Write-Host "AgentOS started (STABLE SERVER MODE): backend http://localhost:3000, frontend http://localhost:3001"
} else {
  Write-Host "AgentOS started: backend http://localhost:3000, frontend http://localhost:3001"
}
