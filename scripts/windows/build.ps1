# UNTESTED ON WINDOWS. Builds the app and Windows artifacts (NSIS installer, portable exe, zip) into apps/desktop/release.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')
pnpm typecheck; pnpm test
pnpm dist:win
