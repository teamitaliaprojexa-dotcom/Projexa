# Database

Dal 2026-09-27 i 4 database di Projexa girano su **PostgreSQL 18 installato sulla VM Oracle**,
al posto dei progetti Neon. Il motivo: il piano gratuito Neon ha superato il limite mensile di
traffico di rete, perché con il backend su Oracle ogni query attraversava internet. Da quel
momento Neon ha bloccato le connessioni ("Internal server error" nell'app).

| Variabile `.env` | Database locale | Ex progetto Neon |
|---|---|---|
| `DATABASE_URL` | `projexa` | Projexa |
| `AUTH_DATABASE_URL` | `projexa_auth` | Projexa-Auth |
| `LICEN_DATABASE_URL` | `projexa_lic` | Projexa-Lic |
| `NOTIF_DATABASE_URL` | `projexa_notif` | Projexa-Notif |

Il codice non è cambiato: i pool (`backend/config/*Database.js`) leggono solo la connection
string. L'header `X-Target-DB` e i 4 pool separati funzionano come prima.

## Server

- Installazione e configurazione: `deploy/oracle/setup-postgres.sh` (idempotente).
- Servizio `postgresql-18`, dati in `/var/lib/pgsql/18/data`, tuning in `conf.d/projexa.conf`
  (shared_buffers 1 GB: la VM è condivisa con Node e Whisper; timezone UTC come su Neon).
- Ascolta **solo su localhost**: la porta 5432 non è raggiungibile da internet.
- Ruolo applicativo `projexa` (proprietario dei 4 database), password in
  `/opt/projexa/.pg_app_password` (permessi 600). Superutente: `sudo -u postgres psql`.
- `.env` del server: `postgresql://projexa:<password>@127.0.0.1:5432/<database>`, senza SSL
  (connessione locale). Copia del vecchio `.env` con gli URL Neon in `/opt/projexa/env-backups/`
  (fuori da `backend/`, altrimenti il deploy con `rsync --delete` la cancellerebbe).

## Sviluppo in locale

Il `backend/.env` locale punta a `127.0.0.1:15432`. Prima di avviare il backend aprire il tunnel
SSH e lasciarlo aperto:

```powershell
.\deploy\oracle\db-tunnel.ps1
```

Attenzione: in locale si lavora **sui dati di produzione**. Per test distruttivi usare un
database di prova (es. `sudo -u postgres createdb -O projexa projexa_test` e ripristinarci un
backup, vedi `docs/BACKUP.md`).

## Staging

I branch di staging (`STAGING_*`) sono ancora su Neon, negli stessi progetti: finché la quota
del progetto non si azzera (inizio del mese successivo) anche lo staging è bloccato.

## Backup

Notturno nell'Object Storage di Oracle: vedi `docs/BACKUP.md`. Primo ripristino (2026-09-27)
eseguito dal backup Neon del 2026-09-26 02:32 UTC: i dati scritti dopo quell'ora sono andati persi.
