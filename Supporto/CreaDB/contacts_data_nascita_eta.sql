-- =====================================================================
-- CONTACTS: aggiunta di "data_nascita" (DATE) ed "eta" (INTEGER calcolata).
-- ---------------------------------------------------------------------
-- Nota: "eta" NON può essere una colonna GENERATED STORED perché il calcolo usa
-- CURRENT_DATE (non immutabile) → Postgres lo rifiuta. Qui è una colonna fisica
-- mantenuta da un trigger che la ricalcola all'INSERT/UPDATE di data_nascita.
-- L'età cambia nel tempo: per tenerla sempre aggiornata vedi il refresh in fondo.
-- =====================================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS data_nascita DATE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS eta INTEGER;

-- Funzione: calcola gli anni compiuti dalla data di nascita alla data odierna.
CREATE OR REPLACE FUNCTION contacts_calc_eta()
RETURNS TRIGGER AS $$
BEGIN
  NEW.eta := CASE
    WHEN NEW.data_nascita IS NULL THEN NULL
    ELSE EXTRACT(YEAR FROM AGE(CURRENT_DATE, NEW.data_nascita))::int
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger: ricalcola "eta" quando si inserisce/aggiorna data_nascita.
DROP TRIGGER IF EXISTS trg_contacts_eta ON contacts;
CREATE TRIGGER trg_contacts_eta
BEFORE INSERT OR UPDATE OF data_nascita ON contacts
FOR EACH ROW EXECUTE FUNCTION contacts_calc_eta();

-- Inizializza "eta" sui record già esistenti.
UPDATE contacts
SET eta = EXTRACT(YEAR FROM AGE(CURRENT_DATE, data_nascita))::int
WHERE data_nascita IS NOT NULL;

-- (Opzionale) Aggiornamento periodico: esegui questa riga una volta al giorno
-- (es. da un job schedulato) per mantenere "eta" sempre corretta anche senza
-- modifiche ai record:
--   UPDATE contacts SET eta = EXTRACT(YEAR FROM AGE(CURRENT_DATE, data_nascita))::int
--   WHERE data_nascita IS NOT NULL AND eta IS DISTINCT FROM EXTRACT(YEAR FROM AGE(CURRENT_DATE, data_nascita))::int;
