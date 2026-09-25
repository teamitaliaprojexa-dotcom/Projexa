#!/usr/bin/env bash
# Preparazione una-tantum della VM Oracle Cloud.
# Funziona sia su Oracle Linux 8/9 (utente "opc") sia su Ubuntu (utente "ubuntu").
# Uso (sulla VM):  bash setup-server.sh tuo-dominio.it
#   senza dominio:  bash setup-server.sh   -> usa <ip-con-trattini>.sslip.io
set -euo pipefail

APP_DIR=/opt/projexa

if command -v dnf >/dev/null 2>&1; then
  # ---------- Oracle Linux ----------
  sudo dnf install -y curl git rsync gcc-c++ make tar nano
  curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
  sudo dnf install -y nodejs
  sudo dnf install -y 'dnf-command(copr)'
  sudo dnf copr enable -y @caddy/caddy
  sudo dnf install -y caddy
  # Firewall interno (firewalld) e SELinux: consente a Caddy di fare da proxy verso Node
  sudo firewall-cmd --permanent --add-service=http
  sudo firewall-cmd --permanent --add-service=https
  sudo firewall-cmd --reload
  sudo setsebool -P httpd_can_network_connect 1 || true
else
  # ---------- Ubuntu ----------
  sudo apt-get update
  sudo apt-get install -y curl git rsync build-essential iptables-persistent debian-keyring debian-archive-keyring apt-transport-https
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update
  sudo apt-get install -y caddy
  # Le immagini Ubuntu di Oracle bloccano tutto tranne SSH
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
fi

sudo npm install -g pm2

# Cartella applicazione (riempita dal workflow GitHub Actions)
sudo mkdir -p "$APP_DIR/backend" "$APP_DIR/sito"
sudo chown -R "$USER":"$USER" "$APP_DIR"
[ -f "$APP_DIR/backend/.env" ] || { touch "$APP_DIR/backend/.env"; chmod 600 "$APP_DIR/backend/.env"; }

# Dominio per Caddy (HTTPS automatico)
DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  IP=$(curl -s https://ifconfig.me)
  DOMAIN="${IP//./-}.sslip.io"
fi
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$DOMAIN {
    encode gzip
    reverse_proxy localhost:3001
}
CADDY
sudo systemctl enable caddy
sudo systemctl restart caddy

# PM2 all'avvio della VM
sudo env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$USER" --hp "$HOME"

echo
echo "Fatto. URL pubblico: https://$DOMAIN"
echo "Ora compila $APP_DIR/backend/.env (nano $APP_DIR/backend/.env)"
