@echo off
cd /d "%~dp0"
echo Configuro DIDWW per Expocar... > didww-config.log
echo Cartella: %CD% >> didww-config.log
echo Node: >> didww-config.log
"C:\Program Files\nodejs\node.exe" --version >> didww-config.log 2>&1
echo Elenco DID visibili... >> didww-config.log
"C:\Program Files\nodejs\node.exe" scripts\list-didww-dids.js >> didww-config.log 2>&1
echo List exit code: %ERRORLEVEL% >> didww-config.log
echo Avvio configurazione DIDWW... >> didww-config.log
"C:\Program Files\nodejs\node.exe" scripts\configure-didww-sip.js >> didww-config.log 2>&1
echo Exit code: %ERRORLEVEL% >> didww-config.log
echo. >> didww-config.log
echo Se il numero e ancora in review, il trunk puo risultare creato ma non assegnato. >> didww-config.log
type didww-config.log
echo.
pause
