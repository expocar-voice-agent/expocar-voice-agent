@echo off
cd /d "%~dp0"
echo Attendo che DIDWW renda disponibile il numero e poi assegno il trunk...
"C:\Program Files\nodejs\node.exe" scripts\wait-didww-did.js
echo.
pause
