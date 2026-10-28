#!/usr/bin/env bash
# =============================================================================
# Basi F16 e Q4_K_M con imatrix per i modelli di Ollama (2026-10-28, richiesta utente)
# -----------------------------------------------------------------------------
# Per ogni modello base (qwen3:8b, qwen3:14b, qwen3:4b-instruct, qwen2.5:3b):
#   1. scarica da Ollama la versione originale F16 (es. qwen3:8b-fp16);
#   2. calcola la matrice di importanza (llama-imatrix) su testi di Projexa: calibrazione-imatrix.txt,
#      i prompt di backend/prompts e, se ci sono, i file in ~/projexa-modelli/calibrazione/*.txt|*.jsonl
#      (es. i .jsonl pseudonimizzati scaricati da Analisi PM). Su una copia Q8_0 (Q6_K per il 14B):
#      la F16 del 14B non sta nei 24 GB della VM. Il file .imatrix contiene solo statistiche, non testo;
#   3. rifà il Q4_K_M dalla F16 con la matrice (stessa RAM di prima, qualità migliore) e lo mette al
#      posto della base con lo stesso nome (qwen3:8b ecc.): nessuna variabile del .env da cambiare.
#      La versione di prima resta come <base>-originale (es. qwen3:8b-originale) finché non la togli;
#   4. ricrea i modelli dei Modelfile di deploy/oracle/ollama NON addestrati (pm-projexa,
#      recap-projexa...) sulla base nuova; quelli addestrati si riapplicano dal job o da Analisi PM;
#   5. annota base, F16 e matrice in ~/projexa-modelli/basi/basi.json: da lì Analisi PM › Modello
#      sulla VM unisce gli adattatori alla F16 e quantizza una volta sola con la matrice
#      (routes/analisiPm.js, unisciAdattatore). La F16 resta su disco solo per le basi addestrabili.
# Un sola base per giro è il modo normale (job «quantizza_modelli» della pagina Schedulazioni,
# jobs/quantizzaModelli.js): il job aspetta la VM libera e tiene fermi i lavori con «Projexa».
# A mano (sulla VM, utente opc, con la VM libera):
#   bash /opt/projexa/deploy/oracle/setup-modelli-imatrix.sh qwen3:8b
#   bash /opt/projexa/deploy/oracle/setup-modelli-imatrix.sh qwen3:4b-instruct=qwen3:4b-instruct-2507-fp16
# Serve llama-imatrix: rieseguire prima deploy/oracle/setup-llama-cpp.sh.
# Disco: F16 tenute ~16 GB (8B) + ~30 GB (14B) + ~8 GB (4B); durante il lavoro serve circa il doppio
# della F16 della base in corso. Tempo: 8B circa 40-60 minuti, 14B circa 1,5 ore (3 core).
# Durante il lavoro il file /var/tmp/projexa-modelli.lock ferma recap e funzioni con «Projexa»
# (config/ollamaPrecedenza.js).
# =============================================================================
set -euo pipefail

QUI="$(cd "$(dirname "$0")" && pwd)"
APP=${PROJEXA_APP_DIR:-/opt/projexa}
BIN=${LLAMA_CPP_BIN:-$APP/llama-cpp/src/build/bin}
CARTELLA=${OLLAMA_MODELLI_DIR:-$HOME/projexa-modelli}
BASI="$CARTELLA/basi"
LOCK=/var/tmp/projexa-modelli.lock
OLLAMA_DATI=/usr/share/ollama/.ollama/models; [ -d "$OLLAMA_DATI" ] || OLLAMA_DATI=/
MODELFILES="$QUI/ollama"; [ -d "$MODELFILES" ] || MODELFILES="$APP/deploy/oracle/ollama"
PROMPTS="$QUI/../../backend/prompts"; [ -d "$PROMPTS" ] || PROMPTS="$APP/backend/prompts"
THREADS=${QUANT_THREADS:-3}

# base | versione F16 su Ollama | GB della F16 | F16 da tenere (si = base di modelli addestrabili)
CATALOGO="qwen3:8b|qwen3:8b-fp16|16.4|si
qwen3:14b|qwen3:14b-fp16|29.6|si
qwen3:4b-instruct|qwen3:4b-instruct-2507-fp16|8.1|si
qwen2.5:3b|qwen2.5:3b-instruct-fp16|6.2|no"

