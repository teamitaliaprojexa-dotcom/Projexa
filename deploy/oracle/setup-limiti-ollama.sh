#!/usr/bin/env bash
# Limiti di CPU e RAM per Ollama (2026-10-22, richiesta utente).
# Il 22/10 un recap con «Projexa 14B» ha bloccato la VM (sito con pagine bianche, SSH senza
# risposta): il 14B (~12 GB mentre lavora) si è sommato ai modelli dell'Assistente PM rimasti in
# RAM, a Whisper, Parakeet, PostgreSQL e Node, oltre i 24 GB della VM.
# Con questi limiti Ollama non può prendersi tutta la macchina:
#   - CPUQuota=350%   al massimo 3,5 dei 4 core (resta sempre mezzo core a sito e database);
#   - CPUWeight=50 e Nice=10: se sito, DB o trascrizione chiedono CPU, passano davanti;
#   - MemoryHigh=15G  oltre questa soglia il kernel rallenta Ollama e gli toglie memoria;
#   - MemoryMax=17G   tetto rigido: se Ollama lo supera viene fermato lui, non la VM
#                     (restano ~7 GB a PostgreSQL, Node, Whisper, Parakeet, Presidio e sistema);
#   - MemorySwapMax=1G niente swap «infinito» che rallenta tutta la macchina;
#   - OOMScoreAdjust=500: in caso di memoria finita il kernel sacrifica Ollama, non DB o sito.
# Il backend (routes/ai.js, liberaRamOllama) scarica i modelli non in uso prima di ogni recap e
# usa 3 core (OLLAMA_RECAP_THREADS), così il 14B sta sotto il tetto.
# Il file è un drop-in separato: le variabili già in projexa.conf (OLLAMA_MAX_LOADED_MODELS...)
# restano come sono.
# Uso (sulla VM; riavvia Ollama, quindi un recap in corso con «Projexa» si interrompe):
#   bash ~/setup-limiti-ollama.sh
set -euo pipefail

sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/limiti.conf >/dev/null <<'UNIT'
[Service]
CPUQuota=350%
CPUWeight=50
Nice=10
MemoryAccounting=yes
MemoryHigh=15G
MemoryMax=17G
MemorySwapMax=1G
OOMScoreAdjust=500
UNIT

sudo systemctl daemon-reload
sudo systemctl restart ollama
sleep 3
systemctl is-active ollama
for p in CPUQuotaPerSecUSec CPUWeight Nice MemoryHigh MemoryMax MemorySwapMax OOMScoreAdjust; do
  printf '%-20s %s\n' "$p" "$(systemctl show -p "$p" --value ollama)"
done
free -h
