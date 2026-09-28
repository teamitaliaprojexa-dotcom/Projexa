-- ============================================================================
-- RECAP PROJEXA (modelli locali, gratuiti) - voci del campo "AI generazione e-mail recap"
-- ----------------------------------------------------------------------------
--   Recap Projexa (lento)          -> Ollama sulla VM (backend/routes/ai.js, askOllamaRecap)
--   Recap Projexa (Browser-Medio)  -> Qwen2.5 7B nel browser (sito/js/browser-recap.js)
--   Recap Projexa (Browser-Alto)   -> Gemma 2 9B nel browser
--
-- Le opzioni del menu (tipo_valore 10) stanno in lookup_values. Le tre voci si aggiungono
-- a OGNI elenco già esistente per il campo (globale, di tenant o personale), in coda,
-- così compaiono a tutti quelli che vedono già il menu. Rieseguibile: non crea doppioni.
-- Database: principale (projexa).
-- ============================================================================

INSERT INTO lookup_values (tenant_id, user_id, tabella, tipo_valore, nome_campo, valore, ordinamento, id_roles)
SELECT g.tenant_id, g.user_id, g.tabella, g.tipo_valore, g.nome_campo, v.valore, g.max_ord + v.n, NULL
  FROM (
        SELECT tenant_id, user_id, tabella, tipo_valore, nome_campo, COALESCE(MAX(ordinamento), 0) AS max_ord
          FROM lookup_values
         WHERE LOWER(BTRIM(nome_campo)) IN ('ai generazione e-mail recap', '(*) ai generazione e-mail recap')
         GROUP BY tenant_id, user_id, tabella, tipo_valore, nome_campo
       ) g
 CROSS JOIN (VALUES (1, 'Recap Projexa (lento)'),
                    (2, 'Recap Projexa (Browser-Medio)'),
                    (3, 'Recap Projexa (Browser-Alto)')) AS v(n, valore)
 WHERE NOT EXISTS (
        SELECT 1 FROM lookup_values x
         WHERE x.tenant_id IS NOT DISTINCT FROM g.tenant_id
           AND x.user_id IS NOT DISTINCT FROM g.user_id
           AND x.nome_campo = g.nome_campo
           AND LOWER(x.valore) = LOWER(v.valore)
       );

-- Controllo: elenchi del campo con le nuove voci
SELECT tenant_id, user_id, nome_campo, valore, ordinamento
  FROM lookup_values
 WHERE LOWER(BTRIM(nome_campo)) IN ('ai generazione e-mail recap', '(*) ai generazione e-mail recap')
 ORDER BY tenant_id NULLS FIRST, user_id NULLS FIRST, ordinamento;
