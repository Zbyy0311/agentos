[CmdletBinding()]
param(
  [switch] $Mock,
  [switch] $Stable,
  [switch] $Json,
  [string] $DataPath,
  [string] $ServerHost,
  [int] $ServerPort = 0,
  [string] $WebHost,
  [int] $WebPort = 0
)

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'scripts/agentos-local.ps1'
$arguments = [ordered]@{
  Action = 'start'
  Development = $true
}
if ($Mock) { $arguments.Mock = $true }
if ($Stable) { $arguments.Stable = $true }
if ($Json) { $arguments.Json = $true }
if (-not [string]::IsNullOrWhiteSpace($DataPath)) { $arguments.DataPath = $DataPath }
if (-not [string]::IsNullOrWhiteSpace($ServerHost)) { $arguments.ServerHost = $ServerHost }
if ($ServerPort -gt 0) { $arguments.ServerPort = $ServerPort }
if (-not [string]::IsNullOrWhiteSpace($WebHost)) { $arguments.WebHost = $WebHost }
if ($WebPort -gt 0) { $arguments.WebPort = $WebPort }

& $launcher @arguments
if (-not $Json) {
  $mode = if ($Mock) { 'MOCK DEVELOPMENT' } elseif ($Stable) { 'STABLE SERVER DEVELOPMENT' } else { 'DEVELOPMENT' }
  Write-Output ('AgentOS started (' + $mode + '). Use scripts/agentos-local.ps1 -Action status or -Action stop.')
}
