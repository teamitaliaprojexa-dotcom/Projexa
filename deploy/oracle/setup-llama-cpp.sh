#!/usr/bin/env bash
# =============================================================================
# Strumenti llama.cpp per installare i modelli addestrati (2026-10-23)
# -----------------------------------------------------------------------------
# Ollama 0.34 non accetta più gli adattatori LoRA («ADAPTER» nel Modelfile): Analisi PM ›
# Modello sulla VM unisce l'adattatore alla base con llama-export-lora e lo riporta a Q4_K_M con
# llama-quantize (backend/routes/analisiPm.js, unisciAdattatore). Questo script compila quei
# due programmi e llama-imatrix (2026-10-28, per setup-modelli-imatrix.sh: basi F16 e Q4_K_M con
# matrice di importanza) in /opt/projexa/llama-cpp/src/build/bin (variabile LLAMA_CPP_BIN).
# Uso sulla VM, utente opc:   bash /opt/projexa/backend/../deploy/oracle/setup-llama-cpp.sh
# Rieseguirlo aggiorna llama.cpp all'ultima versione. Circa 10 minuti con 3 core.
# =============================================================================
set -euo pipefail
DIR=/opt/projexa/llama-cpp/src
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 https://github.com/ggml-org/llama.cpp "$DIR"
fi
cd "$DIR"
nice -n 10 cmake -B build -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_SERVER=OFF -DGGML_NATIVE=ON -DCMAKE_BUILD_TYPE=Release
nice -n 10 cmake --build build --target llama-export-lora llama-quantize llama-imatrix -j 3
ls -la build/bin/llama-export-lora build/bin/llama-quantize build/bin/llama-imatrix
echo "Fatto: strumenti in $DIR/build/bin"