for t in llama-quantize llama-imatrix; do
  [ -x "$BIN/$t" ] || { echo "ERRORE: manca $BIN/$t: esegui prima deploy/oracle/setup-llama-cpp.sh"; exit 1; }
done
[ $# -gt 0 ] || set -- $(echo "$CATALOGO" | cut -d'|' -f1)

# Un solo aggiornamento alla volta; il PID nel lock dice al backend che stiamo lavorando.
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "ERRORE: aggiornamento dei modelli già in corso (PID $(cat "$LOCK"))"; exit 1
fi
mkdir -p "$BASI"
echo $$ > "$LOCK"
TMP=""
pulizia() { rm -f "$LOCK"; [ -n "$TMP" ] && rm -f "$TMP"; rm -f "$BASI/calibrazione.txt"; }
trap pulizia EXIT
trap 'exit 143' TERM INT

libero() { df -B1 --output=avail "$1" | tail -1 | tr -d ' '; }
disp() { df --output=source "$1" | tail -1; }
gb() { awk -v b="$1" 'BEGIN { printf "%.0f", b / 1e9 }'; }

# Testi per la matrice: senza dati personali in chiaro (prompt e jsonl già pseudonimizzati).
CAL="$BASI/calibrazione.txt"
cat "$MODELFILES/calibrazione-imatrix.txt" > "$CAL"
for f in "$PROMPTS"/*.txt "$CARTELLA"/calibrazione/*.txt "$CARTELLA"/calibrazione/*.jsonl; do
  [ -f "$f" ] && { cat "$f"; echo; } >> "$CAL"
done
echo "Testi di calibrazione: $(wc -c < "$CAL") byte"

# Modelli in RAM fuori da Ollama: la RAM serve a llama-imatrix.
ollama ps 2>/dev/null | awk 'NR > 1 { print $1 }' | while read -r m; do ollama stop "$m" || true; done

for arg in "$@"; do
  base=${arg%%=*}
  riga=$(echo "$CATALOGO" | awk -F'|' -v b="$base" '$1 == b')
  f16=$(echo "$riga" | cut -d'|' -f2); dimf16=$(echo "$riga" | cut -d'|' -f3); tieni=$(echo "$riga" | cut -d'|' -f4)
  [ "$arg" != "$base" ] && f16=${arg#*=}
  [ -n "$f16" ] || { echo "ERRORE: $base non è nel catalogo: indica la versione F16 come $base=<nome-fp16>"; exit 1; }
  dimf16=${dimf16:-16}; tieni=${tieni:-si}
  slug=$(echo "$base" | tr ':.' '--')
  echo "=== $base (F16: $f16) ==="

  # Spazio: F16 nei dati di Ollama (se non c'è già) + copia intermedia, Q4 e copia di Ollama.
  serve_ollama=$(awk -v g="$dimf16" 'BEGIN { printf "%.0f", g * 0.35e9 }')
  ollama show "$f16" >/dev/null 2>&1 || serve_ollama=$(awk -v g="$dimf16" 'BEGIN { printf "%.0f", g * 1.4e9 }')
  serve_basi=$(awk -v g="$dimf16" 'BEGIN { printf "%.0f", g * 0.9e9 }')
  if [ "$(disp "$OLLAMA_DATI")" = "$(disp "$BASI")" ]; then
    serve=$((serve_ollama + serve_basi)); ha=$(libero "$BASI")
    [ "$ha" -ge "$serve" ] || { echo "ERRORE: spazio su disco insufficiente: servono circa $(gb $serve) GB, liberi $(gb $ha)"; exit 1; }
  else
    [ "$(libero "$OLLAMA_DATI")" -ge "$serve_ollama" ] || { echo "ERRORE: spazio insufficiente in $OLLAMA_DATI (servono circa $(gb $serve_ollama) GB)"; exit 1; }
    [ "$(libero "$BASI")" -ge "$serve_basi" ] || { echo "ERRORE: spazio insufficiente in $BASI (servono circa $(gb $serve_basi) GB)"; exit 1; }
  fi

  echo "[1/5] Scarico $f16"
  ollama pull "$f16" | tr '\r' '\n' | grep -E 'success|error' || true
  blob=$(ollama show "$f16" --modelfile | awk '/^FROM / { print $2; exit }')
  case "$blob" in /*) ;; *) echo "ERRORE: file F16 di $f16 non trovato"; exit 1 ;; esac

  # I file dei modelli di Ollama sono leggibili solo dall'utente ollama: si legge con sudo.
  tipo=Q8_0; awk -v g="$dimf16" 'BEGIN { exit !(g > 20) }' && tipo=Q6_K
  TMP="$BASI/$slug-$tipo.gguf"
  echo "[2/5] Copia $tipo per la matrice"
  sudo -n nice -n 10 "$BIN/llama-quantize" "$blob" "$TMP" "$tipo" "$THREADS" | grep -E '^\[ *[0-9]+/' | awk 'NR % 50 == 0' || true
  sudo -n chown "$(id -un):" "$TMP"

  echo "[3/5] Matrice di importanza (la parte lunga)"
  rm -f "$BASI/$slug.imatrix"
  nice -n 10 "$BIN/llama-imatrix" -m "$TMP" -f "$CAL" -o "$BASI/$slug.imatrix" -c 512 --chunks 150 -t "$THREADS" 2>&1 \
    | grep -E 'compute_imatrix|\[[0-9]+\]|saving|error' | tr -s ' ' | tail -n 5 || true
  rm -f "$TMP"; TMP=""
  [ -s "$BASI/$slug.imatrix" ] || { echo "ERRORE: matrice non creata"; exit 1; }

  echo "[4/5] Q4_K_M con la matrice"
  TMP="$BASI/$slug-Q4_K_M-imx.gguf"
  sudo -n nice -n 10 "$BIN/llama-quantize" --imatrix "$BASI/$slug.imatrix" "$blob" "$TMP" Q4_K_M "$THREADS" | grep -E '^\[ *[0-9]+/' | awk 'NR % 50 == 0' || true
  sudo -n chown "$(id -un):" "$TMP"

  echo "[5/5] Sostituisco $base su Ollama"
  ollama show "$base-originale" >/dev/null 2>&1 || ollama cp "$base" "$base-originale"
  mf="$BASI/$slug.Modelfile"
  { echo "FROM $TMP"; ollama show "$base-originale" --modelfile | awk '/^FROM / { dopo = 1; next } dopo || !/^#/'; } > "$mf"
  ollama create "$base" -f "$mf" | tr '\r' '\n' | grep -E 'success|error' || true
  rm -f "$TMP" "$mf"; TMP=""

  if [ "$tieni" = "no" ]; then ollama rm "$f16" >/dev/null; f16=""; fi
  python3 - "$BASI/basi.json" "$base" "$f16" "$BASI/$slug.imatrix" <<'PY'
import datetime, json, sys
p, base, f16, imx = sys.argv[1:]
try:
    d = json.load(open(p))
except Exception:
    d = {}
d[base] = {'f16': f16 or None, 'imatrix': imx, 'quantizzato': datetime.datetime.now().isoformat(timespec='minutes')}
json.dump(d, open(p, 'w'), indent=1)
PY

  # Modelli dei Modelfile sulla stessa base: Ollama li ha legati ai file di prima.
  for m in "$MODELFILES"/*.Modelfile; do
    nome=$(basename "$m" .Modelfile)
    [ "$(awk '/^FROM / { print $2; exit }' "$m")" = "$base" ] || continue
    ollama show "$nome" >/dev/null 2>&1 || continue
    if python3 -c "import json,sys; sys.exit(0 if sys.argv[2] in json.load(open(sys.argv[1])) else 1)" "$CARTELLA/versioni.json" "$nome" 2>/dev/null; then
      echo "  $nome è addestrato: da riapplicare (job quantizza_modelli o Analisi PM › Riapplica)"
    else
      ollama create "$nome" -f "$m" | tr '\r' '\n' | grep -E 'success|error' || true
      echo "  $nome ricreato sulla base nuova"
    fi
  done
  echo "FATTO: $base è Q4_K_M con imatrix ($(date '+%d/%m %H:%M'))"
done
