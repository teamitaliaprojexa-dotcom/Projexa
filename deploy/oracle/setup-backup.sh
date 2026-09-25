#!/usr/bin/env bash
# Installa il backup notturno dei database (backup-db.sh) come timer systemd.
# Prerequisiti su Oracle Cloud (una volta sola, dalla console):
#   - bucket "projexa-backup" (privato) nel compartimento radice;
#   - gruppo dinamico con la VM + policy che gli consente di gestire gli oggetti del bucket.
# Uso (sulla VM):  bash setup-backup.sh
set -euo pipefail

APP_DIR=/opt/projexa

# Strumenti: pg_dump 18 (stessa versione di Neon) e OCI CLI
if [ ! -x /usr/pgsql-18/bin/pg_dump ]; then
  sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-aarch64/pgdg-redhat-repo-latest.noarch.rpm || true
  sudo dnf -qy module disable postgresql || true
  sudo dnf install -y postgresql18
fi
if [ ! -x "$APP_DIR/oci-venv/bin/oci" ]; then
  python3.11 -m venv "$APP_DIR/oci-venv"
  "$APP_DIR/oci-venv/bin/pip" install -q --upgrade pip
  "$APP_DIR/oci-venv/bin/pip" install -q oci-cli
fi

install -m 750 "$(dirname "$0")/backup-db.sh" "$APP_DIR/backup-db.sh"
mkdir -p "$APP_DIR/backups"
chmod 700 "$APP_DIR/backups"

sudo tee /etc/systemd/system/projexa-backup.service >/dev/null <<UNIT
[Unit]
Description=Projexa - backup database Neon su Object Storage
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$USER
ExecStart=$APP_DIR/backup-db.sh
UNIT

# Ogni notte alle 02:30 (ora del server, UTC); se la VM era spenta, parte al riavvio
sudo tee /etc/systemd/system/projexa-backup.timer >/dev/null <<UNIT
[Unit]
Description=Projexa - backup notturno database

[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now projexa-backup.timer
systemctl list-timers projexa-backup.timer --no-pager
