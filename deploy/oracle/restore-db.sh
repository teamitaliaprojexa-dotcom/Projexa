#!/usr/bin/env bash
# Ripristina i dump del backup indicato nei 4 database locali.
# Uso: bash restore-db.sh AAAA-MM-GG   (dump già presenti in /opt/projexa/backups/<data>/;
#      dal bucket si scaricano con oci os object get, vedi docs/BACKUP.md). I database devono essere vuoti.
# Esclude gli oggetti propri di Neon (estensione pg_session_jwt, schema pgrst della Data API).
set -euo pipefail
DAY="${1:?data backup AAAA-MM-GG}"
DIR=/opt/projexa/backups/$DAY
BIN=/usr/pgsql-18/bin
export PGPASSWORD=$(cat /opt/projexa/.pg_app_password)

declare -A TARGET=([projexa]=projexa [auth]=projexa_auth [lic]=projexa_lic [notif]=projexa_notif)

for name in projexa auth lic notif; do
  f=$(ls "$DIR"/projexa_${name}_*.dump | tail -1)
  db=${TARGET[$name]}
  list=$(mktemp)
  "$BIN/pg_restore" --list "$f" | grep -v -E 'pg_session_jwt|pgrst' > "$list"
  "$BIN/pg_restore" --host=127.0.0.1 --username=projexa --dbname="$db" \
    --no-owner --no-privileges --exit-on-error --single-transaction \
    --use-list="$list" "$f"
  rm -f "$list"
  echo "[RESTORE] $name <- $(basename "$f") -> $db: $("$BIN/psql" -h 127.0.0.1 -U projexa -d "$db" -tAc "select count(*) from information_schema.tables where table_schema='public'") tabelle/viste"
done

# Rigenera le statistiche per il planner
for db in "${TARGET[@]}"; do "$BIN/vacuumdb" -h 127.0.0.1 -U projexa -d "$db" --analyze-only -q; done
