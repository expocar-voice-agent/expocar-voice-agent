$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Node = "C:\Program Files\nodejs\node.exe"
$Cloudflared = Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet" -Recurse -Filter cloudflared.exe -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty FullName -First 1

if (-not (Test-Path $Node)) {
  throw "Node.js non trovato in $Node"
}

if (-not $Cloudflared) {
  throw "cloudflared non trovato. Installalo con: winget install Cloudflare.cloudflared"
}

Set-Location $Root

$Port = ((Get-Content .env | Where-Object { $_ -like "PORT=*" }) -split "=", 2)[1]
if (-not $Port) {
  $Port = "3000"
}

Start-Process -FilePath $Node -ArgumentList "src/server.js" -WorkingDirectory $Root -WindowStyle Hidden
Start-Sleep -Seconds 2

$LogFile = "cloudflared-$Port-http2.log"
Start-Process -FilePath $Cloudflared -ArgumentList "tunnel --protocol http2 --url http://localhost:$Port --logfile $LogFile" -WorkingDirectory $Root -WindowStyle Hidden
Start-Sleep -Seconds 8

$Log = Get-Content $LogFile -ErrorAction Stop
$UrlLine = $Log | Where-Object { $_ -like "*https://*.trycloudflare.com*" } | Select-Object -First 1

if ($UrlLine -match "https://[a-z0-9-]+\.trycloudflare\.com") {
  $Url = $Matches[0]
  (Get-Content .env) -replace "^PUBLIC_BASE_URL=.*", "PUBLIC_BASE_URL=$Url" | Set-Content .env
  Write-Host "Agente avviato."
  Write-Host "URL pubblico: $Url"
  Write-Host "Webhook Twilio: $Url/twilio/voice"
} else {
  Write-Host "Agente locale avviato su http://localhost:$Port"
  Write-Host "Non sono riuscito a leggere l'URL pubblico dal log $LogFile"
}
