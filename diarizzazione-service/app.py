# Servizio di DIARIZZAZIONE delle riunioni, fase 1 (2026-10-28).
# Calcola l'"impronta vocale" (speaker embedding) di ogni frase detta dagli altri partecipanti:
# un vettore di numeri che descrive la voce, NON il testo. Il backend (jobs/meetingTranscription.js)
# confronta le impronte di tutta la riunione e divide «Partecipanti» in «Partecipante 1, 2…».
# Non riconosce CHI è la persona (nessun nome, nessuna impronta salvata qui) e non salva l'audio.
#
# Modello: speaker embedding ONNX eseguito con sherpa-onnx sulla CPU (come Parakeet), ~25 MB,
# pochi decimi di secondo per un blocco da 2 minuti.
#
# Endpoint (solo 127.0.0.1, nessuna chiave, come Parakeet):
#   GET  /health  -> {"ready": true, "model": "...", "dim": N}
#   POST /voci    -> corpo = file WAV (PCM 16 bit, mono o stereo, qualsiasi frequenza)
#                    header X-Segmenti = "inizio-fine,inizio-fine,..." in secondi (es. "0.5-3.2,4-9.75")
#                    risposta {"voci": [[...] | null, ...]} nello stesso ordine dei segmenti;
#                    null = frase troppo corta (sotto DIARIZZAZIONE_MIN_SEC) per un'impronta affidabile.
#
# Avvio: deploy/oracle/setup-diarizzazione.sh (systemd projexa-diarizzazione, porta 8105);
# in locale diarizzazione-service/avvia_locale.bat.
# Variabili: DIARIZZAZIONE_MODEL (percorso del .onnx), DIARIZZAZIONE_THREADS (1),
#            DIARIZZAZIONE_PORT (8105), DIARIZZAZIONE_MIN_SEC (1.0).
import io
import json
import os
import threading
import time
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

QUI = os.path.dirname(os.path.abspath(__file__))
NOME_MODELLO = 'wespeaker_en_voxceleb_resnet34.onnx'
URL_MODELLO = f'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/{NOME_MODELLO}'
MODEL = os.environ.get('DIARIZZAZIONE_MODEL', os.path.join(QUI, 'modelli', NOME_MODELLO))
THREADS = int(os.environ.get('DIARIZZAZIONE_THREADS', '1'))
PORT = int(os.environ.get('DIARIZZAZIONE_PORT', '8105'))
MIN_SEC = float(os.environ.get('DIARIZZAZIONE_MIN_SEC', '1.0'))
SR = 16000
MAX_BODY = 64 * 1024 * 1024
MAX_SEGMENTI = 1000


def scarica_modello():
    """Al primo avvio scarica il modello (~25 MB) accanto al servizio, se non c'è già."""
    if os.path.exists(MODEL):
        return
    os.makedirs(os.path.dirname(MODEL), exist_ok=True)
    print(f'[DIARIZZAZIONE] scarico {URL_MODELLO} ...', flush=True)
    tmp = MODEL + '.part'
    urllib.request.urlretrieve(URL_MODELLO, tmp)
    os.replace(tmp, MODEL)


scarica_modello()
extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
    sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=MODEL, num_threads=THREADS, provider='cpu')
)
# Un blocco alla volta: tutti usano gli stessi core, in parallelo sarebbero solo più lenti.
lock = threading.Lock()


def leggi_wav(dati):
    with wave.open(io.BytesIO(dati), 'rb') as w:
        canali, larghezza, freq = w.getnchannels(), w.getsampwidth(), w.getframerate()
        grezzo = w.readframes(w.getnframes())
    if larghezza != 2:
        raise ValueError('serve un WAV PCM a 16 bit')
    x = np.frombuffer(grezzo, dtype=np.int16).astype(np.float32) / 32768.0
    if canali > 1:
        x = x.reshape(-1, canali).mean(axis=1)
    if freq != SR and len(x):
        # Ricampionamento lineare: sufficiente per il parlato.
        n = int(round(len(x) * SR / freq))
        x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
    return x


def leggi_segmenti(testo):
    out = []
    for pezzo in (testo or '').split(','):
        if '-' not in pezzo:
            continue
        a, b = pezzo.split('-', 1)
        out.append((max(0.0, float(a)), max(0.0, float(b))))
    return out[:MAX_SEGMENTI]


def impronte(x, segmenti):
    out = []
    for inizio, fine in segmenti:
        campioni = x[int(inizio * SR):int(fine * SR)]
        if len(campioni) < MIN_SEC * SR:
            out.append(None)
            continue
        s = extractor.create_stream()
        s.accept_waveform(SR, campioni)
        s.input_finished()
        if not extractor.is_ready(s):
            out.append(None)
            continue
        v = np.array(extractor.compute(s), dtype=np.float32)
        norma = float(np.linalg.norm(v))
        out.append([round(float(n), 4) for n in v / norma] if norma > 0 else None)
    return out


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip('/') in ('', '/health'):
            return self._json(200, {'ready': True, 'model': os.path.basename(MODEL), 'dim': extractor.dim, 'threads': THREADS})
        self._json(404, {'error': 'non trovato'})

    def do_POST(self):
        if self.path.rstrip('/') != '/voci':
            return self._json(404, {'error': 'non trovato'})
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BODY:
            return self._json(400, {'error': 'audio mancante o troppo grande'})
        try:
            x = leggi_wav(self.rfile.read(n))
            segmenti = leggi_segmenti(self.headers.get('X-Segmenti'))
        except Exception as e:  # file non WAV o segmenti rovinati: errore del chiamante
            return self._json(400, {'error': f'richiesta non valida: {e}'})
        try:
            t0 = time.time()
            with lock:
                voci = impronte(x, segmenti)
            print(f'[DIARIZZAZIONE] {len(x) / SR:.1f} s di audio, {sum(v is not None for v in voci)}/{len(voci)} impronte in {time.time() - t0:.2f} s', flush=True)
            self._json(200, {'voci': voci})
        except Exception as e:
            self._json(500, {'error': str(e)[:300]})

    def log_message(self, *args):  # niente log per richiesta (il riepilogo è sopra)
        pass


if __name__ == '__main__':
    print(f'[DIARIZZAZIONE] pronto su 127.0.0.1:{PORT} (modello {os.path.basename(MODEL)}, {THREADS} core)', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
