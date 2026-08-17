---
name: projexa-deploy-setup
description: Come è distribuito Projexa (Render/branch/OneDrive) e i tranelli relativi
metadata:
  type: project
---

Setup di deploy di Projexa (aggiornato 2026-08-17):

- **Backend**: Render, servizio su `https://projexa-4mix.onrender.com`. Serve ANCHE il frontend statico (`server.js` fa `express.static(../sito)`), quindi sito + API sono sullo stesso dominio se si usa l'URL onrender.
- **Branch di deploy**: dal 2026-08-17 Render distribuisce da **`master`**, non da `main`. `main` è rimasto indietro/incasinato (mix di "Add files via upload" web + push desktop) e un merge `master`→`main` dà conflitti. Il codice buono è su `master`.
- **GitHub Pages**: esiste un deploy `github-pages` (dominio `github.io`) che serve il frontend da `main` → è stale/rotto. **Usare sempre `https://projexa-4mix.onrender.com/login.html`**, NON l'URL github.io.
- **`JWT_SECRET` su Render**: obbligatorio (>= 16 char) perché `backend/config/jwt.js` fa fail-fast. Se manca, il server non parte (era il vecchio comportamento col fallback debole a mascherarlo). Non cambiarlo o si invalidano i token.
- **URL frontend**: `API_URL`/`BACKEND_URL` ora sono localhost-aware: su localhost usano l'origine, altrimenti puntano a `https://projexa-4mix.onrender.com`.

⚠️ **Tranello OneDrive**: il repo è dentro OneDrive (`C:\Users\y.dacco\OneDrive - TeamSystem...`). OneDrive sincronizza la cartella `.git` e **ripristina i commit locali**, facendo divergere locale e remote (GitHub Desktop mostra file "non committati" anche dopo il push). I push arrivano comunque su GitHub. Rimedio definitivo: spostare il repo fuori da OneDrive e ri-clonare. Vedi [[projexa-security-hardening]].
