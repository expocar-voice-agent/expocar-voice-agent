@echo off
cd /d "%~dp0"
echo Verifico API Render... > render-check.log
"C:\Program Files\nodejs\node.exe" scripts\check-render-api.js >> render-check.log 2>&1
echo Exit code: %ERRORLEVEL% >> render-check.log
type render-check.log
echo.
pause
