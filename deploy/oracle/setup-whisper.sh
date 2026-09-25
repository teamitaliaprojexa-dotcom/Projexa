#!/usr/bin/env bash
# Installa il servizio Whisper (whisper-service/) sulla VM Oracle, accanto al backend.
# Ogni istanza è un servizio systemd "projexa-whisper@<porta>" in ascolto solo su
# 127.0.0.1: il backend le usa in parallelo tramite WHISPER_URLS.
# Uso (sulla VM, dopo aver copiato whisper-service in /opt/projexa/whisper-service):
#   bash setup-whisper.sh [numero_istanze]     (default: CPU - 1, minimo 1)
set -euo pipefail

APP_DIR=/opt/projexa
N="${1:-$(( $(nproc) > 1 ? $(nproc) - 1 : 1 ))}"

sudo dnf install -y python3.11 python3.11-pip
[ -x "$APP_DIR/whisper-venv/bin/python" ] || python3.11 -m venv "$APP_DIR/whisper-venv"
"$APP_DIR/whisper-venv/bin/pip" install --upgrade pip -q
"$APP_DIR/whisper-venv/bin/pip" install -r "$APP_DIR/whisper-service/requirements.txt" -q

# Chiave condivisa con il backend: la stessa WHISPER_API_KEY del .env di Node
KEY=$(grep -E '^WHISPER_API_KEY=' "$APP_DIR/backend/.env" | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//')
[ -n "$KEY" ] || { echo "WHISPER_API_KEY mancante in $APP_DIR/backend/.env"; exit 1; }
if [ ! -f "$APP_DIR/whisper.env" ]; then
  printf 'WHISPER_API_KEY=%s\nWHISPER_MODEL=large-v3-turbo\nWHISPER_LANGUAGE=it\nWHISPER_COMPUTE=int8\nWHISPER_THREADS=%s\n' "$KEY" "$(nproc)" >"$APP_DIR/whisper.env"
  chmod 600 "$APP_DIR/whisper.env"
fi

sudo tee /etc/systemd/system/projexa-whisper@.service >/dev/null <<UNIT
[Unit]
Description=Projexa Whisper (porta %i)
After=network.target

[Service]
User=$USER
WorkingDirectory=$APP_DIR/whisper-service
EnvironmentFile=$APP_DIR/whisper.env
ExecStart=$APP_DIR/whisper-venv/bin/uvicorn app:app --host 127.0.0.1 --port %i
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload

# Attiva le porte 8001..(8000+N), spegne quelle in più
URLS=""
for p in $(systemctl list-units --all --plain --no-legend 'projexa-whisper@*' | awk '{print $1}' | sed -E 's/.*@([0-9]+).*/\1/'); do
  [ "$p" -gt $((8000 + N)) ] && sudo systemctl disable --now "projexa-whisper@$p"
done
for i in $(seq 1 "$N"); do
  p=$((8000 + i))
  sudo systemctl enable "projexa-whisper@$p" >/dev/null 2>&1
  sudo systemctl restart "projexa-whisper@$p"
  URLS="${URLS:+$URLS,}http://127.0.0.1:$p"
  # La prima istanza scarica il modello: le altre partono dopo, per non scaricarlo N volte
  [ "$i" -eq 1 ] && for _ in $(seq 1 60); do curl -s "http://127.0.0.1:$p/health" | grep -q '"ready":true' && break; sleep 5; done
done

# Aggiorna il backend perché usi le istanze locali
ENV="$APP_DIR/backend/.env"
sed -i -E '/^WHISPER_URLS?=/d' "$ENV"
printf 'WHISPER_URL=http://127.0.0.1:8001\nWHISPER_URLS=%s\n' "$URLS" >> "$ENV"
pm2 reload projexa --update-env >/dev/null

echo "Whisper attivo: $N istanze -> $URLS"
