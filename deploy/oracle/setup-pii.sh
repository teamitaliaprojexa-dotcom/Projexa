#!/usr/bin/env bash
# Anonymization Layer (PII masking) sulla VM (2026-10-22).
# Microsoft Presidio Analyzer + spaCy it_core_news_lg: riconosce i dati personali nei testi che
# Projexa manda alle AI ESTERNE (Claude, ChatGPT, Gemini, Mistral); il backend (config/pii.js) li
# sostituisce con segnaposto e rimette i valori veri nella risposta. Le AI locali non passano di qui.
# Servizio systemd projexa-pii su 127.0.0.1:8104 (senza chiave, come whisper.cpp e Parakeet).
# Il codice del servizio arriva con il deploy in /opt/projexa/pii-service/app.py.
# Uso: dopo il deploy, copiare lo script sulla VM (scp) e lanciare  bash ~/setup-pii.sh
set -euo pipefail

APP_DIR=/opt/projexa
VENV=$APP_DIR/pii-venv
PORT=8104
MODELLO=it_core_news_lg

[ -f "$APP_DIR/pii-service/app.py" ] || { echo "Manca $APP_DIR/pii-service/app.py: fare prima il deploy da GitHub"; exit 1; }

# Ambiente Python separato (non tocca i venv di Whisper e Parakeet). spaCy 3.8 vuole Python 3.9-3.12.
PY=python3
for v in python3.12 python3.11; do command -v "$v" >/dev/null 2>&1 && { PY=$v; break; }; done
[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$APP_DIR/pii-service/requirements.txt"
# Modello italiano grande di spaCy (~550 MB, NER persone/luoghi/organizzazioni): una volta sola.
"$VENV/bin/python" -c "import $MODELLO" 2>/dev/null || "$VENV/bin/python" -m spacy download "$MODELLO"

# Priorità normale (sotto la trascrizione): un'analisi dura millisecondi.
sudo tee /etc/systemd/system/projexa-pii.service >/dev/null <<UNIT
[Unit]
Description=Projexa Anonymization Layer - Presidio + spaCy $MODELLO (porta $PORT)
After=network.target

[Service]
User=$USER
WorkingDirectory=$APP_DIR/pii-service
Environment=PII_SPACY_MODEL=$MODELLO
Environment=PII_PORT=$PORT
ExecStart=$VENV/bin/python $APP_DIR/pii-service/app.py
Restart=always
RestartSec=5
MemoryMax=3G

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable projexa-pii >/dev/null 2>&1
sudo systemctl restart projexa-pii

# Attesa del caricamento del modello e prova con un testo di esempio (dati inventati).
for i in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$PORT/health" >/dev/null && break
  sleep 2
done
systemctl is-active projexa-pii
curl -s "http://127.0.0.1:$PORT/health"; echo
curl -s -X POST "http://127.0.0.1:$PORT/analizza" -H 'Content-Type: application/json' \
  -d '{"testi":["Domani Giulia Esposito di Napoli scrive a giulia.esposito@example.com, cell. 333 1234567, CF SPSGLI85M41F839K."],"entita":["PERSON","LOCATION","EMAIL_ADDRESS","PHONE_NUMBER","IT_FISCAL_CODE"]}'; echo

# Il backend usa il servizio per tutte le chiamate alle AI esterne.
ENV="$APP_DIR/backend/.env"
sed -i -E '/^PII_URL=/d' "$ENV"
printf 'PII_URL=http://127.0.0.1:%s\n' "$PORT" >> "$ENV"
pm2 reload projexa --update-env >/dev/null
echo "Anonymization Layer attivo su http://127.0.0.1:$PORT. Log: journalctl -u projexa-pii -f"
