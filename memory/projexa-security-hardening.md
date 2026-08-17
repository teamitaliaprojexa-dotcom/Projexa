---
name: projexa-security-hardening
description: Modifiche di sicurezza applicate al backend/frontend Projexa e cosa resta da fare
metadata:
  type: project
---

Il 2026-08-17 è stato fatto un hardening di sicurezza su Projexa (live su `master`/Render). Vedi [[projexa-deploy-setup]].

Fatto:
- Auth JWT obbligatoria (`backend/middleware/auth.js` + `requireAuth`) su `/api/data`, `/api/sql`, `/api/table-structures`.
- Isolamento multi-tenant: query filtrate per `tenant_id` (dove la colonna esiste) sul generico `/api/data/:table`.
- Fix SQL injection sui nomi tabella/colonna (validazione identificatori + quoting).
- `password_hash` mai restituito al client.
- Transazioni SQL editor con client dedicato dal pool (prima rotte sul pool).
- Escaping XSS nel frontend (greeting da URL, calendario, todo, sql-editor, database-viewer, login tenant).
- Token OAuth tolti dalla query string dashboard; token calendario Microsoft via header Authorization.
- Nome dashboard = `name + " " + cognome` dalla tabella `users` (`buildFullName` in auth.js e microsoft-oauth.js).

⚠️ Da tenere d'occhio / TODO:
- **Editor SQL** (`/api/sql/execute`): un utente autenticato può ancora eseguire SQL su TUTTI i tenant. Andrebbe riservato a un ruolo admin o spento con `DISABLE_SQL_EDITOR=true`.
- Nel `backend/.env` locale c'è un **MICROSOFT_CLIENT_SECRET reale** in chiaro (non committato, `.env` è gitignored). Se mai esposto, rigenerarlo su Azure.
- Utenti creati via Google/Microsoft hanno `cognome` vuoto alla registrazione (i callback salvano solo `name`/`displayName`): finché non si popola `cognome`, vedono solo il nome.
- File JS non inclusi da nessuna pagina (dead code): `sito/js/app.js`, `data.js`, `database.js`.
- Login Microsoft in locale richiede il redirect URI `http://localhost:3001/api/auth/microsoft-callback` registrato su Azure + `BACKEND_URL=http://localhost:3001` nel .env.
