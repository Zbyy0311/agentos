@echo off
cd /d "%~dp0"
if exist collab.db del collab.db
echo === Multi-Agent 协作系统 v1.0 ===
echo 启动中... 打开 http://localhost:8000
python -m uvicorn app.main:app --port 8000
pause
