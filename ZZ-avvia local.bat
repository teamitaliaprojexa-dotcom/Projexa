@echo off
REM Avvia Projexa in locale: tunnel SSH verso i database della VM + backend (http://localhost:3001).
REM Non contiene percorsi fissi: funziona sia dalla cartella del repo sia dalla cartella che la contiene
REM (es. ...\Projexa_Staging\ZZ-avvia local.bat accanto alla cartella Projexa).
setlocal

set "ROOT=%~dp0"
if not exist "%ROOT%backend\server.js" set "ROOT=%~dp0Projexa\"
if not exist "%ROOT%backend\server.js" (
    echo Cartella del progetto non trovata: questo file va messo nella cartella Projexa o in quella che la contiene.
    goto errore
)

if not exist "%ROOT%backend\.env" (
    echo Manca "%ROOT%backend\.env": copialo dalla vecchia cartella o crealo da backend\.env.example.
    goto errore
)

if not exist "%USERPROFILE%\.ssh\ssh-key-2026-09-25.key" (
    echo Manca la chiave SSH "%USERPROFILE%\.ssh\ssh-key-2026-09-25.key": copiala li' per aprire il tunnel ai database.
    goto errore
)

where node >nul 2>nul || (echo Node.js non trovato: installalo da https://nodejs.org e riapri questa finestra. & goto errore)

echo Apertura tunnel verso la VM in una nuova finestra (lasciala aperta)...
start "Projexa - tunnel DB" powershell -NoExit -ExecutionPolicy Bypass -File "%ROOT%deploy\oracle\db-tunnel.ps1"

cd /d "%ROOT%backend"
if not exist "node_modules" (
    echo Prima installazione delle dipendenze...
    call npm install || goto errore
)

REM Attende qualche secondo che il tunnel sia su, poi apre il browser e avvia il backend.
timeout /t 5 /nobreak >nul
start "" "http://localhost:3001/login.html"
echo Backend su http://localhost:3001 - chiudi questa finestra (o Ctrl+C) per fermarlo
call npm run dev
goto fine

:errore
echo.
pause
exit /b 1

:fine
endlocal
