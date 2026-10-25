@echo off
cd /d "%~dp0"
runtime\node.exe launcher\service.mjs install
echo.
pause
