@echo off
REM Avvia in locale il servizio di trascrizione Whisper per Projexa.
REM La prima volta crea l'ambiente Python e installa i pacchetti (qualche minuto);
REM al primo uso scarica anche il modello Whisper (~500 MB per "small").
REM Nel backend/.env servono: WHISPER_URL=http://localhost:8001 e WHISPER_API_KEY=projexa-locale
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Creazione ambiente Python...
    python -m venv .venv || goto errore
    ".venv\Scripts\python.exe" -m pip install --upgrade pip
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto errore
)

set WHISPER_API_KEY=projexa-locale
if "%WHISPER_MODEL%"=="" set WHISPER_MODEL=small

echo Servizio Whisper (modello %WHISPER_MODEL%) su http://localhost:8001 - chiudi questa finestra per fermarlo
".venv\Scripts\python.exe" -m uvicorn app:app --host 127.0.0.1 --port 8001
goto fine

:errore
echo.
echo Installazione non riuscita: controlla la connessione e riprova (cancella la cartella .venv prima di rilanciare).
pause

:fine
