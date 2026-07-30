# Starts the supervised Telegram sidecar from the repository root.
# This script is intended to run under Task Scheduler so the bot is not tied to a terminal.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$logPath = Join-Path $env:TEMP "midiumor-telegram-sidecar.log"
"[$(Get-Date -Format o)] Starting supervised Telegram sidecar." | Out-File -FilePath $logPath -Append -Encoding utf8
npm run sidecar:watch *>> $logPath
