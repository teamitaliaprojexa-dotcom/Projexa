# Projexa Whisper

Servizio di trascrizione delle riunioni (Whisper open source, gratuito) usato dal backend
Projexa. Riceve blocchi audio WAV e restituisce le frasi con l'orario. L'audio non viene salvato.

## Installazione sulla VM Oracle

Sulla VM il servizio gira accanto al backend, in una o più istanze systemd
`projexa-whisper@<porta>` in ascolto solo su `127.0.0.1`. Lo installa
`deploy/oracle/setup-whisper.sh` (dopo aver copiato `whisper-service` in `/opt/projexa/whisper-service`):

```bash
bash setup-whisper.sh [numero_istanze]     # default: CPU - 1, minimo 1
```

Lo script legge `WHISPER_API_KEY` dal `.env` del backend e scrive le impostazioni del servizio
in `/opt/projexa/whisper.env` (`WHISPER_MODEL`, `WHISPER_LANGUAGE`, `WHISPER_COMPUTE`, `WHISPER_THREADS`).

Nel `.env` del backend Node:

| Variabile | Valore |
|---|---|
| `WHISPER_URLS` (o `WHISPER_URL`) | gli indirizzi delle istanze, es. `http://127.0.0.1:8001` |
| `WHISPER_API_KEY` | la stessa chiave del servizio |

## Memoria indicativa (int8, CPU)

| Modello | RAM | Qualità in italiano |
|---|---|---|
| `base` | ~300 MB | discreta |
| `small` | ~700 MB | buona (consigliato) |
| `medium` | ~1,8 GB | molto buona, più lento |

## Prova in locale

Su Windows basta lanciare `avvia_locale.bat`: la prima volta crea l'ambiente Python e installa
i pacchetti. Nel `.env` del backend: `WHISPER_URL=http://localhost:8001`, `WHISPER_API_KEY=projexa-locale`.
