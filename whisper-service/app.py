"""Projexa Whisper - servizio di trascrizione audio (gratuito, Whisper open source).

Servizio web separato (Python) da pubblicare su Render accanto al backend Node di Projexa.
Il backend Node (backend/routes/ai.js) gli invia i blocchi WAV delle riunioni registrate
dalla dashboard e riceve le frasi con l'orario di inizio. L'audio non viene salvato.

Usa faster-whisper: gli stessi modelli di openai-whisper (tiny/base/small/medium/large)
ma senza PyTorch, con meno memoria e più veloce su CPU.

Variabili d'ambiente:
  WHISPER_API_KEY   chiave condivisa con il backend Node (header X-Whisper-Key) - obbligatoria
  WHISPER_MODEL     tiny | base | small | medium | large-v3   (default: small)
  WHISPER_LANGUAGE  lingua del parlato (default: it)
  WHISPER_COMPUTE   int8 (default, meno RAM) | int8_float32 | float32
  WHISPER_THREADS   thread CPU (default: 0 = automatico)
"""
import hmac
import io
import os
import threading
import time

# In locale su Windows, dietro il proxy aziendale che ispeziona l'HTTPS, il download del
# modello fallirebbe (CERTIFICATE_VERIFY_FAILED): si usano i certificati di Windows.
# Su Render (Linux) non serve.
if os.name == "nt":
    try:
        import truststore
        truststore.inject_into_ssl()
    except ImportError:
        pass

from fastapi import FastAPI, Header, HTTPException, Request
from faster_whisper import WhisperModel

API_KEY = os.environ.get("WHISPER_API_KEY", "")
MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "it")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "int8")
THREADS = int(os.environ.get("WHISPER_THREADS", "0") or 0)
MAX_AUDIO_BYTES = 8 * 1024 * 1024

app = FastAPI(title="Projexa Whisper", docs_url=None, redoc_url=None)

# Il modello si carica una volta sola (al primo uso lo scarica, poi resta in memoria).
_model = None
_model_lock = threading.Lock()
# Una trascrizione alla volta: su poche CPU più richieste in parallelo rallentano tutte.
_run_lock = threading.Lock()


def get_model():
    global _model
    with _model_lock:
        if _model is None:
            t = time.time()
            _model = WhisperModel(MODEL_NAME, device="cpu", compute_type=COMPUTE_TYPE, cpu_threads=THREADS)
            print(f"[whisper] modello '{MODEL_NAME}' ({COMPUTE_TYPE}) caricato in {time.time() - t:.1f}s", flush=True)
        return _model


@app.on_event("startup")
def preload():
    # Caricamento in background: il servizio risponde subito a /health mentre scarica il modello.
    threading.Thread(target=get_model, daemon=True).start()


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME, "ready": _model is not None}


@app.post("/transcribe")
async def transcribe(request: Request, x_whisper_key: str = Header(default="")):
    if not API_KEY or not hmac.compare_digest(x_whisper_key, API_KEY):
        raise HTTPException(status_code=401, detail="Chiave non valida")
    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="Audio mancante")
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Blocco audio troppo grande")

    model = get_model()
    t = time.time()
    with _run_lock:
        segments, _info = model.transcribe(
            io.BytesIO(audio),
            language=LANGUAGE,
            task="transcribe",
            beam_size=1,        # più veloce: adatto alla trascrizione "dal vivo"
            vad_filter=True,    # salta i silenzi (niente frasi inventate sul silenzio)
            condition_on_previous_text=False,
        )
        out = [
            {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
            for s in segments
            if s.text.strip()
        ]
    print(f"[whisper] blocco trascritto in {time.time() - t:.1f}s, {len(out)} frasi", flush=True)
    return {"segments": out, "model": MODEL_NAME}
