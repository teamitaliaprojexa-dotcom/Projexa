#!/usr/bin/env bash
# Backup notturno dei 4 database Neon di Projexa nell'Object Storage di Oracle.
#   - pg_dump in formato "custom" (compresso, si ripristina con pg_restore);
#   - carica in <bucket>/daily/AAAA-MM-GG/ e, il giorno 1 del mese, anche in monthly/AAAA-MM/;
#   - conserva 30 giorni di daily e 12 mesi di monthly; sulla VM tiene gli ultimi 3 giorni.
# Autenticazione a Oracle: instance principal (la VM stessa, niente chiavi da custodire).
# Uso:  backup-db.sh            backup completo
#       backup-db.sh --local    solo dump sulla VM, senza caricare (per prova)
# Avviato ogni notte dal timer systemd projexa-backup.timer (vedi setup-backup.sh).
set -euo pipefail

APP_DIR=/opt/projexa
ENV_FILE="$APP_DIR/backend/.env"
LOCAL_DIR="$APP_DIR/backups"
BUCKET="${BACKUP_BUCKET:-projexa-backup}"
KEEP_DAILY_DAYS=30
KEEP_MONTHLY_MONTHS=12
KEEP_LOCAL_DAYS=3
PG_DUMP=/usr/pgsql-18/bin/pg_dump
OCI="$APP_DIR/oci-venv/bin/oci --auth instance_principal"

DAY=$(date +%F)
STAMP=$(date +%F_%H%M)
WORK="$LOCAL_DIR/$DAY"
mkdir -p "$WORK"

log() { echo "[BACKUP] $*"; }

# Valore di una variabile del .env (senza virgolette)
env_value() {
  grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'
}

# Connessione diretta per pg_dump: Neon sconsiglia il pooler (-pooler) per i dump.
# Con sslmode=verify-full si usano i certificati di sistema.
dump_url() {
  local url="$1"
  url="${url/-pooler./.}"
  if [[ "$url" == *"sslmode=verify-full"* && "$url" != *"sslrootcert="* ]]; then
    url="${url}&sslrootcert=system"
  fi
  echo "$url"
}

declare -A DBS=(
  [projexa]=DATABASE_URL
  [auth]=AUTH_DATABASE_URL
  [lic]=LICEN_DATABASE_URL
  [notif]=NOTIF_DATABASE_URL
)

FILES=()
for name in projexa auth lic notif; do
  url=$(env_value "${DBS[$name]}")
  [ -n "$url" ] || { log "ERRORE: ${DBS[$name]} mancante in $ENV_FILE"; exit 1; }
  out="$WORK/projexa_${name}_${STAMP}.dump"
  "$PG_DUMP" --format=custom --compress=9 --no-owner --no-privileges \
    --dbname="$(dump_url "$url")" --file="$out"
  # Controllo: l'archivio deve essere leggibile da pg_restore
  /usr/pgsql-18/bin/pg_restore --list "$out" >/dev/null
  log "$name: $(du -h "$out" | cut -f1) ($out)"
  FILES+=("$out")
done

# Copie locali oltre KEEP_LOCAL_DAYS giorni
find "$LOCAL_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_LOCAL_DAYS" -exec rm -rf {} +

if [ "${1:-}" = "--local" ]; then
  log "Solo copia locale (--local): nessun caricamento"
  exit 0
fi

NS=$($OCI os ns get --query data --raw-output)

# Fino a 3 tentativi: Object Storage a volte risponde con errori momentanei
upload() {
  local i
  for i in 1 2 3; do
    $OCI os object put --namespace "$NS" --bucket-name "$BUCKET" \
      --file "$1" --name "$2" --force >/dev/null 2>&1 && return 0
    log "caricamento di $2 fallito (tentativo $i/3)"
    sleep $((i * 20))
  done
  $OCI os object put --namespace "$NS" --bucket-name "$BUCKET" --file "$1" --name "$2" --force >/dev/null
}

for f in "${FILES[@]}"; do
  upload "$f" "daily/$DAY/$(basename "$f")"
  if [ "$(date +%d)" = "01" ]; then
    upload "$f" "monthly/$(date +%Y-%m)/$(basename "$f")"
  fi
done
log "Caricati ${#FILES[@]} file in $BUCKET/daily/$DAY"

# Pulizia: daily più vecchi di 30 giorni, monthly più vecchi di 12 mesi
CUT_DAILY=$(date -d "-$KEEP_DAILY_DAYS days" +%F)
CUT_MONTHLY=$(date -d "-$KEEP_MONTHLY_MONTHS months" +%Y-%m)
$OCI os object list --namespace "$NS" --bucket-name "$BUCKET" --all \
    --query 'data[].name' --raw-output 2>/dev/null \
  | tr -d '[]", ' | grep -E '^(daily|monthly)/' | while read -r obj; do
    folder=$(echo "$obj" | cut -d/ -f2)
    if { [[ "$obj" == daily/* ]] && [[ "$folder" < "$CUT_DAILY" ]]; } ||
       { [[ "$obj" == monthly/* ]] && [[ "$folder" < "$CUT_MONTHLY" ]]; }; then
      $OCI os object delete --namespace "$NS" --bucket-name "$BUCKET" --object-name "$obj" --force >/dev/null
      log "Eliminato (scaduto): $obj"
    fi
  done

# Segno per monitor.sh: data dell'ultimo backup riuscito
touch "$LOCAL_DIR/.ultimo_ok"
log "Backup completato"
