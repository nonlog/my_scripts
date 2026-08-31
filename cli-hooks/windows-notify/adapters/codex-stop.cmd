@echo off
pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0codex-stop.ps1"
exit /b %errorlevel%
