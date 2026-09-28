# Projexa - Installazione e avvio

## Backend in locale

### 1. Dipendenze

```bash
cd backend
npm install
```

### 2. File `.env`

Copiare `backend/.env.example` in `backend/.env` e completarlo. Le voci principali:

| Variabile | Uso |
|---|---|
| `DATABASE_URL`, `AUTH_DATABASE_URL`, `LICEN_DATABASE_URL`, `NOTIF_DATABASE_URL` | I 4 database (in locale `127.0.0.1:15432` tramite tunnel) |
| `JWT_SECRET` | Firma dei token di sessione (obbligatoria) |
| `ENCRYPTION_KEY` | Cifratura dei dati a riposo (vedi [CRYPTO.md](CRYPTO.md)) |
| `BACKEND_URL`, `APP_URL` | Indirizzo pubblico, usato per callback OAuth e link nelle email |
| `ALLOWED_ORIGINS` | Origini ammesse (CORS) |
| `GOOGLE_*`, `MICROSOFT_*`, `JIRA_*` | Login e integrazioni |
| `WHISPER_URL` / `WHISPER_URLS`, `WHISPER_API_KEY` | Servizio di trascrizione |
| `APP_ENV=staging` | Usa i database di staging (`STAGING_*`), vedi [DATABASE.md](DATABASE.md) |

### 3. Database

I database stanno sulla VM Oracle e ascoltano solo su localhost. In locale si raggiungono con il
tunnel SSH (lasciare aperta la finestra):

```powershell
deploy/oracle/db-tunnel.ps1
```

Attenzione: in locale si lavora sui **dati di produzione**. Per le prove distruttive usare lo
staging (`APP_ENV=staging`). Dettagli in [DATABASE.md](DATABASE.md).

### 4. Avvio

```bash
npm start          # oppure npm run dev (riavvio automatico)
```

Il server risponde su `http://localhost:3001` e serve anche il sito (`sito/`).

### 5. Trascrizione (facoltativa)

Per trascrivere le riunioni in locale avviare `whisper-service/avvia_locale.bat` e impostare
`WHISPER_URL=http://localhost:8001` nel `.env`.

## Frontend

Tutte le pagine sono in `sito/` e chiamano le API sulla stessa origine (`location.origin + '/api'`).
Pagine principali: `login.html`, `dashboard.html`, `gantt.html`, `issue.html`,
`database-viewer.html` / `sql-editor.html` (strumenti admin), `prompt-editor.html`.

## Produzione

- VM Oracle Cloud, dominio `www.projexa.it` (Caddy con HTTPS automatico → Node su `127.0.0.1:3001`, PM2).
- Deploy automatico a ogni push su `master` (`.github/workflows/deploy-oracle.yml`).
- Script di installazione e manutenzione in `deploy/oracle/`, backup in [BACKUP.md](BACKUP.md).

## Architettura multi-tenant

Un utente può appartenere a più tenant: al login, se ne ha 2 o più, sceglie quale usare.
Il token JWT contiene `tenant_id` e `user_id`, che filtrano i dati di ogni richiesta.
