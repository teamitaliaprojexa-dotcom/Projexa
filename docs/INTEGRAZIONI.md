# Aggiorna Integrazioni

Il pulsante **Aggiorna Integrazioni**, nell'intestazione della dashboard accanto a
*Nuovo Progetto*, lancia i programmi che portano i dati da Jira dentro Projexa.

Ogni programma è un **file a sé**, con un suo nome, richiamabile anche da riga di
comando: è la premessa per farlo girare, in futuro, da uno schedulatore.

| Programma | Da | A |
|---|---|---|
| `aggiornaJiraQuotazioni` | filtro Jira indicato in `jira_quotazioni` | `cl_quotazioni` |
| `aggiornaJiraTask` | filtro Jira indicato in `jira_task` | `task_app` |

## Pezzi

| Pezzo | Dove |
|---|---|
| Programma quotazioni | `backend/jobs/aggiornaJiraQuotazioni.js` |
| Programma task | `backend/jobs/aggiornaJiraTask.js` |
| Logica condivisa | `backend/jobs/jiraSyncEngine.js` |
| API backend | `backend/routes/integrazioni.js`, montate su `/api/integrazioni` |
| Interfaccia | `sito/js/integrazioni.js` + `#btnAggiornaIntegrazioni` in `sito/dashboard.html` |

Il pulsante compare solo se l'integrazione Jira è attiva per l'utente (stesso flag
che governa la voce Jira in sidebar: `settings`, `campo = 'Jira'`, `valore1 = true`).

## Come funziona un programma

Tutto è guidato dalla tabella di mappatura (`jira_quotazioni` / `jira_task`),
filtrata per `tenant_id` e `user_id` del login:

1. **Filtro** — la riga `colonna_projexa = 'Nome_Filtro'` dice quale filtro salvato
   su Jira eseguire; il nome sta in `colonna_jira`. Il filtro viene cercato per nome
   fra quelli dell'account Jira collegato ed eseguito scorrendo tutte le pagine
   (100 righe per volta, fino a 5.000 righe).
2. **Cliente** — la riga che indica la colonna Jira del nome cliente
   (`cliente` per le quotazioni, `Nome_cliente` per i task) viene confrontata con
   `clients.valore2`:

   | Programma | `clients.campo` | Confronto |
   |---|---|---|
   | `aggiornaJiraQuotazioni` | `Nome Cliente Jira Quot` | uguaglianza |
   | `aggiornaJiraTask` | `Nome Cliente Jira task` | il nome configurato è **contenuto** nel testo Jira (es. dentro le etichette) |

   Il `client_id` scritto sulla riga è `clients.argument`. Le righe Jira che non
   trovano un cliente vengono ignorate e contate nel riepilogo.
3. **Insert o update** — si guarda il codice (`codice` / `cod_task`) nel perimetro
   *tenant + utente + cliente*:
   - codice assente → **INSERT**;
   - codice presente e `scadenza > oggi` → **UPDATE**;
   - codice presente ma riga **scaduta** → non si tocca nulla.
4. **Colonne** — tutte le altre righe di mappatura valorizzano la colonna Projexa
   indicata in `colonna_projexa` con la colonna Jira indicata in `colonna_jira`.

## Dettagli che è utile conoscere

- **`colonna_jira` contiene l'etichetta**, non il nome tecnico del campo: si scrive
  `Chiave`, `Creati`, `Riepilogo` — non `issuekey`, `created`, `summary`. Il
  confronto ignora maiuscole e spazi in eccesso. Se l'etichetta non è fra le colonne
  del filtro, viene cercata fra tutti i campi del sito Jira.
- **Conversione dei tipi**: il valore Jira viene convertito nel tipo della colonna di
  destinazione (date come `YYYY-MM-DD`, numeri con virgola o punto, testo con la
  stessa resa della griglia Jira). Una colonna indicata in mappatura ma inesistente
  sulla tabella Projexa viene saltata e segnalata nel riepilogo.
- **`link_task`** è mappato sulla chiave dell'issue ma viene scritto come link
  completo (`https://<sito>.atlassian.net/browse/<chiave>`).
- **Cifratura**: `cl_quotazioni` e `task_app` nascono con `crypto = 1`, quindi i dati
  sul database sono cifrati. Poiché la cifratura è randomizzata, il codice **non**
  può essere cercato con una `WHERE`: il confronto avviene in memoria sulle righe
  lette dal pool (che decifra in automatico) e le scritture passano da
  `encryptRowForWrite`.
- **Un programma che fallisce non blocca gli altri**: l'errore finisce nel suo
  riquadro del riepilogo. Anche un singolo record che va in errore non interrompe
  l'elaborazione delle altre righe.
- Al termine i KPI della dashboard vengono ricaricati.

## Riga di comando

Da lanciare **dalla cartella `backend`** (è lì che `config/database.js` cerca il `.env`):

```bash
node jobs/aggiornaJiraQuotazioni.js <tenant_id> <user_id>
node jobs/aggiornaJiraTask.js <tenant_id> <user_id>
```

Con `--dry` il programma elabora tutto e stampa il riepilogo **senza scrivere nulla**
sul database, aggiungendo un campo `esempio` con la prima riga elaborata: è il modo
per verificare una mappatura appena modificata.

```bash
node jobs/aggiornaJiraQuotazioni.js <tenant_id> <user_id> --dry
```

## Aggiungere un nuovo programma

1. Creare `backend/jobs/<nome>.js` sul modello dei due esistenti (configurazione +
   chiamata a `runJiraSync`).
2. Aggiungerlo all'elenco `PROGRAMMI` in `backend/routes/integrazioni.js`.

Il pulsante li esegue tutti in sequenza; `POST /api/integrazioni/aggiorna` accetta
anche `{ "programmi": ["aggiornaJiraTask"] }` per eseguirne solo alcuni.
