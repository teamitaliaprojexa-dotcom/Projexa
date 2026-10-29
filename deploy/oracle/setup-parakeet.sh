#!/usr/bin/env bash
# NVIDIA Parakeet TDT 0.6B v3 sulla VM (2026-10-21).
# Terzo motore di trascrizione accanto a faster-whisper (Background) e whisper.cpp
# (Background-Veloce): modello multilingue con l'italiano, ONNX int8 eseguito da sherpa-onnx
# sulla CPU ARM, molto più veloce di Whisper large-v3-turbo. Usato da:
#   - «modalità Trascrizione» = Parakeet (coda delle riunioni, PARAKEET_URL)
#   - «AI Assistente PM» = «Projexa 4B + 8B (Parakeet trascrive)» (blocchi brevi dell'assistente)
# Servizio systemd projexa-parakeet su 127.0.0.1:8103 (senza chiave, come whisper.cpp).
# Il codice del servizio arriva con il deploy in /opt/projexa/parakeet-service/app.py.
# Uso: dopo il deploy, copiare lo script sulla VM (scp) e lanciare  bash ~/setup-parakeet.sh [core]   (default 4)
set -euo pipefail

APP_DIR=/opt/projexa
DIR=$APP_DIR/parakeet
VENV=$APP_DIR/parakeet-venv
PORT=8103
THREADS="${1:-4}"
MODELLO=sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models

[ -f "$APP_DIR/parakeet-service/app.py" ] || { echo "Manca $APP_DIR/parakeet-service/app.py: fare prima il deploy da GitHub"; exit 1; }
mkdir -p "$DIR"
cd "$DIR"

# Modello (~640 MB) e VAD Silero: scaricati una volta sola.
if [ ! -f "$MODELLO/encoder.int8.onnx" ]; then
  echo "Scarico $MODELLO ..."
  curl -fL -o "$MODELLO.tar.bz2" "$URL/$MODELLO.tar.bz2"
  tar xjf "$MODELLO.tar.bz2" && rm -f "$MODELLO.tar.bz2"
fi
[ -f silero_vad.onnx ] || curl -fL -o silero_vad.onnx "$URL/silero_vad.onnx"

# Ambiente Python separato (non tocca il venv di faster-whisper).
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q "sherpa-onnx>=1.12" numpy

# Nice=-5 e CPUWeight=1000 come il Whisper dell'assistente: durante la call la trascrizione
# passa davanti agli altri servizi.
sudo tee /etc/systemd/system/projexa-parakeet.service >/dev/null <<UNIT
[Unit]
Description=Projexa Parakeet TDT 0.6B v3 (porta $PORT, $THREADS core)
After=network.target

[Service]
User=$USER
WorkingDirectory=$APP_DIR/parakeet-service
Environment=PARAKEET_MODEL_DIR=$DIR/$MODELLO
Environment=PARAKEET_VAD=$DIR/silero_vad.onnx
Environment=PARAKEET_THREADS=$THREADS
Environment=PARAKEET_PORT=$PORT
ExecStart=$VENV/bin/python $APP_DIR/parakeet-service/app.py
Nice=-5
CPUWeight=1000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable projexa-parakeet >/dev/null 2>&1
sudo systemctl restart projexa-parakeet

# Il backend usa Parakeet per chi lo sceglie (coda riunioni e Assistente PM).
ENV="$APP_DIR/backend/.env"
sed -i -E '/^PARAKEET_URL=/d' "$ENV"
printf 'PARAKEET_URL=http://127.0.0.1:%s\n' "$PORT" >> "$ENV"
pm2 reload projexa --update-env >/dev/null

# Attesa del caricamento del modello e prova con 1 secondo di silenzio.
for i in $(seq 1 30); do
  curl -fs "http://127.0.0.1:$PORT/health" >/dev/null && break
  sleep 2
done
systemctl is-active projexa-parakeet
curl -s "http://127.0.0.1:$PORT/health"; echo
echo "Parakeet attivo su http://127.0.0.1:$PORT ($THREADS core). Log: journalctl -u projexa-parakeet -f"
