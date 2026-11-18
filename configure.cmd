@echo off
chcp 65001 >nul
node "%~dp0cli.mjs" configure
pause
