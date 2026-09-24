# Projexa Whisper

Servizio di trascrizione delle riunioni (Whisper open source, gratuito) usato dal backend
Projexa. Riceve blocchi audio WAV e restituisce le frasi con l'orario. L'audio non viene salvato.

## Pubblicazione su Render (Web Service separato)

| Impostazione | Valore |
|---|---|
| Runtime | Python 3 |
| Root Directory | `whisper-service` |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn app:app --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/health` |

Variabili d'ambiente del servizio:

| Variabile | Valore |
|---|---|
| `WHISPER_API_KEY` | una chiave casuale lunga (la stessa va messa nel backend Node) |
| `WHISPER_MODEL` | `base` (istanza da 512 MB) oppure `small` (da 2 GB in su) |
| `PYTHON_VERSION` | `3.12.8` |

Nel backend Node (servizio `projexa-4mix`):

| Variabile | Valore |
|---|---|
| `WHISPER_URL` | l'indirizzo del servizio, es. `https://projexa-whisper.onrender.com` |
| `WHISPER_API_KEY` | la stessa chiave del servizio |

## Memoria indicativa (int8, CPU)

| Modello | RAM | Qualità in italiano |
|---|---|---|
| `base` | ~300 MB | discreta |
| `small` | ~700 MB | buona (consigliato) |
| `medium` | ~1,8 GB | molto buona, più lento |

## Prova in locale

```bash
pip install -r requirements.txt
set WHISPER_API_KEY=prova
uvicorn app:app --port 8001
```
e nel `.env` del backend: `WHISPER_URL=http://localhost:8001`, `WHISPER_API_KEY=prova`.
