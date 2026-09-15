-- ============================================================================
-- CORREZIONE: la griglia "Task" dei clienti non mostra mai righe
-- Da eseguire MANUALMENTE sul progetto Neon "Projexa" (DATABASE_URL).
-- ============================================================================
--
-- IL PROBLEMA
--   Le righe di configurazione della griglia Task (clients, tipo_valore = 11,
--   tabella = 'task_app') hanno nel campo VariabDB:
--
--       AND project_id = null
--
--   In SQL il confronto con NULL non è mai vero: "project_id = NULL" restituisce
--   sempre "sconosciuto", mai TRUE, quindi la WHERE scarta OGNI riga e la griglia
--   risulta vuota anche quando i task esistono. La forma corretta è "IS NULL",
--   quella già usata dalla griglia Quotazioni:
--
--       AND project_id is null
--
--   Riscontro sul cliente MIROGLIO (14 task a database):
--       nessun filtro extra .............. 14 righe
--       AND project_id = null ............  0 righe   <- configurazione attuale
--       AND project_id is null ........... 11 righe   <- corretta (3 task sono
--                                                        legati a un progetto e
--                                                        si vedono nella griglia
--                                                        Task del progetto)
--
-- Al momento della stesura il refuso è su 12 righe, tutte clients/campo='Task'.
-- Nessuna riga di settings o projects ne è affetta.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) VERIFICA — quali righe verranno toccate
-- ----------------------------------------------------------------------------

SELECT id, argument, campo, tabella, "VariabDB"
  FROM clients
 WHERE tipo_valore::text = '11'
   AND "VariabDB" ILIKE '%= null%'
 ORDER BY campo;


-- ----------------------------------------------------------------------------
-- 2) CORREZIONE
-- ----------------------------------------------------------------------------

UPDATE clients
   SET "VariabDB" = replace("VariabDB", '= null', 'is null')
 WHERE tipo_valore::text = '11'
   AND "VariabDB" ILIKE '%= null%';


-- ----------------------------------------------------------------------------
-- 3) CONTROLLO — dopo l'UPDATE non deve restituire nessuna riga
-- ----------------------------------------------------------------------------

SELECT id, argument, campo, "VariabDB"
  FROM clients
 WHERE tipo_valore::text = '11'
   AND "VariabDB" ILIKE '%= null%';


-- ----------------------------------------------------------------------------
-- NOTA PER IL FUTURO
--   VariabDB viene concatenato tal quale nella WHERE della griglia
--   (backend/server.js, endpoint grid-widget). Scrivere sempre "IS NULL" /
--   "IS NOT NULL": "= null" e "<> null" non danno errore, semplicemente
--   svuotano la griglia in silenzio.
-- ----------------------------------------------------------------------------
