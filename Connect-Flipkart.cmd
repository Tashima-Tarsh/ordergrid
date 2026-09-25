@echo off
title OrderGrid - Connect Flipkart Account
cd /d "%~dp0"
echo Starting Flipkart Login Browser...
node scripts/open-browser-login.mjs %*
pause
