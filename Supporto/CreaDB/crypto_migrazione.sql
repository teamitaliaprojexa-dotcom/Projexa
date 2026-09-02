-- ============================================================================
-- MIGRAZIONE CRYPTO — preparazione del database
-- Da eseguire MANUALMENTE, una tabella alla volta, sul progetto Neon indicato.
-- Dopo aver eseguito la parte che interessa, usare il pulsante
-- "Migrazione Crypto" nel database-viewer per cifrare/decifrare i dati esistenti.
-- ============================================================================
--
-- COME FUNZIONA
--   * La colonna "crypto" decide, RIGA PER RIGA, se i dati vanno cifrati:
--         crypto = 1  -> i valori vengono scritti cifrati sul database
--         crypto = 0  -> i valori restano in chiaro
--   * Una tabella SENZA la colonna "crypto" non viene mai cifrata.
--   * A video i dati si vedono sempre in chiaro: la decifratura è automatica
--     in lettura (backend/config/cryptoPool.js).
--
-- COSA NON VIENE MAI CIFRATO (anche con crypto = 1)
--   * UUID, date, timestamp, booleani e colonne numeriche
--   * tenant_id, user_id, client_id, project_id e ogni colonna *_id
--   * password e hash
--   * le colonne "strutturali" usate dall'applicazione nelle ricerche:
--     argument, campo, tabella, colonna, tipo_valore, VariabDB, id_roles,
--     id_roles_write, users.email, elemento, provider_integrazione, ...
--     (elenco completo e commentato in backend/config/crypto.js)
--
-- REGOLE PER TABELLA
--   clients   -> solo valore2 e valore3
--   projects  -> solo valore2
--   altre     -> tutte le colonne testuali che superano le esclusioni sopra
--
-- PRIMA DI TUTTO: impostare ENCRYPTION_KEY (Render + .env locale).
-- Se la chiave cambia, i dati già cifrati NON sono più leggibili: prima di
-- cambiarla eseguire "Decripta" su tutte le tabelle migrate.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) PROGETTO "Projexa" (DATABASE_URL)
--    STATO al 02/09/2026: la colonna crypto ESISTE GIÀ (integer NOT NULL) su
--      cl_quotazioni(1), clients(0), contacts(1), proj_componenti(1),
--      projects(0), settings(0), table_structures(1), task_app(1), tasks(1),
--      users(1)                                   -- fra parentesi il DEFAULT
--    Non serve quindi eseguire nulla qui: le righe da cifrare si scelgono al
--    punto 3. Le istruzioni sotto servono solo per le tabelle non ancora
--    predisposte (es. proj_activity, risks, meetings, stakeholders).
--
--    Il DEFAULT decide come nascono le NUOVE righe scritte dall'applicazione:
--      DEFAULT 0 = in chiaro   ·   DEFAULT 1 = cifrate
--    Sulle tabelle EAV (settings/clients/projects) le righe nuove ereditano
--    comunque il flag dalle righe sorelle dello stesso contenitore (argument).
-- ----------------------------------------------------------------------------

-- ALTER TABLE proj_activity ADD COLUMN IF NOT EXISTS crypto integer NOT NULL DEFAULT 0;
-- ALTER TABLE risks         ADD COLUMN IF NOT EXISTS crypto integer NOT NULL DEFAULT 0;
-- ALTER TABLE meetings      ADD COLUMN IF NOT EXISTS crypto integer NOT NULL DEFAULT 0;
-- ALTER TABLE stakeholders  ADD COLUMN IF NOT EXISTS crypto integer NOT NULL DEFAULT 0;

-- Cambio del default su una tabella già predisposta (es. far nascere cifrate le
-- nuove righe di clients):
-- ALTER TABLE clients ALTER COLUMN crypto SET DEFAULT 1;

-- Verifica dello stato attuale:
-- SELECT table_name, data_type, column_default
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND column_name = 'crypto'
--  ORDER BY table_name;


-- ----------------------------------------------------------------------------
-- 2) clients.valore3 — SOLO SE SERVE CIFRARE ANCHE valore3
--    valore3 è numeric(12,2): una colonna numerica NON può contenere il testo
--    cifrato, quindi finché resta numerica la migrazione la SALTA (e lo segnala
--    nella finestra "Migrazione Crypto").
--
--    Per cifrarla davvero va convertita in testo. ATTENZIONE: dopo la conversione
--    gli ordinamenti e i confronti su clients.valore3 diventano alfabetici
--    ('10' < '9'). Verificare le configurazioni che usano clients.valore3 come
--    numero (campi tipo 12, VariabDB, function_db) prima di eseguirla.
-- ----------------------------------------------------------------------------

-- ALTER TABLE clients ALTER COLUMN valore3 TYPE text USING valore3::text;
-- Ritorno indietro (solo se i dati sono stati prima decifrati con "Decripta"):
-- ALTER TABLE clients ALTER COLUMN valore3 TYPE numeric(12,2) USING NULLIF(valore3, '')::numeric;


-- ----------------------------------------------------------------------------
-- 3) Marcare le righe da cifrare (crypto = 1)
--    La cifratura agisce SOLO sulle righe marcate. Esempi:
-- ----------------------------------------------------------------------------

-- Tutte le righe di un cliente (contenitore + campi figli):
-- UPDATE clients SET crypto = 1
--  WHERE tenant_id = '<uuid tenant>'
--    AND (id = '<uuid cliente>' OR argument = '<uuid cliente>');

-- Tutti i clienti di un tenant:
-- UPDATE clients SET crypto = 1 WHERE tenant_id = '<uuid tenant>';

-- Tutti i progetti di un cliente:
-- UPDATE projects SET crypto = 1 WHERE client_id = '<uuid cliente>';

-- Verifica di quante righe sono marcate:
-- SELECT crypto, COUNT(*) FROM clients GROUP BY crypto;


-- ----------------------------------------------------------------------------
-- 4) PROGETTO "Projexa-Auth" (AUTH_DATABASE_URL)
--    Tabella integr_tok_auth (token delle integrazioni, es. Jira):
--    colonna crypto GIÀ PRESENTE con DEFAULT 1 e tutte le righe a 1, quindi non
--    serve eseguire nulla. Viene cifrata solo valore_alfa; elemento,
--    provider_integrazione e tipo_integrazione restano in chiaro perché servono
--    a ritrovare le righe. L'integrazione continua a funzionare come prima.
--
--    I token 'jira_access_token' e 'jira_refresh_token' sono cifrati SEMPRE,
--    anche a crypto = 0 (come già avveniva prima di questa funzione).
-- ----------------------------------------------------------------------------

-- Se servisse ricrearla:
-- ALTER TABLE integr_tok_auth ADD COLUMN IF NOT EXISTS crypto integer NOT NULL DEFAULT 1;
-- UPDATE integr_tok_auth SET crypto = 1;

-- NB: la tabella users di Projexa-Auth NON ha la colonna crypto e non va cifrata:
-- email e password_hash sono le chiavi del login. Anche aggiungendola e mettendo
-- crypto = 1, quelle due colonne resterebbero comunque escluse.


-- ----------------------------------------------------------------------------
-- 5) Controllo dopo la migrazione (dati cifrati sul database)
-- ----------------------------------------------------------------------------

-- SELECT id, campo, left(valore2, 20) AS valore2_su_db, crypto FROM clients WHERE crypto = 1 LIMIT 20;
--   -> i valori devono iniziare con 'enc:v1:' mentre nel database-viewer si vedono in chiaro.
