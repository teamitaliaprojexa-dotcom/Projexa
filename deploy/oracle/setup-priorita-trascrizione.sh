#!/usr/bin/env bash
# Whisper della trascrizione delle riunioni: 4 core e priorità bassa (2026-10-21).
#   - projexa-whisper@8001 (faster-whisper): da 2 a 4 core (WHISPER_THREADS in whisper.env);
#   - projexa-whisper@8001 e projexa-whisper-cpp (8101): Nice 10 e CPUWeight 50, così Projexa
#     (Node) e il database restano reattivi anche mentre si trascrive.
# 2026-10-31: tolto il Whisper dell'Assistente PM (projexa-whisper-assistente), a cui questa
# priorità bassa lasciava il passo: l'assistente ora manda l'audio all'AI esterna.
# Uso (sulla VM, senza registrazioni in corso: i servizi si riavviano):
#   bash setup-priorita-trascrizione.sh
set -euo pipefail

APP_DIR=/opt/projexa
ENV_WHISPER=$APP_DIR/whisper.env

for unita in 'projexa-whisper@.service' 'projexa-whisper-cpp.service'; do
  sudo mkdir -p "/etc/systemd/system/$unita.d"
  sudo tee "/etc/systemd/system/$unita.d/priorita.conf" >/dev/null <<'UNIT'
[Service]
Nice=10
CPUWeight=50
UNIT
done

# faster-whisper su 4 core (la riga si sostituisce, o si aggiunge se manca).
if grep -q '^WHISPER_THREADS=' "$ENV_WHISPER"; then
  sudo sed -i -E 's/^WHISPER_THREADS=.*/WHISPER_THREADS=4/' "$ENV_WHISPER"
else
  echo 'WHISPER_THREADS=4' | sudo tee -a "$ENV_WHISPER" >/dev/null
fi

sudo systemctl daemon-reload
sudo systemctl restart projexa-whisper@8001 projexa-whisper-cpp
sleep 5
for u in projexa-whisper@8001 projexa-whisper-cpp; do
  printf '%-30s %s  Nice=%s CPUWeight=%s\n' "$u" "$(systemctl is-active "$u")" \
    "$(systemctl show -p Nice --value "$u")" "$(systemctl show -p CPUWeight --value "$u")"
done
grep '^WHISPER_THREADS=' "$ENV_WHISPER"
