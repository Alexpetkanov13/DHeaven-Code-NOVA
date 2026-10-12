# DHeaven Code: NOVA — Windows setup. UNTESTED ON WINDOWS (authored on Linux).
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js >= 20.19 is required: https://nodejs.org' }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { corepack enable; corepack prepare pnpm@latest --activate }
pnpm install
