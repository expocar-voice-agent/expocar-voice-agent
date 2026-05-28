@echo off
cd /d "%~dp0"
echo Configuro Cartesia Sonic su Render...
"C:\Program Files\nodejs\node.exe" scripts\setup-cartesia-render.js
echo.
pause
