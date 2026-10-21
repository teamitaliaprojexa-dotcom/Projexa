# Servizio di trascrizione NVIDIA Parakeet TDT 0.6B v3 (2026-10-21).
# Modello multilingue (25 lingue europee, italiano compreso) in formato ONNX int8, eseguito
# con sherpa-onnx sulla CPU ARM della VM: molto più veloce di Whisper large-v3-turbo a parità
# di core, con punteggiatura e maiuscole già nel testo e senza le "allucinazioni" di Whisper
# sui silenzi. Non accetta un prompt (glossario): i nomi propri li sistemano le correzioni
# automatiche del backend come per gli altri motori.
#
# Endpoint (solo 127.0.0.1, nessuna chiave, come whisper.cpp):
#   GET  /health     -> {"ready": true, "model": "..."}
#   POST /inference  -> corpo = file WAV (PCM 16 bit, mono o stereo, qualsiasi frequenza)
#                       risposta {"segments": [{"start", "end", "text"}], "duration"}
# Il parlato viene diviso in frasi con il VAD Silero (max ~20 s l'una), così ogni frase ha il
# suo orario: serve al backend per capire chi parla (microfono / audio di sistema).
#
# Avvio: deploy/oracle/setup-parakeet.sh (systemd projexa-parakeet, porta 8103).
# Variabili: PARAKEET_MODEL_DIR, PARAKEET_VAD, PARAKEET_THREADS (4), PARAKEET_PORT (8103).
import io
import json
import os
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

MODEL_DIR = os.environ.get('PARAKEET_MODEL_DIR', '/opt/projexa/parakeet/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8')
VAD_MODEL = os.environ.get('PARAKEET_VAD', '/opt/projexa/parakeet/silero_vad.onnx')
THREADS = int(os.environ.get('PARAKEET_THREADS', '4'))
PORT = int(os.environ.get('PARAKEET_PORT', '8103'))
SR = 16000
MAX_BODY = 64 * 1024 * 1024  # blocchi da ~2 minuti in WAV 16 kHz = ~4 MB: margine ampio

recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
    encoder=os.path.join(MODEL_DIR, 'encoder.int8.onnx'),
    decoder=os.path.join(MODEL_DIR, 'decoder.int8.onnx'),
    joiner=os.path.join(MODEL_DIR, 'joiner.int8.onnx'),
    tokens=os.path.join(MODEL_DIR, 'tokens.txt'),
    num_threads=THREADS,
    sample_rate=SR,
    feature_dim=80,
    decoding_method='greedy_search',
    model_type='nemo_transducer',
)
# Una trascrizione alla volta: tutte usano gli stessi core, in parallelo sarebbero solo più lente.
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


def frasi(x):
    """Pezzi di parlato [(inizio in campioni, campioni)] trovati dal VAD; senza VAD tutto il blocco."""
    if not os.path.exists(VAD_MODEL):
        return [(0, x)] if len(x) else []
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = VAD_MODEL
    cfg.silero_vad.threshold = 0.4
    cfg.silero_vad.min_silence_duration = 0.4
    cfg.silero_vad.min_speech_duration = 0.25
    cfg.silero_vad.max_speech_duration = 20
    cfg.sample_rate = SR
    cfg.num_threads = 1
    vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=max(30, len(x) / SR + 5))
    finestra = cfg.silero_vad.window_size
    pezzi = []
    for i in range(0, len(x), finestra):
        vad.accept_waveform(x[i:i + finestra])
        while not vad.empty():
            pezzi.append((vad.front.start, np.array(vad.front.samples, dtype=np.float32)))
            vad.pop()
    vad.flush()
    while not vad.empty():
        pezzi.append((vad.front.start, np.array(vad.front.samples, dtype=np.float32)))
        vad.pop()
    return pezzi


def trascrivi(x):
    pezzi = frasi(x)
    if not pezzi:
        return []
    streams = []
    for _, campioni in pezzi:
        s = recognizer.create_stream()
        s.accept_waveform(SR, campioni)
        streams.append(s)
    recognizer.decode_streams(streams)
    out = []
    for (inizio, campioni), s in zip(pezzi, streams):
        testo = (s.result.text or '').strip()
        if testo:
            out.append({'start': round(inizio / SR, 2), 'end': round((inizio + len(campioni)) / SR, 2), 'text': testo})
    return out


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip('/') in ('', '/health'):
            return self._json(200, {'ready': True, 'model': 'parakeet-tdt-0.6b-v3-int8', 'threads': THREADS})
        self._json(404, {'error': 'non trovato'})

    def do_POST(self):
        if self.path.rstrip('/') != '/inference':
            return self._json(404, {'error': 'non trovato'})
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BODY:
            return self._json(400, {'error': 'audio mancante o troppo grande'})
        try:
            x = leggi_wav(self.rfile.read(n))
        except Exception as e:  # file non WAV o rovinato: errore del chiamante, non del servizio
            return self._json(400, {'error': f'audio non leggibile: {e}'})
        try:
            t0 = time.time()
            with lock:
                segmenti = trascrivi(x)
            durata = len(x) / SR
            print(f'[PARAKEET] {durata:.1f} s di audio in {time.time() - t0:.1f} s, {len(segmenti)} frasi', flush=True)
            self._json(200, {'segments': segmenti, 'duration': round(durata, 2)})
        except Exception as e:
            self._json(500, {'error': str(e)[:300]})

    def log_message(self, *args):  # niente log per richiesta (il riepilogo è sopra)
        pass


if __name__ == '__main__':
    print(f'[PARAKEET] pronto su 127.0.0.1:{PORT} ({THREADS} core)', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
