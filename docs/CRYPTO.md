# Cifratura dei dati a riposo ("Migrazione Crypto")

Sul database i dati sono cifrati; nell'applicazione (e quindi a video) si vedono
in chiaro. La conversione è automatica e non richiede modifiche alle pagine.

## In due righe

| | dove |
|---|---|
| Chiave | variabile d'ambiente `ENCRYPTION_KEY` (Render + `backend/.env`) |
| Algoritmo | AES-256-GCM, valori con prefisso `enc:v1:` |
| Regola | `backend/config/crypto.js` |
| Decifratura in lettura | `backend/config/cryptoPool.js` (avvolge i 4 pool) |
| Cifratura in scrittura | `cryptoWrite(...)` negli endpoint di `backend/server.js` |
| Migrazione manuale | `backend/routes/crypto-migration.js` + pulsante nel database-viewer |
| Preparazione DB | `Supporto/CreaDB/crypto_migrazione.sql` |

Si cifra **solo** con `ENCRYPTION_KEY`. `INTEGR_ENC_KEY` è accettata **solo in
decifratura**, per i token Jira salvati prima dell'unificazione della chiave.

### Interruttore

Svuotare `ENCRYPTION_KEY` (e riavviare) disattiva la cifratura in scrittura:
l'applicazione torna a salvare in chiaro e i pulsanti Crypta/Decripta si
bloccano con un messaggio. Serve per tenere la funzione ferma finché non si è
pronti. Attenzione: i dati già cifrati con quella chiave restano illeggibili
finché non la si rimette, quindi va fatto **prima** di lanciare la prima
migrazione, non dopo.

## La regola

1. La tabella deve avere la colonna **`crypto`**. Senza quella colonna non viene
   cifrato nulla.
2. Si cifrano solo le righe con **`crypto = 1`**.
3. Non vengono **mai** cifrati, nemmeno con `crypto = 1`:
   - UUID, date, timestamp, booleani e colonne numeriche;
   - `tenant_id`, `user_id`, `client_id`, `project_id` e ogni colonna `*_id`;
   - password e hash;
   - le colonne strutturali/di ricerca: `argument`, `campo`, `tabella`,
     `colonna`, `tipo_valore`, `VariabDB`, `id_roles`, `id_roles_write`,
     `table_name`, `elemento`, `provider_integrazione`, `tipo_integrazione`,
     `users.email`… — l'applicazione le usa nelle `WHERE` con l'uguaglianza e,
     poiché la cifratura è randomizzata, cifrandole le righe non si troverebbero
     più (login compreso). L'elenco completo è in `backend/config/crypto.js`.
   - le colonne generate (`GENERATED ALWAYS`), che Postgres non permette di
     scrivere (es. `contacts.nominativo`) — vedi sotto.
4. Elenco chiuso per tabella:
   - **clients** → solo `valore2` e `valore3`
   - **projects** → solo `valore2`
5. Tutte le altre tabelle: ogni colonna testuale che supera il punto 3.

### Colonne calcolate (contacts.nominativo)

`contacts.nominativo` è una colonna **calcolata da Postgres**: concatena `nome` e
`cognome`. Quando quelle due colonne sono cifrate, il database ricalcola
`nominativo` concatenando i due testi cifrati, quindi sul DB si legge
`enc:v1:… enc:v1:…`.

L'applicazione lo mostra comunque in chiaro: in lettura ogni blocco `enc:v1:…`
dentro la stringa viene decifrato singolarmente (`decryptEmbedded` in
`crypto.js`), così `nominativo` torna "Mario Rossi". Vale per qualsiasi colonna
calcolata o espressione SQL che concateni colonne cifrate.

Due note pratiche:

- La colonna calcolata **non** viene cifrata né decifrata dalla migrazione: è
  Postgres a ricalcolarla da solo. Dopo "Decripta" torna leggibile anche sul DB.
