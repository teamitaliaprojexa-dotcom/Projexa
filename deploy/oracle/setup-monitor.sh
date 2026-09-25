#!/usr/bin/env bash
# Installa i controlli di salute (monitor.sh) come timer systemd ogni 5 minuti.
# Prerequisiti su Oracle Cloud: criterio che consente al gruppo dinamico projexa-vm di
# pubblicare metriche nel namespace "projexa"; topic Notifications con l'email; allarmi.
# Uso (sulla VM):  bash setup-monitor.sh
set -euo pipefail

APP_DIR=/opt/projexa
install -m 750 "$(dirname "$0")/monitor.sh" "$APP_DIR/monitor.sh"

sudo tee /etc/systemd/system/projexa-monitor.service >/dev/null <<UNIT
[Unit]
Description=Projexa - controlli di salute (OCI Monitoring)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$USER
ExecStart=$APP_DIR/monitor.sh
UNIT

sudo tee /etc/systemd/system/projexa-monitor.timer >/dev/null <<UNIT
[Unit]
Description=Projexa - controlli di salute ogni 5 minuti

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now projexa-monitor.timer
systemctl list-timers projexa-monitor.timer --no-pager
