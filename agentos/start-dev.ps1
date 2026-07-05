$p3000 = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($p3000) { Stop-Process -Id $p3000 -Force -ErrorAction SilentlyContinue }
$p3001 = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($p3001) { Stop-Process -Id $p3001 -Force -ErrorAction SilentlyContinue }

Start-Process -NoNewWindow -FilePath "cmd.exe" -ArgumentList "/c cd /d E:\workspace\Multi-Agent\agentos && pnpm --filter @agentos/server run dev"
Start-Sleep -Seconds 2
Start-Process -NoNewWindow -FilePath "cmd.exe" -ArgumentList "/c cd /d E:\workspace\Multi-Agent\agentos && pnpm --filter @agentos/web run dev"

Write-Host "AgentOS started: backend http://localhost:3000, frontend http://localhost:3001"
