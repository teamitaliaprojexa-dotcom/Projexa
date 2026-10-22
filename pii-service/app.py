# Servizio di riconoscimento dei DATI PERSONALI (PII) per l'Anonymization Layer (2026-10-22).
#
# Prima che Projexa mandi testo a un'AI esterna (Claude, ChatGPT, Gemini, Mistral), il backend
# (backend/config/pii.js) chiede a questo servizio DOVE sono i dati personali nel testo e li
# sostituisce con segnaposto ([PERSONA_1], [EMAIL_2], ...). La risposta dell'AI torna con i
# segnaposto e il backend rimette i valori veri. Le AI locali (Ollama «Projexa») non passano di qui.
#
# Motore: Microsoft Presidio Analyzer + spaCy it_core_news_lg (NER italiano: persone, luoghi,
# organizzazioni) + riconoscitori a regole di Presidio (email, telefono, IBAN, carta di credito,
# IP, URL, codice fiscale, partita IVA, carta d'identità, passaporto, patente italiani).
#
# Il servizio è SENZA STATO: riceve il testo, restituisce solo le posizioni trovate e non
# conserva nulla (niente log del testo, niente file). La tabella segnaposto -> valore resta nel
# backend, in memoria (o cifrata sul DB per le richieste Batch).
#
# Endpoint (solo 127.0.0.1, nessuna chiave, come whisper.cpp e Parakeet):
#   GET  /health    -> {"ready": true, "modello": "it_core_news_lg", "entita": [...]}
#   POST /analizza  -> {"testi": ["..."], "entita": ["PERSON", ...], "soglia": 0.5,
#                       "consentiti": ["Projexa", ...]}
#                      risposta {"risultati": [[{"tipo", "inizio", "fine", "punteggio"}], ...]}
#
# Avvio: deploy/oracle/setup-pii.sh (systemd projexa-pii, porta 8104).
# Variabili: PII_SPACY_MODEL (it_core_news_lg), PII_PORT (8104).
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from presidio_analyzer import AnalyzerEngine, RecognizerRegistry
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_analyzer.predefined_recognizers import (
    CreditCardRecognizer,
    EmailRecognizer,
    IbanRecognizer,
    IpRecognizer,
    ItDriverLicenseRecognizer,
    ItFiscalCodeRecognizer,
    ItIdentityCardRecognizer,
    ItPassportRecognizer,
    ItVatCodeRecognizer,
    PhoneRecognizer,
    SpacyRecognizer,
    UrlRecognizer,
)

MODELLO = os.environ.get('PII_SPACY_MODEL', 'it_core_news_lg')
PORT = int(os.environ.get('PII_PORT', '8104'))
LINGUA = 'it'
MAX_BODY = 8 * 1024 * 1024       # ~4 milioni di caratteri: più di qualsiasi richiesta di Projexa
MAX_TESTO = 200000               # caratteri per testo (il backend divide prima, a capoverso)

# NER di spaCy italiano: PER/LOC/ORG/MISC. MISC (eventi, prodotti, «Kick-off»...) non è un
# dato personale e si ignora.
NLP_CONF = {
    'nlp_engine_name': 'spacy',
    'models': [{'lang_code': LINGUA, 'model_name': MODELLO}],
    'ner_model_configuration': {
        'model_to_presidio_entity_mapping': {
            'PER': 'PERSON', 'PERSON': 'PERSON',
            'LOC': 'LOCATION', 'GPE': 'LOCATION',
            'ORG': 'ORGANIZATION',
        },
        'labels_to_ignore': ['MISC'],
        'low_confidence_score_multiplier': 0.4,
        'low_score_entity_names': ['ORGANIZATION'],
    },
}


