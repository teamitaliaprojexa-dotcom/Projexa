# Integrazione Jira (sola lettura)

Il pulsante **Jira** nella sidebar apre un pannello a tutto schermo con i filtri
salvati dell'utente su Jira Cloud e la griglia dei risultati (100 righe per pagina,
ordinamento e filtri di colonna). L'integrazione **non scrive nulla su Jira**: gli
scope richiesti sono solo di lettura.

## Come funziona

| Pezzo | Dove |
|---|---|
| Flag di abilitazione | `settings.argument = 'Integrazioni'`, `campo = 'Jira'`, `tipo_valore = '1'`, `valore1` booleano (DB *Projexa*) |
| Dati di accesso | tabella `integr_tok_auth` (DB *Projexa-Auth*), `provider_integrazione = 'Jira'` |
| API backend | `backend/routes/jira.js`, montate su `/api/jira` |
| Lettura/scrittura tabella token | `backend/config/integrations.js` |
| Interfaccia | `sito/js/jira.js` + voce `#navJira` in `sito/dashboard.html` |

- **Flag a true** → la voce Jira compare nella sidebar.
- **Flag a false** (o riga assente) → la voce sparisce e, al primo accesso
  successivo, il backend **cancella tutte le righe dell'utente** su
  `integr_tok_auth`. Per riattivarla l'utente deve rifare l'intera procedura
  di autorizzazione.

## Righe scritte su `integr_tok_auth`

Una riga per elemento, con `tipo_integrazione = 'issue_tracking'`,
`provider_integrazione = 'Jira'`, `active = true`, `data_inzio = CURRENT_DATE`:

| elemento | contenuto |
|---|---|
| `projexa_email` | email dell'utente Projexa che ha collegato l'account |
| `jira_email` | email dell'account Atlassian autorizzato |
| `jira_account_id` | accountId Atlassian |
| `jira_display_name` | nome visualizzato dell'account |
| `jira_cloud_id` | id del sito Jira (base delle chiamate API) |
| `jira_site_url` | link del sito, es. `https://azienda.atlassian.net` |
| `jira_site_name` | nome del sito |
| `jira_access_token` | token di accesso (cifrato) |
| `jira_refresh_token` | token di refresh (cifrato), `scadenza` = +90 giorni |
| `jira_token_expires_at` | scadenza esatta dell'access token (ISO 8601) |
| `jira_scopes` | scope concessi |

L'access token dura un'ora e viene rinnovato automaticamente con il refresh token
(rotante: a ogni rinnovo viene salvato quello nuovo). L'utente non deve ripetere
l'autorizzazione a ogni accesso.

## Setup

### 1. App OAuth su Atlassian

Su <https://developer.atlassian.com/console/myapps/> → *Create* → **OAuth 2.0 integration**:

1. **Permissions** → *Jira API* → aggiungi gli scope: `read:jira-work`,
   `read:jira-user`, `offline_access`.
2. **Authorization** → *OAuth 2.0 (3LO)* → Callback URL:
   `https://<dominio-backend>/api/jira/callback`
   (in locale: `http://localhost:3001/api/jira/callback`).
3. **Settings** → copia *Client ID* e *Secret*.

### 2. Variabili d'ambiente del backend

```
JIRA_CLIENT_ID=...
JIRA_CLIENT_SECRET=...
BACKEND_URL=https://<dominio-backend>     # deve combaciare con la callback registrata
INTEGR_ENC_KEY=<passphrase lunga e casuale>
```

`INTEGR_ENC_KEY` cifra i token a riposo (AES-256-GCM). Se manca, i token vengono
salvati in chiaro e il server lo segnala nei log. **Cambiare la chiave rende
illeggibili i token già salvati**: gli utenti dovranno ricollegare l'account.

### 3. Database

Eseguire `Supporto/CreaDB/jira_integrazione.sql`: indici su `integr_tok_auth`
(*Projexa-Auth*) e verifica del campo booleano `Integrazioni / Jira` in `settings`
(*Projexa*), che di norma esiste già.

### 4. Attivazione per l'utente

Impostazioni → **Integrazioni** → spuntare la casella **Jira**.
Poi, dal pannello Jira, «Collega account Jira» e autorizzare nella finestra Atlassian.

## Note operative

- **Sito multiplo**: se l'account Atlassian ha accesso a più siti Jira viene usato
  il primo restituito da Atlassian. Per cambiarlo: Scollega e ricollega.
- **Ordinamento**: viene applicato da Jira su tutto il risultato (JQL `ORDER BY`) e
  riporta alla prima pagina. Se la colonna non è ordinabile in JQL, l'ordinamento
  viene applicato solo alla pagina caricata e la griglia lo segnala.
- **Ricerca**: il campo in alto aggiunge `text ~ "..."` alla JQL del filtro, quindi
  cerca su tutto il risultato. I filtri sotto le intestazioni agiscono invece sulle
  100 righe della pagina corrente.
- **Colonne**: sono quelle configurate nel filtro Jira. Se il filtro non ne ha (o
  contiene campi non più esistenti) si usa un set predefinito.
- **Revoca**: «Scollega» elimina i dati salvati su Projexa. Per revocare anche il
  consenso lato Atlassian: <https://id.atlassian.com/manage-profile/apps>.
