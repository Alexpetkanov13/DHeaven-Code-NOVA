@echo off
REM UNTESTED ON WINDOWS
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
