#!/usr/bin/env bash
# Whisper della trascrizione delle riunioni: tutta la potenza quando l'Assistente PM è chiuso,
# niente disturbo quando è aperto (2026-10-21, scelta utente dopo la call Miroglio).
#   - projexa-whisper@8001 (faster-whisper): da 2 a 4 core (WHISPER_THREADS in whisper.env);
#   - projexa-whisper@8001 e projexa-whisper-cpp (8101): Nice 10 e CPUWeight 50, così se un
#     blocco è ancora in trascrizione quando parte l'assistente, il Whisper dell'assistente
#     (Nice -5, setup-whisper-assistente.sh) passa davanti.
# Con l'assistente aperto il backend non manda blocchi nuovi a questi servizi (restano in coda,
# jobs/meetingTranscription.js); appena si chiude ripartono su tutti i core.
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
for u in projexa-whisper@8001 projexa-whisper-cpp projexa-whisper-assistente; do
  printf '%-30s %s  Nice=%s CPUWeight=%s\n' "$u" "$(systemctl is-active "$u")" \
    "$(systemctl show -p Nice --value "$u")" "$(systemctl show -p CPUWeight --value "$u")"
done
grep '^WHISPER_THREADS=' "$ENV_WHISPER"
