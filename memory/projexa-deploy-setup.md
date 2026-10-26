---
name: projexa-deploy-setup
description: Come è distribuito Projexa (VM Oracle, branch master, cartelle sul PC personale)
metadata:
  type: project
---

Setup di deploy di Projexa (aggiornato 2026-10-25):

- **Produzione**: VM Oracle Cloud (`129.152.0.49`, utente `opc`), dominio `https://www.projexa.it`. Caddy (HTTPS) → Node su `127.0.0.1:3001` gestito da PM2. Il backend serve ANCHE il frontend statico (`server.js` fa `express.static(../sito)`). Render è dismesso: gli URL `onrender.com` non vanno più usati.
- **Branch di deploy**: `master`. Il push su `master` avvia `.github/workflows/deploy-oracle.yml` (rsync, `npm ci`, `pm2 reload`). `main` è rimasto indietro: il codice buono è su `master`.
- **GitHub Pages**: il deploy `github-pages` (dominio `github.io`) serve un frontend vecchio da `main` → non usarlo.
- **`JWT_SECRET`**: obbligatorio (>= 16 char) perché `backend/config/jwt.js` fa fail-fast. Non cambiarlo o si invalidano i token.
- **Cartelle sul PC personale** (`C:\Users\ydacc\`, il repo non è più in OneDrive):
  - `Documents\Projexa\Projexa_Staging\Projexa` = sviluppo/staging
  - `Documents\Projexa\Projexa_Prod\Projexa` = versione da pubblicare
  - `Documents\GitHub\Projexa` = clone git da cui si fa il push; `Projexa_Prod\ZZ-copia file Github.bat` copia Prod qui (senza `Supporto`) e fa commit + push su `master`.
- **Chiave SSH**: `C:\Users\ydacc\.ssh\ssh-key-2026-09-25.key` (usata da `deploy/oracle/db-tunnel.ps1` e `oracle-console.ps1`).

Vedi [[projexa-security-hardening]].
