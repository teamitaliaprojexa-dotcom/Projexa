#!/usr/bin/env bash
# Whisper DEDICATO all'Assistente PM (2026-10-20).
# I blocchi brevi dell'assistente (~25 s) andavano allo stesso whisper.cpp della trascrizione
# delle riunioni (porta 8101) e restavano in coda dietro i blocchi da 2 minuti: prova reale
# (Pre-Sal Miroglio) = 3-4 minuti di ritardo prima che l'assistente vedesse il testo.
# Qui un secondo whisper-server, con un modello piccolo e veloce (small, quantizzato) e
# ricerca greedy, su 127.0.0.1:8102, usato SOLO dall'assistente (ASSISTENTE_PM_WHISPER_CPP_URL).
# La trascrizione ufficiale delle riunioni resta quella di sempre (large-v3-turbo).
# Riusa i programmi già compilati da setup-whisper-cpp.sh (nessuna ricompilazione).
# 2026-10-21 (call Miroglio): con 2 core un blocco da 20 s richiedeva ~40 s, la coda si riempiva
# e l'assistente vedeva meno di metà riunione, 4-6 minuti in ritardo. Ora 4 core e precedenza
# sulla CPU (Nice -5, CPUWeight 1000): mentre l'assistente è aperto la trascrizione delle
# riunioni aspetta in coda (backend, config/ollamaPrecedenza.js) e Ollama (Nice 10) usa il resto.
# Uso (sulla VM):  bash setup-whisper-assistente.sh [modello]   (default: small-q5_1)
set -euo pipefail

APP_DIR=/opt/projexa
SRC=$APP_DIR/whisper-cpp/src
PORT=8102
MODEL="${1:-small-q5_1}"
VAD=silero-v5.1.2
THREADS=4

[ -x "$SRC/build/bin/whisper-server" ] || { echo "whisper.cpp non trovato in $SRC: eseguire prima setup-whisper-cpp.sh"; exit 1; }
cd "$SRC"
[ -f "models/ggml-$MODEL.bin" ] || bash models/download-ggml-model.sh "$MODEL"
[ -f "models/ggml-$VAD.bin" ] || bash models/download-vad-model.sh "$VAD"

# -bs 1 (greedy): per i suggerimenti conta la velocità più della parola perfetta.
# Nice=-5 e CPUWeight=1000: durante la call il Whisper dell'assistente passa davanti a tutto.
sudo tee /etc/systemd/system/projexa-whisper-assistente.service >/dev/null <<UNIT
[Unit]
Description=Projexa Whisper.cpp per l'Assistente PM (porta $PORT, modello $MODEL)
After=network.target

[Service]
User=$USER
WorkingDirectory=$SRC
ExecStart=$SRC/build/bin/whisper-server -m models/ggml-$MODEL.bin -t $THREADS -l it -bs 1 --vad -vm models/ggml-$VAD.bin --vad-threshold 0.35 --vad-speech-pad-ms 500 --host 127.0.0.1 --port $PORT
Nice=-5
CPUWeight=1000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable projexa-whisper-assistente >/dev/null 2>&1
sudo systemctl restart projexa-whisper-assistente

# Il backend manda i blocchi dell'assistente a questo servizio.
ENV="$APP_DIR/backend/.env"
sed -i -E '/^ASSISTENTE_PM_WHISPER_CPP_URL=/d' "$ENV"
printf 'ASSISTENTE_PM_WHISPER_CPP_URL=http://127.0.0.1:%s\n' "$PORT" >> "$ENV"
pm2 reload projexa --update-env >/dev/null

sleep 3
systemctl is-active projexa-whisper-assistente
echo "Whisper dell'Assistente PM attivo su http://127.0.0.1:$PORT (modello $MODEL, $THREADS core)"
