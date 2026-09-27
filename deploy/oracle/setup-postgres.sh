#!/usr/bin/env bash
# Installa e configura PostgreSQL 18 sulla VM Oracle per Projexa (dal 2026-09-27, al posto di Neon).
#   - ascolta solo su localhost (non esposto su internet; da remoto: tunnel SSH, vedi docs/DATABASE.md)
#   - ruolo applicativo "projexa", password generata in /opt/projexa/.pg_app_password
#   - 4 database: projexa, projexa_auth, projexa_lic, projexa_notif
# Idempotente: si può rilanciare. Uso: bash setup-postgres.sh
set -euo pipefail
DATA=/var/lib/pgsql/18/data

if [ ! -x /usr/pgsql-18/bin/postgres ]; then
  sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-aarch64/pgdg-redhat-repo-latest.noarch.rpm || true
  sudo dnf -qy module disable postgresql || true
  sudo dnf install -y postgresql18-server postgresql18-contrib
fi
if ! sudo test -f "$DATA/PG_VERSION"; then
  sudo PGSETUP_INITDB_OPTIONS="--encoding=UTF8 --locale=C.UTF-8 --auth-local=peer --auth-host=scram-sha-256" \
    /usr/pgsql-18/bin/postgresql-18-setup initdb
fi
sudo systemctl enable --now postgresql-18

sudo -u postgres mkdir -p "$DATA/conf.d"
if ! sudo grep -q "^include_dir = 'conf.d'" "$DATA/postgresql.conf"; then
  echo "include_dir = 'conf.d'" | sudo -u postgres tee -a "$DATA/postgresql.conf" >/dev/null
fi
sudo -u postgres tee "$DATA/conf.d/projexa.conf" >/dev/null <<'EOF'
# Projexa - VM condivisa con Node e Whisper (2 OCPU / 12 GB)
listen_addresses = 'localhost'
max_connections = 60
shared_buffers = 1GB
effective_cache_size = 3GB
work_mem = 8MB
maintenance_work_mem = 128MB
timezone = 'UTC'
log_timezone = 'UTC'
log_min_duration_statement = 2000
EOF
sudo systemctl restart postgresql-18

PWFILE=/opt/projexa/.pg_app_password
if [ ! -s "$PWFILE" ]; then
  (umask 077; openssl rand -hex 24 > "$PWFILE")
fi
PW=$(cat "$PWFILE")

sudo -u postgres psql -v ON_ERROR_STOP=1 -q -v pw="$PW" <<'SQL'
SELECT format('CREATE ROLE projexa LOGIN PASSWORD %L', :'pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'projexa') \gexec
SELECT format('ALTER ROLE projexa PASSWORD %L', :'pw') \gexec
SELECT 'CREATE DATABASE ' || d || ' OWNER projexa'
  FROM unnest(ARRAY['projexa','projexa_auth','projexa_lic','projexa_notif']) d
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = d) \gexec
SQL

sudo -u postgres psql -tAc "show shared_buffers"
sudo -u postgres psql -tAc "show timezone"
sudo -u postgres psql -tAc "select datname from pg_database where datname like 'projexa%' order by 1"
