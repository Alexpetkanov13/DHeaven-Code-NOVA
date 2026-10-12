# UNTESTED ON WINDOWS. Starts Vite + Electron dev loop.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')
pnpm dev
