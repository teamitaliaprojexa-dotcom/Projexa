-- =============================================================================
-- ANONIMIZZAZIONE DELLO STAGING (2026-10-17)
-- -----------------------------------------------------------------------------
-- Eseguito da sync-staging.sh su ogni database di staging (Neon) SUBITO DOPO il ripristino,
-- nella stessa transazione: se qualcosa fallisce, su Neon non arriva nulla della copia.
-- Così sullo staging (fornitore esterno) non restano dati personali né segreti:
--   - token delle integrazioni, chiavi API, token MySupport: cancellati;
--   - code e registri con valori prima/dopo o audio: svuotati;
--   - email, nominativi, telefoni, referenti, operatori, testi delle riunioni: sostituiti;
--   - anagrafica sensibile dei clienti (ragione sociale, CF, P.IVA, email, PEC, indirizzo).
-- Restano gli account indicati in :keep (email separate da virgola, STAGING_EMAIL_CONSENTITE
-- di staging-sync.env), per poter accedere allo staging. Funziona su tutti e 4 i database:
-- tabelle e colonne assenti vengono saltate. I nomi delle aziende clienti restano (non sono
-- dati personali) per rendere lo staging utilizzabile nei test.
-- =============================================================================

SELECT set_config('projexa.keep', lower(:'keep'), true);
-- Il trigger del log di audit (ripristinato con i dati) non deve registrare l'anonimizzazione.
SELECT set_config('projexa.audit_salta', 'on', true);

DO $$
DECLARE
  keep text[] := string_to_array(replace(coalesce(current_setting('projexa.keep', true), ''), ' ', ''), ',');
  r record;
  t text;
  espr text;
  -- Colonne con dati personali, riconosciute dal nome (qualunque tabella).
  persone text[] := ARRAY['nominativo', 'nome', 'cognome', 'telefono', 'cellulare', 'mittente', 'owner',
                          'owner_nominativo', 'referente', 'richiedente', 'assegnatario', 'operatore',
                          'accettato_da', 'decisa_da', 'richiesta_da', 'fornitore', 'foto_nome'];
  testi text[] := ARRAY['trascrizione', 'recap', 'recap_html', 'recap_interno', 'oggetto', 'email_a', 'email_cc'];
BEGIN
  -- 1) Segreti
  FOREACH t IN ARRAY ARRAY['integr_tok_auth', 'api_token', 'session_revoked'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN EXECUTE format('DELETE FROM public.%I', t); END IF;
  END LOOP;

  -- 2) Code e registri (valori prima/dopo, audio, risultati AI, notifiche)
  FOREACH t IN ARRAY ARRAY['audit_outbox', 'rec_meeting_chunks', 'activity_log', 'activity_logs', 'ai_lavori',
                           'projexa_notif', 'notifiche'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN EXECUTE format('DELETE FROM public.%I', t); END IF;
  END LOOP;

  -- 3) Colonne personali riconosciute dal nome
  FOR r IN
    SELECT c.table_name, c.column_name, c.character_maximum_length AS len
      FROM information_schema.columns c
      JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.is_generated = 'NEVER'
       AND c.data_type IN ('text', 'character varying')
       AND (c.column_name LIKE '%email%' OR c.column_name = ANY(persone) OR c.column_name = ANY(testi)
            OR (c.table_name = 'users' AND c.column_name IN ('name', 'cognome')))
  LOOP
    IF r.column_name = ANY(testi) AND r.column_name NOT LIKE 'email%' THEN
      espr := quote_literal('[testo rimosso nello staging]');
    ELSIF r.column_name LIKE '%email%' THEN
      espr := format($f$'anonimo+' || substr(md5(%1$I::text), 1, 12) || '@staging.invalid'$f$, r.column_name);
    ELSE
      espr := format($f$'Anonimo ' || substr(md5(%1$I::text), 1, 6)$f$, r.column_name);
    END IF;
    IF r.len IS NOT NULL THEN espr := format('left(%s, %s)', espr, r.len); END IF;
    -- Gli account consentiti (tabella users, per email) restano intatti.
    IF r.table_name = 'users' AND EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email') THEN
      EXECUTE format('UPDATE public.users SET %1$I = %2$s WHERE NULLIF(btrim(%1$I::text), %3$L) IS NOT NULL AND NOT (lower(btrim(email)) = ANY($1))',
                     r.column_name, espr, '') USING keep;
    ELSE
      EXECUTE format('UPDATE public.%1$I SET %2$I = %3$s WHERE NULLIF(btrim(%2$I::text), %4$L) IS NOT NULL',
                     r.table_name, r.column_name, espr, '');
    END IF;
  END LOOP;

  -- 4) Anagrafica sensibile dei clienti (tabella EAV clients, valore2)
  IF to_regclass('public.clients') IS NOT NULL THEN
    UPDATE public.clients SET valore2 = 'Dato anonimizzato'
     WHERE NULLIF(btrim(valore2::text), '') IS NOT NULL
       AND lower(btrim(regexp_replace(campo, '^[(][*][)][[:space:]]*', ''))) IN
           ('ragione sociale', 'cod fiscale', 'p.iva', 'email', 'pec', 'indirizzo', 'id. ambiente cliente prod', 'id. ambiente cliente staging');
  END IF;

  -- 5) Loghi e foto (immagini): tolti
  IF to_regclass('public.rubrica') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rubrica' AND column_name = 'foto') THEN
    UPDATE public.rubrica SET foto = NULL WHERE foto IS NOT NULL;
  END IF;

  -- Controllo finale: nessun segreto deve restare.
  -- (query dinamica: la tabella esiste solo nel database delle credenziali)
  IF to_regclass('public.integr_tok_auth') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.integr_tok_auth)' INTO r;
    IF (row_to_json(r) ->> 'exists')::boolean THEN
      RAISE EXCEPTION 'anonimizzazione incompleta: integr_tok_auth non vuota';
    END IF;
  END IF;
END $$;
