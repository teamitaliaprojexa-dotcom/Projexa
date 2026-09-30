#!/usr/bin/env bash
# Installa whisper.cpp sulla VM Oracle come secondo motore di trascrizione ("Background-Veloce").
# Stesso modello del servizio Python (large-v3-turbo), ma eseguito da whisper.cpp,
# ottimizzato per CPU ARM (NEON/dotprod), quantizzato q8_0, con VAD Silero per i silenzi.
# Servizio systemd "projexa-whisper-cpp" in ascolto solo su 127.0.0.1:8101; il backend lo
# usa per gli utenti con "modalità Trascrizione" = Background-Veloce (WHISPER_CPP_URL).
# Uso (sulla VM):  bash setup-whisper-cpp.sh [tag_release]   (default: ultima release)
set -euo pipefail

APP_DIR=/opt/projexa
CPP_DIR=$APP_DIR/whisper-cpp
PORT=8101
MODEL=large-v3-turbo-q8_0
VAD=silero-v5.1.2

sudo dnf install -y -q cmake gcc-c++ git
TAG="${1:-$(git ls-remote --tags --refs https://github.com/ggml-org/whisper.cpp | awk -F/ '{print $3}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)}"

sudo mkdir -p "$CPP_DIR"
sudo chown "$USER:$USER" "$CPP_DIR"
if [ ! -d "$CPP_DIR/src" ]; then
  git clone -q --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp "$CPP_DIR/src"
else
  git -C "$CPP_DIR/src" fetch -q --depth 1 origin tag "$TAG"
  git -C "$CPP_DIR/src" checkout -q "$TAG"
fi
cd "$CPP_DIR/src"
cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF >/dev/null
nice cmake --build build -j"$(nproc)" --config Release --target whisper-server whisper-cli >/dev/null

[ -f "models/ggml-$MODEL.bin" ] || bash models/download-ggml-model.sh "$MODEL"
[ -f "models/ggml-$VAD.bin" ] || bash models/download-vad-model.sh "$VAD"

# -mc 0: nessun contesto dal testo precedente (come condition_on_previous_text=False nel
# servizio Python): evita che un'allucinazione si ripeta nei segmenti successivi.
# --vad-threshold 0.35 (default 0.5): con 0.5 il VAD scartava le voci deboli degli altri
# partecipanti (audio di sistema); --vad-speech-pad-ms 500: non taglia inizio/fine frase.
sudo tee /etc/systemd/system/projexa-whisper-cpp.service >/dev/null <<UNIT
[Unit]
Description=Projexa Whisper.cpp (Background-Veloce, porta $PORT)
After=network.target

[Service]
User=$USER
WorkingDirectory=$CPP_DIR/src
ExecStart=$CPP_DIR/src/build/bin/whisper-server -m models/ggml-$MODEL.bin -t $(nproc) -l it -bs 5 --vad -vm models/ggml-$VAD.bin --vad-threshold 0.35 --vad-speech-pad-ms 500 --host 127.0.0.1 --port $PORT
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable projexa-whisper-cpp >/dev/null 2>&1
sudo systemctl restart projexa-whisper-cpp

# Il backend usa whisper.cpp solo per chi ha scelto Background-Veloce
ENV="$APP_DIR/backend/.env"
sed -i -E '/^WHISPER_CPP_URL=/d' "$ENV"
printf 'WHISPER_CPP_URL=http://127.0.0.1:%s\n' "$PORT" >> "$ENV"
pm2 reload projexa --update-env >/dev/null

echo "whisper.cpp $TAG attivo su http://127.0.0.1:$PORT (modello $MODEL)"