- Un valore cifrato è più lungo dell'originale (circa 50 caratteri fissi più un
  terzo in più del testo). `nominativo` è `varchar(511)`: regge nomi + cognomi
  fino a circa 150 caratteri ciascuno, ben oltre l'uso reale, ma se un giorno
  quel limite venisse superato il salvataggio darebbe errore.

### clients.valore3

`valore3` è `numeric(12,2)`: una colonna numerica non può contenere il testo
cifrato, quindi la migrazione la **salta** e lo segnala nella finestra. Per
cifrarla davvero va convertita in `text` (istruzione pronta, commentata, in
`Supporto/CreaDB/crypto_migrazione.sql`). Dopo la conversione gli ordinamenti e
i confronti su `clients.valore3` diventano alfabetici: verificare prima i campi
tipo 12, i frammenti `VariabDB` e `function_db` che la usano come numero.

## Come si usa

1. `Database Viewer` → pulsante **Migrazione Crypto** (solo amministratori).
2. Scegliere il **database** (Projexa, Projexa-Auth, Projexa-Lic, Projexa-Notif)
   e la **tabella**. La finestra mostra quali colonne verranno cifrate, quante
   righe hanno `crypto = 1` e quanti valori sono già cifrati.
3. **Crypta** cifra le righe con `crypto = 1`; **Decripta** riporta in chiaro
   tutti i valori cifrati della tabella. Ogni operazione è una singola
   transazione: se qualcosa va storto non viene salvato niente.

Da quel momento l'applicazione continua a scrivere cifrato da sola: gli endpoint
di scrittura applicano la stessa regola.

> **Decripta non spegne la cifratura.** Le righe restano marcate `crypto = 1`,
> quindi al primo salvataggio dall'applicazione tornano cifrate. Per lasciarle
> stabilmente in chiaro impostare prima `crypto = 0` su quelle righe.

## Quando i dati vengono cifrati in scrittura

Applicano la regola: il CRUD generico (`/api/data/:table` POST/PUT e import CSV),
le griglie (`grid-widget/row`), il Gantt (`proj_activity`), le task della
dashboard, `linked-row`, `reference-value`, la creazione di clienti e progetti e
i token delle integrazioni (`integr_tok_auth`).

Restano in chiaro finché non vengono modificati (o finché non si rilancia
"Crypta") i valori di default scritti dalla creazione di un nuovo campo
(`/api/:source/field`), che nascono quasi sempre vuoti.

## Limiti da conoscere

Sono conseguenze inevitabili della cifratura, non difetti dell'implementazione:

- **Ricerca e filtri**: i filtri per colonna del database-viewer e ogni `WHERE`
  o `LIKE` su una colonna cifrata non trovano nulla. Il confronto avviene sul
  testo cifrato, che è diverso a ogni salvataggio (IV casuale).
- **Ordinamento**: un `ORDER BY` su colonna cifrata ordina il testo cifrato.
  Gli elenchi di clienti e progetti sono già riordinati lato server dopo la
  decifratura (`sortByName`); altri ordinamenti (es. Gantt per `nominativo`)
  seguono l'ordine del cifrato.
- **Controlli di unicità** fatti dal database o via `SELECT ... WHERE col = $1`
  (es. `reference-value`) non intercettano più i duplicati.
- **Somme e aggregazioni SQL** non sono possibili su colonne cifrate. Per questo
  le colonne numeriche non vengono mai cifrate.

## Cambio della chiave

Se `ENCRYPTION_KEY` cambia, i dati già cifrati non sono più leggibili.
Procedura corretta:

1. **Decripta** tutte le tabelle migrate (con la chiave vecchia ancora attiva).
2. Cambiare `ENCRYPTION_KEY` su Render e in `backend/.env`, riavviare.
3. **Crypta** di nuovo le stesse tabelle.

Se la chiave è già stata cambiata, "Decripta" si ferma con un errore esplicito e
non riscrive nulla: rimettere la chiave precedente e ripartire dal punto 1.
