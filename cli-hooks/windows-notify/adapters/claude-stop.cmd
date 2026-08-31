@echo off
pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0claude-stop.ps1"
exit /b %errorlevel%
