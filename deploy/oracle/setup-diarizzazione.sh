#!/usr/bin/env bash
# Diarizzazione delle riunioni, fase 1 (2026-10-28).
# Servizio delle impronte vocali (speaker embedding ONNX, sherpa-onnx, ~25 MB): a fine riunione
# il backend divide le righe «Partecipanti» in «Partecipante 1, 2…».
# Servizio systemd projexa-diarizzazione su 127.0.0.1:8105 (senza chiave, come Parakeet).
# Priorità BASSA (Nice=10, CPUWeight=20): lavora dopo trascrizione, Assistente PM e Ollama,
# così non rallenta le funzioni live.
# Il codice del servizio arriva con il deploy in /opt/projexa/diarizzazione-service/app.py.
# Prima: eseguire Supporto/CreaDB/rec_meeting_voci.sql sul database.
# Uso: dopo il deploy, copiare lo script sulla VM (scp) e lanciare  bash ~/setup-diarizzazione.sh [core]   (default 1)
set -euo pipefail

APP_DIR=/opt/projexa
DIR=$APP_DIR/diarizzazione
VENV=$APP_DIR/diarizzazione-venv
PORT=8105
THREADS="${1:-1}"
MODELLO=wespeaker_en_voxceleb_resnet34.onnx
URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models

[ -f "$APP_DIR/diarizzazione-service/app.py" ] || { echo "Manca $APP_DIR/diarizzazione-service/app.py: fare prima il deploy da GitHub"; exit 1; }
mkdir -p "$DIR"
# Modello fuori dalla cartella del servizio (il deploy la riallinea con rsync --delete).
[ -f "$DIR/$MODELLO" ] || curl -fL -o "$DIR/$MODELLO" "$URL/$MODELLO"

# Ambiente Python separato.
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$APP_DIR/diarizzazione-service/requirements.txt"

sudo tee /etc/systemd/system/projexa-diarizzazione.service >/dev/null <<UNIT
[Unit]
Description=Projexa diarizzazione (porta $PORT, $THREADS core)
After=network.target

[Service]
User=$USER
WorkingDirectory=$APP_DIR/diarizzazione-service
Environment=DIARIZZAZIONE_MODEL=$DIR/$MODELLO
Environment=DIARIZZAZIONE_THREADS=$THREADS
Environment=DIARIZZAZIONE_PORT=$PORT
ExecStart=$VENV/bin/python $APP_DIR/diarizzazione-service/app.py
Nice=10
CPUWeight=20
MemoryMax=1G
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable projexa-diarizzazione >/dev/null 2>&1
sudo systemctl restart projexa-diarizzazione

# Il backend la usa per tutte le riunioni registrate.
ENV="$APP_DIR/backend/.env"
sed -i -E '/^DIARIZZAZIONE_URL=/d' "$ENV"
printf 'DIARIZZAZIONE_URL=http://127.0.0.1:%s\n' "$PORT" >> "$ENV"
pm2 reload projexa --update-env >/dev/null

for i in $(seq 1 30); do
  curl -fs "http://127.0.0.1:$PORT/health" >/dev/null && break
  sleep 2
done
systemctl is-active projexa-diarizzazione
curl -s "http://127.0.0.1:$PORT/health"; echo
echo "Diarizzazione attiva su http://127.0.0.1:$PORT. Log: journalctl -u projexa-diarizzazione -f"
echo "Per spegnerla: togliere DIARIZZAZIONE_URL da $ENV e pm2 reload projexa --update-env"
