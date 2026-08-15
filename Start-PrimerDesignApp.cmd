@echo off
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\Start-PrimerDesignApp.ps1"
exit /b 0
