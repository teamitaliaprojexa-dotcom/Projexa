# Projexa Diarizzazione (fase 1)

Divide gli altri partecipanti di una riunione registrata: nella trascrizione le righe
«Partecipanti» diventano «Partecipante 1», «Partecipante 2»… con lo stesso numero dall'inizio
alla fine. Non riconosce chi è la persona (nessun nome) e non salva l'audio.

## Come funziona

1. Il backend trascrive ogni blocco audio come sempre (Whisper, whisper.cpp, Parakeet o Gemini).
2. Per le frasi degli altri partecipanti (audio di sistema più forte del microfono) chiede a
   questo servizio l'impronta vocale (`POST /voci`): un vettore di 256 numeri per frase.
   Frasi sotto 1 secondo: nessuna impronta.
3. Le impronte restano cifrate nella tabella `rec_meeting_voci` (al massimo 48 ore).
4. A fine registrazione, prima del recap, il backend raggruppa le impronte di tutta la riunione
   e riscrive le etichette (`dividiPartecipanti` in `backend/jobs/meetingTranscription.js`).

L'Assistente PM (funzione live) non la usa. Se il servizio è spento o va in errore la trascrizione
prosegue normalmente, con le righe «Partecipanti» come prima.

## Installazione sulla VM Oracle

1. Eseguire `Supporto/CreaDB/rec_meeting_voci.sql` sul database.
2. Dopo il deploy: `bash setup-diarizzazione.sh` (in `deploy/oracle/`). Crea il servizio
   systemd `projexa-diarizzazione` su `127.0.0.1:8105` a priorità bassa (1 core) e scrive
   `DIARIZZAZIONE_URL` nel `.env` del backend.

Per spegnerla basta togliere `DIARIZZAZIONE_URL` dal `.env` e ricaricare il backend.

## Taratura

`DIARIZZAZIONE_SOGLIA` (backend, predefinita 0.85) è la somiglianza minima tra due voci per
considerarle la stessa persona. Con l'audio di una riunione Teams la stessa voce sta in media
a 0,88-0,92 e voci diverse a 0,72-0,81 (riunione del 2026-10-30). Se in una riunione la stessa
persona viene divisa in più partecipanti, abbassarla (es. 0.82); se persone diverse vengono
unite, alzarla (es. 0.87).

## Prova in locale

`avvia_locale.bat`: la prima volta crea l'ambiente Python e scarica il modello (~25 MB).
Nel `backend/.env`: `DIARIZZAZIONE_URL=http://127.0.0.1:8105`.
