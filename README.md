# Projexa

**Piattaforma SaaS di Project Management** multi-tenant per project manager.

Produzione: **https://www.projexa.it**

## Stack

- **Backend:** Node.js + Express (`backend/`), serve anche il sito
- **Frontend:** HTML + CSS + JavaScript (`sito/`), stessa origine del backend
- **Database:** PostgreSQL 18 sulla VM (4 database: `projexa`, `projexa_auth`, `projexa_lic`, `projexa_notif`)
- **Auth:** JWT + bcrypt, login Google / Microsoft / magic link
- **Trascrizione riunioni:** servizio Whisper locale (`whisper-service/`)
- **Hosting:** VM Oracle Cloud (Oracle Linux 9), Caddy (HTTPS) → Node gestito da PM2

## Avvio in locale

```bash
cd backend
npm install
npm start          # oppure: npm run dev
```

Il `.env` si crea partendo da `backend/.env.example`. In locale i database sono quelli della VM,
raggiunti con il tunnel SSH `deploy/oracle/db-tunnel.ps1` (porta 15432).
Dettagli in [docs/SETUP.md](docs/SETUP.md).

## Deploy

Push sul branch `master` → GitHub Actions (`.github/workflows/deploy-oracle.yml`) copia il codice
sulla VM, esegue `npm ci` e ricarica PM2. Script del server in `deploy/oracle/`.

## Documentazione

| File | Contenuto |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Installazione, avvio in locale, variabili d'ambiente |
| [docs/DATABASE.md](docs/DATABASE.md) | Database sulla VM, tunnel, staging |
| [docs/BACKUP.md](docs/BACKUP.md) | Backup notturno e ripristino |
| [docs/CRYPTO.md](docs/CRYPTO.md) | Cifratura dei dati a riposo |
| [docs/INTEGRAZIONI.md](docs/INTEGRAZIONI.md) | Integrazioni esterne |
| [docs/JIRA.md](docs/JIRA.md) | Integrazione Jira |

## Architettura multi-tenant

- Un utente può appartenere a più tenant: al login, se ne ha 2 o più, sceglie quale usare.
- Il token JWT contiene `tenant_id` e `user_id`, che filtrano i dati di ogni richiesta.
