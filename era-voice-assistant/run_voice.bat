@echo off
set PATH=C:\Program Files\nodejs;%PATH%
title ERA Voice Assistant UI (Port 3000)
cd /d "%~dp0"
if exist "dist\server.cjs" (
    node dist/server.cjs
) else (
    npm run dev
)
pause
