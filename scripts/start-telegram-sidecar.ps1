# Starts the supervised Telegram sidecar from the repository root.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
npm run sidecar:watch
