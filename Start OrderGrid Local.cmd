@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ordergrid-local.ps1"
if errorlevel 1 (
  echo.
  echo OrderGrid Local could not start. See the error above.
  pause
)
