@echo off
cd /d "%~dp0"

set "SOURCE=%~dp0expocar-voice-agent-production.zip"
set "DESKTOP=%USERPROFILE%\Desktop"

if not exist "%DESKTOP%" (
  if exist "%USERPROFILE%\OneDrive\Desktop" set "DESKTOP=%USERPROFILE%\OneDrive\Desktop"
)

if not exist "%SOURCE%" (
  echo File non trovato: %SOURCE%
  echo.
  pause
  exit /b 1
)

if not exist "%DESKTOP%" (
  echo Desktop non trovato automaticamente.
  echo Copia manualmente questo file:
  echo %SOURCE%
  echo.
  pause
  exit /b 1
)

copy /Y "%SOURCE%" "%DESKTOP%\expocar-voice-agent-production.zip"
echo.
echo Pacchetto copiato sul Desktop:
echo %DESKTOP%\expocar-voice-agent-production.zip
echo.
pause
