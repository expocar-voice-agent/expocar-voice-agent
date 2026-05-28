$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot\..

Write-Host "Configuro DIDWW per Expocar..."
& "C:\Program Files\nodejs\node.exe" scripts/configure-didww-sip.js

Write-Host ""
Write-Host "Configurazione DIDWW completata."
