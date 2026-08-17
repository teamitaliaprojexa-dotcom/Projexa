# Projexa — Code Review completa

*Data: 17/08/2026 — Revisione di backend (`backend/`) e frontend (`sito/`)*

---

## 🔴 CRITICI — da sistemare prima di qualsiasi uso reale

### 1. Endpoint SQL arbitrario senza autenticazione
`backend/server.js:202` — `POST /api/sql/execute` esegue qualunque SQL ricevuto, senza verificare il JWT. La funzione `getTokenId()` (riga 196) usa il token solo come chiave di una mappa, **non lo valida mai**. Chiunque conosca l'URL del backend può fare `DROP TABLE users`, leggere tutti i dati di tutti i tenant, ecc. Il frontend `sql-editor.html` è solo l'interfaccia: il problema è che l'API risponde a chiunque.

### 2. Nessuna autenticazione su tutti gli endpoint dati
`backend/server.js:48-186` e `backend/routes/table-structures.js` — `GET/POST/PUT/DELETE /api/data/:table` e tutto `/api/table-structures` sono completamente aperti. Il JWT viene generato al login ma **nessun middleware lo verifica** (esiste solo `/api/auth/verify`, mai usato dalle API). Conseguenze:
- `GET /api/data/users` restituisce tutti gli utenti **con `password_hash`** (`SELECT *`)
- il multi-tenancy non esiste a livello API: nessuna query filtra per `tenant_id`, il claim `tenant_id` nel JWT non è mai usato
- chiunque può creare/modificare/cancellare record in qualunque tabella registrata

### 3. SQL injection sui nomi colonna
`backend/server.js:99-103` e `140-144` — le chiavi del body JSON vengono interpolate direttamente nella query:
```js
const columns = Object.keys(data);
const query = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders}) ...`;
```
Un body come `{"name) VALUES ('x'); DROP TABLE users; --": 1}` inietta SQL. Inoltre la