# Backup dei database

Ogni notte alle 02:30 UTC (04:30 ora italiana d'estate) la VM Oracle salva i 4 database
Neon nell'Object Storage di Oracle (Always Free, 20 GB).

| Cosa | Dove |
|---|---|
| Script | `/opt/projexa/backup-db.sh` (sorgente: `deploy/oracle/backup-db.sh`) |
| Timer | `projexa-backup.timer` → `projexa-backup.service` (installati da `deploy/oracle/setup-backup.sh`) |
| Bucket | `projexa-backup`, namespace `axzmowo31clc`, regione eu-milan-1 |
| Conservazione | `daily/AAAA-MM-GG/` per 30 giorni, `monthly/AAAA-MM/` (giorno 1) per 12 mesi |
| Copia locale | `/opt/projexa/backups/` ultimi 3 giorni |
| Accesso | instance principal: gruppo dinamico `projexa-vm` + criterio `projexa-backup-policy` (solo quel bucket) |

File: `projexa_<db>_<data>_<ora>.dump` con `<db>` = `projexa` (DATABASE_URL), `auth`,
`lic`, `notif`. Formato "custom" di pg_dump, compresso.

## Controlli

```bash
# esito dell'ultimo backup e prossima esecuzione
systemctl status projexa-backup.service --no-pager
systemctl list-timers projexa-backup.timer --no-pager
journalctl -u projexa-backup.service -n 20 -o cat

# backup presenti nel bucket
/opt/projexa/oci-venv/bin/oci --auth instance_principal os object list \
  -ns axzmowo31clc -bn projexa-backup --query "data[].name" --output table

# backup manuale immediato
sudo systemctl start projexa-backup.service
```

## Ripristino

1. Scaricare il file dal bucket (dalla console Oracle: Bucket → projexa-backup → ⋮ → Scarica,
   oppure sulla VM):
   ```bash
   /opt/projexa/oci-venv/bin/oci --auth instance_principal os object get \
     -ns axzmowo31clc -bn projexa-backup \
     --name daily/AAAA-MM-GG/projexa_projexa_AAAA-MM-GG_HHMM.dump --file restore.dump
   ```
2. Ripristinare **in un database nuovo e vuoto** (su Neon: crea un branch o un database
   vuoto), mai sopra quello in uso senza aver prima verificato:
   ```bash
   /usr/pgsql-18/bin/pg_restore --no-owner --no-privileges \
     --dbname="postgresql://utente:password@host/nuovo_db?sslmode=require" restore.dump
   ```
3. Controllare i dati, poi puntare `DATABASE_URL` (o la variabile del db ripristinato) al
   nuovo database nel `.env` del server e `pm2 reload projexa --update-env`.

I dati cifrati dall'applicazione restano cifrati nel backup: per leggerli serve la stessa
`ENCRYPTION_KEY` (e `INTEGR_ENC_KEY`) del `.env`. Conservare quelle chiavi anche fuori dal
server, altrimenti il backup dei campi cifrati è inutilizzabile.

Prova di ripristino eseguita il 2026-09-26: 45 tabelle, conteggi identici a Neon.
