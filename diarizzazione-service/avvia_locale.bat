@echo off
REM Avvia in locale il servizio di diarizzazione (impronte vocali) per Projexa.
REM La prima volta crea l'ambiente Python e installa i pacchetti; al primo avvio scarica
REM anche il modello (~25 MB) nella cartella "modelli".
REM Nel backend/.env serve: DIARIZZAZIONE_URL=http://127.0.0.1:8105
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Creazione ambiente Python...
    python -m venv .venv || goto errore
    ".venv\Scripts\python.exe" -m pip install --upgrade pip
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto errore
)

echo Servizio diarizzazione su http://127.0.0.1:8105 - chiudi questa finestra per fermarlo
".venv\Scripts\python.exe" app.py
goto fine

:errore
echo.
echo Installazione non riuscita: controlla la connessione e riprova (cancella la cartella .venv prima di rilanciare).
pause

:fine
