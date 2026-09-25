#!/usr/bin/env bash
# Controlli di salute di Projexa, ogni 5 minuti (timer systemd projexa-monitor.timer).
# Per ogni controllo pubblica su OCI Monitoring la metrica projexa/ok con dimensione
# "controllo" (1 = ok, 0 = problema). Gli allarmi della console mandano l'email:
#   - ok < 1 su un controllo          -> quel controllo è fallito;
#   - metrica assente per 15 minuti   -> VM spenta o irraggiungibile.
# Ogni controllo fallito viene ripetuto una volta dopo 20 secondi (niente falsi allarmi).
# Autenticazione: instance principal (gruppo dinamico projexa-vm).
set -uo pipefail

APP_DIR=/opt/projexa
ENV_FILE="$APP_DIR/backend/.env"
PUBLIC_URL="${PUBLIC_URL:-$(grep -E '^BACKEND_URL=' "$ENV_FILE" | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/')}"
OCI="$APP_DIR/oci-venv/bin/oci --auth instance_principal"
BACKUP_MAX_HOURS=26
DISK_MAX_PERCENT=90

META=$(curl -s -H "Authorization: Bearer Oracle" http://169.254.169.254/opc/v2/instance/)
COMPARTMENT=$(echo "$META" | python3 -c 'import json,sys; print(json.load(sys.stdin)["compartmentId"])')
REGION=$(echo "$META" | python3 -c 'import json,sys; print(json.load(sys.stdin)["canonicalRegionName"])')

env_value() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'; }

check_sito()    { curl -fsS --max-time 20 "$PUBLIC_URL/api/health" | grep -q '"ok"'; }
check_api()     { curl -fsS --max-time 10 http://127.0.0.1:3001/api/health | grep -q '"ok"'; }
check_database() {
  local url; url=$(env_value DATABASE_URL)
  [[ "$url" == *"sslmode=verify-full"* && "$url" != *"sslrootcert="* ]] && url="${url}&sslrootcert=system"
  [ "$(PGCONNECT_TIMEOUT=15 /usr/pgsql-18/bin/psql "$url" -Atc 'SELECT 1' 2>/dev/null)" = "1" ]
}
check_whisper() {
  local units u port
  units=$(systemctl list-units --plain --no-legend 'projexa-whisper@*' | awk '{print $1}')
  [ -n "$units" ] || return 1
  for u in $units; do
    port=$(echo "$u" | sed -E 's/.*@([0-9]+).*/\1/')
    curl -fsS --max-time 10 "http://127.0.0.1:$port/health" | grep -q '"ok":true' || return 1
  done
}
check_backup() {
  local f="$APP_DIR/backups/.ultimo_ok"
  [ -f "$f" ] && [ $(( ($(date +%s) - $(stat -c %Y "$f")) / 3600 )) -lt "$BACKUP_MAX_HOURS" ]
}
check_disco() { [ "$(df --output=pcent / | tail -1 | tr -dc 0-9)" -lt "$DISK_MAX_PERCENT" ]; }

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ITEMS=()
FAILED=()
for c in sito api database whisper backup disco; do
  if "check_$c" || { sleep 20; "check_$c"; }; then v=1; else v=0; FAILED+=("$c"); fi
  ITEMS+=("{\"namespace\":\"projexa\",\"compartmentId\":\"$COMPARTMENT\",\"name\":\"ok\",\"dimensions\":{\"controllo\":\"$c\"},\"datapoints\":[{\"timestamp\":\"$NOW\",\"value\":$v}]}")
done

PAYLOAD=$(mktemp)
trap 'rm -f "$PAYLOAD"' EXIT
( IFS=,; echo "[${ITEMS[*]}]" ) > "$PAYLOAD"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "[MONITOR] PROBLEMI: ${FAILED[*]}"
else
  echo "[MONITOR] tutto ok"
fi

if ! ERR=$($OCI monitoring metric-data post --metric-data "file://$PAYLOAD" \
      --endpoint "https://telemetry-ingestion.$REGION.oraclecloud.com" 2>&1 >/dev/null); then
  echo "[MONITOR] ERRORE invio metriche a OCI Monitoring: $(echo "$ERR" | grep -m1 -E '"(code|message)"')"
  exit 1
fi
