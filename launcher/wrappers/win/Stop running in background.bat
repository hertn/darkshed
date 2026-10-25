@echo off
cd /d "%~dp0"
runtime\node.exe launcher\service.mjs remove
echo.
pause