def crea_motore():
    nlp_engine = NlpEngineProvider(nlp_configuration=NLP_CONF).create_engine()
    registro = RecognizerRegistry(supported_languages=[LINGUA])
    # I riconoscitori generici di Presidio sono dichiarati per l'inglese: si istanziano per
    # l'italiano (le regole sono le stesse; le parole di contesto si aggiungono in italiano).
    for r in (
        SpacyRecognizer(supported_language=LINGUA, supported_entities=['PERSON', 'LOCATION', 'ORGANIZATION']),
        EmailRecognizer(supported_language=LINGUA),
        PhoneRecognizer(supported_language=LINGUA, supported_regions=('IT', 'US', 'GB', 'DE', 'FR', 'ES', 'CH'),
                        context=['telefono', 'tel', 'cellulare', 'cell', 'numero', 'chiamare', 'whatsapp']),
        IbanRecognizer(supported_language=LINGUA, context=['iban', 'conto', 'bonifico', 'coordinate']),
        CreditCardRecognizer(supported_language=LINGUA, context=['carta', 'credito', 'visa', 'mastercard', 'amex']),
        IpRecognizer(supported_language=LINGUA),
        UrlRecognizer(supported_language=LINGUA),
        ItFiscalCodeRecognizer(),
        ItVatCodeRecognizer(),
        ItIdentityCardRecognizer(),
        ItPassportRecognizer(),
        ItDriverLicenseRecognizer(),
    ):
        registro.add_recognizer(r)
    return AnalyzerEngine(nlp_engine=nlp_engine, registry=registro, supported_languages=[LINGUA])


t0 = time.time()
MOTORE = crea_motore()
ENTITA = sorted(MOTORE.get_supported_entities(language=LINGUA))
# spaCy non è garantito thread-safe: un'analisi alla volta (ognuna dura millisecondi).
BLOCCO = threading.Lock()
print(f'[PII] Presidio + {MODELLO} pronto in {time.time() - t0:.1f} s; entità: {", ".join(ENTITA)}', flush=True)


def analizza(testo, entita, soglia, consentiti):
    if not testo.strip():
        return []
    with BLOCCO:
        trovati = MOTORE.analyze(
            text=testo, language=LINGUA, entities=entita or None, score_threshold=soglia,
            allow_list=consentiti or None,
        )
    return [{'tipo': r.entity_type, 'inizio': r.start, 'fine': r.end, 'punteggio': round(float(r.score), 3)}
            for r in trovati]


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split('?')[0] == '/health':
            return self._json(200, {'ready': True, 'modello': MODELLO, 'entita': ENTITA})
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path.split('?')[0] != '/analizza':
            return self._json(404, {'error': 'not found'})
        try:
            n = int(self.headers.get('Content-Length') or 0)
            if n <= 0 or n > MAX_BODY:
                return self._json(413, {'error': 'corpo mancante o troppo grande'})
            req = json.loads(self.rfile.read(n).decode('utf-8'))
            testi = req.get('testi') or []
            if not isinstance(testi, list) or any(not isinstance(t, str) or len(t) > MAX_TESTO for t in testi):
                return self._json(400, {'error': f'testi: elenco di stringhe di max {MAX_TESTO} caratteri'})
            entita = [e for e in (req.get('entita') or []) if e in ENTITA]
            soglia = float(req.get('soglia') or 0.5)
            consentiti = [str(c) for c in (req.get('consentiti') or []) if str(c).strip()][:2000]
            t = time.time()
            risultati = [analizza(x, entita, soglia, consentiti) for x in testi]
            # Nel log solo numeri: MAI il testo o i dati trovati.
            print(f'[PII] {len(testi)} testi, {sum(len(x) for x in testi)} caratteri, '
                  f'{sum(len(r) for r in risultati)} dati in {time.time() - t:.2f} s', flush=True)
            self._json(200, {'risultati': risultati})
        except Exception as e:  # noqa: BLE001
            print(f'[PII] errore: {type(e).__name__}', flush=True)
            self._json(500, {'error': type(e).__name__})

    def log_message(self, *args):
        pass  # niente log di accesso (gli URL sono sempre gli stessi)


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
