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
import subprocess
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

import numpy as np
import sherpa_onnx

MODEL_DIR = os.environ.get('PARAKEET_MODEL_DIR', '/opt/projexa/parakeet/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8')
VAD_MODEL = os.environ.get('PARAKEET_VAD', '/opt/projexa/parakeet/silero_vad.onnx')
THREADS = int(os.environ.get('PARAKEET_THREADS', '4'))
PORT = int(os.environ.get('PARAKEET_PORT', '8103'))
SR = 16000
MAX_BODY = 64 * 1024 * 1024  # blocchi da ~2 minuti in WAV 16 kHz = ~4 MB: margine ampio

HOTWORDS_SCORE = float(os.environ.get('PARAKEET_HOTWORDS_SCORE', '1.5'))
BPE_VOCAB = os.path.join(MODEL_DIR, 'bpe.vocab')

# HOTWORDS (2026-10-21): l'equivalente del glossario di Whisper. Il backend manda per ogni
# blocco le parole della riunione (partecipanti, cliente, termini delle Correzioni) nell'header
# X-Hotwords; il modello le preferisce quando l'audio è simile. In sherpa-onnx funzionano solo
# con modified_beam_search e servono un vocabolario BPE ("pezzo<TAB>punteggio"): il pacchetto
# del modello non lo ha, si ricava da tokens.txt (punteggio = -id, come nei vocabolari BPE di
# SentencePiece). PARAKEET_HOTWORDS=0 le spegne (ricerca greedy, come prima).
def prepara_vocab():
    if os.path.exists(BPE_VOCAB):
        return
    righe = []
    with open(os.path.join(MODEL_DIR, 'tokens.txt'), encoding='utf-8') as f:
        for r in f:
            parti = r.rstrip('\n').rsplit(' ', 1)
            if len(parti) == 2 and parti[0] and not parti[0].startswith('<'):
                righe.append(f'{parti[0]}\t{-int(parti[1])}')
    with open(BPE_VOCAB, 'w', encoding='utf-8') as f:
        f.write('\n'.join(righe) + '\n')


def crea(hotwords):
    extra = dict(decoding_method='modified_beam_search', max_active_paths=4, hotwords_score=HOTWORDS_SCORE,
                 modeling_unit='bpe', bpe_vocab=BPE_VOCAB) if hotwords else dict(decoding_method='greedy_search')
    return sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=os.path.join(MODEL_DIR, 'encoder.int8.onnx'),
        decoder=os.path.join(MODEL_DIR, 'decoder.int8.onnx'),
        joiner=os.path.join(MODEL_DIR, 'joiner.int8.onnx'),
        tokens=os.path.join(MODEL_DIR, 'tokens.txt'),
        num_threads=THREADS,
        sample_rate=SR,
        feature_dim=80,
        model_type='nemo_transducer',
        **extra,
    )


def hotwords_funzionano():
    """Prova in un processo a parte: se la codifica delle hotwords facesse cadere sherpa-onnx
    (errore in C++, non intercettabile) cadrebbe solo la prova e il servizio resterebbe su greedy."""
    if os.environ.get('PARAKEET_HOTWORDS', '1') == '0':
        return False
    try:
        prepara_vocab()
        prova = ('import sys, numpy as np; sys.argv = ["x"]; import app; r = app.crea(True); '
                 's = r.create_stream(hotwords="Projexa/TeamSystem Miroglio"); '
                 's.accept_waveform(16000, np.zeros(16000, dtype=np.float32)); r.decode_streams([s]); print("ok")')
        env = dict(os.environ, PARAKEET_PROVA='1')
        out = subprocess.run([sys.executable, '-c', prova], cwd=os.path.dirname(os.path.abspath(__file__)),
                             env=env, capture_output=True, text=True, timeout=300)
        if out.returncode == 0 and 'ok' in out.stdout:
            return True
        print(f'[PARAKEET] hotwords non disponibili (codice {out.returncode}): {(out.stderr or "")[-300:]}', flush=True)
    except Exception as e:
        print(f'[PARAKEET] hotwords non disponibili: {e}', flush=True)
    return False


# Nel processo di prova (PARAKEET_PROVA) il modello non si carica qui: lo fa la prova con crea().
HOTWORDS = False if os.environ.get('PARAKEET_PROVA') else hotwords_funzionano()
recognizer = None if os.environ.get('PARAKEET_PROVA') else crea(HOTWORDS)
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


def trascrivi(x, hotwords=''):
    pezzi = frasi(x)
    if not pezzi:
        return []
    streams = []
    for _, campioni in pezzi:
        s = recognizer.create_stream(hotwords=hotwords) if (HOTWORDS and hotwords) else recognizer.create_stream()
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
            return self._json(200, {'ready': True, 'model': 'parakeet-tdt-0.6b-v3-int8', 'threads': THREADS, 'hotwords': HOTWORDS})
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
        # Hotwords: "parola/frase due/..." codificate con encodeURIComponent (header solo ASCII).
        hw = unquote(self.headers.get('X-Hotwords') or '').strip()
        try:
            t0 = time.time()
            with lock:
                segmenti = trascrivi(x, hw)
            durata = len(x) / SR
            n_hw = len([h for h in hw.split('/') if h.strip()]) if (HOTWORDS and hw) else 0
            print(f'[PARAKEET] {durata:.1f} s di audio in {time.time() - t0:.1f} s, {len(segmenti)} frasi, {n_hw} hotwords', flush=True)
            self._json(200, {'segments': segmenti, 'duration': round(durata, 2)})
        except Exception as e:
            self._json(500, {'error': str(e)[:300]})

    def log_message(self, *args):  # niente log per richiesta (il riepilogo è sopra)
        pass


if __name__ == '__main__':
    print(f'[PARAKEET] pronto su 127.0.0.1:{PORT} ({THREADS} core, hotwords {"attive" if HOTWORDS else "spente"})', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
