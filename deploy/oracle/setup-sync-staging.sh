#!/usr/bin/env bash
# Installa la copia notturna produzione -> staging (sync-staging.sh) con servizio e timer systemd.
# Di default il timer viene solo INSTALLATO, non abilitato.
# Uso:  bash setup-sync-staging.sh            installa (timer spento)
#       bash setup-sync-staging.sh --enable   installa e abilita il timer (ogni notte alle 03:30 UTC)
# Prima serve /opt/projexa/staging-sync.env (permessi 600) con STAGING_DATABASE_URL,
# STAGING_AUTH_DATABASE_URL, STAGING_LICEN_DATABASE_URL, STAGING_NOTIF_DATABASE_URL.
set -euo pipefail
APP_DIR=/opt/projexa

install -m 750 "$(dirname "$0")/sync-staging.sh" "$APP_DIR/sync-staging.sh"

sudo tee /etc/systemd/system/projexa-sync-staging.service >/dev/null <<UNIT
[Unit]
Description=Projexa - copia produzione (VM) su staging (Neon)
After=network-online.target postgresql-18.service
Wants=network-online.target

[Service]
Type=oneshot
User=$USER
ExecStart=$APP_DIR/sync-staging.sh
UNIT

# Alle 03:30 UTC, dopo il backup notturno delle 02:30
sudo tee /etc/systemd/system/projexa-sync-staging.timer >/dev/null <<UNIT
[Unit]
Description=Projexa - copia notturna produzione su staging

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=120
Persistent=false

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload

if [ "${1:-}" = "--enable" ]; then
  sudo systemctl enable --now projexa-sync-staging.timer
  echo "Timer abilitato: $(systemctl list-timers projexa-sync-staging.timer --no-pager | sed -n 2p)"
else
  echo "Installato, timer NON abilitato. Per attivarlo: sudo systemctl enable --now projexa-sync-staging.timer"
fi
