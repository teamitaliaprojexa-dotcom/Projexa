#!/usr/bin/env bash
# Copia notturna PRODUZIONE (Postgres sulla VM) -> STAGING (ex produzione su Neon).
#   - pg_dump dei 4 database locali, poi pg_restore --clean su Neon, un database alla volta,
#     ciascuno in una sola transazione: se qualcosa fallisce quel database di staging resta com'era;
#   - SOVRASCRIVE i dati di staging (le modifiche fatte in staging si perdono): è lo scopo;
#   - gli URL di staging stanno in /opt/projexa/staging-sync.env (STAGING_DATABASE_URL, ...),
#     separati dal .env di produzione, che non contiene nessun URL Neon;
#   - per sicurezza la destinazione deve essere un host *.neon.tech, mai localhost.
# Uso:  sync-staging.sh            copia tutti e 4 i database
#       sync-staging.sh projexa    solo quelli indicati (projexa auth lic notif)
# Avviato dal timer projexa-sync-staging.timer, se abilitato (vedi setup-sync-staging.sh).
set -euo pipefail

APP_DIR=/opt/projexa
PROD_ENV="$APP_DIR/backend/.env"
STAGING_ENV="$APP_DIR/staging-sync.env"
WORK="$APP_DIR/sync-staging-tmp"
BIN=/usr/pgsql-18/bin

log() { echo "[SYNC-STAGING] $*"; }

# Valore di una variabile in un file .env (senza virgolette)
env_value() {
  grep -E "^$2=" "$1" | head -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'
}

# Neon: connessione diretta (niente pooler) per dump/restore; certificati di sistema per verify-full
neon_url() {
  local url="${1/-pooler./.}"
  if [[ "$url" == *"sslmode=verify-full"* && "$url" != *"sslrootcert="* ]]; then
    url="${url}&sslrootcert=system"
  fi
  echo "$url"
}

declare -A VAR=([projexa]=DATABASE_URL [auth]=AUTH_DATABASE_URL [lic]=LICEN_DATABASE_URL [notif]=NOTIF_DATABASE_URL)
NAMES=("$@")
[ ${#NAMES[@]} -gt 0 ] || NAMES=(projexa auth lic notif)

[ -r "$STAGING_ENV" ] || { log "ERRORE: manca $STAGING_ENV"; exit 1; }
mkdir -p -m 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

for name in "${NAMES[@]}"; do
  var=${VAR[$name]:-}
  [ -n "$var" ] || { log "ERRORE: database sconosciuto '$name'"; exit 1; }
  src=$(env_value "$PROD_ENV" "$var")
  dst=$(env_value "$STAGING_ENV" "STAGING_$var")
  [ -n "$src" ] || { log "ERRORE: $var mancante in $PROD_ENV"; exit 1; }
  [ -n "$dst" ] || { log "ERRORE: STAGING_$var mancante in $STAGING_ENV"; exit 1; }

  # Protezione: mai scrivere sulla produzione o su un host che non sia Neon
  dst_host=$(echo "$dst" | sed -E 's#^[^@]+@([^/:?]+).*#\1#')
  if [[ "$dst_host" != *.neon.tech ]]; then
    log "ERRORE: destinazione di $name non è su Neon ($dst_host): copia annullata"; exit 1
  fi

  dump="$WORK/$name.dump"
  "$BIN/pg_dump" --format=custom --no-owner --no-privileges --dbname="$src" --file="$dump"
  "$BIN/pg_restore" --clean --if-exists --no-owner --no-privileges \
    --single-transaction --exit-on-error --dbname="$(neon_url "$dst")" "$dump"
  log "$name -> staging ($dst_host): $(du -h "$dump" | cut -f1) copiati"
  rm -f "$dump"
done

log "Copia completata"
