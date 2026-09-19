@echo off
setlocal
if "%ORDERGRID_URL%"=="" set "ORDERGRID_URL=http://localhost:3000"
node "%~dp0index.mjs"
if errorlevel 1 pause
