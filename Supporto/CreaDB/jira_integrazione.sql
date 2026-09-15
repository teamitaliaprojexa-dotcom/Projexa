-- ============================================================
-- INTEGRAZIONE JIRA (sola lettura) — script di setup
-- Da eseguire una volta, sui due progetti Neon indicati.
-- ============================================================


-- ------------------------------------------------------------
-- 1) PROGETTO "Projexa-Auth"  (AUTH_DATABASE_URL)
--    Tabella integr_tok_auth: già creata. Qui si aggiungono solo
--    gli indici che rendono veloci e sicure le operazioni fatte
--    dal backend (lettura per utente/provider, un solo valore per
--    ogni elemento).
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_integr_tok_auth_user_provider
    ON integr_tok_auth (user_id, provider_integrazione);

-- Evita righe doppie per lo stesso elemento dello stesso utente.
-- Se l'indice fallisse per duplicati già presenti, ripulire prima con:
--   DELETE FROM integr_tok_auth a USING integr_tok_auth b
--    WHERE a.ctid < b.ctid AND a.user_id = b.user_id
--      AND a.provider_integrazione = b.provider_integrazione
--      AND a.elemento = b.elemento;
CREATE UNIQUE INDEX IF NOT EXISTS uq_integr_tok_auth_user_provider_elemento
    ON integr_tok_auth (user_id, provider_integrazione, elemento);


-- Righe scritte dal programma quando l'utente collega Jira
-- (provider_integrazione = 'Jira', tipo_integrazione = 'issue_tracking'):
--
--   projexa_email          email dell'utente Projexa che ha collegato l'account
--   jira_email             email dell'account Atlassian autorizzato
--   jira_account_id        accountId Atlassian (identifica l'utente nelle API)
--   jira_display_name      nome visualizzato dell'account
--   jira_cloud_id          id del sito Jira (serve a comporre l'URL delle API)
--   jira_site_url          link del sito Jira (es. https://azienda.atlassian.net)
--   jira_site_name         nome del sito Jira
--   jira_access_token      token di accesso (cifrato se INTEGR_ENC_KEY è impostata)
--   jira_refresh_token     token di refresh, rinnova l'accesso senza rifare la procedura
--   jira_token_expires_at  scadenza esatta dell'access token (ISO 8601)
--   jira_scopes            scope concessi (solo lettura)
--
-- Controllo dei dati salvati per un utente:
--   SELECT elemento, left(valore_alfa, 30) AS valore, active, data_inzio, scadenza
--     FROM integr_tok_auth
--    WHERE provider_integrazione = 'Jira' AND user_id = '<uuid utente>'
--    ORDER BY elemento;


-- ------------------------------------------------------------
-- 2) PROGETTO "Projexa"  (DATABASE_URL)
--    Flag che abilita l'integrazione: campo 'Jira' sotto l'argomento
--    'Integrazioni', tipo_valore = '1' (booleano -> valore1).
--    Il campo ESISTE GIÀ: qui c'è solo la verifica e la riga di
--    recupero per eventuali utenti a cui manca.
--
--    Il pulsante nella sidebar compare solo se valore1 = true.
--    Con valore1 = false (o riga assente) il backend cancella le
--    righe dell'utente su integr_tok_auth.
--    NB: il backend cerca per campo = 'Jira' (senza vincolo
--    sull'argomento), filtrando per tenant_id e user_id del login.
-- ------------------------------------------------------------

-- Verifica: quali utenti hanno il campo e com'è impostato.
SELECT tenant_id, user_id, argument, campo, tipo_valore, valore1
  FROM settings
 WHERE campo = 'Jira'
 ORDER BY tenant_id, user_id;

-- Recupero: crea il campo SOLO per gli utenti dell'argomento 'Integrazioni'
-- che non ce l'hanno (utenti creati prima dell'introduzione del campo).
-- Se la SELECT qui sopra copre già tutti gli utenti, questa INSERT non fa nulla.
INSERT INTO settings (tenant_id, user_id, argument, campo, tipo_valore, valore1, ordinamento, id_roles)
SELECT DISTINCT s.tenant_id,
       s.user_id,
       'Integrazioni',
       'Jira',
       '1',
       false,
       COALESCE((SELECT MAX(x.ordinamento) FROM settings x
                  WHERE x.argument = 'Integrazioni' AND x.tenant_id = s.tenant_id
                    AND x.ordinamento BETWEEN 1 AND 199), 0) + 1,
       (SELECT MIN(z.id_roles) FROM settings z
         WHERE z.argument = 'Integrazioni' AND z.tenant_id = s.tenant_id AND z.campo = 'Jira')
  FROM settings s
 WHERE s.argument = 'Integrazioni'
   AND NOT EXISTS (SELECT 1 FROM settings y
                    WHERE y.tenant_id = s.tenant_id AND y.user_id = s.user_id
                      AND y.campo = 'Jira');

-- Attivazione per un singolo utente (in alternativa si usa la UI Impostazioni):
--   UPDATE settings SET valore1 = true
--    WHERE campo = 'Jira' AND tenant_id = '<uuid tenant>' AND user_id = '<uuid utente>';

-- Disattivazione: al primo accesso successivo il backend elimina i token dell'utente.
--   UPDATE settings SET valore1 = false
--    WHERE campo = 'Jira' AND tenant_id = '<uuid tenant>' AND user_id = '<uuid utente>';
