@echo off
REM UNTESTED ON WINDOWS
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
