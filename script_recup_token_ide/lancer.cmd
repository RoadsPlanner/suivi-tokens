@echo off
rem Double-cliquer sur ce fichier pour ouvrir le tableau de bord des tokens IA (Antigravity et Claude Code)
rem dans le navigateur (les données sont relues à chaque lancement).
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js est introuvable. Installe-le depuis https://nodejs.org puis relance ce fichier.
  pause
  exit /b 1
)

node suivi_tokens.js
if errorlevel 1 pause
timeout /t 2 >nul
